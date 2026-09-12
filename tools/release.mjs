// release.mjs — 一键发布：刷新资源 → 构建 NSIS 安装包 → 创建 GitHub Release 并上传产物
// electron-updater 按 tag + latest.yml 自动更新，产物三件套缺一不可：
//   dshl-<version>.exe / dshl-<version>.exe.blockmap / latest.yml
//
// 前置：
//   1. git 工作区干净，且已 git push origin main（tag 要指向已推送的提交）
//   2. 安装并登录 GitHub CLI：winget install GitHub.cli && gh auth login
//
// 用法：
//   npm run release                                  —— 说明自动取"上一 tag 以来的提交列表"
//   npm run release "v1.0.7 更新内容：\n- 第一条\n- 第二条"  —— 字面 \n 表示换行（真实换行会被批处理截断）
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = 'v' + version
const exe = `dshl-${version}.exe`
const exePath = join(root, 'dist', exe)
const blockmapPath = exePath + '.blockmap'
const latestYml = join(root, 'dist', 'latest.yml')

// 说明：命令行参数里请用字面 \n 表示换行（真实换行会被 npm/cmd 批处理在传递时截断）。
// 发布说明必须遵守 docs/release-notes-style.md：版本头只写「版本号 — 日期」，
// 正文按 新增/优化/调整/修复/移除 分组、每条一行、动词开头、只讲用户可感知的变化。
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function header() {
  return `## ${tag} — ${today()}`
}

// 兜底：没给说明时，按提交类型分组生成（feat→新增 / perf→优化 / refactor→调整 / fix→修复），
// chore/docs/test 等不面向用户的提交直接跳过，避免把内部提交写进发布说明。
function notesFromCommits() {
  try {
    const prev = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' }).trim()
    const log = execFileSync('git', ['log', `${prev}..HEAD`, '--pretty=format:%s'], { cwd: root, encoding: 'utf8' }).trim()
    const groups = { 新增: [], 优化: [], 调整: [], 修复: [] }
    for (const line of log.split('\n')) {
      const m = /^(feat|fix|perf|refactor|style|chore|docs|test|build|ci)\b[:\s]*(.*)$/i.exec(line.trim())
      const body = (m ? m[2] : line).trim()
      if (!body) continue
      const kind = (m ? m[1] : '').toLowerCase()
      const bucket = kind === 'feat' ? '新增' : kind === 'fix' ? '修复' : kind === 'perf' ? '优化' : kind === 'refactor' ? '调整' : ''
      if (!bucket) continue
      groups[bucket].push('- ' + body)
    }
    const parts = []
    for (const k of ['新增', '优化', '调整', '修复']) {
      if (groups[k].length) parts.push(`**${k}**\n${groups[k].join('\n')}`)
    }
    return parts.length ? parts.join('\n\n') : '- 维护性更新'
  } catch { return '- 维护性更新' }
}

const rawNotes = process.argv.slice(2).join(' ').trim().replace(/\\n/g, '\n')
const body = rawNotes || notesFromCommits()
const notes = `${header()}\n\n${body}\n`
console.log('--- 发布说明 ---\n' + notes + '----------------')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(cmd, args) {
  console.log('> ' + cmd + ' ' + args.join(' '))
  // Windows：仅 .cmd 批处理经 shell 执行（无法被 CreateProcess 直接 spawn，spawnSync EINVAL）；
  // 其他命令（node.exe 等含空格路径）必须 shell:false，否则 cmd 会把 "C:\Program Files" 按空格拆断
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' && /\.cmd$/i.test(cmd) })
}

// 捕获 stdout 的命令；非零退出/不存在 → null（注意 stdio 不可用 ignore，成功也返回 null）
function tryOut(cmd, args) {
  try { return execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }) } catch { return null }
}

// ---------- 1. 前置检查 ----------
if (tryOut('gh', ['--version']) === null) {
  console.error('未找到 GitHub CLI。请先执行：winget install GitHub.cli 然后 gh auth login')
  process.exit(1)
}
const dirty = (tryOut('git', ['status', '--porcelain']) || '').trim()
if (dirty) {
  console.error('工作区有未提交改动，请先提交并推送后再发布：\n' + dirty)
  process.exit(1)
}
const unpushed = (tryOut('git', ['log', 'origin/main..HEAD', '--oneline']) || '').trim()
if (unpushed) {
  console.error('本地有未推送提交，请先执行 git push origin main：\n' + unpushed)
  process.exit(1)
}
const existing = tryOut('gh', ['release', 'view', tag])
if (existing !== null) {
  console.error(`Release ${tag} 已存在：https://github.com/IMHaoyan/deepseek-harness-launcher/releases/tag/${tag}`)
  console.error('如需重新发布请先删除旧 Release（或 bump 版本号）。')
  process.exit(1)
}

// ---------- 2. 构建（内置 Node 发行包 + wwwroot 资源 + NSIS 安装包） ----------
// 先跑单测与打包前校验（require 闭包 / wwwroot 同步 / extraResources 源目录），任一失败即中止，
// 避免把降级包（缺内置 Node、缺面板产物）发出去。可用 DSHL_SKIP_PRECHECK=1 跳过。
if (process.env.DSHL_SKIP_PRECHECK === '1') {
  console.log('跳过发布前检查（DSHL_SKIP_PRECHECK=1）')
} else {
  run(npm, ['test'])
  run(npm, ['run', 'verify'])
}
run(process.execPath, ['tools/fetch-node-dist.mjs'])
run(npm, ['run', 'build:assets'])
run(npm, ['run', 'dist:win'])

// ---------- 3. 产物校验 ----------
for (const f of [exePath, blockmapPath, latestYml]) {
  if (!existsSync(f)) { console.error('产物缺失：' + f); process.exit(1) }
}

// ---------- 4. 创建 Release 并上传（说明经 --notes-file 传文件，避免换行/引号被 shell 拆散） ----------
const notesFile = join(root, 'dist', '.release-notes.md')
writeFileSync(notesFile, notes, 'utf8')
// 预发布号（含 '-'，如 1.2.1-rc.1）必须发成 GitHub prerelease 且不占用 Latest：
// 否则正式用户（updater.js 里 allowPrerelease=false）会把尚未验证的版本当成正式更新拉走。
const prereleaseArgs = version.includes('-') ? ['--prerelease', '--latest=false'] : []
try {
  run('gh', ['release', 'create', tag, exePath, blockmapPath, latestYml, '--title', tag, '--notes-file', notesFile, ...prereleaseArgs])
} finally {
  try { unlinkSync(notesFile) } catch { /* noop */ }
}
console.log(`发布完成：https://github.com/IMHaoyan/deepseek-harness-launcher/releases/tag/${tag}`)
console.log(version.includes('-')
  ? '这是预发布版本（GitHub prerelease，不占 Latest）：正式版用户不会收到它，只有手动安装的机器会用它。'
  : '已安装旧版本的用户将收到自动更新（依据 latest.yml）。')
