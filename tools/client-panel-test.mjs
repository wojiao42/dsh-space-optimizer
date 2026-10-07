#!/usr/bin/env node
/**
 * 客户端半侧的离线断言：用一个假 React / 假 ReactDOM / 假 fetch，
 * 把 plugin 真正渲染一遍并模拟点击，验证：
 *
 *   1. 模块形状与 slot 注册参数（注入源、order、locale 命名空间）；
 *   2. 界面文本的 locale 键齐全（中英都要有，缺键会退化成显示键名）；
 *   3. 关着的时候只有一个按钮，侧栏收起时只剩图标；
 *   4. 打开后账本渲染出**每个任务**（含子任务）、当前/运行中标签、运行中不可选；
 *   5. 默认勾选 = 只勾无主垃圾，任务级项目默认不勾；
 *   6. 点「确认优化」发的请求体只含被勾选的 targetId。
 *
 *   node tools/client-panel-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPlugin, createReact, findAll, find, loadClientDefinition, mountedStyles } from './lib/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SOURCE = path.join(here, '..', 'client.js')
const SOURCE_TEXT = fs.readFileSync(CLIENT_SOURCE, 'utf8')

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push({ name, message: String(error?.message ?? error) })
    console.log('  FAIL ' + name + '  → ' + String(error?.message ?? error))
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 假的 React / ReactDOM（共用 harness）────────────────────────────────────
const harness = createReact()

// ── 抓取模块定义 ───────────────────────────────────────────────────────────
const definition = await loadClientDefinition(CLIENT_SOURCE)
const plugin = createPlugin(definition, harness)

// ── 假的宿主上下文 ─────────────────────────────────────────────────────────
const dictionaries = new Map()
let slotRegistration
const fakeStore = {
  snapshot: { ids: [], byId: {} },
  getSnapshot() {
    return this.snapshot
  },
  subscribe() {
    return () => {}
  },
}
const ctx = {
  effect: (fn) => {
    fn()
    return () => {}
  },
  locale: { register: (namespace, dict) => dictionaries.set(namespace, dict) },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => {
      slotRegistration = { options, component }
    },
  },
  sessions: { list: fakeStore },
}

console.log('\n[1] 模块与 slot 注册')
check('模块 id 正确', () => assert.equal(definition.id, 'dsh-space-optimizer'))
check('factory 返回插件面', () => {
  assert.equal(plugin.name, 'space-optimizer')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('slots') && plugin.inject.includes('locale') && plugin.inject.includes('sessions'))
})
check('apply 注册了 locale 与 sidebar.footer.action', () => {
  plugin.apply(ctx)
  assert.ok(dictionaries.has('spaceOptimizer'))
  assert.equal(slotRegistration.options.name, 'sidebar.footer.action')
  assert.equal(slotRegistration.options.id, 'space-optimizer')
  assert.equal(slotRegistration.options.locale, 'spaceOptimizer')
  assert.equal(typeof slotRegistration.component, 'function')
})
check('注入面把会话列表 observable 带进组件', () => {
  const injected = slotRegistration.options.inject()
  assert.equal(injected.sessionsSource, fakeStore)
})

const ZH = dictionaries.get('spaceOptimizer').zh
const EN = dictionaries.get('spaceOptimizer').en

console.log('\n[2] locale 键齐全')
check('源码里用到的静态键中英都有', () => {
  const keys = new Set()
  for (const match of SOURCE_TEXT.matchAll(/\btr\(\s*'([A-Za-z][\w.]*)'\s*\)/g)) keys.add(match[1])
  assert.ok(keys.size > 20, '期望扫到一批键，实际 ' + keys.size)
  const missing = [...keys].filter((key) => ZH[key] === undefined || EN[key] === undefined)
  assert.deepEqual(missing, [])
})
check('动态拼的 cat.* 键四个类别都有', () => {
  for (const id of ['market-cache', 'dead-temp', 'projection-orphan', 'attachment-orphan']) {
    assert.ok(ZH['cat.' + id] !== undefined, 'zh 缺 cat.' + id)
    assert.ok(EN['cat.' + id] !== undefined, 'en 缺 cat.' + id)
  }
})
check('中英键集合一致（不含动态键）', () => {
  const zh = Object.keys(ZH).filter((key) => !key.startsWith('cat.')).sort()
  const en = Object.keys(EN).filter((key) => !key.startsWith('cat.')).sort()
  assert.deepEqual(zh, en)
})

// ── 夹具账本 ───────────────────────────────────────────────────────────────
const t = (key) => (ZH[key] === undefined ? key : ZH[key])
const CURRENT = 'session-current'
const RUNNING = 'session-running'
const DONE = 'session-done'
const SUB = 'child-subagent'

const ledger = {
  ok: true,
  ledger: {
    home: 'C:\\x\\home',
    kept: '会话日志原样保留',
    totals: {
      sessions: 5_000_000,
      sessionLogs: 4_000_000,
      attachments: 2_000_000,
      attachmentsComplete: true,
      junk: 9_000_000,
      reclaimable: 12_000_000,
      sessionReclaimable: 3_000_000,
      junkReclaimable: 9_000_000,
      sessionCount: 4,
    },
    sessions: [
      {
        id: CURRENT,
        ownedBytes: 3_000_000,
        logBytes: 2_800_000,
        projectionBytes: 20_000,
        attachmentExclusiveBytes: 200_000,
        attachmentSharedBytes: 0,
        attachmentBytes: 200_000,
        spillBytes: 180_000,
        supersededBytes: 0,
        reclaimableBytes: 180_000,
        supersededItems: [],
        spillItems: [{ targetId: 'cur-spill', label: 'dsh-spill-a/session-x', bytes: 180_000, reclaimable: true }],
      },
      {
        id: RUNNING,
        ownedBytes: 2_000_000,
        logBytes: 2_000_000,
        projectionBytes: 0,
        attachmentExclusiveBytes: 0,
        attachmentSharedBytes: 0,
        attachmentBytes: 0,
        spillBytes: 300_000,
        supersededBytes: 0,
        reclaimableBytes: 300_000,
        supersededItems: [],
        spillItems: [{ targetId: 'run-spill', label: 'dsh-spill-b/session-y', bytes: 300_000, reclaimable: true }],
      },
      {
        id: DONE,
        ownedBytes: 2_000_000,
        logBytes: 1_900_000,
        projectionBytes: 0,
        attachmentExclusiveBytes: 0,
        attachmentSharedBytes: 2_000_000,
        attachmentBytes: 2_000_000,
        spillBytes: 0,
        supersededBytes: 64_000,
        reclaimableBytes: 64_000,
        supersededItems: [{ targetId: 'done-v3', label: 'session.v3.jsonl.zstd', bytes: 64_000, reclaimable: true }],
        spillItems: [],
      },
      {
        id: SUB,
        origin: 'subagent',
        ownedBytes: 300_000,
        logBytes: 300_000,
        projectionBytes: 0,
        attachmentExclusiveBytes: 0,
        attachmentSharedBytes: 0,
        attachmentBytes: 0,
        spillBytes: 0,
        supersededBytes: 0,
        reclaimableBytes: 0,
        supersededItems: [],
        spillItems: [],
      },
    ],
    junk: [
      {
        id: 'market-cache',
        title: '插件市场目录缓存',
        note: '纯缓存',
        reclaimableBytes: 8_388_608,
        reclaimableFiles: 1,
        items: [{ targetId: 'junk-market', label: 'catalog.zh.json', bytes: 8_388_608, reclaimable: true }],
      },
      {
        id: 'dead-temp',
        title: '无主临时文件',
        note: '会话已不存在的 spill',
        reclaimableBytes: 1_048_576,
        reclaimableFiles: 2,
        items: [
          { targetId: 'junk-temp-a', label: 'dsh-spill-z/session-gone/a.txt', bytes: 943_718, reclaimable: true },
          { targetId: 'junk-temp-b', label: 'dsh-spill-z/session-gone/b.txt', bytes: 104_858, reclaimable: true },
          { targetId: 'junk-temp-kept', label: 'dsh-subprocess-z/live.log', bytes: 50_000, reclaimable: false, note: '还太新，保留' },
        ],
      },
      {
        id: 'projection-orphan',
        title: '失效的投影缓存',
        note: '会话已不存在',
        reclaimableBytes: 0,
        reclaimableFiles: 0,
        items: [],
      },
      {
        id: 'attachment-orphan',
        title: '无主附件对象',
        note: '没有任何会话引用',
        reclaimableBytes: 0,
        reclaimableFiles: 0,
        blocked: '会话 x 的日志无法读取',
        items: [{ targetId: 'junk-attachment', label: 'abc…', bytes: 500, reclaimable: false, note: '无法证明引用关系' }],
      },
    ],
  },
}

fakeStore.snapshot = {
  ids: [CURRENT, RUNNING, DONE, SUB],
  byId: {
    [CURRENT]: { title: '当前这个任务', running: true, retainedBy: { mainView: 1 }, displayTitle: '当前这个任务' },
    [RUNNING]: { title: '后台跑着的任务', running: true, retainedBy: { mainView: 0 } },
    [DONE]: { title: '已经做完的任务', running: false, retainedBy: { mainView: 0 } },
    [SUB]: { title: undefined, running: false, retainedBy: { mainView: 0 } },
  },
}

let responses = []
let reclaimOverride = null
let ledgerOverride = null
const requests = []
/** 回收接口的应答形状与账本不同：带 result。 */
const reclaimPayload = {
  ok: true,
  result: {
    freedBytes: 9_437_184,
    freedFiles: 3,
    freedByCategory: { 'market-cache': 8_388_608, 'dead-temp': 1_048_576 },
    freedTargets: [],
    failures: [],
    attempted: 3,
    stale: 0,
    kept: '会话日志原样保留',
  },
  ledger: ledger.ledger,
}
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init })
  if (String(url).startsWith('/space-optimizer/reclaim')) {
    return { json: async () => reclaimOverride ?? reclaimPayload }
  }
  return { json: async () => ledgerOverride ?? responses.shift() ?? ledger }
}

const render = (wide = true) => {
  harness.reset()
  return slotRegistration.component({ t, wide, sessionsSource: fakeStore })
}

console.log('\n[3] 关着的时候')
const closed = render(true)
check('只有一个按钮，没有面板', () => {
  assert.equal(find(closed, (node) => node.props['data-space-optimizer'] === 'panel'), undefined)
  const button = find(closed, (node) => node.type === 'button' && node.props['data-space-optimizer'] === undefined && node.props.className === 'sop-btn')
  assert.ok(button !== undefined, '没找到按钮')
  assert.equal(button.props['aria-label'], ZH.label)
  assert.ok(button.children.some((child) => child === ZH.label), '展开时应当有文字')
})
check('侧栏收起时只剩图标（文字为空）', () => {
  const collapsed = render(false)
  const button = find(collapsed, (node) => node.props.className === 'sop-btn')
  assert.equal(button.props.title, ZH.label)
  assert.ok(!button.children.some((child) => typeof child === 'string'), '收起时不该有文字')
})

// 回归：样式表必须留在组件树里。挂到 document.head 会照不到侧栏插槽子树
// （插槽树与文档之间有样式隔离），按钮于是露出 UA 默认外观——实测表现是
// 「按钮一直挂着一圈黑框」，而 portal 到 body 的面板照常，很容易误判成别的毛病。
check('样式表留在组件树里（按钮树 + 面板树两份），不挂 document.head', () => {
  const styleNode = find(render(true), (node) => node.type === 'style')
  assert.ok(styleNode !== undefined, '按钮所在的 DOM 树里必须有 <style>')
  assert.ok(String(styleNode.children.join('')).includes('.sop-btn svg'), '样式表应含按钮图标规则')
  assert.equal(
    (SOURCE_TEXT.match(/h\('style', null, CSS\)/g) ?? []).length,
    2,
    '应当恰好两处树内样式表（按钮树一份、面板树一份）',
  )
  assert.ok(!/document\.head\.(appendChild|replaceChildren|append)\s*\(/.test(SOURCE_TEXT), '不能把样式表挂到 document.head')
  assert.ok(!/createElement\(\s*['"]style['"]\s*\)/.test(SOURCE_TEXT), '不该动态造 style 元素（树内渲染就行）')
  assert.equal(mountedStyles().length, 0, '不该再往 document.head 挂样式')
})
check('按钮内联兜底 border:none（样式表失效时不露浏览器默认黑框）', () => {
  const button = find(render(true), (node) => node.props?.className === 'sop-btn')
  assert.ok(button !== undefined, '没找到按钮')
  assert.equal(button.props.style?.border, 'none')
})
check('图标自带内在尺寸，不依赖 CSS 生效时机', () => {
  // 假 React 不展开函数组件：找出函数节点并调用它，才能看到真实的 svg。
  const svg = findAll(render(true), (node) => typeof node.type === 'function')
    .map((node) => {
      try {
        return node.type(node.props)
      } catch {
        return undefined
      }
    })
    .find((output) => output?.type === 'svg')
  assert.ok(svg !== undefined, '没找到图标')
  assert.equal(svg.props.width, 14)
  assert.equal(svg.props.height, 14)
  assert.equal(svg.props.viewBox, '0 0 16 16')
})

console.log('\n[4] 打开账本')
const closedButton = find(closed, (node) => node.props.className === 'sop-btn')
closedButton.props.onClick()
await tick()
await tick()
const openTree = render(true)
const panel = find(openTree, (node) => node.props['data-space-optimizer'] === 'panel')

check('面板出现了', () => assert.ok(panel !== undefined))
check('标题与副标题是本地化文本', () => {
  assert.ok(findAll(panel, (node) => node.children.includes(ZH.title)).length > 0)
  assert.ok(findAll(panel, (node) => node.children.includes(ZH.subtitle)).length > 0)
})
const isRow = (node) => typeof node.props?.className === 'string' && /^sop-row( |$)/.test(node.props.className)
const rowTexts = (tree) =>
  findAll(tree, isRow).map((row) => {
    const names = findAll(row, (node) => node.props?.className === 'sop-name').map((node) => node.children.join(''))
    const occ = findAll(row, (node) => node.props?.className === 'sop-occ').map((node) => node.children.join(''))
    return { name: names.join(''), occ: occ.join('') }
  })
check('四个任务都列出来了（含子任务）', () => {
  const rows = rowTexts(panel).map((row) => row.name)
  for (const name of ['当前这个任务', '后台跑着的任务', '已经做完的任务', SUB]) {
    assert.ok(rows.includes(name), '缺行：' + name)
  }
})
check('当前任务带「当前」标签且排在最前', () => {
  const tags = findAll(panel, (node) => node.props?.className === 'sop-tag').map((node) => node.children.join(''))
  assert.ok(tags.includes(ZH.current))
  assert.equal(rowTexts(panel)[0].name, '当前这个任务')
})
check('每个任务都显示「占用」字节数', () => {
  const occ = rowTexts(panel).map((row) => row.occ)
  assert.ok(
    occ.filter((value) => value.startsWith(ZH.occupied)).length >= 4,
    '行占用列：' + JSON.stringify(occ),
  )
})
check('子任务显示占用但标为无可优化项', () => {
  const rows = findAll(panel, isRow)
  const subRow = rows.find((row) => findAll(row, (node) => node.props?.className === 'sop-name').some((node) => node.children.includes(SUB)))
  const text = JSON.stringify(subRow)
  assert.ok(text.includes(ZH.noReclaim), '子任务行应写明无可优化项')
})
check('无主垃圾四个类别都在，被屏蔽的类别显示原因', () => {
  const names = findAll(panel, (node) => node.props?.className === 'sop-name').map((node) => node.children.join(''))
  for (const key of ['cat.market-cache', 'cat.dead-temp', 'cat.projection-orphan', 'cat.attachment-orphan']) {
    assert.ok(names.includes(ZH[key]), '缺类别：' + ZH[key])
  }
  assert.ok(JSON.stringify(panel).includes('会话 x 的日志无法读取'))
})
check('明细里说明了"还太新，保留"的跳过项', () => {
  assert.ok(JSON.stringify(panel).includes('还太新，保留'))
})

console.log('\n[5] 默认勾选策略')
const checkboxes = findAll(panel, (node) => node.type === 'input' && node.props.type === 'checkbox')
check('总共 8 个复选框（4 任务 + 4 类别）', () => assert.equal(checkboxes.length, 8))
check('任务级默认不勾（清理 spill 要用户点头）', () => {
  const bySession = [
    { id: CURRENT, index: 0 },
    { id: RUNNING, index: 1 },
    { id: DONE, index: 2 },
    { id: SUB, index: 3 },
  ]
  for (const entry of bySession) {
    assert.equal(checkboxes[entry.index].props.checked, false, entry.id + ' 不该默认勾上')
  }
})
check('无主垃圾默认全勾（被屏蔽的类别除外）', () => {
  assert.equal(checkboxes[4].props.checked, true, '市场缓存应默认勾')
  assert.equal(checkboxes[5].props.checked, true, '无主临时文件应默认勾')
  assert.equal(checkboxes[6].props.disabled, true, '失效投影缓存无可回收项，应禁用')
  assert.equal(checkboxes[7].props.disabled, true, '被屏蔽的附件类别应禁用')
})
check('运行中的任务不可勾选', () => {
  assert.equal(checkboxes[0].props.disabled, true, '当前任务在跑，应禁用')
  assert.equal(checkboxes[1].props.disabled, true, '后台任务在跑，应禁用')
  assert.equal(checkboxes[2].props.disabled, false, '做完的任务可以勾')
})
check('底部显示已选数量与可释放量', () => {
  const pick = findAll(panel, (node) => node.props?.className === 'sop-pick').map((node) => node.children.join(''))
  assert.equal(pick.length, 1)
  assert.ok(pick[0].includes('3 ' + ZH.items), '已选三项：' + pick[0])
  assert.ok(pick[0].includes('9.0 MB'), '可释放 9 MB：' + pick[0])
})

console.log('\n[6] 确认优化：请求体只含被勾选的 targetId')
const releaseButton = findAll(panel, (node) => node.props?.className === 'sop-primary').at(-1)
check('按钮上写着要释放多少', () => {
  assert.ok(releaseButton.children.join('').includes('9.0 MB'), releaseButton.children.join(''))
  assert.equal(releaseButton.props.disabled, false)
})
const before = requests.length
releaseButton.props.onClick()
await tick()
await tick()
check('发的是一个 POST，且只有一次', () => {
  assert.equal(requests.length, before + 1)
  const call = requests.at(-1)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.url, '/space-optimizer/reclaim')
})
check('带上防跨源的自定义头', () => {
  assert.equal(requests.at(-1).init.headers['x-space-optimizer'], '1')
})
check('请求体 = 三个无主垃圾 targetId，不含任何任务级 targetId', () => {
  const body = JSON.parse(requests.at(-1).init.body)
  assert.deepEqual(body.targets.sort(), ['junk-market', 'junk-temp-a', 'junk-temp-b'])
  for (const forbidden of ['cur-spill', 'run-spill', 'done-v3']) {
    assert.ok(!body.targets.includes(forbidden), '不该包含任务级目标 ' + forbidden)
  }
})
check('回收结果渲染成"已释放"汇总', () => {
  const tree = render(true)
  const text = JSON.stringify(tree)
  assert.ok(text.includes(ZH.freed), '应有已释放文案')
  assert.ok(text.includes('9.0 MB'), '应显示释放量')
})

// 手动勾一个任务级项目，再确认请求体确实会带上它。
console.log('\n[7] 勾上任务级项目后请求体带上它')
const seenBefore = requests.length
// 重新打开面板（上一轮已进入 done 状态，关掉重开能拿到全新的账本状态）。
{
  const tree = render(true)
  find(tree, (node) => node.props.className === 'sop-btn').props.onClick()
}
await tick()
await tick()
const reopened = render(true)
const boxes = findAll(reopened, (node) => node.type === 'input' && node.props.type === 'checkbox')
check('重开后仍是 8 个复选框，任务级默认仍不勾', () => {
  assert.equal(boxes.length, 8)
  assert.equal(boxes[2].props.checked, false)
})
boxes[2].props.onChange()
const afterPick = render(true)
const release = findAll(afterPick, (node) => node.props?.className === 'sop-primary').at(-1)
release.props.onClick()
await tick()
await tick()
check('请求体含勾选的任务级 targetId，同时保留无主垃圾', () => {
  assert.equal(requests.length, seenBefore + 2, '打开一次 + 回收一次')
  const body = JSON.parse(requests.at(-1).init.body)
  assert.ok(body.targets.includes('done-v3'), '应包含勾选的任务级目标：' + JSON.stringify(body.targets))
  assert.ok(body.targets.includes('junk-market'), '无主垃圾仍在：' + JSON.stringify(body.targets))
  assert.ok(!body.targets.includes('cur-spill'), '没勾的当前任务不该被带上')
  assert.ok(!body.targets.includes('run-spill'), '没勾的运行中任务不该被带上')
})

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[8] 协议异常：不许崩面板')
// 回收应答缺 result（版本错配 / 代理截断）：应显示错误文案，而不是读 undefined 崩掉。
{
  reclaimOverride = { ok: true }
  const tree = render(true)
  find(tree, (node) => node.props.className === 'sop-btn').props.onClick()
  await tick()
  await tick()
  const opened = render(true)
  findAll(opened, (node) => node.props?.className === 'sop-primary').at(-1).props.onClick()
  await tick()
  await tick()
  let rendered
  let threw = null
  try {
    rendered = render(true)
  } catch (error) {
    threw = error
  }
  check('回收应答缺 result 时显示错误而不是抛异常', () => {
    assert.equal(threw, null, '不该抛异常：' + String(threw?.message))
    assert.ok(JSON.stringify(rendered).includes(ZH.failed), '应显示失败文案')
  })
  check('缺 result 时不显示"已释放"汇总', () => {
    assert.ok(!JSON.stringify(rendered).includes(ZH.freed), '不该出现已释放文案')
  })
  reclaimOverride = null
}
// 账本应答形状不对：同样只报错。
{
  ledgerOverride = { ok: true }
  const tree = render(true)
  find(tree, (node) => node.props.className === 'sop-btn').props.onClick()
  await tick()
  await tick()
  let threw = null
  try {
    render(true)
  } catch (error) {
    threw = error
  }
  check('账本应答形状不对时报错而不是崩溃', () => assert.equal(threw, null, '不该抛异常：' + String(threw?.message)))
  ledgerOverride = null
}

console.log('\n[9] 字段缺失时自己算，不许把 8 MB 显示成 0')
{
  // 造一份"Host 没给汇总字段"的账本：组件应从条目累加出来。
  const bare = JSON.parse(JSON.stringify(ledger.ledger))
  for (const category of bare.junk) {
    delete category.reclaimableBytes
    delete category.reclaimableFiles
  }
  for (const session of bare.sessions) {
    delete session.reclaimableBytes
    delete session.spillBytes
    delete session.supersededBytes
    delete session.ownedBytes
  }
  ledgerOverride = { ok: true, ledger: bare }
  const tree = render(true)
  find(tree, (node) => node.props.className === 'sop-btn').props.onClick()
  await tick()
  await tick()
  const panel = find(render(true), (node) => node.props['data-space-optimizer'] === 'panel')
  check('类别体积从条目累加出来', () => {
    const occ = findAll(panel, (node) => node.props?.className === 'sop-occ').map((node) => node.children.join(''))
    assert.ok(occ.includes('8.0 MB'), '市场缓存应显示 8.0 MB，实际：' + JSON.stringify(occ))
  })
  check('任务的可优化量也从条目累加出来', () => {
    // 夹具里 run-spill = 300000 字节 —— 删掉 reclaimableBytes 后应当仍能算出来。
    assert.ok(
      JSON.stringify(panel).includes('293.0 KB'),
      '「后台跑着的任务」应显示可优化 293.0 KB（由 spillItems 累加）',
    )
  })
  ledgerOverride = null
}

console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`)
  process.exit(0)
}
console.log(`${passed} 项通过，${failures.length} 项失败：`)
for (const failure of failures) console.log('  - ' + failure.name + ': ' + failure.message)
process.exit(1)
