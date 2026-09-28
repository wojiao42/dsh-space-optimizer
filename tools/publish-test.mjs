#!/usr/bin/env node
/**
 * 发布脚本的离线断言：纯函数部分（许可证文本、收录 YAML、仓库年龄门槛、令牌解析）。
 *
 *   node tools/publish-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { CATEGORY, humanWait, licenseText, readToken, repoAgeOk, submissionYaml } from './publish.mjs'

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

console.log('\n[1] MIT 许可证文本')
check('版权行含年份与署名', () => {
  const text = licenseText('octocat', 2026)
  assert.ok(text.startsWith('MIT License\n'))
  assert.ok(text.includes('Copyright (c) 2026 octocat'))
  assert.ok(text.includes('THE SOFTWARE IS PROVIDED "AS IS"'))
})
check('年份缺省为当前年', () => {
  assert.ok(licenseText('octocat').includes(`Copyright (c) ${new Date().getFullYear()} octocat`))
})

console.log('\n[2] 收录条目 YAML')
const yaml = submissionYaml({
  url: 'https://github.com/octocat/dsh-space-optimizer',
  name: 'octocat/dsh-space-optimizer',
  en: 'Ledger: per-task disk usage.',
  zh: '侧栏里的每个任务磁盘占用账本。',
})
check('含 url / name / category / 双语描述', () => {
  assert.ok(yaml.includes('url: https://github.com/octocat/dsh-space-optimizer'))
  assert.ok(yaml.includes('name: octocat/dsh-space-optimizer'))
  assert.ok(yaml.includes(`category: ${CATEGORY}`))
  assert.ok(yaml.includes('description:'))
  assert.ok(yaml.includes('zh: 侧栏里的每个任务磁盘占用账本。'))
})
check('英文描述里的冒号加空格被引号包住（否则 YAML 解析失败）', () => {
  assert.ok(yaml.includes("en: 'Ledger: per-task disk usage.'"), yaml)
})
check('不含冒号的描述不加多余引号', () => {
  const plain = submissionYaml({ url: 'u', name: 'n', en: 'No colon here.', zh: '无冒号。' })
  assert.ok(plain.includes('en: No colon here.'))
})
check('描述里的单引号被正确转义', () => {
  const quoted = submissionYaml({ url: 'u', name: 'n', en: "It's a ledger: yes.", zh: 'x' })
  assert.ok(quoted.includes("en: 'It''s a ledger: yes.'"), quoted)
})
check('YAML 以换行结尾', () => assert.ok(yaml.endsWith('\n')))

console.log('\n[3] 仓库年龄门槛（收录 CI 的硬性要求）')
check('刚建的仓库：不合格，且能算出还差多久', () => {
  const now = Date.parse('2026-09-28T12:00:00Z')
  const result = repoAgeOk('2026-09-28T06:00:00Z', now)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'too-young')
  assert.equal(result.waitMs, 18 * 3600 * 1000)
})
check('满 24 小时：合格', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  assert.equal(repoAgeOk('2026-09-28T12:00:00Z', now).ok, true)
})
check('刚满 24 小时整：合格（边界）', () => {
  const created = '2026-09-28T12:00:00Z'
  assert.equal(repoAgeOk(created, Date.parse(created) + 24 * 3600 * 1000).ok, true)
  assert.equal(repoAgeOk(created, Date.parse(created) + 24 * 3600 * 1000 - 1).ok, false)
})
check('时间戳不可解析：不合格且不报假等待时间', () => {
  const result = repoAgeOk('not-a-date')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'creation-time-unparsable')
  assert.equal(result.waitMs, null)
})
check('等待时长说成人话', () => {
  assert.equal(humanWait(18 * 3600 * 1000), '18 小时 0 分钟')
  assert.equal(humanWait(45 * 60 * 1000), '45 分钟')
  assert.equal(humanWait(null), '未知')
})

console.log('\n[4] 令牌解析')
check('环境变量优先于文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-token-'))
  fs.writeFileSync(path.join(dir, '.gh-token'), 'from-file\n')
  const saved = process.env.GH_TOKEN
  try {
    process.env.GH_TOKEN = 'from-env'
    const resolved = readToken(dir)
    assert.equal(resolved.token, 'from-env')
    assert.equal(resolved.source, 'env')
    delete process.env.GH_TOKEN
    const fromFile = readToken(dir)
    assert.equal(fromFile.token, 'from-file')
    assert.equal(fromFile.source, path.join(dir, '.gh-token'))
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = saved
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
check('都没有时返回 undefined（不抛异常）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-token-'))
  const saved = process.env.GH_TOKEN
  const savedGithub = process.env.GITHUB_TOKEN
  try {
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    assert.equal(readToken(dir), undefined)
  } finally {
    if (saved !== undefined) process.env.GH_TOKEN = saved
    if (savedGithub !== undefined) process.env.GITHUB_TOKEN = savedGithub
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`)
  process.exit(0)
}
console.log(`${passed} 项通过，${failures.length} 项失败：`)
for (const failure of failures) console.log('  - ' + failure.name + ': ' + failure.message)
process.exit(1)
