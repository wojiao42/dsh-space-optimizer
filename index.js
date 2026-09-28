/**
 * Host 半侧：把空间账本暴露成本地 web server 上的路由。
 *
 *   GET  /space-optimizer/ledger            → 空间账本（只读，不修改任何东西）
 *   POST /space-optimizer/reclaim           → 按 targetId 回收；body `{ targets: [...] }`
 *   GET  /space-optimizer/config            → 当前门槛配置
 *
 * 放在 Host 而不是浏览器里的原因：要读 DSH_HOME、OS 临时目录、以及每个会话日志的
 * 压缩帧，浏览器沙箱做不到；同时**路径永远由 Host 自己枚举**，渲染进程只回传
 * targetId，因此无从越权删任意文件。
 *
 * 回收接口要求显式列出 targets：不提供"清空一切"的写法，避免一次误请求造成
 * 大范围删除。扫描结果过期时认不出的 id 会被忽略，并在结果里如实报告。
 *
 * @module @local/dsh-space-optimizer
 */

import {
  DEFAULT_MARKET_MIN_AGE_MS,
  DEFAULT_MIN_IDLE_MS,
  defaultHome,
  reclaim,
  scan,
} from './lib/space.js'

/** Cordis 插件名。 */
export const name = 'space-optimizer'

/** 默认配置。 */
const DEFAULTS = {
  minIdleHours: DEFAULT_MIN_IDLE_MS / 3600000,
  marketCacheMinAgeHours: DEFAULT_MARKET_MIN_AGE_MS / 3600000,
}

/** 请求体上限：targets 列表顶多几百个短 id。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 回收是写操作，而这条路由挂在无需授权的本地 web server 上。
 * 浏览器对跨源**简单请求**不拦发送（只是不让读响应），所以一个被访问的网页
 * 就能匿名 POST 到这里造成删除。要求一个自定义头即可挡掉：
 * 带自定义头必然触发预检，而预检没有 CORS 应答，浏览器就不会发出真实请求。
 * （本地进程仍可调用，但它本来就能直接删这些文件，不是这条防线要挡的东西。）
 */
const REQUIRED_HEADER = 'x-space-optimizer'

/** 同一时刻只允许一次回收。 */
let reclaiming = false

/** 按配置算出扫描参数。 */
function scanOptions(config) {
  const minIdleHours = Number.isFinite(config?.minIdleHours) ? config.minIdleHours : DEFAULTS.minIdleHours
  const marketHours = Number.isFinite(config?.marketCacheMinAgeHours)
    ? config.marketCacheMinAgeHours
    : DEFAULTS.marketCacheMinAgeHours
  return {
    home: typeof config?.home === 'string' && config.home.length > 0 ? config.home : defaultHome(),
    tempDir: typeof config?.tempDir === 'string' && config.tempDir.length > 0 ? config.tempDir : undefined,
    minIdleMs: Math.max(0, minIdleHours) * 3600000,
    marketCacheMinAgeMs: Math.max(0, marketHours) * 3600000,
  }
}

/** 回一个 JSON 响应。 */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** 只放行指定方法；其余 405。 */
function methodAllowed(request, response, methods) {
  if (methods.includes(request.method)) return true
  response.writeHead(405, { allow: methods.join(', ') })
  response.end()
  return false
}

/** 读请求体（有上限），失败返回 undefined。 */
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(undefined)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => resolve(undefined))
  })
}

/**
 * 注册路由。
 * @param ctx Cordis 上下文。
 * @param config `{ home?, tempDir?, minIdleHours?, marketCacheMinAgeHours? }`。
 */
export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULTS, ...config }
  const options = () => scanOptions(resolved)

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/space-optimizer/config',
          handler: (request, response) => {
            if (!methodAllowed(request, response, ['GET', 'HEAD'])) return
            const resolvedOptions = options()
            sendJson(response, 200, {
              ok: true,
              home: resolvedOptions.home,
              minIdleHours: resolved.minIdleHours,
              marketCacheMinAgeHours: resolved.marketCacheMinAgeHours,
            })
          },
        }),
      'space-optimizer: config route',
    )

    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/space-optimizer/ledger',
          handler: (request, response) => {
            if (!methodAllowed(request, response, ['GET', 'HEAD'])) return
            try {
              const ledger = scan(options())
              if (request.method === 'HEAD') {
                response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                response.end()
                return
              }
              sendJson(response, 200, { ok: true, ledger })
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'space-optimizer: ledger route',
    )

    host.effect(
      () =>
        host.webServer.register({
          kind: 'exact',
          path: '/space-optimizer/reclaim',
          handler: async (request, response) => {
            if (!methodAllowed(request, response, ['POST'])) return
            // 挡掉跨源表单/简单请求：自定义头会强制预检，而这里不应答预检。
            if (request.headers[REQUIRED_HEADER] === undefined) {
              sendJson(response, 403, { ok: false, error: 'missing-header' })
              return
            }
            if (request.headers['sec-fetch-site'] === 'cross-site') {
              sendJson(response, 403, { ok: false, error: 'cross-site' })
              return
            }
            if (reclaiming) {
              sendJson(response, 409, { ok: false, error: 'busy' })
              return
            }
            const url = new URL(request.url ?? '/', 'http://localhost')
            let targets
            const rawBody = await readBody(request)
            if (rawBody !== undefined && rawBody.trim() !== '') {
              try {
                const parsed = JSON.parse(rawBody)
                if (Array.isArray(parsed?.targets)) targets = parsed.targets.filter((id) => typeof id === 'string')
              } catch {
                sendJson(response, 400, { ok: false, error: 'bad-json' })
                return
              }
            }
            if (targets === undefined) {
              const raw = (url.searchParams.get('targets') ?? '').trim()
              if (raw !== '') targets = raw.split(',').map((value) => value.trim()).filter((value) => value !== '')
            }
            // 必须显式列出要删什么：没有"全清"写法。
            if (targets === undefined) {
              sendJson(response, 400, { ok: false, error: 'targets-required' })
              return
            }
            if (targets.length > 4096) {
              sendJson(response, 400, { ok: false, error: 'too-many-targets' })
              return
            }
            reclaiming = true
            try {
              const result = reclaim({ ...options(), targets })
              sendJson(response, 200, { ok: true, result, ledger: scan(options()) })
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
            } finally {
              reclaiming = false
            }
          },
        }),
      'space-optimizer: reclaim route',
    )
  })
}
