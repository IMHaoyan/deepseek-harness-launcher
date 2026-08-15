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

// 说明：命令行参数里请用字面 \n 表示换行（真实换行会被 npm/cmd 批处理在传递时截断，导致 Release 说明只剩第一行）
function defaultNotes() {
  try {
    const prev = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' }).trim()
    const log = execFileSync('git', ['log', `${prev}..HEAD`, '--pretty=format:- %s'], { cwd: root, encoding: 'utf8' }).trim()
    return log ? `${tag} 更新内容：\n${log}` : tag
  } catch { return tag }
}
const notes = process.argv.slice(2).join(' ').trim().replace(/\\n/g, '\n') || defaultNotes()

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(cmd, args) {
  console.log('> ' + cmd + ' ' + args.join(' '))
  // Windows：.cmd 批处理无法被 CreateProcess 直接 spawn（spawnSync EINVAL），经 shell 执行
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32' })
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

// ---------- 2. 构建（wwwroot 资源 + NSIS 安装包） ----------
run(npm, ['run', 'build:assets'])
run(npm, ['run', 'dist:win'])

// ---------- 3. 产物校验 ----------
for (const f of [exePath, blockmapPath, latestYml]) {
  if (!existsSync(f)) { console.error('产物缺失：' + f); process.exit(1) }
}

// ---------- 4. 创建 Release 并上传（说明经 --notes-file 传文件，避免换行/引号被 shell 拆散） ----------
const notesFile = join(root, 'dist', '.release-notes.md')
writeFileSync(notesFile, notes, 'utf8')
try {
  run('gh', ['release', 'create', tag, exePath, blockmapPath, latestYml, '--title', tag, '--notes-file', notesFile])
} finally {
  try { unlinkSync(notesFile) } catch { /* noop */ }
}
console.log(`发布完成：https://github.com/IMHaoyan/deepseek-harness-launcher/releases/tag/${tag}`)
console.log('已安装旧版本的用户将收到自动更新（依据 latest.yml）。')
