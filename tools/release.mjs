// release.mjs — 一键发布：刷新资源 → 构建 NSIS 安装包 → 创建 GitHub Release 并上传产物
// electron-updater 按 tag + 渠道 yml 自动更新，产物三件套缺一不可：
//   dshl-<version>.exe / dshl-<version>.exe.blockmap / <渠道>.yml
//
// 渠道由**版本号**决定（唯一事实来源，避免把 alpha 包误发到正式线）：
//   x.y.z-alpha.N  → alpha 渠道：GitHub prerelease（不占 Latest）+ 上传 alpha.yml  → 只发给选了 alpha 的机器
//   x.y.z          → latest 渠道：GitHub 正式 Release + 上传 latest.yml              → 所有默认机器自动更新
// 日常开发默认发 alpha：把 package.json 版本号写成 x.y.z-alpha.N 再跑本脚本即可。
// electron-builder 也按版本号的预发布段命名 yml（alpha 段 → alpha.yml），所以两者天然对齐；
// 历史上用过的 -rc.N 会被 updater 当成「自定义渠道」而忽略，已停用（脚本会直接拒绝）。
//
// 前置：
//   1. git 工作区干净，且已 git push origin main（tag 要指向已推送的提交）
//   2. 安装并登录 GitHub CLI：winget install GitHub.cli && gh auth login
//
// 用法：
//   npm run release                                  —— 说明自动取"上一 tag 以来的提交列表"
//   npm run release "v1.0.7 更新内容：\n- 第一条\n- 第二条"  —— 字面 \n 表示换行（真实换行会被批处理截断）
//   npm run release -- --notes-file <文件路径>        —— 从文件读取说明（中文/多行/特殊字符最稳，推荐）
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
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

// ---------- 0. 渠道判定（版本号是唯一事实来源） ----------
const prereleaseTag = version.includes('-') ? version.slice(version.indexOf('-') + 1).split('.')[0] : ''
if (prereleaseTag && prereleaseTag !== 'alpha') {
  console.error(`版本号里的预发布段是 "${prereleaseTag}"，但预发布只支持 alpha 渠道。`)
  console.error('预发布包必须发成 GitHub prerelease 并带 alpha.yml，否则 updater 的渠道判定会错位。')
  console.error('请把 package.json 的版本号写成 x.y.z-alpha.N（例如 1.4.5-alpha.1）。')
  process.exit(1)
}
const channel = prereleaseTag === 'alpha' ? 'alpha' : 'latest'
// 日常开发默认发 alpha：正式版会让**所有**机器自动更新，所以必须显式确认一次（--stable），
// 免得版本号忘了写成 alpha 就直接把未验证的构建推给所有人。
if (channel === 'latest' && !process.argv.slice(2).includes('--stable')) {
  console.error(`当前版本号是正式版（${version}），会发到 latest 渠道，让所有机器自动更新。`)
  console.error('日常开发请把 package.json 的版本号写成 x.y.z-alpha.N（默认发 alpha 渠道）；')
  console.error('确实要发正式版请显式加 --stable（例如：npm run release -- --stable --notes-file notes.md）。')
  process.exit(1)
}
// electron-builder 按版本号的预发布段命名：alpha → dist/alpha.yml，正式版 → dist/latest.yml
const channelYml = join(root, 'dist', channel === 'latest' ? 'latest.yml' : `${channel}.yml`)

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

// 说明优先级：--notes-file 指向的文件 > 命令行字面文本 > **同一条 alpha 线的本地留档** > 按提交自动生成。
// 为什么优先文件：中文与多行说明经 npm/cmd 传递会被拆散或截断，走文件最稳。
const argv = process.argv.slice(2)
const notesFileArg = argv.findIndex((a) => a === '--notes-file' || a.startsWith('--notes-file='))
let rawNotes = ''
if (notesFileArg >= 0) {
  const inline = argv[notesFileArg].startsWith('--notes-file=') ? argv[notesFileArg].slice('--notes-file='.length) : ''
  const fileArg = inline || argv[notesFileArg + 1] || ''
  if (!fileArg) {
    console.error('--notes-file 需要一个文件路径')
    process.exit(1)
  }
  const filePath = join(root, fileArg)
  if (!existsSync(filePath)) {
    console.error('找不到说明文件：' + filePath)
    process.exit(1)
  }
  rawNotes = readFileSync(filePath, 'utf8').trim()
  if (!rawNotes) {
    console.error('说明文件是空的：' + filePath)
    process.exit(1)
  }
} else {
  rawNotes = argv.filter((a) => !a.startsWith('--')).join(' ').trim().replace(/\\n/g, '\n')
}

// ---------- alpha 与正式版的口径（约定见 docs/release-notes-style.md） ----------
// alpha：内容只进**本地留档**（.alpha-notes/ 是 gitignore 的：不发公告，也不进公开仓库），
//        GitHub Release 正文留一句占位；
// 正式版：才把这条 alpha 线的留档汇总成公告（没给 --notes-file 时自动汇总，省得手抄）。
const ALPHA_RECORD = join(root, '.alpha-notes', 'release-notes.md')
const ALPHA_PLACEHOLDER = 'alpha 预发布版，仅用于内部验证；更新内容不发公告，转正式版时随正式版发布说明公布。'

function recordAlphaNotes(ver, notesText) {
  try {
    mkdirSync(dirname(ALPHA_RECORD), { recursive: true })
    const existing = existsSync(ALPHA_RECORD)
      ? readFileSync(ALPHA_RECORD, 'utf8')
      : '# alpha 预发布记录（本地存盘：不发公告、不进公开仓库）\n\n> 等这条 alpha 线转正式版时，正式版发布说明会自动汇总本文件里的条目（前提是按发布说明规范写）。\n'
    if (existing.includes(`## v${ver} `)) {
      console.log('本地留档已含该版本，跳过追加：' + ALPHA_RECORD)
      return
    }
    writeFileSync(ALPHA_RECORD, existing.replace(/\s*$/, '\n') + '\n' + notesText.trim() + '\n', 'utf8')
    console.log('alpha 内容已存入本地留档：' + ALPHA_RECORD + '（本地文件，不需要提交）')
  } catch (e) {
    console.error('本地留档写入失败（不影响本次发布）：' + (e && e.message ? e.message : String(e)))
  }
}

// 汇总"同一条 alpha 线"（同 base 版本、按 alpha 序号升序）的条目，按固定分组顺序合并、去掉重复行
function notesFromAlphaRecord(ver) {
  const base = String(ver).split('-')[0]
  let text = ''
  try { text = readFileSync(ALPHA_RECORD, 'utf8') } catch { return '' }
  const chunks = text.split(/^## /mu).slice(1) // 去掉文件头
  const picked = []
  for (const c of chunks) {
    const head = c.split('\n', 1)[0]
    const m = /^v(\S+)\s+—/.exec(head)
    if (!m || !m[1].startsWith(base + '-alpha')) continue
    const n = Number((/-alpha\.(\d+)$/.exec(m[1]) || [])[1] || 0)
    picked.push({ n, body: c.slice(head.length).trim() })
  }
  if (!picked.length) return ''
  picked.sort((a, b) => a.n - b.n)
  const groups = new Map()
  for (const p of picked) {
    let cur = ''
    for (const raw of p.body.split('\n')) {
      const line = raw.trim()
      const gm = /^\*\*(新增|优化|调整|修复|移除)\*\*$/.exec(line)
      if (gm) { cur = gm[1]; if (!groups.has(cur)) groups.set(cur, []); continue }
      if (!cur || !line.startsWith('- ')) continue
      const arr = groups.get(cur)
      if (!arr.includes(line)) arr.push(line)
    }
  }
  const parts = []
  for (const g of ['新增', '优化', '调整', '修复', '移除']) {
    const items = groups.get(g)
    if (items && items.length) parts.push(`**${g}**\n${items.join('\n')}`)
  }
  return parts.join('\n\n')
}

let body = rawNotes
let notesSource = rawNotes ? '命令行/文件' : ''
if (!body && channel === 'latest') {
  const aggregated = notesFromAlphaRecord(version)
  if (aggregated) { body = aggregated; notesSource = 'alpha 本地留档汇总' }
}
if (!body) { body = notesFromCommits(); notesSource = '提交列表兜底' }
const notes = `${header()}\n\n${body}\n`
console.log(`--- 发布说明（来源：${notesSource}）---\n` + notes + '----------------')
if (channel === 'alpha') {
  console.log('注意：alpha 版本不发公告 —— 上面的内容只会写进本地留档，Release 正文仅留一句占位说明。')
}
// --dry-run：只把说明算出来看一眼（正式版会汇总 alpha 留档，最值得先核对），不构建、不上传、不写留档
if (process.argv.slice(2).includes('--dry-run')) {
  console.log('--dry-run：仅打印渠道判定与发布说明，未构建、未上传、未写留档。')
  process.exit(0)
}

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

// 捕获 stdout 且**需要区分成败**的命令（自检门禁用）。Windows 上 npm 是 .cmd，
// 不经 shell 无法 spawn，所以沿用 run() 的同一条判断；失败时照样把已产出的 stdout 带回来。
function capture(cmd, args) {
  const opts = { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' && /\.cmd$/i.test(cmd) }
  try {
    return { ok: true, out: execFileSync(cmd, args, opts) }
  } catch (error) {
    const out = error && typeof error.stdout === 'string' ? error.stdout : ''
    return { ok: false, out }
  }
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
  // 运行期自检：npm test 只能断言源码**文本**（挂错 emitter 也照样绿），
  // 断言不了"运行时接线"。2026-09-20 的两个回归（session-end 挂到 app 上、
  // 观察期识别器少一个 marker）都是这一层先抓到的。selftest 自带隔离 HOME + 随机端口，
  // 不碰用户配置；无 GUI 环境可用 DSHL_SKIP_SELFTEST=1 跳过（会留一条显式警告）。
  if (process.env.DSHL_SKIP_SELFTEST === '1') {
    console.log('警告：跳过运行期自检（DSHL_SKIP_SELFTEST=1）—— 本次发布的运行时接线未经机器验证')
  } else {
    const check = capture(npm, ['run', 'selftest'])
    const failed = check.out.split('\n').filter((line) => line.includes('FAILED'))
    if (!check.ok || failed.length > 0) {
      console.error('运行期自检未通过（npm run selftest）' + (failed.length ? '：\n' + failed.join('\n') : ''))
      process.exit(1)
    }
    console.log('运行期自检通过')
  }
}
run(process.execPath, ['tools/fetch-node-dist.mjs'])
run(npm, ['run', 'build:assets'])
// electron-builder 的 yml 文件名取自 **publish 配置里的 channel**（默认 latest），不会自己看版本号：
// 不显式传的话，alpha 版本也会写成 latest.yml —— 而 electron-updater 的 alpha 渠道只会去下 alpha.yml。
// 所以这里按渠道显式传一次（`--publish never`，只是让它在本地按渠道名写出 yml，不触发上传）。
run(npm, ['run', 'dist:win', '--', `-c.publish.channel=${channel}`])

// ---------- 3. 产物校验 ----------
for (const f of [exePath, blockmapPath, channelYml]) {
  if (!existsSync(f)) { console.error('产物缺失：' + f); process.exit(1) }
}
// yml 必须是这次的版本，且指向这次的安装包：文件名对得上不代表内容对得上（旧产物会留在 dist 里）
const ymlText = readFileSync(channelYml, 'utf8')
const ymlVersion = (/^version:\s*(\S+)/mu.exec(ymlText) || [])[1] || ''
if (ymlVersion !== version) {
  console.error(`产物版本不一致：${channel === 'latest' ? 'latest.yml' : channel + '.yml'} 里是 ${ymlVersion || '（读不到）'}，package.json 是 ${version}`)
  process.exit(1)
}
if (!ymlText.includes(exe)) {
  console.error(`产物不匹配：${channel === 'latest' ? 'latest.yml' : channel + '.yml'} 没有指向 ${exe}`)
  process.exit(1)
}
console.log(`产物校验通过：${exe} / ${channel === 'latest' ? 'latest.yml' : channel + '.yml'}（${channel} 渠道，版本 ${ymlVersion}）`)

// ---------- 4. 创建 Release 并上传（说明经 --notes-file 传文件，避免换行/引号被 shell 拆散） ----------
const notesFile = join(root, 'dist', '.release-notes.md')
if (channel === 'alpha') {
  // alpha 不发公告：内容进本地留档，Release 正文只留占位（转正式版时才把留档汇总成公告）
  recordAlphaNotes(version, notes)
  writeFileSync(notesFile, ALPHA_PLACEHOLDER + '\n', 'utf8')
} else {
  writeFileSync(notesFile, notes, 'utf8')
}
// alpha 必须发成 GitHub prerelease 且不占用 Latest：否则正式用户（updater.js 里 latest 渠道
// allowPrerelease=false）会把尚未验证的版本当成正式更新拉走。
const prereleaseArgs = channel === 'latest' ? [] : ['--prerelease', '--latest=false']
try {
  run('gh', ['release', 'create', tag, exePath, blockmapPath, channelYml, '--title', tag, '--notes-file', notesFile, ...prereleaseArgs])
} finally {
  try { unlinkSync(notesFile) } catch { /* noop */ }
}
console.log(`发布完成（${channel} 渠道，产物 ${channel === 'latest' ? 'latest.yml' : channel + '.yml'}）：https://github.com/IMHaoyan/deepseek-harness-launcher/releases/tag/${tag}`)
console.log(channel === 'alpha'
  ? '这是 alpha 预发布版（GitHub prerelease，不占 Latest + alpha.yml）：只有把「启动器更新渠道」选成 alpha 的机器会收到它。\n'
    + '按约定 alpha 不发公告：更新内容只写进本地留档 .alpha-notes/release-notes.md（本地文件，不需要提交），转正式版时自动汇总进正式版发布说明。'
  : '这是正式版（GitHub Latest + latest.yml）：所有默认（latest 渠道）的机器会自动更新，选了 alpha 的机器也会拿到它。\n'
    + '正式版才发公告：上面这份说明就是挂在正式版本号下的更新内容（若来自 alpha 留档汇总，请顺手核对分组与措辞）。')
