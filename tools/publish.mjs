#!/usr/bin/env node
/**
 * 一条命令完成 GitHub 侧的发布流程。
 *
 *   node tools/publish.mjs --dry-run          # 只打印将要执行的命令，不碰任何东西
 *   node tools/publish.mjs                    # 建仓 + 推送 + 加 topic
 *   node tools/publish.mjs --pr               # 再提收录 PR（要求仓库创建满 1 天）
 *
 * 令牌来源（按顺序）：
 *   1. 环境变量 GH_TOKEN / GITHUB_TOKEN
 *   2. 工作区根的 .gh-token 文件（用完建议删掉）
 * 令牌只通过 stdin 交给 `gh auth login --with-token`，不进命令行参数、不进 git remote URL。
 *
 * 需要的令牌权限（经典 PAT）：`public_repo` + `read:user`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.resolve(HERE, '..')

/** 收录条目的分类（依据：同类插件 dsh-session-sweeper / dsh-session-delete 都在这里）。 */
export const CATEGORY = 'session'
export const AWESOME_REPO = 'awesome-dsh-plugin/awesome-dsh-plugin'

// ── 纯函数部分（可离线断言）────────────────────────────────────────────────

/** MIT 许可证文本。 */
export function licenseText(holder, year = new Date().getFullYear()) {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
}

/**
 * 收录条目 YAML。
 * 含英文冒号加空格的描述必须加引号，否则 YAML 会解析成嵌套键（contributing.md 明确警告过）。
 */
export function submissionYaml({ url, name, category = CATEGORY, en, zh }) {
  const quote = (value) => (/:\s/.test(value) ? `'${value.replace(/'/g, "''")}'` : value)
  return [
    `url: ${url}`,
    `name: ${name}`,
    `category: ${category}`,
    'description:',
    `  en: ${quote(en)}`,
    `  zh: ${quote(zh)}`,
    '',
  ].join('\n')
}

/** 仓库是否已经创建满 24 小时（收录 CI 的硬性要求）。 */
export function repoAgeOk(createdAt, now = Date.now()) {
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return { ok: false, reason: 'creation-time-unparsable', waitMs: null }
  const ageMs = now - created
  const DAY = 24 * 60 * 60 * 1000
  return { ok: ageMs >= DAY, reason: ageMs >= DAY ? null : 'too-young', waitMs: Math.max(0, DAY - ageMs) }
}

/** 把毫秒说成人话。 */
export function humanWait(ms) {
  if (ms === null || ms === undefined) return '未知'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.round((ms % 3_600_000) / 60_000)
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`
}

// ── 环境部分 ───────────────────────────────────────────────────────────────

/** 找到 gh：优先 PATH，其次便携安装位置。 */
export function findGh() {
  if (process.platform === 'win32') {
    const portable = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'gh', 'bin', 'gh.exe')
    if (fs.existsSync(portable)) return portable
  }
  try {
    const which = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['gh'], { encoding: 'utf8' })
    const first = which.split(/\r?\n/).find((line) => line.trim() !== '')
    if (first !== undefined) return first.trim()
  } catch {
    /* 没装 */
  }
  return undefined
}

/** 读令牌：环境变量优先，其次 .gh-token。 */
export function readToken(workspaceRoot) {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { token: fromEnv.trim(), source: 'env' }
  const file = path.join(workspaceRoot, '.gh-token')
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, 'utf8').trim()
    if (token !== '') return { token, source: file }
  }
  return undefined
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

function makeRunner(dryRun) {
  const log = []
  return {
    log,
    run(command, commandArgs, options = {}) {
      const shown = `${command} ${commandArgs.join(' ')}`
      log.push(shown)
      if (dryRun) {
        console.log(`  [dry-run] ${shown}`)
        return ''
      }
      return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: options.input === undefined ? 'pipe' : ['pipe', 'pipe', 'pipe'], ...options })
    },
  }
}

function usage() {
  console.log(`用法：
  node tools/publish.mjs [--dry-run] [--prepare-pr] [--pr] [--repo <名称>] [--owner <登录名>] [--email <邮箱>]

不传 --repo 时用 package.json 的 name。令牌取 GH_TOKEN 环境变量或工作区根的 .gh-token。
  --dry-run      只打印命令，不碰任何东西
  --prepare-pr   先推好 fork 与分支（不受"仓库满 1 天"限制）
  --pr           提收录 PR；会先校验 24 小时门槛，不满就直接拒绝并告诉你还差多久`)
}

async function main() {
  const dryRun = flag('--dry-run')
  const workspaceRoot = path.resolve(PLUGIN_ROOT, '..', '..')
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
  const repo = valueOf('--repo', manifest.name)
  const email = valueOf('--email', process.env.GIT_AUTHOR_EMAIL ?? '')

  if (!manifest.dsh?.bundle?.patch) {
    throw new Error('package.json 没有声明 dsh.bundle —— 收录 CI 会直接拒绝，先修这个')
  }

  const gh = findGh()
  if (gh === undefined) throw new Error('找不到 gh。装一个：https://github.com/cli/cli/releases')
  const resolved = readToken(workspaceRoot)
  if (resolved === undefined && !dryRun) {
    usage()
    throw new Error(
      '没有令牌。请二选一：\n' +
        '  A) 自己执行（令牌不进对话）：gh auth login --with-token\n' +
        '  B) 把经典 PAT（public_repo + read:user）写进 ' +
        path.join(workspaceRoot, '.gh-token') +
        '\n然后再跑一次本脚本。',
    )
  }

  const runner = makeRunner(dryRun)
  const env = { ...process.env }
  if (resolved !== undefined) {
    env.GH_TOKEN = resolved.token
    env.GITHUB_TOKEN = resolved.token
  }
  const ghRun = (ghArgs, options = {}) => runner.run(gh, ghArgs, { env, ...options })

  console.log('gh        :', gh)
  console.log('插件目录  :', PLUGIN_ROOT)
  console.log('目标仓库  :', repo)
  console.log('令牌来源  :', resolved === undefined ? '(dry-run 不需要)' : resolved.source === 'env' ? '环境变量' : resolved.source)
  console.log('模式      :', dryRun ? 'dry-run（不执行，只打印）' : '执行')
  console.log('')

  // 1. 不做 `gh auth login`：它强制要求 `repo` + `read:org` 这两个更大的权限，
  //    而建一个公开仓库只需要 `public_repo`。令牌经 GH_TOKEN 环境变量交给 gh，
  //    推送再用 GIT_CONFIG_* 注入 http 头（见第 5 步），全程最小权限。
  console.log('  认证方式：GH_TOKEN 环境变量（不做 gh auth login，避免索要 repo / read:org）')

  // 2. 读登录名
  let login = valueOf('--owner', '')
  if (login === '') {
    if (dryRun) {
      login = '<登录名>'
      console.log('  [dry-run] gh api user -q .login')
    } else {
      login = ghRun(['api', 'user', '-q', '.login']).trim()
      if (login === '') throw new Error('拿不到登录名，令牌可能缺 read:user 权限')
    }
  }
  console.log('登录名    :', login)

  // 3. 补 LICENSE 与 repository 字段（幂等：已存在就不覆盖）
  const licensePath = path.join(PLUGIN_ROOT, 'LICENSE')
  if (!fs.existsSync(licensePath) && login !== '<登录名>') {
    fs.writeFileSync(licensePath, licenseText(login))
    console.log('  已写入 LICENSE（MIT，版权行 = ' + login + '）')
  } else if (fs.existsSync(licensePath)) {
    console.log('  LICENSE 已存在，保持不动')
  }

  const repoUrl = `https://github.com/${login}/${repo}`
  const manifestPath = path.join(PLUGIN_ROOT, 'package.json')
  const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (current.repository === undefined && login !== '<登录名>') {
    current.repository = { type: 'git', url: `git+${repoUrl}.git` }
    fs.writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n')
    console.log('  已补 package.json 的 repository 字段')
  }

  // 4. git 初始化与首个提交
  const gitDir = path.join(PLUGIN_ROOT, '.git')
  const git = (gitArgs) => runner.run('git', ['-C', PLUGIN_ROOT, ...gitArgs])
  if (!fs.existsSync(gitDir)) {
    git(['init', '-b', 'main'])
    console.log('  git init -b main')
  }
  if (login !== '<登录名>') {
    git(['config', '--local', 'user.name', login])
    if (email !== '') git(['config', '--local', 'user.email', email])
  }
  const commitMessage = (isFirstCommit) =>
    isFirstCommit
      ? `feat: DSH 侧栏空间账本插件 ${manifest.name} v${manifest.version}`
      : `chore: 同步 ${manifest.name} v${manifest.version}`
  if (dryRun) {
    git(['add', '-A'])
    git(['commit', '-m', commitMessage(true)])
  } else {
    const porcelain = git(['status', '--porcelain']).trim()
    if (porcelain === '') {
      console.log('  工作区干净，无需提交')
    } else {
      let isFirstCommit = false
      try {
        git(['rev-parse', '--verify', 'HEAD'])
      } catch {
        isFirstCommit = true // HEAD 还不存在：这是仓库的第一个提交
      }
      git(['add', '-A'])
      git(['commit', '-m', commitMessage(isFirstCommit)])
      console.log('  已提交:', commitMessage(isFirstCommit))
    }
  }

  // 推送用的环境：令牌经 GIT_CONFIG_* 注入 http 头 —— 不进 argv、不进 remote URL、不落盘
  const authHeader =
    'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${resolved?.token ?? ''}`).toString('base64')
  const pushEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: authHeader,
  }

  // 5. 建仓 / 推送。幂等：origin 已指向目标仓库、且远端 main 与本地 HEAD 一致时跳过，
  //    这样日后专门跑 --pr 不会再把建仓/推送重放一遍、也不会打出吓人的"建仓失败"。
  let alreadyPublished = false
  if (!dryRun) {
    try {
      const remoteUrl = git(['remote', 'get-url', 'origin']).trim()
      const localHead = git(['rev-parse', 'HEAD']).trim()
      if (remoteUrl.includes(`${login}/${repo}`) && localHead !== '') {
        const listed = runner.run('git', ['-C', PLUGIN_ROOT, 'ls-remote', 'origin', 'refs/heads/main']).trim()
        const remoteHead = listed === '' ? '' : listed.split(/\s+/)[0]
        alreadyPublished = remoteHead === localHead
      }
    } catch {
      alreadyPublished = false
    }
  }
  if (alreadyPublished) {
    console.log('  仓库已发布，且远端 main 与本地 HEAD 一致 —— 跳过建仓与推送')
  } else {
    try {
      ghRun(['repo', 'create', `${login}/${repo}`, '--public', '--source', PLUGIN_ROOT, '--remote', 'origin'])
    } catch {
      console.log('  origin 已存在，改用现有远端')
      try {
        git(['remote', 'get-url', 'origin'])
      } catch {
        git(['remote', 'add', 'origin', `${repoUrl}.git`])
      }
    }
    runner.run('git', ['-C', PLUGIN_ROOT, 'push', '-u', 'origin', 'main'], { env: pushEnv })
    ghRun(['repo', 'edit', `${login}/${repo}`, '--add-topic', 'dsh-plugin', '--add-topic', 'deepseek-harness', '--add-topic', 'dsh'])
  }

  // 6. 生成收录条目
  const yaml = submissionYaml({
    url: repoUrl,
    name: `${login}/${repo}`,
    en: 'Per-task disk-space ledger in the sidebar with opt-in reclamation of unowned junk; session logs are never trimmed.',
    zh: '侧栏里的每个任务磁盘占用账本，可勾选回收无主垃圾；会话日志绝不被裁剪。',
  })
  const submissionDir = path.join(workspaceRoot, 'dist', 'awesome-submission')
  const submissionFile = path.join(submissionDir, `${login}__${repo}.yml`)
  if (dryRun) {
    console.log('  [dry-run] 将写入收录条目:', submissionFile)
    console.log('  ---- 条目内容 ----')
    console.log(
      yaml
        .trimEnd()
        .split('\n')
        .map((line) => '  | ' + line)
        .join('\n'),
    )
    console.log('  ------------------')
  } else {
    fs.mkdirSync(submissionDir, { recursive: true })
    fs.writeFileSync(submissionFile, yaml)
    console.log('  收录条目已生成:', submissionFile)
  }

  // 7. fork + 分支 + 条目（不依赖仓库年龄），以及可选的 PR（受"仓库满 1 天"约束）
  if (flag('--pr') || flag('--prepare-pr')) {
    const branch = `add-${repo}`
    const file = `${login}__${repo}.yml`
    const relPath = `data/plugins/${file}`

    if (flag('--pr') && !dryRun) {
      const createdAt = ghRun(['api', `repos/${login}/${repo}`, '-q', '.created_at']).trim()
      const age = repoAgeOk(createdAt)
      if (!age.ok) {
        console.log('')
        console.log(`  收录 PR 暂时提不了：仓库创建于 ${createdAt}，还差 ${humanWait(age.waitMs)} 才满 1 天。`)
        console.log('  （CI 会硬性校验这一条，现在提只会得到一个必红的 PR。）')
        console.log('  可以先跑 --prepare-pr 把 fork 与分支推好，到点只差一条 gh pr create。')
        console.log(`  到点后再跑：node tools/publish.mjs --pr`)
        if (!flag('--prepare-pr')) return
      }
    }

    // 幂等判断：fork 上这个分支里的条目内容是否已经和我们一致
    let branchReady = false
    if (!dryRun) {
      try {
        const raw = ghRun(['api', `repos/${login}/awesome-dsh-plugin/contents/${relPath}?ref=${branch}`])
        const parsed = JSON.parse(raw)
        const decoded = Buffer.from(String(parsed.content ?? '').replace(/\s/g, ''), 'base64').toString('utf8')
        branchReady = decoded === yaml
      } catch {
        branchReady = false
      }
    }

    if (dryRun) {
      console.log('  [dry-run] gh repo fork ' + AWESOME_REPO + ' --clone=false')
      console.log('  [dry-run] git clone --depth 1 https://github.com/' + login + '/awesome-dsh-plugin.git <tmp>')
      console.log('  [dry-run] 写入 ' + relPath)
      console.log('  [dry-run] git checkout -b ' + branch + ' && git add && git commit && git push')
      if (flag('--pr')) {
        console.log('  [dry-run] gh pr create --repo ' + AWESOME_REPO + ' --head ' + login + ':' + branch + ' --base <默认分支>')
      }
    } else if (branchReady) {
      console.log(`  fork 的分支 ${branch} 已存在且条目内容一致 —— 跳过提交与推送`)
    } else {
      try {
        ghRun(['repo', 'fork', AWESOME_REPO, '--clone=false'])
      } catch {
        console.log('  fork 已存在，直接复用')
      }
      const forkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-awesome-'))
      const forkUrl = `https://github.com/${login}/awesome-dsh-plugin.git`
      let cloned = false
      for (let attempt = 1; attempt <= 6 && !cloned; attempt++) {
        try {
          runner.run('git', ['clone', '--depth', '1', forkUrl, forkDir])
          cloned = true
        } catch {
          console.log(`  克隆失败，第 ${attempt} 次重试（新建 fork 可能需要几秒）`)
          await new Promise((resolve) => setTimeout(resolve, 4000))
        }
      }
      if (!cloned) throw new Error('克隆 fork 失败：' + forkUrl)

      fs.mkdirSync(path.join(forkDir, 'data', 'plugins'), { recursive: true })
      fs.writeFileSync(path.join(forkDir, relPath), yaml)
      const gitFork = (gitArgs, gitEnv) =>
        runner.run('git', ['-C', forkDir, ...gitArgs], gitEnv === undefined ? {} : { env: gitEnv })
      gitFork(['checkout', '-b', branch])
      gitFork(['add', relPath])
      gitFork(['commit', '-m', `Add ${repo}`])
      gitFork(['push', '-u', 'origin', branch], pushEnv)
      console.log(`  已推送分支：${login}:${branch}`)
    }

    if (flag('--pr') && !dryRun) {
      // `--head owner:branch` 不能省：这个进程的 cwd 是插件仓库而不是 fork，
      // gh 无法自行推断 PR 的头分支，会去用插件仓库的 remote 然后报错。
      const baseBranch = ghRun(['api', AWESOME_REPO, '-q', '.default_branch']).trim() || 'main'
      ghRun([
        'pr', 'create',
        '--repo', AWESOME_REPO,
        '--head', `${login}:${branch}`,
        '--base', baseBranch,
        '--title', `Add ${repo}`,
        '--body', `Adds ${repoUrl} under \`${CATEGORY}\`.`,
      ])
      console.log(`  PR 已创建（head: ${login}:${branch} → base: ${baseBranch}）`)
    }
  } else {
    console.log('')
    console.log('下一步（两选一）：')
    console.log('  node tools/publish.mjs --prepare-pr   # 先推好 fork 与分支（不受仓库年龄限制）')
    console.log('  node tools/publish.mjs --pr           # 仓库满 1 天后提收录 PR')
  }
}

// 只有直接运行时才跑主流程（被测试 import 时不跑）
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error('')
    console.error('失败：' + String(error?.message ?? error))
    process.exit(1)
  })
}
