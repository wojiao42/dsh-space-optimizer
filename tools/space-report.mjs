#!/usr/bin/env node
/**
 * 命令行账本：不开界面也能看清空间去哪了。
 *
 *   node tools/space-report.mjs          # 人类的表格
 *   node tools/space-report.mjs --json   # 原始账本（给脚本吃）
 *
 * 只读——这个脚本永远不会删东西。要回收请走插件面板（它要求逐项确认）。
 */

import { scan } from '../lib/space.js'

const asJson = process.argv.includes('--json')
const ledger = scan(
  process.argv.includes('--home') ? { home: process.argv[process.argv.indexOf('--home') + 1] } : {},
)

const fmt = (bytes) => {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

if (asJson) {
  console.log(JSON.stringify(ledger, null, 2))
  process.exit(0)
}

const totals = ledger.totals
console.log('DSH_HOME :', ledger.home)
console.log('临时目录 :', ledger.tempDir)
console.log('')
console.log('Harness 数据合计 :', fmt(totals.sessions + totals.attachments + totals.junk))
console.log('  任务占用       :', fmt(totals.sessions), `(${totals.sessionCount} 个任务，日志 ${fmt(totals.sessionLogs)})`)
console.log('  附件对象       :', fmt(totals.attachments), totals.attachmentsComplete ? '' : '(引用统计不完整)')
console.log('  无主垃圾       :', fmt(totals.junk))
console.log('')
console.log('可优化合计 :', fmt(totals.reclaimable), `= 任务级 ${fmt(totals.sessionReclaimable)} + 无主垃圾 ${fmt(totals.junkReclaimable)}`)
console.log('')
console.log('═══ 每个任务 ═══')
console.log(
  '  ' + '任务/会话 id'.padEnd(46) + '占用'.padStart(10) + '日志'.padStart(10) +
  '临时'.padStart(10) + '可优化'.padStart(10) + '引用附件'.padStart(12),
)
for (const session of ledger.sessions) {
  const label = (session.origin === 'subagent' ? '└ ' : '  ') + session.id.slice(0, 34)
  const attachments =
    session.attachmentBytes === 0
      ? '—'
      : fmt(session.attachmentBytes) +
        (session.attachmentSharedBytes > 0 ? `(共享 ${fmt(session.attachmentSharedBytes)})` : '')
  console.log(
    '  ' +
      label.padEnd(46) +
      fmt(session.ownedBytes).padStart(10) +
      fmt(session.logBytes).padStart(10) +
      fmt(session.spillBytes).padStart(10) +
      fmt(session.reclaimableBytes).padStart(10) +
      attachments.padStart(12),
  )
}
console.log('')
console.log('注 : 「占用」是任务独占的字节，相加不会重复；附件按引用归属，共享的会在多行出现但只算一次。')
console.log('')
console.log('═══ 无主垃圾 ═══')
for (const category of ledger.junk) {
  console.log(
    '  ' + category.title.padEnd(20) + fmt(category.reclaimableBytes).padStart(10),
    `${category.items.length} 项`,
    category.blocked === undefined ? '' : ' [已跳过: ' + category.blocked + ']',
  )
  for (const item of category.items) {
    console.log(
      '      ' + (item.reclaimable ? '可删' : '保留') + '  ' + fmt(item.bytes).padStart(10) + '  ' + (item.label ?? item.path) +
        (item.note === undefined ? '' : '  — ' + item.note),
    )
  }
}
console.log('')
console.log('说明 :', ledger.kept)
