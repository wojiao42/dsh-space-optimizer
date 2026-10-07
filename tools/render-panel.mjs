#!/usr/bin/env node
/**
 * 把**真实组件**渲染成 HTML，再用无头浏览器出截图。
 *
 *   node tools/render-panel.mjs
 *
 * 为什么要绕这一步：这个插件是浏览器插件，没有真实 GUI 就截不到图。与其手画一张
 * 示意图，不如把 `client.js` 真正的渲染结果序列化成 HTML——`<style>` 里就是组件
 * 自己带的那份 CSS，页面主题变量则是从已安装的 `dsh-client-ui-theme` 里原样抽出来的
 * 真实样式表。所以出来的像素就是插件的像素，只是数据是虚构的样本。
 *
 * ⚠️ **样本数据是编造的**：真实账本含用户的任务标题与本机路径，不能进公开截图。
 *
 * 产出：`assets/screenshot-1-ledger.png`、`-2-freed.png`、`-3-button.png`、`-4-dark.png`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createPlugin, createReact, findAll, find, loadClientDefinition, mountedStyles } from './lib/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const assets = path.join(root, 'assets')
const clientPath = path.join(root, 'client.js')

// ── 1. 抽取真实主题样式表 ───────────────────────────────────────────────────
/** 在常见位置找已安装的 `dsh-client-ui-theme`。 */
function findThemeClient() {
  const candidates = []
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const profiles = path.join(home, 'profiles')
  for (const name of fs.existsSync(profiles) ? fs.readdirSync(profiles) : []) {
    candidates.push(path.join(profiles, name, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'))
  }
  const npxCache = path.join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')
  for (const hash of fs.existsSync(npxCache) ? fs.readdirSync(npxCache) : []) {
    candidates.push(path.join(npxCache, hash, 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js'))
  }
  return candidates.find((candidate) => fs.existsSync(candidate))
}

/** 抽出主题模块里内联的样式表字面量（`--dsw-*` 变量都在里面）。 */
function extractThemeCss(themeClientPath) {
  const source = fs.readFileSync(themeClientPath, 'utf8')
  const blocks = []
  for (const match of source.matchAll(/var\s+\w+_css_default\s*=\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      blocks.push(JSON.parse(match[1]))
    } catch {
      /* 跳过解析不了的字面量 */
    }
  }
  return blocks.join('\n')
}

// ── 2. HTML 序列化 ─────────────────────────────────────────────────────────
const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])
const BOOL_ATTRS = new Set(['checked', 'disabled', 'aria-modal', 'aria-hidden', 'focusable'])
const escapeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (value) => escapeText(value).replace(/"/g, '&quot;')
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())

function serializeStyle(style) {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${kebab(key)}:${value}`)
    .join(';')
}

function serializeAttrs(node) {
  const parts = []
  for (const [key, value] of Object.entries(node.props)) {
    if (key === 'children' || key === 'key' || key === 'ref') continue
    if (typeof value === 'function') continue // 事件处理器：静态图里没有意义
    if (value === undefined || value === null || value === false) continue
    if (key === 'style') {
      const css = serializeStyle(value)
      if (css !== '') parts.push(`style="${escapeAttr(css)}"`)
      continue
    }
    const name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key
    if (value === true) {
      parts.push(BOOL_ATTRS.has(name) ? name : `${name}=""`)
      continue
    }
    parts.push(`${name}="${escapeAttr(String(value))}"`)
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

/** 渲染树 → HTML 字符串。 */
function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeText(node)
  if (typeof node.type === 'function') return toHtml(node.type(node.props)) // 函数组件（图标）
  const tag = node.type
  if (tag === 'style') return `<style>${node.children.map(String).join('')}</style>`
  const inner = node.children.map(toHtml).join('')
  if (VOID_TAGS.has(tag)) return `<${tag}${serializeAttrs(node)}>`
  return `<${tag}${serializeAttrs(node)}>${inner}</${tag}>`
}

// ── 3. 虚构样本账本（不用真实数据：会泄露用户任务标题与本机路径）────────────
const CURRENT = 'session-9f2c41a7-demo'
const state = { ids: [], byId: {} }

/** 造一个会话行。 */
function session({
  id,
  title,
  log,
  spill = 0,
  oldLog = 0,
  projection = 64000,
  attached = 0,
  shared = 0,
  running = false,
  subagent = false,
  current = false,
}) {
  const supersededItems =
    oldLog > 0 ? [{ targetId: `${id}-old`, label: 'session.v3.jsonl.zstd', bytes: oldLog, reclaimable: true }] : []
  const spillItems =
    spill > 0
      ? [{ targetId: `${id}-spill`, label: `dsh-spill-8f13ac/session-${id.slice(-4)}`, bytes: spill, reclaimable: true }]
      : []
  state.ids.push(id)
  state.byId[id] = { title, running, retainedBy: { mainView: current ? 1 : 0 }, displayTitle: title }
  const reclaimableBytes = spill + oldLog
  return {
    id,
    origin: subagent ? 'subagent' : 'session',
    logBytes: log,
    projectionBytes: projection,
    spillBytes: spill,
    supersededBytes: oldLog,
    attachmentBytes: attached + shared,
    attachmentExclusiveBytes: attached,
    attachmentSharedBytes: shared,
    reclaimableBytes,
    ownedBytes: log + projection + reclaimableBytes,
    totalBytes: log + projection + reclaimableBytes,
    supersededItems,
    spillItems,
  }
}

const sessions = [
  session({ id: CURRENT, title: '给侧栏加一个用量徽标', log: 1_048_576, spill: 65_536, projection: 65_536, running: true, current: true }),
  session({ id: 'session-3d81f6b2-demo', title: '重构登录模块', log: 1_992_294, spill: 3_145_728, projection: 92_160 }),
  session({ id: 'session-b47e09c5-demo', title: 'README 批量校对', log: 2_023_424, projection: 94_208, shared: 2_621_440 }),
  session({ id: 'session-71ac5e30-demo', title: 'B 站视频链接分析', log: 419_430, projection: 28_672, attached: 7_347 }),
  session({ id: 'session-c02f9a84-demo', title: '依赖升级排查', log: 1_281_505, projection: 45_056 }),
  session({ id: 'e0a7b41c-demo', title: '调研：三种缓存方案对比', log: 337_779, projection: 26_624, subagent: true }),
]

const sum = (items) => items.reduce((total, item) => total + item.bytes, 0)
const junk = [
  {
    id: 'market-cache',
    title: '插件市场目录缓存',
    note: '纯缓存，删掉后按需重新下载',
    items: [{ targetId: 'junk-market', label: 'catalog.zh.json', bytes: 8_655_772, reclaimable: true }],
  },
  {
    id: 'dead-temp',
    title: '无主临时文件',
    note: '会话已不存在的 spill，以及闲置 24 小时以上、非当前进程在用的 dsh-* 目录',
    items: [
      { targetId: 'junk-temp-a', label: 'dsh-spill-1a77c0/session-4be9120af3c1', bytes: 3_086_186, reclaimable: true },
      { targetId: 'junk-temp-b', label: 'dsh-subprocess-4d91aa/…-stdout.log', bytes: 82_044, reclaimable: true },
      { targetId: 'junk-temp-c', label: 'dsh-workspace-changes-7f2e10/captures', bytes: 25_180, reclaimable: true },
      {
        targetId: 'junk-temp-kept',
        label: 'dsh-subprocess-6c0f31/…-stdout.log',
        bytes: 121_938,
        reclaimable: false,
        note: '当前进程正在使用',
      },
    ],
  },
  {
    id: 'projection-orphan',
    title: '失效的投影缓存',
    note: '会话已不存在，缓存行永远不会被读到',
    items: [
      { targetId: 'junk-proj-a', label: 'session-8ad07c11…json', bytes: 28_911, reclaimable: true },
      { targetId: 'junk-proj-b', label: 'session-2fe6a0d4…json', bytes: 9_252, reclaimable: true },
    ],
  },
  {
    id: 'attachment-orphan',
    title: '无主附件对象',
    note: '内容寻址存储；只列没有任何会话引用的对象',
    items: [{ targetId: 'junk-attachment', label: '4c4cc87394db6d0f…', bytes: 524_288, reclaimable: true }],
  },
].map((category) => ({
  ...category,
  reclaimableBytes: sum(category.items.filter((item) => item.reclaimable)),
  reclaimableFiles: category.items.filter((item) => item.reclaimable).length,
}))

const ledger = {
  home: '~/.dsh',
  tempDir: '%TEMP%',
  generatedAt: Date.now(),
  minIdleMs: 86_400_000,
  sessions,
  junk,
  emptyRoots: [],
  kept: '会话日志原样保留：日志里的 stream 字段被用量、上下文、耗时等投影读取，无法安全瘦身',
  totals: {
    sessions: sessions.reduce((total, item) => total + item.ownedBytes, 0),
    sessionLogs: sessions.reduce((total, item) => total + item.logBytes, 0),
    attachments: 2_628_787,
    attachmentsComplete: true,
    junk: sum(junk.flatMap((category) => category.items)),
    sessionReclaimable: sessions.reduce((total, item) => total + item.reclaimableBytes, 0),
    junkReclaimable: sum(junk.flatMap((category) => category.items.filter((item) => item.reclaimable))),
    sessionCount: sessions.length,
  },
}
ledger.totals.reclaimable = ledger.totals.sessionReclaimable + ledger.totals.junkReclaimable

const reclaimResult = {
  freedBytes: ledger.totals.junkReclaimable + 65_540,
  freedFiles: 6,
  freedByCategory: { 'market-cache': 8_655_772, 'dead-temp': 3_193_410 },
  freedTargets: [],
  failures: [],
  attempted: 6,
  stale: 0,
  kept: ledger.kept,
}

// ── 4. 驱动真实组件 ───────────────────────────────────────────────────────
const definition = await loadClientDefinition(clientPath)
const harness = createReact()
const plugin = createPlugin(definition, harness)

const dictionaries = new Map()
let slot
const store = {
  snapshot: state,
  getSnapshot() {
    return this.snapshot
  },
  subscribe: () => () => {},
}
plugin.apply({
  effect: (fn) => {
    fn()
  },
  locale: { register: (namespace, dict) => dictionaries.set(namespace, dict) },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => {
      slot = { options, component }
    },
  },
  sessions: { list: store },
})
const dict = dictionaries.get('spaceOptimizer').zh
const t = (key) => (dict[key] === undefined ? key : dict[key])

let fetchMode = 'ledger'
globalThis.fetch = async () => ({
  json: async () => (fetchMode === 'ledger' ? { ok: true, ledger } : { ok: true, result: reclaimResult, ledger }),
})

const render = () => {
  harness.reset()
  return slot.component({ t, wide: true, sessionsSource: store })
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 取 portal 的遮罩节点（卡片是它的子节点；只取卡片会丢掉居中与背景）。 */
const backdropOf = (tree) =>
  find(tree, (node) => {
    const className = node.props?.className
    return typeof className === 'string' && className.split(' ').includes('sop-backdrop')
  })

// 关着 → 打开（扫描）→ 渲染账本
let tree = render()
find(tree, (node) => node.props.className === 'sop-btn').props.onClick()
await tick()
await tick()
tree = render()
// 样式表在渲染树里（按钮树一份、面板树一份），一起序列化进页面。
// 不能改用 document.head —— 插槽子树与文档之间有样式隔离，只有树内样式才照得到
// 侧栏按钮（踩过：按钮一直挂着一圈黑框，而 portal 到 body 的面板照常）。
const stylesHtml = findAll(tree, (node) => node.type === 'style').map(toHtml).join('')
if (!stylesHtml.includes('.sop-btn')) throw new Error('没从渲染树里拿到插件样式表')
const buttonHtml = toHtml(find(tree, (node) => node.props.className === 'sop-btn'))
const ledgerHtml = toHtml(backdropOf(tree))

// 点「确认优化」→ 渲染释放结果（先把桩切到回收应答，再点，否则拿到的是账本）
fetchMode = 'reclaim'
findAll(tree, (node) => node.props?.className === 'sop-primary').at(-1).props.onClick()
await tick()
await tick()
tree = render()
const freedHtml = toHtml(backdropOf(tree))

// ── 5. 出页并截图 ─────────────────────────────────────────────────────────
const themeCss = extractThemeCss(findThemeClient())
if (themeCss.length < 1000) throw new Error('主题样式表抽取失败')

const PAGE_CSS = [
  'html,body{height:100%;margin:0;padding:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
  'font-family:var(--dsw-font-family);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
  // 出图专用：真实界面里卡片会被 84vh 限高并内部滚动；截图要一次看全，所以解除限高。
  '.sop-card{max-height:none!important}',
  '.sop-body{overflow:visible!important}',
].join('')

/** 面板页：主题 CSS + 插件自己的 <style> + portal（遮罩+卡片）。 */
function panelPage(panelHtml, dark) {
  // 出图专用：真实界面里遮罩是 `position:fixed` 盖住整个视口并压暗背景；
  // 单独出图时改成普通流式居中、去掉压暗，让面板成为画面主体。
  const shotCss = [
    '.sop-backdrop{position:static!important;inset:auto!important;width:100%!important;box-sizing:border-box!important;',
    'padding:28px 24px!important;background:transparent!important;align-items:flex-start!important;justify-content:center!important}',
  ].join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-space-optimizer</title>
<style>${themeCss}</style>
<style>${PAGE_CSS}</style>
<style>${shotCss}</style>
</head><body${dark ? ' data-ds-dark-theme=""' : ''}>${stylesHtml}${panelHtml}</body></html>`
}

/** 侧栏条页：只为说明"按钮长什么样、在哪"，没有任何伪造的侧栏行。 */
function stripPage(dark) {
  const extra = [
    'body{box-sizing:border-box;padding:18px;display:flex;align-items:center;justify-content:flex-start}',
    '.strip{box-sizing:border-box;width:236px;padding:10px 8px;border-radius:12px;',
    'background:var(--dsw-specific-tip,var(--dsw-alias-bg-base));border:.5px solid var(--dsw-alias-border-l2)}',
  ].join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-space-optimizer</title>
<style>${themeCss}</style>
<style>${PAGE_CSS}</style>
<style>${extra}</style>
</head><body${dark ? ' data-ds-dark-theme=""' : ''}>${stylesHtml}<div class="strip">${buttonHtml}</div></body></html>`
}

/** 找一个可用的无头浏览器。 */
function findBrowser() {
  const candidates = [
    path.join(process.env['ProgramFiles'] ?? '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  ]
  const found = candidates.find((candidate) => candidate !== '' && fs.existsSync(candidate))
  if (found === undefined) throw new Error('找不到 Chrome / Edge，无法出截图')
  return found
}

function shoot(browser, html, outFile, size) {
  const htmlFile = path.join(assets, path.basename(outFile, '.png') + '.html')
  fs.writeFileSync(htmlFile, html)
  fs.rmSync(outFile, { force: true })
  execFileSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${size}`,
      '--virtual-time-budget=4000',
      `--screenshot=${outFile}`,
      'file:///' + htmlFile.replace(/\\/g, '/'),
    ],
    { stdio: 'ignore', timeout: 120000 },
  )
  if (!fs.existsSync(outFile)) throw new Error('截图失败：' + outFile)
  return fs.statSync(outFile).size
}

fs.mkdirSync(assets, { recursive: true })
const browser = findBrowser()
const PANEL_SIZE = '880,1320'
const shots = [
  ['screenshot-1-ledger.png', panelPage(ledgerHtml, false), PANEL_SIZE],
  ['screenshot-2-freed.png', panelPage(freedHtml, false), PANEL_SIZE],
  ['screenshot-3-button.png', stripPage(false), '320,150'],
  ['screenshot-4-dark.png', panelPage(ledgerHtml, true), PANEL_SIZE],
]

console.log('浏览器:', browser)
console.log('主题 CSS:', (themeCss.length / 1024).toFixed(1), 'KB')
for (const [name, html, size] of shots) {
  const bytes = shoot(browser, html, path.join(assets, name), size)
  console.log(`  ${name}  ${(bytes / 1024).toFixed(0)} KB  (${size})`)
}
console.log('可优化合计:', (ledger.totals.reclaimable / 1048576).toFixed(2), 'MB')
