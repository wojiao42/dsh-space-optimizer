#!/usr/bin/env node
/**
 * 空间账本的离线断言：假造一个 DSH_HOME + 临时目录，验证账目算得对、
 * 而且回收**只删该删的**。
 *
 *   node tools/space-optimizer-test.mjs
 *
 * 退出码 0 表示全部通过。不需要浏览器、不需要运行中的 Harness。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { reclaim, scan } from '../lib/space.js'

const DAY = 24 * 60 * 60 * 1000
let passed = 0
const failures = []

/** 跑一条断言，失败不中断，最后统一汇报。 */
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

const digest = (seed) => crypto.createHash('sha256').update(seed).digest('hex')
const spillHash = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)

/** 写一份合法会话日志：header 帧 + 事件帧，模拟官方的多帧拼接。 */
function writeLog(file, header, events) {
  const frames = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))].map((line) =>
    zlib.zstdCompressSync(Buffer.from(line + '\n')),
  )
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat(frames))
}

/** 把 mtime 拨到 n 天前。 */
function age(target, days) {
  const when = new Date(Date.now() - days * DAY)
  fs.utimesSync(target, when, when)
}

/** 造夹具。`withBroken` 会额外放一个日志解不开的会话，用来验证保守规则。 */
function buildFixture(root, { withBroken = false } = {}) {
  const home = path.join(root, 'home')
  const tempDir = path.join(root, 'tmp')
  const project = path.join(home, 'sessions', '--proj--')
  const attach = path.join(home, 'attachments', 'v1', 'objects')

  const LIVE = 'session-live-0001'
  const BROKEN = 'session-broken-0003'
  const GONE = 'session-gone-9999'
  const digestLive = digest('image-live')
  const digestOrphan = digest('image-orphan')

  // 活会话：合法日志 + 引用了 digestLive；另有一份被取代的 v3 日志。
  writeLog(
    path.join(project, LIVE, 'session.v4.jsonl.zstd'),
    { type: 'session', version: 4, id: LIVE, createdAt: 1, cwd: 'X:\\proj' },
    [
      { type: 'user/message', seq: 0, time: 1, data: { turn: 0, step: 0, message: { role: 'user', content: 'hi' } } },
      {
        type: 'tool/result',
        seq: 1,
        time: 2,
        data: {
          turn: 0,
          step: 0,
          message: { role: 'tool', content: [{ type: 'text', text: 'image sha256:' + digestLive + ' stored' }] },
        },
      },
    ],
  )
  fs.writeFileSync(path.join(project, LIVE, 'session.v3.jsonl'), '{"type":"session","version":3,"id":"' + LIVE + '"}\n')

  // 坏会话：v4 帧根本解不开，所以它的 v3 不能被判定为"被取代"。
  if (withBroken) {
    fs.mkdirSync(path.join(project, BROKEN), { recursive: true })
    fs.writeFileSync(path.join(project, BROKEN, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame at all'))
    fs.writeFileSync(path.join(project, BROKEN, 'session.v3.jsonl'), '{"type":"session","version":3,"id":"' + BROKEN + '"}\n')
  }

  // 附件：一个被引用、一个无主。
  for (const [prefix, item] of [
    [digestLive.slice(0, 2), digestLive],
    [digestOrphan.slice(0, 2), digestOrphan],
  ]) {
    const dir = path.join(attach, prefix)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, item), Buffer.alloc(1000, 7))
  }

  // 投影缓存：活的 + 失效的。
  const proj = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, LIVE + '.json'), '{"live":true}')
  fs.writeFileSync(path.join(proj, GONE + '.json'), '{"gone":true}')

  // 插件市场缓存：过期 + 新鲜。
  const market = path.join(home, 'plugin-market')
  fs.mkdirSync(market, { recursive: true })
  fs.writeFileSync(path.join(market, 'catalog.zh.json'), Buffer.alloc(5000, 1))
  fs.writeFileSync(path.join(market, 'stats.json'), '{"fresh":true}')

  // 临时目录。
  const spillRoot = path.join(tempDir, 'dsh-spill-aaa111')
  fs.mkdirSync(path.join(spillRoot, 'session-' + spillHash(LIVE)), { recursive: true })
  fs.writeFileSync(path.join(spillRoot, 'session-' + spillHash(LIVE), 'abc-output.txt'), Buffer.alloc(3000, 2))
  fs.mkdirSync(path.join(spillRoot, 'session-' + spillHash(GONE)), { recursive: true })
  fs.writeFileSync(path.join(spillRoot, 'session-' + spillHash(GONE), 'abc-output.txt'), Buffer.alloc(4000, 3))

  const inUseRoot = path.join(tempDir, 'dsh-subprocess-live01')
  fs.mkdirSync(inUseRoot, { recursive: true })
  fs.writeFileSync(path.join(inUseRoot, `dsh-subprocess-${process.pid}-1-aa-stdout.log`), Buffer.alloc(700, 4))

  const deadRoot = path.join(tempDir, 'dsh-subprocess-dead01')
  fs.mkdirSync(deadRoot, { recursive: true })
  fs.writeFileSync(path.join(deadRoot, 'dsh-subprocess-16416-1-bb-stdout.log'), Buffer.alloc(900, 5))

  const changesRoot = path.join(tempDir, 'dsh-workspace-changes-old01')
  fs.mkdirSync(path.join(changesRoot, 'captures'), { recursive: true })
  fs.writeFileSync(path.join(changesRoot, 'captures', 'aaa'), Buffer.alloc(600, 6))

  const freshRoot = path.join(tempDir, 'dsh-workspace-changes-new01')
  fs.mkdirSync(path.join(freshRoot, 'captures'), { recursive: true })
  fs.writeFileSync(path.join(freshRoot, 'captures', 'bbb'), Buffer.alloc(500, 7))

  const emptyRoot = path.join(tempDir, 'dsh-acl-locks')
  fs.mkdirSync(emptyRoot, { recursive: true })

  // 年龄：过期 / 新鲜。
  age(path.join(market, 'catalog.zh.json'), 10)
  age(path.join(spillRoot, 'session-' + spillHash(GONE), 'abc-output.txt'), 10)
  age(path.join(deadRoot, 'dsh-subprocess-16416-1-bb-stdout.log'), 10)
  age(path.join(deadRoot), 10)
  age(path.join(changesRoot, 'captures', 'aaa'), 10)
  age(path.join(changesRoot, 'captures'), 10)
  age(changesRoot, 10)

  return { home, tempDir, LIVE, BROKEN, GONE, digestLive, digestOrphan, spillRoot, inUseRoot, deadRoot, changesRoot, freshRoot, emptyRoot, project,
    liveLog: path.join(project, LIVE, 'session.v4.jsonl.zstd'),
    liveV3: path.join(project, LIVE, 'session.v3.jsonl'),
    brokenV3: path.join(project, BROKEN, 'session.v3.jsonl'),
    orphanAttachment: path.join(attach, digestOrphan.slice(0, 2), digestOrphan),
    liveAttachment: path.join(attach, digestLive.slice(0, 2), digestLive),
    liveProjection: path.join(proj, LIVE + '.json'),
    goneProjection: path.join(proj, GONE + '.json'),
    oldMarket: path.join(market, 'catalog.zh.json'),
    freshMarket: path.join(market, 'stats.json'),
  }
}

const optionsOf = (fixture) => ({ home: fixture.home, tempDir: fixture.tempDir, minIdleMs: 3600000, marketCacheMinAgeMs: 3600000, pid: process.pid })
const exists = (file) => fs.existsSync(file)
const sizeOf = (file) => (exists(file) ? fs.statSync(file).size : 0)

// ════════════════════════════════════════════════════════════════════════════
console.log('\n[1] 账目：每个任务占了多少')
const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-test-a-'))
const A = buildFixture(rootA)
const ledger = scan(optionsOf(A))

check('会话数 = 1（这个夹具只有活会话）', () => assert.equal(ledger.sessions.length, 1))
check('活会话的日志字节与磁盘一致', () => {
  const live = ledger.sessions.find((session) => session.id === A.LIVE)
  assert.equal(live.logBytes, sizeOf(A.liveLog))
  assert.equal(live.logUnreadable, false)
  assert.equal(live.cwd, 'X:\\proj')
})
check('任务「占用」= 日志 + 投影 + 可优化，不含共享附件', () => {
  const live = ledger.sessions.find((session) => session.id === A.LIVE)
  assert.equal(live.ownedBytes, live.logBytes + live.projectionBytes + live.reclaimableBytes)
})
check('活会话的可优化 = spill(3000) + 被取代的 v3', () => {
  const live = ledger.sessions.find((session) => session.id === A.LIVE)
  assert.equal(live.spillBytes, 3000)
  assert.ok(live.supersededBytes > 0)
  assert.equal(live.reclaimableBytes, live.spillBytes + live.supersededBytes)
})
check('spill 精确归属到活会话（而不是当成无主垃圾）', () => {
  const live = ledger.sessions.find((session) => session.id === A.LIVE)
  assert.equal(live.spillItems.length, 1)
  assert.match(live.spillItems[0].label, /session-/)
  const deadTemp = ledger.junk.find((category) => category.id === 'dead-temp')
  assert.ok(
    !deadTemp.items.some((item) => item.path.includes('session-' + spillHash(A.LIVE))),
    '活会话的 spill 不该出现在无主垃圾里',
  )
})

console.log('\n[2] 账目：无主垃圾')
check('会话已不存在的 spill 归入无主临时文件', () => {
  const deadTemp = ledger.junk.find((category) => category.id === 'dead-temp')
  const item = deadTemp.items.find((entry) => entry.path.includes('session-' + spillHash(A.GONE)))
  assert.ok(item !== undefined)
  assert.equal(item.reclaimable, true)
})
check('正在用的子进程日志不列为可回收', () => {
  const deadTemp = ledger.junk.find((category) => category.id === 'dead-temp')
  const item = deadTemp.items.find((entry) => entry.path.includes(`dsh-subprocess-${process.pid}-1-`))
  assert.equal(item.reclaimable, false)
  assert.equal(item.reason, 'in-use')
})
check('死进程的旧日志可回收', () => {
  const deadTemp = ledger.junk.find((category) => category.id === 'dead-temp')
  assert.equal(deadTemp.items.find((entry) => entry.path.includes('16416')).reclaimable, true)
})
check('空的临时根目录被记下来准备删掉', () => {
  assert.ok(ledger.emptyRoots.includes(A.emptyRoot))
})
check('新鲜的市场缓存不动、过期的可回收', () => {
  const market = ledger.junk.find((category) => category.id === 'market-cache')
  assert.equal(market.items.find((entry) => entry.path === A.oldMarket).reclaimable, true)
  assert.equal(market.items.find((entry) => entry.path === A.freshMarket).reclaimable, false)
})
check('失效投影缓存可回收、活会话的投影缓存只统计不回收', () => {
  const projection = ledger.junk.find((category) => category.id === 'projection-orphan')
  assert.equal(projection.items.length, 1)
  assert.equal(projection.items[0].path, A.goneProjection)
  const live = ledger.sessions.find((session) => session.id === A.LIVE)
  assert.ok(live.projectionBytes > 0)
  assert.equal(live.projectionItem.reclaimable, false)
})

console.log('\n[3] 账目：附件按引用归属')
check('被引用的附件算活着那个任务的，不进无主垃圾', () => {
  const junk = ledger.junk.find((category) => category.id === 'attachment-orphan')
  assert.ok(!junk.items.some((item) => item.path === A.liveAttachment))
  const live = ledger.sessions.find((session) => session.id === A.LIVE)
  assert.equal(live.attachmentExclusiveBytes, 1000)
})
check('没有任何会话引用的附件列为可回收', () => {
  const junk = ledger.junk.find((category) => category.id === 'attachment-orphan')
  const item = junk.items.find((entry) => entry.path === A.orphanAttachment)
  assert.equal(item.reclaimable, true)
})
check('附件总量只算一次，与逐任务归属相加无关', () => {
  assert.equal(ledger.totals.attachments, 2000)
})
check('合计 = 任务独占 + 附件对象 + 无主垃圾', () => {
  assert.equal(
    ledger.totals.sessions + ledger.totals.attachments + ledger.totals.junk,
    ledger.totals.sessions + ledger.totals.attachments + ledger.totals.junk,
  )
  assert.equal(ledger.totals.sessions, ledger.sessions.reduce((sum, session) => sum + session.ownedBytes, 0))
})

console.log('\n[4] 回收：只删我点名的')
const before = {
  liveLog: sizeOf(A.liveLog),
  liveV3: sizeOf(A.liveV3),
  liveAttachment: sizeOf(A.liveAttachment),
  liveProjection: sizeOf(A.liveProjection),
  freshMarket: sizeOf(A.freshMarket),
  inUse: sizeOf(path.join(A.inUseRoot, `dsh-subprocess-${process.pid}-1-aa-stdout.log`)),
  orphanAttachment: sizeOf(A.orphanAttachment),
  goneProjection: sizeOf(A.goneProjection),
  oldMarket: sizeOf(A.oldMarket),
}

// 只点三样：无主附件、失效投影缓存、过期市场缓存。
const attachmentJunk = ledger.junk.find((category) => category.id === 'attachment-orphan')
const pickedIds = [
  attachmentJunk.items.find((item) => item.reclaimable === true).targetId,
  ledger.junk.find((category) => category.id === 'projection-orphan').items[0].targetId,
  ledger.junk.find((category) => category.id === 'market-cache').items.find((item) => item.reclaimable).targetId,
]
const result = reclaim({ ...optionsOf(A), targets: pickedIds })

check('回收量 = 三个目标的字节和', () => {
  assert.equal(result.freedBytes, before.orphanAttachment + before.goneProjection + before.oldMarket)
  assert.equal(result.attempted, 3)
  assert.equal(result.stale, 0)
  assert.deepEqual(result.failures, [])
})
check('点名的三样确实没了', () => {
  assert.equal(exists(A.orphanAttachment), false, '无主附件应当被删')
  assert.equal(exists(A.goneProjection), false, '失效投影缓存应当被删')
  assert.equal(exists(A.oldMarket), false, '过期市场缓存应当被删')
})
check('没点名的原样都在', () => {
  assert.equal(sizeOf(A.liveLog), before.liveLog, '会话日志绝不能被碰')
  assert.equal(sizeOf(A.liveV3), before.liveV3, '被取代的旧日志这次没点名，要留着')
  assert.equal(sizeOf(A.liveAttachment), before.liveAttachment, '被引用的附件要留着')
  assert.equal(sizeOf(A.liveProjection), before.liveProjection, '活会话的投影缓存要留着')
  assert.equal(sizeOf(A.freshMarket), before.freshMarket, '新鲜的市场缓存要留着')
  assert.equal(sizeOf(path.join(A.inUseRoot, `dsh-subprocess-${process.pid}-1-aa-stdout.log`)), before.inUse, '在用的日志要留着')
})
check('无主附件已被回收，但被引用的附件还在', () => {
  const after = scan(optionsOf(A))
  const junk = after.junk.find((category) => category.id === 'attachment-orphan')
  assert.equal(junk.items.length, 0)
  assert.equal(after.totals.attachments, 1000)
})

console.log('\n[5] 回收：全选也绝不碰会话日志')
const allTargets = []
{
  const current = scan(optionsOf(A))
  for (const session of current.sessions) {
    for (const item of [...session.supersededItems, ...session.spillItems]) {
      if (item.reclaimable) allTargets.push(item.targetId)
    }
  }
  for (const category of current.junk) {
    if (category.blocked !== undefined) continue
    for (const item of category.items) if (item.reclaimable) allTargets.push(item.targetId)
  }
}
const everything = reclaim({ ...optionsOf(A), targets: allTargets })
check('全选之后，会话日志与活附件仍然完好', () => {
  assert.equal(sizeOf(A.liveLog), before.liveLog, '会话日志绝不能被碰')
  assert.equal(sizeOf(A.liveAttachment), before.liveAttachment, '被引用的附件要留着')
  assert.equal(sizeOf(A.liveProjection), before.liveProjection, '活会话的投影缓存要留着')
})
check('全选回收到了内容（spill / 旧日志 / 死临时）', () => {
  assert.ok(everything.freedBytes > 3000, '期望释放量大于活会话的 spill：' + everything.freedBytes)
  assert.equal(exists(path.join(A.deadRoot, 'dsh-subprocess-16416-1-bb-stdout.log')), false, '死进程日志应当被删')
})
check('清空的临时根目录被收走，仍在用的根留着', () => {
  assert.equal(exists(A.deadRoot), false)
  assert.equal(exists(A.inUseRoot), true)
  assert.equal(exists(A.emptyRoot), false)
})
check('回收后账本几乎无可回收项（幂等）', () => {
  const after = scan(optionsOf(A))
  assert.equal(after.totals.reclaimable, 0)
})

console.log('\n[6] 回收：过期 id 与空选择')
check('认不出来的 targetId 一律忽略并回报', () => {
  const outcome = reclaim({ ...optionsOf(A), targets: ['deadbeefdeadbeef'] })
  assert.equal(outcome.freedBytes, 0)
  assert.equal(outcome.attempted, 0)
  assert.equal(outcome.stale, 1)
})
check('空 targets = 什么都不删', () => {
  const outcome = reclaim({ ...optionsOf(A), targets: [] })
  assert.equal(outcome.freedBytes, 0)
})

console.log('\n[7] 安全阀：有日志读不通时，一律保守')
const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-test-b-'))
// 夹具里额外有一个解不开的会话；再把活会话的日志也换成坏字节。
const B = buildFixture(rootB, { withBroken: true })
fs.writeFileSync(B.liveLog, Buffer.from('corrupted completely'))
const ledgerB = scan(optionsOf(B))
check('会话数 = 2（活会话 + 坏会话）', () => assert.equal(ledgerB.sessions.length, 2))
check('最新日志解不开时，旧 generation 不列为可回收', () => {
  for (const id of [B.LIVE, B.BROKEN]) {
    const session = ledgerB.sessions.find((entry) => entry.id === id)
    assert.equal(session.logUnreadable, true, id + ' 应当被判为不可读')
    assert.equal(session.supersededBytes, 0, id + ' 的旧日志不该被回收')
    assert.equal(session.supersededItems[0].reason, 'keeper-unreadable')
  }
})
check('附件类别被标记为不可信', () => {
  const junk = ledgerB.junk.find((category) => category.id === 'attachment-orphan')
  assert.ok(junk.blocked !== undefined)
  assert.equal(junk.reclaimableBytes, 0)
})
check('即使被全选，无主附件也不会被删', () => {
  const targets = []
  for (const category of ledgerB.junk) {
    if (category.blocked !== undefined) continue
    for (const item of category.items) if (item.reclaimable) targets.push(item.targetId)
  }
  for (const session of ledgerB.sessions) {
    for (const item of [...session.supersededItems, ...session.spillItems]) if (item.reclaimable) targets.push(item.targetId)
  }
  reclaim({ ...optionsOf(B), targets })
  assert.equal(exists(B.orphanAttachment), true, '证明不了无主就不能删')
  assert.equal(exists(B.liveAttachment), true)
})
check('坏日志不被当成可回收的历史 generation', () => {
  const broken = ledgerB.sessions.find((session) => session.id === B.BROKEN)
  assert.equal(broken.supersededBytes, 0)
})

// ════════════════════════════════════════════════════════════════════════════
for (const directory of [rootA, rootB]) {
  try {
    fs.rmSync(directory, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`)
  process.exit(0)
}
console.log(`${passed} 项通过，${failures.length} 项失败：`)
for (const failure of failures) console.log('  - ' + failure.name + ': ' + failure.message)
process.exit(1)
