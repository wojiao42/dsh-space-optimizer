/**
 * 空间账本核心（纯文件系统，无 Cordis / 无 React 依赖）。
 *
 * 输出两份清单，供界面核对之后才动手：
 *   · `sessions` —— **每个任务**占了多少、其中多少能优化；
 *   · `junk`     —— 不属于任何任务的**无主垃圾**，按类别列出。
 *
 * ── 为什么账本长这样 ────────────────────────────────────────────────────────
 * 会话日志**不是垃圾**：`dsh-session` 的事件契约里 `assistant/message.stream`
 * 是必填字段，`dsh-token-meter`、`dsh-client-ui-chat`、`dsh-session-stats`、
 * `dsh-api-session-controller`、`dsh-subagent`、`dsh-session-persistence-jsonl`、
 * `dsh-client-connection` 都靠它重算用量 / 上下文 / 首 token 耗时。任何"拆字段
 * 瘦身"都会打坏这些投影，所以日志只统计、不裁剪。
 *
 * 一个任务真正能优化的只有三处，都是**附属产物**：
 *   1. spill —— 超出内联预算的工具输出被落盘到 `%TEMP%` 下 `dsh-spill-<id>\session-<hash>\`。
 *      目录名的 hash 就是 `sha256(sessionId)[0:12]`，所以能精确归属到任务。
 *      清理后：该任务里那些超大工具输出的**全文**读不回来了（日志里存的是路径），
 *      但对话正文、思考、工具调用、最终答案、代码改动都完好。
 *   2. 被取代的历史日志 —— 旧格式 generation，仅在更高版本校验通过时才回收。
 *   3. 独占的附件 —— 只有这个任务引用；任务一旦不在，它就变成无主垃圾。
 *
 * 安全纪律：不跟随符号链接；删除前重新 stat 防止和正在写的进程抢；任何一处日志
 * 读不通就不敢判定"无主"（附件孤儿整体放弃）；调用方只能回传服务端生成的
 * targetId，路径永远不外流。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'

/** 无会话归属的临时文件默认要闲置多久才算过期。 */
export const DEFAULT_MIN_IDLE_MS = 24 * 60 * 60 * 1000
/** 插件市场缓存默认要多久没更新才值得删（它有 6 小时 TTL）。 */
export const DEFAULT_MARKET_MIN_AGE_MS = 60 * 60 * 1000

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const SESSION_FILE = /^session\.v(\d+)\.jsonl(\.zstd)?$/
const SPILL_SESSION_DIR = /^session-([0-9a-f]{12})$/
const SHA256_REF = /sha256:[0-9a-f]{64}/g

/** Harness 家目录，和官方 `dsh-home-paths` 的兜底规则一致。 */
export function defaultHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** 稳定的目标 id：调用方只回传它，路径不离开 Host。 */
function targetIdFor(fullPath) {
  return createHash('sha1').update(fullPath).digest('hex').slice(0, 16)
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function safeLstat(targetPath) {
  try {
    return fs.lstatSync(targetPath)
  } catch {
    return undefined
  }
}

/** 递归统计目录（不跟随符号链接）。 */
function dirStat(dir) {
  const info = { bytes: 0, files: 0, newest: 0, oldest: Number.POSITIVE_INFINITY, names: [] }
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of safeReaddir(current)) {
      const full = path.join(current, entry.name)
      const stat = safeLstat(full)
      if (stat === undefined || stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!stat.isFile()) continue
      info.bytes += stat.size
      info.files++
      if (info.names.length < 200) info.names.push(entry.name)
      if (stat.mtimeMs > info.newest) info.newest = stat.mtimeMs
      if (stat.mtimeMs < info.oldest) info.oldest = stat.mtimeMs
    }
  }
  if (info.oldest === Number.POSITIVE_INFINITY) info.oldest = 0
  return info
}

/** 文件或目录都适用的统计。 */
function entryStat(targetPath) {
  const stat = safeLstat(targetPath)
  if (stat === undefined) return { bytes: 0, files: 0, newest: 0, names: [] }
  if (stat.isFile()) return { bytes: stat.size, files: 1, newest: stat.mtimeMs, names: [path.basename(targetPath)] }
  if (stat.isDirectory()) return dirStat(targetPath)
  return { bytes: 0, files: 0, newest: 0, names: [] }
}

/**
 * 解开"多个独立 Zstandard 帧首尾相接"的日志。官方后端每个持久批次追加一个
 * 带校验和的帧，所以不能只解第一帧；帧头魔数也可能在压缩数据里偶然出现，
 * 因此从每个魔数偏移试解，失败即跳过（校验和会挡住伪命中）。
 */
function decodeFrames(buffer) {
  const parts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer[i] !== ZSTD_MAGIC[0] || buffer[i + 1] !== ZSTD_MAGIC[1]) continue
    if (buffer[i + 2] !== ZSTD_MAGIC[2] || buffer[i + 3] !== ZSTD_MAGIC[3]) continue
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(i)))
    } catch {
      /* 伪魔数 */
    }
  }
  return parts.length === 0 ? undefined : Buffer.concat(parts).toString('utf8')
}

/** 读出日志正文；失败返回 undefined。 */
function readLogText(file) {
  let raw
  try {
    raw = fs.readFileSync(file)
  } catch {
    return undefined
  }
  return file.endsWith('.zstd') ? decodeFrames(raw) : raw.toString('utf8')
}

/** 首行必须是合法 session 头，否则这份日志不能作为"能读"的证据。 */
function parseHeader(text) {
  let header
  try {
    header = JSON.parse(text.split('\n', 1)[0])
  } catch {
    return { ok: false, reason: 'header-not-json' }
  }
  if (header?.type !== 'session' || typeof header?.id !== 'string') return { ok: false, reason: 'header-shape' }
  return { ok: true, header }
}

/**
 * 从目录条目里挑出当前 generation 与被它取代的旧 generation。
 * 只把**版本号更低**的算作被取代；同版本换了编码的文件不动
 * （一个根只属于一种编码，多出来的那个由官方部署规则处置，不该由我们猜）。
 */
function pickGenerations(entries) {
  const parsed = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = SESSION_FILE.exec(entry.name)
    if (match === null) continue
    parsed.push({ name: entry.name, version: Number(match[1]), zstd: match[2] === '.zstd' })
  }
  if (parsed.length === 0) return undefined
  const maxVersion = Math.max(...parsed.map((item) => item.version))
  const current = parsed.filter((item) => item.version === maxVersion)
  // 同版本里优先认压缩的那个：profile 没关压缩，官方默认产物就是 .zstd。
  const keeper = current.find((item) => item.zstd) ?? current[0]
  return { keeper, stale: parsed.filter((item) => item.version < maxVersion) }
}

/** 枚举 `sessions/<project>/<sessionId>/`。 */
function listSessionDirs(home) {
  const root = path.join(home, 'sessions')
  const dirs = []
  for (const project of safeReaddir(root)) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    for (const session of safeReaddir(projectDir)) {
      if (!session.isDirectory()) continue
      dirs.push({ project: project.name, id: session.name, dir: path.join(projectDir, session.name) })
    }
  }
  return dirs
}

/** 当前进程可能正在用的临时文件：`dsh-subprocess-<pid>-...` 这类命名带 pid。 */
function namesShowPid(names, pid) {
  return names.some((name) => name.includes(`-${pid}-`))
}

/** 复现 spill 后端的会话目录哈希：`session-` + sha256(sessionId) 的前 12 位。 */
function spillHash(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
}

/** 造一个可删除单元；`kind` 决定回收时走删文件还是清目录。 */
function target(fullPath, extra) {
  const stat = safeLstat(fullPath)
  return {
    targetId: targetIdFor(fullPath),
    path: fullPath,
    kind: stat !== undefined && stat.isDirectory() ? 'dir' : 'file',
    ...extra,
  }
}

/**
 * 扫描并生成账本。
 * @param {object} [options]
 * @param {string} [options.home] Harness 家目录。
 * @param {string} [options.tempDir] 临时目录。
 * @param {number} [options.now] 当前时间戳（测试用）。
 * @param {number} [options.minIdleMs] 无会话归属的临时文件闲置门槛。
 * @param {number} [options.marketCacheMinAgeMs] 市场缓存最小年龄。
 * @param {number} [options.pid] 当前进程 pid（测试用）。
 * @returns {object} 账本。
 */
export function scan(options = {}) {
  const home = options.home ?? defaultHome()
  const tempDir = options.tempDir ?? os.tmpdir()
  const now = options.now ?? Date.now()
  const minIdleMs = options.minIdleMs ?? DEFAULT_MIN_IDLE_MS
  const marketCacheMinAgeMs = options.marketCacheMinAgeMs ?? DEFAULT_MARKET_MIN_AGE_MS
  const pid = options.pid ?? process.pid

  // ── 附件对象清单（内容寻址存储）：先列出来，等读完日志再判归属 ──────────────
  const attachmentRoot = path.join(home, 'attachments', 'v1')
  const storedObjects = []
  for (const sub of ['objects', 'file-objects']) {
    const base = path.join(attachmentRoot, sub)
    for (const prefix of safeReaddir(base)) {
      if (!prefix.isDirectory()) continue
      for (const entry of safeReaddir(path.join(base, prefix.name))) {
        if (!entry.isFile()) continue
        const full = path.join(base, prefix.name, entry.name)
        const stat = safeLstat(full)
        if (stat === undefined) continue
        storedObjects.push({ path: full, digest: `sha256:${entry.name}`, bytes: stat.size })
      }
    }
  }
  const referencedBy = new Map()
  let attachmentScanComplete = true
  let attachmentScanReason

  // ── 每个任务的账目（每个日志只读一遍，读完即丢） ──────────────────────────
  const sessions = []
  for (const session of listSessionDirs(home)) {
    const generations = pickGenerations(safeReaddir(session.dir))
    const record = {
      id: session.id,
      project: session.project,
      logMissing: generations === undefined,
      logUnreadable: false,
      logReason: undefined,
      createdAt: undefined,
      cwd: undefined,
      origin: 'session',
      parentSession: undefined,
      delegationDepth: 0,
      logBytes: 0,
      logFile: undefined,
      supersededItems: [],
      spillItems: [],
      projectionItem: undefined,
      attachmentExclusiveBytes: 0,
      attachmentSharedBytes: 0,
    }

    if (generations !== undefined) {
      const keeperPath = path.join(session.dir, generations.keeper.name)
      const keeperStat = safeLstat(keeperPath)
      record.logFile = generations.keeper.name
      record.logBytes = keeperStat === undefined ? 0 : keeperStat.size

      const text = readLogText(keeperPath)
      const proof = text === undefined ? { ok: false, reason: 'decode-failed' } : parseHeader(text)
      record.logUnreadable = proof.ok !== true
      record.logReason = proof.ok === true ? undefined : proof.reason

      if (proof.ok === true) {
        const header = proof.header
        record.createdAt = typeof header.createdAt === 'number' ? header.createdAt : undefined
        record.cwd = typeof header.cwd === 'string' ? header.cwd : undefined
        record.origin = typeof header.origin === 'string' ? header.origin : 'session'
        record.parentSession = typeof header.parentSession === 'string' ? header.parentSession : undefined
        record.delegationDepth = typeof header.delegationDepth === 'number' ? header.delegationDepth : 0

        if (storedObjects.length > 0) {
          for (const match of text.matchAll(SHA256_REF)) {
            const owners = referencedBy.get(match[0]) ?? new Set()
            owners.add(session.id)
            referencedBy.set(match[0], owners)
          }
        }
      } else if (storedObjects.length > 0 && attachmentScanComplete) {
        // 读不通任何一份日志，就无法证明某个摘要是无主的：整体放弃该类别。
        attachmentScanComplete = false
        attachmentScanReason = `会话 ${session.id} 的日志无法读取（${record.logReason}）`
      }

      for (const stale of generations.stale) {
        const full = path.join(session.dir, stale.name)
        const info = entryStat(full)
        const replaceable = proof.ok === true
        record.supersededItems.push(
          target(full, {
            label: stale.name,
            bytes: info.bytes,
            files: info.files,
            reclaimable: replaceable,
            reason: replaceable ? undefined : 'keeper-unreadable',
            note: replaceable
              ? `已被 ${generations.keeper.name} 取代（校验通过）`
              : `最新日志 ${generations.keeper.name} 校验失败（${proof.reason}），保守跳过`,
          }),
        )
      }
    }
    sessions.push(record)
  }
  const byId = new Map(sessions.map((session) => [session.id, session]))

  // ── 附件归属：独占 / 共享 / 无主 ─────────────────────────────────────────
  const attachmentJunk = []
  for (const object of storedObjects) {
    if (!attachmentScanComplete) {
      attachmentJunk.push(
        target(object.path, {
          label: object.digest.slice(7, 23) + '…',
          bytes: object.bytes,
          files: 1,
          reclaimable: false,
          reason: 'unproven',
          note: '无法证明引用关系，保守保留',
        }),
      )
      continue
    }
    const owners = referencedBy.get(object.digest)
    if (owners === undefined || owners.size === 0) {
      attachmentJunk.push(
        target(object.path, {
          label: object.digest.slice(7, 23) + '…',
          bytes: object.bytes,
          files: 1,
          reclaimable: true,
          note: '没有任何会话引用',
        }),
      )
      continue
    }
    for (const owner of owners) {
      const record = byId.get(owner)
      if (record === undefined) continue
      if (owners.size === 1) record.attachmentExclusiveBytes += object.bytes
      else record.attachmentSharedBytes += object.bytes
    }
  }

  // ── 投影缓存：活的算任务账目，死的算垃圾 ──────────────────────────────────
  const projectionRoot = path.join(home, 'storages', 'session_projcache', 'sessions')
  const projectionJunk = []
  for (const entry of safeReaddir(projectionRoot)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -'.json'.length)
    const full = path.join(projectionRoot, entry.name)
    const stat = safeLstat(full)
    if (stat === undefined) continue
    const record = byId.get(id)
    if (record !== undefined) {
      // 缓存：删了会按需重建，收益很小，只统计不列为可优化项，免得制造噪音。
      record.projectionItem = target(full, {
        label: entry.name,
        bytes: stat.size,
        files: 1,
        reclaimable: false,
        reason: 'cache',
        note: '投影缓存，会被按需重建，不列为可优化项',
      })
      continue
    }
    projectionJunk.push(
      target(full, { label: entry.name, bytes: stat.size, files: 1, reclaimable: true, note: '对应会话已不存在' }),
    )
  }

  // ── 临时目录：spill 按会话归属，其余按闲置时长 ────────────────────────────
  const liveSpill = new Map(sessions.map((session) => [spillHash(session.id), session.id]))
  const tempJunk = []
  const emptyRoots = []
  for (const entry of safeReaddir(tempDir)) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-')) continue
    const root = path.join(tempDir, entry.name)
    const children = safeReaddir(root)
    if (children.length === 0) {
      emptyRoots.push(root)
      continue
    }
    const info = entryStat(root)
    const inUse = namesShowPid(info.names, pid)
    const isSpillRoot = entry.name.startsWith('dsh-spill-')
    for (const child of children) {
      const full = path.join(root, child.name)
      const childInfo = entryStat(full)
      const label = `${entry.name}/${child.name}`
      const sessionMatch = SPILL_SESSION_DIR.exec(child.name)
      if (isSpillRoot && sessionMatch !== null) {
        const owner = liveSpill.get(sessionMatch[1])
        if (owner !== undefined) {
          // 归属仍然存在的任务：进这个任务的账本，由用户按任务决定要不要清。
          byId.get(owner).spillItems.push(
            target(full, {
              label,
              bytes: childInfo.bytes,
              files: childInfo.files,
              reclaimable: true,
              note: '该任务落盘的超大工具输出；清理后这些输出只剩摘要',
            }),
          )
          continue
        }
        tempJunk.push(
          target(full, {
            label,
            bytes: childInfo.bytes,
            files: childInfo.files,
            reclaimable: true,
            note: '对应的会话已经不在了，文件不会再被读到',
          }),
        )
        continue
      }
      const idleMs = childInfo.newest === 0 ? Number.POSITIVE_INFINITY : now - childInfo.newest
      tempJunk.push(
        target(full, {
          label,
          bytes: childInfo.bytes,
          files: childInfo.files,
          reclaimable: !inUse && idleMs >= minIdleMs,
          rule: 'age',
          newest: childInfo.newest,
          reason: inUse ? 'in-use' : idleMs < minIdleMs ? 'too-recent' : undefined,
          note: inUse ? '当前进程正在使用' : idleMs < minIdleMs ? '还太新，保留' : undefined,
        }),
      )
    }
  }

  // ── 插件市场缓存 ─────────────────────────────────────────────────────────
  const marketJunk = []
  for (const entry of safeReaddir(path.join(home, 'plugin-market'))) {
    if (!entry.isFile()) continue
    const full = path.join(home, 'plugin-market', entry.name)
    const stat = safeLstat(full)
    if (stat === undefined) continue
    const ageMs = now - stat.mtimeMs
    marketJunk.push(
      target(full, {
        label: entry.name,
        bytes: stat.size,
        files: 1,
        reclaimable: ageMs >= marketCacheMinAgeMs,
        rule: 'age',
        newest: stat.mtimeMs,
        reason: ageMs < marketCacheMinAgeMs ? 'too-recent' : undefined,
        note: '纯缓存，删掉后下次打开插件市场会重新下载',
      }),
    )
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  const sumBytes = (items) => items.reduce((total, item) => total + item.bytes, 0)

  for (const session of sessions) {
    session.supersededBytes = sumBytes(session.supersededItems.filter((item) => item.reclaimable))
    session.spillBytes = sumBytes(session.spillItems)
    session.projectionBytes = session.projectionItem?.bytes ?? 0
    session.attachmentBytes = session.attachmentExclusiveBytes + session.attachmentSharedBytes
    // 能优化的只有附属产物；日志、投影缓存都保留。
    session.reclaimableBytes = session.supersededBytes + session.spillBytes
    // `ownedBytes` 是这个任务在磁盘上**独占**的字节，各任务相加不会重复计数；
    // 附件是共享/内容寻址的，单独统计，不并进来（否则多任务引用同一份会重复加）。
    session.ownedBytes = session.logBytes + session.projectionBytes + session.reclaimableBytes
    session.totalBytes = session.ownedBytes
  }
  sessions.sort((left, right) => right.totalBytes - left.totalBytes)

  const junk = [
    { id: 'market-cache', title: '插件市场目录缓存', note: '纯缓存，删掉后按需重新下载', items: marketJunk },
    {
      id: 'dead-temp',
      title: '无主临时文件',
      note: `会话已不存在的 spill，以及闲置 ${Math.round(minIdleMs / 3600000)} 小时以上、非当前进程在用的 ${tempDir}\\dsh-*`,
      items: tempJunk,
    },
    { id: 'projection-orphan', title: '失效的投影缓存', note: '会话已不存在，缓存行永远不会被读到', items: projectionJunk },
    {
      id: 'attachment-orphan',
      title: '无主附件对象',
      note: '内容寻址存储；只列没有任何会话引用的对象',
      items: attachmentJunk,
      blocked: attachmentScanComplete ? undefined : attachmentScanReason,
    },
  ]

  const junkItems = junk.flatMap((category) => category.items)
  const sessionReclaimable = sessions.reduce((total, session) => total + session.reclaimableBytes, 0)
  const junkReclaimable = junkItems.filter((item) => item.reclaimable).reduce((total, item) => total + item.bytes, 0)

  return {
    home,
    tempDir,
    generatedAt: now,
    minIdleMs,
    marketCacheMinAgeMs,
    sessions,
    junk: junk.map((category) => ({
      ...category,
      reclaimableBytes: category.items.filter((item) => item.reclaimable).reduce((total, item) => total + item.bytes, 0),
      reclaimableFiles: category.items.filter((item) => item.reclaimable).reduce((total, item) => total + item.files, 0),
    })),
    emptyRoots,
    totals: {
      // 各任务独占字节之和（不含共享附件），所以下面三项相加就是真实总占用。
      sessions: sessions.reduce((total, session) => total + session.ownedBytes, 0),
      sessionLogs: sessions.reduce((total, session) => total + session.logBytes, 0),
      attachments: storedObjects.reduce((total, object) => total + object.bytes, 0),
      attachmentsComplete: attachmentScanComplete,
      junk: sumBytes(junkItems),
      reclaimable: sessionReclaimable + junkReclaimable,
      sessionReclaimable,
      junkReclaimable,
      sessionCount: sessions.length,
    },
    kept: '会话日志原样保留：日志里的 stream 字段被用量、上下文、耗时等投影读取，无法安全瘦身',
  }
}

/** 删除单个文件；失败只记录，不中断整次回收。 */
function unlinkFile(targetPath, failures, counter) {
  const before = safeLstat(targetPath)
  if (before === undefined) return 0
  try {
    fs.unlinkSync(targetPath)
  } catch (error) {
    failures.push({ path: targetPath, reason: String(error?.code ?? error?.message ?? error) })
    return 0
  }
  if (!before.isFile()) return 0
  counter.files++
  return before.size
}

/** 清空一个目录树（删文件 + 删空目录），不跟随符号链接。 */
function clearDirectory(dir, failures, counter) {
  let freed = 0
  const stack = [dir]
  const dirs = []
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of safeReaddir(current)) {
      const full = path.join(current, entry.name)
      const stat = safeLstat(full)
      if (stat === undefined) continue
      if (stat.isSymbolicLink()) {
        failures.push({ path: full, reason: 'symlink-skipped' })
        continue
      }
      if (stat.isDirectory()) {
        dirs.push(full)
        stack.push(full)
        continue
      }
      if (!stat.isFile()) continue
      freed += unlinkFile(full, failures, counter)
    }
  }
  // 子目录在前、父目录在后。
  for (const sub of dirs.reverse()) {
    try {
      fs.rmdirSync(sub)
    } catch {
      /* 非空或被占用 */
    }
  }
  try {
    fs.rmdirSync(dir)
  } catch {
    /* 上面还有删不掉的条目 */
  }
  return freed
}

/**
 * 回收。**不接受调用方给的路径**：重新扫描一次，只删本次仍然存在、且本次判定为
 * 可回收的目标；认不出来的 id 一律忽略（说明扫描结果已过期），并如实报告数量。
 * @param {object} options 与 {@link scan} 相同，另加：
 * @param {string[]} [options.targets] 要删的 targetId 列表；省略表示全部可回收项。
 * @returns {object} 回收结果。
 */
export function reclaim(options = {}) {
  const report = scan(options)
  const wanted = Array.isArray(options.targets) ? new Set(options.targets) : undefined

  // Host 自己重建 id → 目标 的映射，路径从不来自请求。
  const index = new Map()
  for (const session of report.sessions) {
    for (const item of [...session.supersededItems, ...session.spillItems]) {
      if (item.reclaimable === true) index.set(item.targetId, { item, category: `session:${session.id}` })
    }
  }
  for (const category of report.junk) {
    if (category.blocked !== undefined) continue
    for (const item of category.items) {
      if (item.reclaimable === true) index.set(item.targetId, { item, category: category.id })
    }
  }

  const failures = []
  const counter = { files: 0 }
  const freedByCategory = new Map()
  const freedTargets = []
  const pruneParents = new Set()

  for (const [id, entry] of index) {
    if (wanted !== undefined && !wanted.has(id)) continue
    const item = entry.item
    const stat = safeLstat(item.path)
    if (stat === undefined) continue
    // 按闲置时长判定的目标：删除前再确认一次，别和刚写入的进程抢。
    if (item.rule === 'age') {
      const info = entryStat(item.path)
      const idleMs = info.newest === 0 ? Number.POSITIVE_INFINITY : Date.now() - info.newest
      if (idleMs < report.minIdleMs) {
        failures.push({ path: item.path, reason: 'became-active' })
        continue
      }
    }
    const freed = stat.isDirectory() ? clearDirectory(item.path, failures, counter) : unlinkFile(item.path, failures, counter)
    freedTargets.push({ targetId: id, label: item.label ?? item.path, bytes: freed })
    freedByCategory.set(entry.category, (freedByCategory.get(entry.category) ?? 0) + freed)
    pruneParents.add(path.dirname(item.path))
  }

  // 收尾：内容清空的 dsh-* 根、以及本来就空的根，一起删掉。
  for (const root of [...pruneParents, ...report.emptyRoots]) {
    try {
      fs.rmdirSync(root)
    } catch {
      /* 仍有内容被占用 */
    }
  }

  return {
    ok: true,
    at: Date.now(),
    freedBytes: [...freedByCategory.values()].reduce((total, value) => total + value, 0),
    freedFiles: counter.files,
    freedByCategory: Object.fromEntries(freedByCategory),
    freedTargets,
    failures,
    attempted: wanted === undefined ? index.size : [...wanted].filter((id) => index.has(id)).length,
    stale: wanted === undefined ? 0 : [...wanted].filter((id) => !index.has(id)).length,
    kept: report.kept,
  }
}
