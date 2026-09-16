// env-install.js — 一键安装引擎：用户级 Node.js（官方发行包下载/校验/解压 + 用户 PATH）+ DSH（全局 npm 安装）+ 通知插件拷贝
//
// 设计要点：
//  - Node 用**官方 MSI**（内置 assets/node-dist 里的 node-v<ver>-x64.msi，静默 msiexec /qn，
//    会弹一次管理员授权）：落位 C:\Program Files\nodejs、HKLM\SOFTWARE\Node.js、机器 PATH、
//    「应用和功能」注册与卸载 —— 与官网下载的 .msi 完全一致（见 decideNodeInstallPlan）。
//    装不了（策略禁止 / 用户取消授权 / 版本管理器在场）才回退用户级 zip（%LOCALAPPDATA%\Programs\nodejs，
//    免管理员，并复刻 MSI 那份 npmrc，让全局包同样落在 %APPDATA%\npm —— 语义一致，只少机器级注册）。
//    已装用户永远复用现有 Node：升级启动器不会被动过环境。
//  - 失败回退：全局 npm 装不上 → 回退托管目录（~/.dsh/dshl-runtime/dsh）；旧版保留不动。
//  - 状态机单例：阶段列表 + 权重进度 + 实时日志（环形缓冲 500 行 + install.log 落盘）+ 取消。
//  - 下载优先 Electron net（自动走系统代理）；脱离 Electron（脚本/测试）回退 Node http/https。
//  - npm 源 npmmirror 优先，失败回退官方源；Node 包校验官方 SHASUMS256.txt。
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const semver = require('semver')
const envDetect = require('./env-detect') // 复用 engines 判据（Node 版本就绪范围），保证与探测侧单一事实源

const IS_WIN = process.platform === 'win32'
const DEFAULT_PNPM_VERSION = '11.8.0'

let HOME = path.join(os.homedir(), '.dsh')
let Config = { nodeMajor: 22, dshVersion: 'latest', pnpmVersion: DEFAULT_PNPM_VERSION, npmRegistry: '', npmGlobalRoot: '' }
let ASSETS_DIR = ''
let logFn = () => {}
let onPushFn = () => {}
let onDoneFn = () => {}
let saveConfigFn = () => {}

const INSTALL_LOG = 'dshl-logs/install.log' // 相对 HOME 的安装日志

function initInstaller(opts = {}) {
  if (opts.HOME) HOME = opts.HOME
  if (opts.Config) Config = opts.Config
  if (opts.ASSETS_DIR) ASSETS_DIR = opts.ASSETS_DIR
  if (opts.log) logFn = opts.log
  if (opts.onPush) onPushFn = opts.onPush
  if (opts.onDone) onDoneFn = opts.onDone
  if (typeof opts.saveConfig === 'function') saveConfigFn = opts.saveConfig
}

function log(message) {
  try { logFn('[install] ' + message) } catch { /* noop */ }
}

function runtimeBase() {
  return path.join(HOME, 'dshl-runtime')
}

// 仅修改 DSHL 当前进程的 PATH：让后续探测/子进程立即看到刚装好的工具，不等新终端。
// 用户全局可见性仍由 HKCU PATH + addToUserPath 负责。
// 只接受绝对目录：复用现有 Node 时 nodeBin 可能是 PATH 上的裸 'node'，dirname 出来是 '.'，
// 把当前目录塞进 PATH 是典型的高危写法（DLL/可执行体劫持），这里直接挡掉。
function prependProcessPath(dirs) {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH'
  const current = process.env[key] || ''
  const normalized = current.split(path.delimiter).map((p) => p.trim().toLowerCase())
  const additions = (dirs || []).filter((d) => d && path.isAbsolute(d) && !normalized.includes(String(d).toLowerCase()))
  if (!additions.length) return
  process.env[key] = additions.join(path.delimiter) + (current ? path.delimiter + current : '')
}

// 用户级 Node 安装目录（官方 zip 解压落位；免管理员；可用环境变量覆盖，测试用）。
// 非 Windows 平台保持托管目录（macOS/Linux 用户 PATH 方案未验证，不冒险）。
function userNodeDir() {
  if (process.env.DSHL_USER_NODE_DIR) return process.env.DSHL_USER_NODE_DIR
  if (!IS_WIN) return path.join(runtimeBase(), 'node')
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'Programs', 'nodejs')
}

// Node 是否走"用户级目录"安装（否则走 ~/.dsh/dshl-runtime/node 下的托管临时目录）。
// 两条路径的差别决定了"换 Node 会不会整目录替换掉一个既有目录"，这里与 runJob 共用同一判据。
function userLevelNodeInstall() {
  return !!process.env.DSHL_USER_NODE_DIR || IS_WIN
}

// 列出某目录下 npm 安装过的全局包（含 scope 包，形如 @scope/name）。读不到就返回空。
function nodeDirGlobalPackages(dest) {
  const nm = path.join(String(dest || ''), 'node_modules')
  const out = []
  let entries = []
  try { entries = fs.readdirSync(nm, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.bin') continue
    if (!e.name.startsWith('@')) { out.push(e.name); continue }
    try {
      for (const s of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) out.push(e.name + '/' + s.name)
      }
    } catch { /* 读不到这个 scope 就跳过 */ }
  }
  return out
}

// Node 发行版自带的包：它们不是"用户装的全局包"，换 Node 时会被新版一并带来，
// 列账/清理都要排除，否则日志里会出现"还有 2 个全局包会删除（npm、corepack）"这种误导。
const DISTRIBUTION_PACKAGES = new Set(['npm', 'corepack'])
function isDistributionPackage(name) {
  return DISTRIBUTION_PACKAGES.has(String(name || '').toLowerCase())
}

/**
 * 换 Node 的依赖补全（纯本地判断，不问 npm、不起进程）：
 * 两种安装方式都会让用户级 Node 目录里那份 DSH 失效：
 *  - 官方 MSI：新 Node 装在 C:\Program Files\nodejs（机器 PATH 优先），旧目录里那份会被新版取代；
 *  - 用户级 zip 重装：旧目录被"改名备份 → 装新的 → 删备份"整目录替换。
 * 所以只要本次要装 Node 且该目录里确实有全局 DSH，就自动带上 dsh 阶段（新版装好后才清旧残留，
 * 见 cleanupLegacyDshInUserNodeDir），并把会被波及的其他全局包如实列出来。
 *
 * 为什么可以拿"items 含 node"当替换信号：探测侧能给出 node.status=ok 时，UI 不会把 node 列进安装项
 * （missingEnvItems 只收 status!=='ok' 的项）；而 status!=='ok' 意味着没有任何候选 Node 满足引擎范围，
 * 那个用户级目录里的 Node 要么不存在、要么正是要被替换的那个。
 */
function nodeReplacePlan(items) {
  const list = [...(items || [])]
  const out = { list, nodeDir: '', dshInNodeDir: false, otherGlobals: [] }
  if (!list.includes('node') || !userLevelNodeInstall()) return out
  const dest = userNodeDir()
  if (!dest) return out
  out.nodeDir = dest
  const globals = nodeDirGlobalPackages(dest)
  out.otherGlobals = globals.filter((g) => g !== '@deepseek-ai/dsh' && !isDistributionPackage(g))
  out.dshInNodeDir = globals.includes('@deepseek-ai/dsh')
  if (out.dshInNodeDir && !list.includes('dsh')) {
    list.push('dsh') // 装 DSH 会带 pnpm（normalizeInstallItems 的规则），这里显式补齐
    if (!list.includes('pnpm')) list.push('pnpm')
  }
  return out
}

// npm 全局根（npm i -g 落点）。注意这只是"没问到 npm 时的兜底默认值"（MSI/官方安装器在 Windows
// 上就是 %APPDATA%\npm）；实际落点一律以 resolveGlobalRoot() 问到的 npm prefix 为准——
// 官方 zip 版 Node 的 npm 没有那份 prefix 覆盖，内建前缀是 node.exe 所在目录。
function npmGlobalRoot() {
  if (process.env.DSHL_NPM_GLOBAL_ROOT) return process.env.DSHL_NPM_GLOBAL_ROOT
  if (!IS_WIN) return '/usr/local'
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')
}

// 记账本次实际使用的 npm 全局根：探测侧（env-detect.globalPrefixes）与更新侧都读它，
// 保证"装到哪儿就找哪儿、更新哪儿"。不记账就只能靠 %APPDATA%\npm 猜，一旦猜错
// 就是"安装报完成、探测报未检测到 DSH"（v1.4.4 反馈的现场）。
function rememberGlobalRoot(root) {
  try {
    if (!root || typeof root !== 'string') return
    if (Config.npmGlobalRoot === root) return
    Config.npmGlobalRoot = root
    log('npm 全局根已记账：' + root)
    try { saveConfigFn() } catch { /* 落盘失败不影响安装本身（下次探测还有 Node 目录候选兜底） */ }
  } catch { /* noop */ }
}

// 当前生效的全局 DSH 所在的 npm 前缀（由最近一次环境探测缓存反推）；非全局形态/探测不可用返回 ''
function liveGlobalPrefix() {
  try {
    const envDetect = require('./env-detect')
    const dsh = envDetect.cachedReport() && envDetect.cachedReport().dsh
    if (!dsh || dsh.kind !== 'global' || !dsh.built || !dsh.dir) return ''
    return envDetect.npmPrefixOf(dsh.dir)
  } catch { return '' }
}

// ---------- 用户 PATH（HKCU\Environment；免管理员，仅 Windows） ----------

// 读用户 PATH。ok=false 表示"查询失败"（reg 超时/被拦截/输出格式变化），调用方必须区分：
// 此时绝不能把空值当成"用户 PATH 本来就是空的"写回去，否则会用只含 DSHL 目录的值覆盖整条用户 PATH。
async function readUserPath() {
  const out = { ok: false, type: 'REG_EXPAND_SZ', value: '' }
  try {
    const r = await runExec('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { timeout: 10000 })
    const m = /Path\s+(REG_\w+)\s+(.*)$/m.exec(r.stdout)
    if (m) { out.type = m[1]; out.value = m[2] }
    // 查询命令成功执行即视为可信（值可能确实不存在 → 按新建处理）
    out.ok = true
  } catch (e) {
    out.error = (e && e.message ? e.message : String(e))
  }
  return out
}

// 把目录写入用户 PATH（默认追加；prepend=true 时置顶——用于 dshl 自装 Node 优先于过旧系统 Node）
async function addToUserPath(job, dirs, opts = {}) {
  if (!IS_WIN) { job.logLine('非 Windows 平台，跳过用户 PATH 写入'); return }
  if (process.env.DSHL_SKIP_PATH === '1') { job.logLine('跳过用户 PATH 写入（DSHL_SKIP_PATH=1，测试模式）'); return }
  const { ok, type, value, error } = await readUserPath()
  if (!ok) {
    // 失败关闭：宁可不动 PATH，也不拿空值覆盖用户环境变量
    job.logLine('读取用户 PATH 失败，已跳过 PATH 写入（避免覆盖现有 PATH）：' + (error || '未知原因'))
    job.logLine('如需手动添加：把以下目录加入用户 PATH —— ' + dirs.filter(Boolean).join('、'))
    return
  }
  const parts = value ? value.split(';').map((p) => p.trim()).filter(Boolean) : []
  const norm = (p) => { try { return path.resolve(p.replace(/^"(.*)"$/, '$1')).toLowerCase() } catch { return p.toLowerCase() } }
  const added = []
  for (const d of dirs) {
    if (!d || parts.some((p) => norm(p) === norm(d))) continue
    parts.push(d)
    added.push(d)
  }
  if (!added.length) { job.logLine('用户 PATH 已包含所需目录，无需修改'); return }
  if (opts.prepend) {
    // 置顶：新装 Node 应优先于系统里过旧的 Node
    for (const d of added) { const i = parts.indexOf(d); if (i > 0) { parts.splice(i, 1); parts.unshift(d) } }
  }
  const newValue = parts.join(';')
  await runExec('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', type, '/d', newValue, '/f'], { timeout: 15000 })
  job.logLine(`用户 PATH 已更新：${added.join('、')}${opts.prepend ? '（置顶）' : ''}（新开终端生效）`)
  broadcastEnvironmentChange()
}

// 广播 WM_SETTINGCHANGE：让 Explorer 立即重载环境变量（新终端无需注销即可看到新 PATH）
function broadcastEnvironmentChange() {
  const ps = [
    "Add-Type -Namespace Dshl -Name Env -MemberDefinition '[DllImport(\"user32.dll\", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
    '$r = [UIntPtr]::Zero',
    '[Dshl.Env]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r) | Out-Null',
  ].join('; ')
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' })
  } catch { /* 广播失败不影响：重开终端/重启资源管理器后仍生效 */ }
}

function installLogPath() {
  return path.join(HOME, INSTALL_LOG)
}

// 安装日志落盘（1MB 轮转，保留 3 份）
function appendInstallLog(line) {
  try {
    const file = installLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > 1024 * 1024) {
        for (let i = 2; i >= 1; i--) {
          try { if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch { /* noop */ }
        }
        try { fs.renameSync(file, `${file}.1`) } catch { /* noop */ }
      }
    } catch { /* 文件不存在 */ }
    fs.appendFileSync(file, `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${line}\n`)
  } catch { /* noop */ }
}

// ---------- 命令执行 ----------

function runExec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const child = execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 0, env: opts.env || process.env }, (err, stdout, stderr) => {
        if (err) {
          const e = new Error(`${cmd} failed: ${String(err.message || err)}\n${String(stderr || '').slice(-800)}`)
          e.stdout = String(stdout || '')
          e.stderr = String(stderr || '')
          reject(e)
        } else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
      if (opts.onAbort) opts.onAbort(() => { try { child.kill() } catch { /* noop */ } })
    } catch (err) { reject(err) }
  })
}

function killChildTree(child) {
  try {
    if (!child || child.exitCode !== null) return
    if (IS_WIN) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* noop */ } }
    }
  } catch { /* noop */ }
}

// ---------- 下载（Electron net 优先，回退 Node http/https；支持重定向、进度、取消） ----------

function electronNet() {
  try { return require('electron').net } catch { return null }
}

// 下载停滞看门狗：代理/连接假死（连上但不发数据、也不关闭）时事件永远不来、Promise 永不 settle，
// 安装任务就会永久卡在 running（只能手动取消）。这里按"多久没收到任何数据"判停滞，超时即失败，
// 控制台出现「重试」入口。默认 60s，DSHL_DL_STALL_MS 可覆盖（测试用）。
const DEFAULT_DL_STALL_MS = 60000
function downloadStallMs() {
  const v = Number(process.env.DSHL_DL_STALL_MS)
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DL_STALL_MS
}

function downloadToFile(url, dest, onProgress, abortRef) {
  return new Promise((resolve, reject) => {
    const httpMod = (() => { try { return require(url.startsWith('https:') ? 'https' : 'http') } catch { return null } })()
    const stallMs = downloadStallMs()
    let settled = false
    let stallTimer = null
    let current = null
    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null } }
    const done = (err, bytes) => {
      if (settled) return
      settled = true
      clearStall()
      if (err) reject(err); else resolve({ bytes })
    }
    const fail = (err) => {
      clearStall()
      try { fs.unlinkSync(dest) } catch { /* noop */ }
      done(err)
    }
    const abort = () => { try { if (current) current.destroy ? current.destroy() : current.abort() } catch { /* noop */ } }
    abortRef.onAbort = abort
    // 收到任何数据都重置计时；到点还没数据 = 停滞（含"连上但首字节不来"）
    const armStall = () => {
      clearStall()
      stallTimer = setTimeout(() => {
        fail(new Error(`下载停滞：${Math.round(stallMs / 1000)} 秒没有收到数据（${url}）`))
        abort()
      }, stallMs)
    }
    const netMod = electronNet()
    if (netMod) {
      current = netMod.request(url)
      current.on('response', (res) => {
        const code = res.statusCode
        const loc = res.headers.location && String(res.headers.location[0] || res.headers.location)
        if ([301, 302, 303, 307, 308].includes(code) && loc) {
          try { res.resume() } catch { /* noop */ }
          clearStall()
          settled = true // 结果由内层下载决定
          abortRef.onAbort = null
          resolve(downloadToFile(new URL(loc, url).toString(), dest, onProgress, abortRef))
          return
        }
        if (code !== 200) { try { res.resume() } catch { /* noop */ } return fail(new Error(`HTTP ${code} ${url}`)) }
        const total = Number(res.headers['content-length'] || 0) || 0
        let got = 0
        const ws = fs.createWriteStream(dest)
        ws.on('error', (e) => fail(e))
        res.on('data', (chunk) => { got += chunk.length; armStall(); try { ws.write(chunk) } catch { /* noop */ } if (onProgress) onProgress(got, total) })
        res.on('end', () => { try { ws.end(() => done(null, got)) } catch { done(null, got) } })
        res.on('error', (e) => { try { ws.destroy() } catch { /* noop */ } fail(e) })
      })
      current.on('error', (e) => fail(e))
      armStall() // 连接/首字节也计入停滞窗口
      current.end()
    } else if (httpMod) {
      current = httpMod.get(url, { headers: { 'user-agent': 'dshl-installer/1.0' } }, (res) => {
        const code = res.statusCode
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          try { res.resume() } catch { /* noop */ }
          clearStall()
          settled = true // 结果由内层下载决定
          abortRef.onAbort = null
          resolve(downloadToFile(new URL(res.headers.location, url).toString(), dest, onProgress, abortRef))
          return
        }
        if (code !== 200) { try { res.resume() } catch { /* noop */ } return fail(new Error(`HTTP ${code} ${url}`)) }
        const total = Number(res.headers['content-length'] || 0) || 0
        let got = 0
        const ws = fs.createWriteStream(dest)
        ws.on('error', (e) => fail(e))
        res.on('data', (chunk) => { got += chunk.length; armStall(); try { ws.write(chunk) } catch { /* noop */ } if (onProgress) onProgress(got, total) })
        res.on('end', () => { try { ws.end(() => done(null, got)) } catch { done(null, got) } })
        res.on('error', (e) => { try { ws.destroy() } catch { /* noop */ } fail(e) })
      })
      current.on('error', (e) => fail(e))
      armStall() // 连接/首字节也计入停滞窗口
    } else {
      return fail(new Error('no http client available'))
    }
  })
}

// 小文本下载（index.json / SHASUMS256.txt）
async function downloadText(url, abortRef) {
  const tmp = path.join(os.tmpdir(), `dshl-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  try {
    await downloadToFile(url, tmp, null, abortRef)
    return fs.readFileSync(tmp, 'utf8')
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* noop */ }
  }
}

// ---------- Node 安装方式：官方 MSI（默认，与官网 .msi 完全一致）＋ 用户级 zip（兜底） ----------
//
// 为什么默认走官方 MSI：只用 zip 复刻永远差一半——MSI 的一致性有相当一部分不在文件里，而在
// Windows Installer 的产品注册里（HKLM\SOFTWARE\Node.js、机器 PATH、Program Files 落位、
// 「应用和功能」的修复/卸载）。这些必须管理员权限，也无法用"看起来像"的注册表项伪造。
// 因此在"确实需要装 Node"时用官方 MSI；装不了（策略禁用/无管理员权限/版本管理器在场）才回退
// 用户级 zip，并保证回退路径的语义与 MSI 一致（补 MSI 那份 npmrc → 全局包同样落在 %APPDATA%\npm）。

// 本机已装的 Node.js MSI 产品标记：官方 MSI 会写 HKLM\SOFTWARE\Node.js（InstallPath + Version）。
// 只读，不写；读不到就当没有（读失败与"没装"在这里等价，后续决策都按"没装"走 = 不会误判成已装）。
async function readInstalledNodeMsi() {
  if (!IS_WIN) return null
  try {
    const r = await runExec('reg', ['query', 'HKLM\\SOFTWARE\\Node.js'], { timeout: 10000 })
    const parsed = parseNodeJsRegQuery(r.stdout)
    return parsed && parsed.version ? parsed : null
  } catch { return null }
}

// reg query 输出解析（纯函数，便于测试）：键不存在会抛错，这里只处理"查到了"的情况
function parseNodeJsRegQuery(stdout) {
  const text = String(stdout || '')
  const pick = (name) => {
    const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(text)
    return m ? m[1].trim() : ''
  }
  const installPath = pick('InstallPath')
  const version = pick('Version')
  if (!installPath && !version) return null
  return { installPath, version }
}

// 版本管理器在场时不要去装机器级 MSI：那会和 nvm/volta/fnm 争 PATH，把用户"切版本"的行为打乱。
function detectVersionManager(deps = {}) {
  const exists = deps.exists || ((p) => { try { return fs.existsSync(p) } catch { return false } })
  const env = deps.env || process.env
  const home = deps.home || os.homedir()
  const candidates = [
    ['nvm', env.NVM_HOME, path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'nvm')],
    ['volta', env.VOLTA_HOME, path.join(home, '.volta')],
    ['fnm', env.FNM_DIR, path.join(home, '.fnm'), path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'fnm')],
  ]
  for (const [name, ...dirs] of candidates) {
    if (dirs.some((d) => d && exists(d))) return name
  }
  return ''
}

/**
 * Node 安装方式决策（纯函数，便于测试；所有输入都来自探测/注册表，不在这里做 IO）。
 * 顺序即优先级，"复用优先"是硬规则——能复用用户现有的 Node 就绝不动它：
 *   1) 探测到可用的 Node（满足 engines）→ 复用，什么都不装
 *   2) 本机已有 Node.js MSI 产品：版本满足且可执行文件在 → 复用；版本过旧 / 文件不在 → 拒绝（见下）
 *   3) 版本管理器在场 → 用户级 zip（不与版本管理器争 PATH）
 *   4) 显式配置成 user → 用户级 zip
 *   5) 其余 → 官方 MSI
 *
 * 为什么"已装 MSI 但版本过旧"要拒绝而不是再装一个：Node 的 MSI 是不同版本 = 不同产品码，却
 * 默认装到同一个 C:\Program Files\nodejs —— 两个产品共同宣称拥有同一目录，卸载其一会把文件删掉、
 * 留下另一个残缺。也不能回退用户级：Windows 的机器 PATH 先于用户 PATH，回退装出来的 Node 会被
 * 旧的那份遮蔽，装了等于没装。所以这里 fail-closed，把可行动作写清楚交给用户。
 *
 * msiUsable=false（注册表说装了、可执行文件却找不到）同样必须拒绝：既兑现不了"复用"，
 * 也不能再装一个产品去争同一目录 —— 只能请用户先在「应用和功能」里修复或卸载它。
 */
function decideNodeInstallPlan(input) {
  const o = input || {}
  const range = o.range || envDetect.DEFAULT_ENGINE_RANGE
  const ok = (v) => {
    const clean = String(v || '').trim().replace(/^v/i, '')
    if (!clean) return false
    try { return semver.satisfies(clean, range, { includePrerelease: true }) } catch { return false }
  }
  if (o.nodeOk) return { action: 'reuse', reason: 'node-ok', version: String(o.nodeVersion || '') }
  const msi = o.installedMsi
  if (msi && msi.version) {
    if (!ok(msi.version)) return { action: 'refuse', reason: 'msi-too-old', version: String(msi.version), range }
    if (o.msiUsable === false) return { action: 'refuse', reason: 'msi-broken', version: String(msi.version), range }
    return { action: 'reuse', reason: 'msi-ok', version: String(msi.version) }
  }
  if (o.versionManager) return { action: 'install-user', reason: 'version-manager-' + o.versionManager }
  if (o.mode === 'user') return { action: 'install-user', reason: 'mode-user' }
  return { action: 'install-msi', reason: 'default' }
}

// msiexec 退出码 → 结局（纯函数，便于测试）。0/3010 都算装好（3010 = 需要重启，Node 用不到）。
const MSI_POLICY_CODES = new Set([1625, 1622]) // 被系统策略禁止 / 打开安装包失败
function interpretMsiResult(code, cancelledByUser) {
  if (cancelledByUser) return { ok: false, cancelled: true, policy: false, detail: '管理员授权被取消' }
  const n = Number(code)
  if (n === 0 || n === 3010) return { ok: true, cancelled: false, policy: false, detail: n === 3010 ? '安装完成（需重启）' : '安装完成' }
  if (n === 1602) return { ok: false, cancelled: true, policy: false, detail: '安装程序被取消（1602）' }
  if (n === 1618) return { ok: false, cancelled: false, policy: false, detail: '另一个安装程序正在运行（1618）' }
  if (MSI_POLICY_CODES.has(n)) return { ok: false, cancelled: false, policy: true, detail: `安装被系统策略禁止（${n}）` }
  return { ok: false, cancelled: false, policy: false, detail: Number.isFinite(n) ? `msiexec 退出码 ${n}` : 'msiexec 结果不可读' }
}

// 提权运行官方 MSI（与 main.js 的 Defender 排除项同一套做法）：外层普通权限 PowerShell →
// Start-Process -Verb RunAs -Wait。用结果文件把三种结局分开记账：装好了 / 用户取消了 UAC /
// msiexec 报错（含被策略禁止）。静默参数 /qn：除了一次 UAC，不弹任何向导——与官网 .msi 的双击安装
// 产物一致，只是没有任何交互页面。
async function runElevatedMsi(msiPath, logPath, opts = {}) {
  const ps = (p) => String(p).replace(/'/g, "''")
  const resultFile = path.join(os.tmpdir(), `dshl-msi-${process.pid}-${Date.now()}.txt`)
  const inner = [
    `$r = '${ps(resultFile)}'`,
    'try {',
    `  $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i','${ps(msiPath)}','/qn','/norestart','/l*v','${ps(logPath)}') -Verb RunAs -Wait -PassThru`,
    `  'CODE=' + $p.ExitCode | Out-File -FilePath $r -Encoding utf8`,
    `} catch { 'CANCELLED=' + $_.Exception.Message | Out-File -FilePath $r -Encoding utf8 }`,
  ].join('; ')
  const b64 = Buffer.from(inner, 'utf16le').toString('base64')
  try {
    await runExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: opts.timeoutMs || 30 * 60 * 1000 })
  } catch { /* 超时/被杀：仍去读结果文件，读不到按"结果不可读"处理 */ }
  let text = ''
  try { text = fs.readFileSync(resultFile, 'utf8').trim() } catch { /* 无结果文件 */ }
  try { fs.unlinkSync(resultFile) } catch { /* noop */ }
  const codeMatch = /CODE=(-?\d+)/.exec(text)
  const cancelledByUser = /CANCELLED=/.test(text)
  return interpretMsiResult(codeMatch ? codeMatch[1] : NaN, cancelledByUser)
}

// ---------- 各阶段实现 ----------

function nodeBases() {
  const list = []
  if (Config.nodeMirror) list.push(Config.nodeMirror.replace(/\/+$/, ''))
  else list.push('https://nodejs.org/dist', 'https://npmmirror.com/dist')
  return [...new Set(list)]
}

async function resolveNodeVersion(job, base) {
  const index = JSON.parse(await downloadText(`${base}/index.json`, job.abortRef))
  const major = Number(Config.nodeMajor) || 22
  const entry = index.find((e) => typeof e.version === 'string' && e.version.startsWith(`v${major}.`))
  if (!entry) throw new Error(`Node.js v${major} 在 ${base} 中不存在`)
  return entry.version.replace(/^v/, '')
}

function nodeDistFile(ver) {
  const p = process.platform
  const a = process.arch
  const arch = a === 'x64' || a === 'arm64' ? a : 'x64'
  if (p === 'win32') return `node-v${ver}-win-${arch}.zip`
  if (p === 'darwin') return `node-v${ver}-darwin-${arch}.tar.gz`
  return `node-v${ver}-linux-${arch}.tar.xz`
}

async function verifySha256(job, base, ver, file, archivePath) {
  const sums = await downloadText(`${base}/v${ver}/SHASUMS256.txt`, job.abortRef)
  const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${file}`))
  if (!line) throw new Error(`校验文件 SHASUMS256.txt 中找不到 ${file}`)
  const expected = line.trim().split(/\s+/)[0]
  const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')
  if (expected.toLowerCase() !== actual.toLowerCase()) throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}`)
}

async function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  if (IS_WIN) {
    try {
      await runExec('tar', ['-xf', archive, '-C', destDir], { timeout: 300000 })
      return
    } catch (e) { log('tar.exe 解压失败，回退 PowerShell Expand-Archive: ' + e.message) }
    await runExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`], { timeout: 600000 })
  } else {
    const flag = archive.endsWith('.tar.xz') ? '-xJf' : '-xzf'
    await runExec('tar', [flag, archive, '-C', destDir], { timeout: 300000 })
  }
}

// 内置 Node 发行包（发布构建时由 tools/fetch-node-dist.mjs 预置，首装免下载）：
// 查找顺序：环境变量 DSHL_NODE_DIST_DIR（测试用）→ 开发模式 <项目根>/assets/node-dist → 打包后 <resources>/node-dist
function nodeDistDirs() {
  return [
    process.env.DSHL_NODE_DIST_DIR,
    path.join(__dirname, 'assets', 'node-dist'),
    path.join(process.resourcesPath || '', 'node-dist'),
  ].filter(Boolean)
}

// 内置的**官方 MSI**（默认安装路径）：与 zip 同一套"内置 + SHA256 侧车"逻辑
function bundledNodeMsi() {
  const major = Number(Config.nodeMajor) || 22
  for (const dir of nodeDistDirs()) {
    try {
      const files = fs.readdirSync(dir).filter((f) => new RegExp(`^node-v${major}\\.\\d+\\.\\d+-x64\\.msi$`).test(f))
      if (!files.length) continue
      const file = files.sort().pop() // 同主版本取最高补丁版
      const msiPath = path.join(dir, file)
      const shaFile = msiPath + '.sha256'
      const expected = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0] : ''
      return { msiPath, ver: file.replace(/^node-v/, '').replace(/-x64\.msi$/, ''), expected }
    } catch { /* 换下一个位置 */ }
  }
  return null
}

// 内置的 zip（**兜底路径**用；没有内置就联网下载）
function bundledNodeDist() {
  const major = Number(Config.nodeMajor) || 22
  for (const dir of nodeDistDirs()) {
    try {
      const zips = fs.readdirSync(dir).filter((f) => new RegExp(`^node-v${major}\\.\\d+\\.\\d+-win-x64\\.zip$`).test(f))
      if (!zips.length) continue
      const file = zips.sort().pop() // 同主版本取最高补丁版
      const archivePath = path.join(dir, file)
      const shaFile = archivePath + '.sha256'
      const expected = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0] : ''
      return { archivePath, ver: file.replace(/^node-v/, '').replace(/-win-x64\.zip$/, ''), expected }
    } catch { /* 换下一个位置 */ }
  }
  return null
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// 拿到官方 MSI（内置优先，否则联网下载并校验官方 SHASUMS256.txt）；拿不到返回 null
async function acquireNodeMsi(job) {
  const bundled = bundledNodeMsi()
  if (bundled) {
    job.logLine(`使用内置官方 Node.js 安装包 v${bundled.ver}（免下载）：${bundled.msiPath}`)
    if (bundled.expected && sha256Of(bundled.msiPath).toLowerCase() !== bundled.expected.toLowerCase()) {
      job.logLine('内置 MSI SHA256 校验失败，改为联网下载')
    } else {
      return { msiPath: bundled.msiPath, ver: bundled.ver, temp: false }
    }
  }
  const bases = nodeBases()
  let ver = null
  let lastErr = null
  for (const base of bases) {
    try {
      ver = await resolveNodeVersion(job, base)
      job.logLine(`Node.js 版本列表：${base} → v${ver}`)
      break
    } catch (e) { lastErr = e; job.logLine(`版本列表获取失败（${base}）：${e.message}`) }
  }
  if (!ver) throw new Error('无法获取 Node.js 版本列表（网络不可用？）' + (lastErr ? ` ${lastErr.message}` : ''))
  const file = `node-v${ver}-x64.msi`
  const tmpDir = path.join(runtimeBase(), 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const msiPath = path.join(tmpDir, file)
  let lastDownloadErr = null
  for (const base of bases) {
    if (job.aborted) throw job.cancelledError()
    const url = `${base}/v${ver}/${file}`
    job.logLine(`下载官方 Node.js 安装包：${url}`)
    job.currentDownloadFile = msiPath
    try {
      const { bytes } = await downloadToFile(url, msiPath, (got, total) => {
        job.stageProgress = total > 0 ? Math.min(1, got / total) : 0
        job.pushProgress()
      }, job.abortRef)
      job.currentDownloadFile = null
      job.logLine(`下载完成：${(bytes / 1024 / 1024).toFixed(1)} MB`)
      await verifySha256(job, base, ver, file, msiPath)
      job.logLine('SHA256 校验通过（官方 SHASUMS256.txt）')
      return { msiPath, ver, temp: true }
    } catch (e) {
      job.currentDownloadFile = null
      lastDownloadErr = e
      job.logLine(`下载失败（${base}）：${e.message}${bases.length > 1 && base === bases[0] ? '，回退镜像源重试' : ''}`)
    }
  }
  throw new Error(`Node.js 安装包下载失败：${lastDownloadErr ? lastDownloadErr.message : '未知错误'}`)
}

// 走官方 MSI 安装 Node（机器级，与官网 .msi 完全一致：Program Files 落位 + HKLM\SOFTWARE\Node.js +
// 机器 PATH + 自己的 npmrc + 「应用和功能」注册）。返回 { ok, nodeBin, detail, cancelled, policy }。
// 失败不抛错：调用方据此决定"回退用户级 zip"还是"明确报错"。
async function installNodeViaMsi(job, onInstallStart) {
  if (!IS_WIN) return { ok: false, detail: '非 Windows 平台不支持官方 MSI', cancelled: false, policy: false }
  if (onInstallStart) onInstallStart()
  const logDir = path.join(HOME, 'dshl-logs')
  fs.mkdirSync(logDir, { recursive: true })
  const msiLog = path.join(logDir, 'msi-node.log')
  let acquired = null
  try {
    acquired = await acquireNodeMsi(job)
  } catch (e) {
    return { ok: false, detail: '官方安装包获取失败：' + (e && e.message ? e.message : String(e)), cancelled: false, policy: false }
  }
  job.logLine('运行官方 Node.js 安装包（msiexec /qn，会弹出一次管理员授权）…')
  const r = await runElevatedMsi(acquired.msiPath, msiLog)
  if (acquired.temp) { try { fs.unlinkSync(acquired.msiPath) } catch { /* noop */ } }
  job.logLine(`官方安装包结果：${r.detail}（详细日志：${msiLog}）`)
  if (!r.ok) return { ok: false, detail: r.detail, cancelled: r.cancelled, policy: r.policy }
  // 落位以注册表为准（MSI 自己写的 InstallPath），回退默认目录
  const msi = await readInstalledNodeMsi()
  const dir = (msi && msi.installPath) || (IS_WIN ? 'C:\\Program Files\\nodejs' : '')
  const nodeBin = path.join(dir, IS_WIN ? 'node.exe' : 'node')
  if (!fs.existsSync(nodeBin)) {
    return { ok: false, detail: `安装包报告成功，但未找到 ${nodeBin}`, cancelled: false, policy: false }
  }
  let version = ''
  try {
    const out = await runExec(nodeBin, ['-v'], { timeout: 15000 })
    version = String(out.stdout || '').trim().replace(/^v/, '')
  } catch { /* 版本探测失败不影响：文件确实在 */ }
  job.logLine(`Node.js 安装完成（官方 MSI）：${dir}${version ? ' · v' + version : ''}`)
  return { ok: true, nodeBin, dir, version, detail: r.detail, cancelled: false, policy: false }
}

// MSI 那份 npmrc 的等效物（**兜底路径**用）：字节级复刻官方 MSI 写入的内容
// （实测 23 字节：prefix=${APPDATA}\npm + CRLF，ASCII、无 BOM），让 zip 版 Node 的全局包也落在
// %APPDATA%\npm —— 这样"官方 MSI"与"用户级兜底"两种安装的语义完全一致（只有落位与注册不同）。
const MSI_NPMRC_BYTES = Buffer.from('prefix=${APPDATA}\\npm\r\n', 'ascii')
function writeMsiEquivalentNpmrc(job, nodeDir) {
  try {
    const npmDir = path.join(nodeDir, 'node_modules', 'npm')
    if (!fs.existsSync(npmDir)) return false
    const target = path.join(npmDir, 'npmrc')
    if (fs.existsSync(target)) {
      job.logLine('Node 目录已存在 npmrc（官方安装器写过或已复刻），沿用不改写')
      return true
    }
    // fail-closed：只有"这个 Node 目录里还没有任何全局包"时才写。
    // 否则翻掉前缀会让已有全局包在 npm 眼里凭空消失（它们仍能跑，但 npm 不再管理）——
    // 那种情况必须走显式迁移，不能顺手改掉。
    const globals = nodeDirGlobalPackages(nodeDir).filter((g) => g !== 'npm' && g !== 'corepack')
    if (globals.length) {
      job.logLine(`Node 目录里已有 ${globals.length} 个全局包，跳过 npmrc 复刻（避免它们被 npm 遗忘）；如需对齐请走迁移`)
      return false
    }
    fs.writeFileSync(target, MSI_NPMRC_BYTES)
    job.logLine(`已复刻官方 MSI 的 npmrc（prefix=\${APPDATA}\\npm）：${target} → 全局包将落在 ${npmGlobalRoot()}`)
    return true
  } catch (e) {
    job.logLine('npmrc 复刻失败（沿用 zip 默认：全局包在 Node 目录内）：' + (e && e.message ? e.message : String(e)))
    return false
  }
}

// 校验并解压 Node 发行包 → 落位 nodeDest（下载路径与内置包路径共用）
async function finalizeNode(job, archivePath, extractDir, file, nodeDest, onExtractStart) {
  if (job.aborted) throw job.cancelledError()
  if (onExtractStart) onExtractStart()
  job.logLine('解压 Node.js 发行包…')
  await extractArchive(archivePath, extractDir)
  const archiveRoot = file.replace(/\.(zip|tar\.gz|tar\.xz)$/, '')
  const extracted = path.join(extractDir, archiveRoot)
  if (!fs.existsSync(extracted)) throw new Error(`解压后未找到目录 ${archiveRoot}`)
  fs.mkdirSync(path.dirname(nodeDest), { recursive: true })
  try { fs.rmSync(nodeDest, { recursive: true, force: true }) } catch { /* noop */ }
  try {
    fs.renameSync(extracted, nodeDest)
  } catch (e) {
    // 跨卷（如 tmp 在 C:、目标在 D:）rename 会 EXDEV：回退复制
    if (!e || e.code !== 'EXDEV') throw e
    job.logLine('跨卷移动，改用复制落位…')
    fs.cpSync(extracted, nodeDest, { recursive: true })
    try { fs.rmSync(extracted, { recursive: true, force: true }) } catch { /* noop */ }
  }
  try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch { /* noop */ }
  try { fs.unlinkSync(archivePath) } catch { /* noop */ }
  const nodeBin = path.join(nodeDest, IS_WIN ? 'node.exe' : 'node')
  if (!fs.existsSync(nodeBin)) throw new Error(`Node 可执行文件缺失：${nodeBin}`)
  job.logLine(`Node.js 安装完成：${nodeDest}`)
  return nodeBin
}

async function installNode(job, nodeDest, onExtractStart) {
  // 快路径：打包内置的 Node 发行包（免下载、秒装；SHA256 校验失败或不存在则回退下载）
  const bundled = bundledNodeDist()
  if (bundled) {
    job.logLine(`使用内置 Node.js 发行包 v${bundled.ver}（免下载）：${bundled.archivePath}`)
    let shaOk = true
    if (bundled.expected) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(bundled.archivePath)).digest('hex')
      shaOk = actual.toLowerCase() === bundled.expected.toLowerCase()
      if (!shaOk) job.logLine(`内置包 SHA256 校验失败（期望 ${bundled.expected.slice(0, 16)}…），回退下载`)
    }
    if (shaOk) {
      job.stageProgress = 1
      job.pushProgress()
      const tmpDir = path.join(runtimeBase(), 'tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      const extractDir = path.join(tmpDir, `extract-${Date.now()}`)
      const file = `node-v${bundled.ver}-win-x64.zip`
      // 内置包在只读资源目录（asar 外）里：拷贝到 tmp 再解压，避免占用原始文件
      const localCopy = path.join(tmpDir, file)
      try { fs.copyFileSync(bundled.archivePath, localCopy) } catch (e) { job.logLine(`内置包拷贝失败（回退下载）：${e.message}`); }
      if (fs.existsSync(localCopy)) {
        return await finalizeNode(job, localCopy, extractDir, file, nodeDest, onExtractStart)
      }
    }
    job.logLine('内置包不可用，回退在线下载')
  }

  const bases = nodeBases()
  let ver = null
  let lastErr = null
  for (const base of bases) {
    try {
      ver = await resolveNodeVersion(job, base)
      job.logLine(`Node.js 版本列表：${base} → v${ver}`)
      break
    } catch (e) { lastErr = e; job.logLine(`版本列表获取失败（${base}）：${e.message}`) }
  }
  if (!ver) throw new Error('无法获取 Node.js 版本列表（网络不可用？）' + (lastErr ? ` ${lastErr.message}` : ''))

  const file = nodeDistFile(ver)
  const tmpDir = path.join(runtimeBase(), 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const archivePath = path.join(tmpDir, file)
  const extractDir = path.join(tmpDir, `extract-${Date.now()}`)

  let ok = false
  let lastDownloadErr = null
  for (const base of bases) {
    if (job.aborted) throw job.cancelledError()
    const url = `${base}/v${ver}/${file}`
    job.logLine(`下载 Node.js：${url}`)
    job.currentDownloadFile = archivePath
    try {
      const { bytes } = await downloadToFile(url, archivePath, (got, total) => {
        if (job.aborted) { try { job.abortRef.onAbort && job.abortRef.onAbort() } catch { /* noop */ } }
        job.stageProgress = total > 0 ? Math.min(1, got / total) : 0
        job.pushProgress()
      }, job.abortRef)
      job.currentDownloadFile = null
      job.logLine(`下载完成：${(bytes / 1024 / 1024).toFixed(1)} MB`)
      try {
        await verifySha256(job, base, ver, file, archivePath)
        job.logLine('SHA256 校验通过（官方 SHASUMS256.txt）')
      } catch (e) {
        job.logLine(`SHA256 校验失败：${e.message}（换源重试）`)
        try { fs.unlinkSync(archivePath) } catch { /* noop */ }
        continue
      }
      ok = true
      break
    } catch (e) {
      job.currentDownloadFile = null
      lastDownloadErr = e
      job.logLine(`下载失败（${base}）：${e.message}${bases.length > 1 && base === bases[0] ? '，回退镜像源重试' : ''}`)
    }
  }
  if (!ok) throw new Error(`Node.js 下载失败：${lastDownloadErr ? lastDownloadErr.message : '未知错误'}`)
  return await finalizeNode(job, archivePath, extractDir, file, nodeDest, onExtractStart)
}

// 解析 npm CLI：托管/发行版 Node 自带 <dir>/node_modules/npm/bin/npm-cli.js
function npmCliFor(nodeBin) {
  const cli = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(cli)) return cli
  return null
}

function runNpmInstall(job, nodeBin, npmCli, args) {
  return new Promise((resolve, reject) => {
    // 关键：把 Node 可执行文件所在目录注入子进程 PATH。
    // 无系统 Node 的干净机器上，koffi/node-pty 等原生包的生命周期脚本以 `cmd /c node xxx.js` 执行，
    // 找不到 node 会报 "'node' 不是内部或外部命令"（npm 退出码 1）。
    const nodeDir = path.dirname(nodeBin)
    const env = Object.assign({}, process.env, { PATH: nodeDir + path.delimiter + (process.env.PATH || '') })
    let child
    try {
      if (npmCli) {
        child = spawn(nodeBin, [npmCli, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      } else if (IS_WIN) {
        // cmd.exe 兜底：首 token（程序名）不加引号（cmd /s /c 会剥字符串首尾引号，加引号会把 npm 变成 npm"），
        // 仅对含空格/& 的参数加引号
        const cmdLine = args.map((a, i) => {
          const s = String(a).replace(/"/g, '\\"')
          return i === 0 ? s : (/\s|&/.test(s) ? `"${s}"` : s)
        }).join(' ')
        child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      } else {
        child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], env })
      }
    } catch (err) { return reject(err) }
    job.child = child
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) job.logLine(line)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => reject(err))
    child.on('exit', (code) => {
      job.child = null
      if (job.aborted) return reject(job.cancelledError())
      if (code === 0) resolve()
      else reject(new Error(`npm 退出码 ${code}`))
    })
  })
}

// ---------- npm 安装（统一渠道：npmmirror 镜像优先，失败回退 npm 官方源） ----------

// npm 双源安装循环：返回 true/false
async function npmInstallTo(job, nodeBin, prefix, spec) {
  let npmCli = npmCliFor(nodeBin)
  if (!npmCli) {
    // nodeBin 可能是 PATH 上的裸 'node'：解析真实可执行路径，再找同目录的 npm-cli.js（MSI/nvm 发行版都自带）
    try {
      const res = await runExec(nodeBin, ['-p', 'process.execPath'], { timeout: 10000 })
      const real = String(res.stdout || '').trim()
      if (real) npmCli = npmCliFor(real)
    } catch { /* 忽略，走 cmd.exe 兜底 */ }
  }
  if (!npmCli) job.logLine('警告：所选 Node 未内置 npm，回退到 PATH 中的 npm 命令')
  const registries = Config.npmRegistry ? [Config.npmRegistry] : ['https://registry.npmmirror.com', null]
  for (const registry of registries) {
    if (job.aborted) throw job.cancelledError()
    const args = ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=info']
    if (registry) args.push('--registry', registry)
    args.push(spec)
    job.logLine(`npm install（registry=${registry || '默认'}）：${spec}`)
    try {
      await runNpmInstall(job, nodeBin, npmCli, args)
      return true
    } catch (e) {
      job.logLine(`npm 安装失败（registry=${registry || '默认'}）：${e.message}${registry ? '，回退官方源重试' : ''}`)
    }
  }
  return false
}

// 全局 npm 安装：npm i -g --prefix <全局根> @deepseek-ai/dsh@<ver>（npmmirror 优先、官方回退）
// 返回全局根（<root>/node_modules/@deepseek-ai/dsh 即安装处）；已装同版本时跳过
async function installDshGlobal(job, nodeBin, globalRoot) {
  const version = (job.opts && job.opts.dshVersion) || Config.dshVersion || 'latest' // 无指定版本一律装 latest（首次安装不落老版本）
  const spec = version === 'latest' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${version}`
  const pkgDir = path.join(globalRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const binPath = path.join(pkgDir, 'lib', 'bin.js')
  const installed = readInstalledVersion(pkgDir)
  if (installed && version !== 'latest' && installed === version) {
    job.logLine(`全局 npm 已安装 v${installed}（与目标版本一致），跳过安装`)
    rememberGlobalRoot(globalRoot)
    return globalRoot
  }
  // 落点可写性预检：给用户一条可行动的报错，而不是 npm 的深层错误
  try {
    const probe = path.join(globalRoot, '.dshl-write-test-' + Date.now())
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
  } catch (e) {
    throw new Error(`npm 全局目录不可写：${globalRoot}（${e.message}）`)
  }
  const registries = Config.npmRegistry ? [Config.npmRegistry] : ['https://registry.npmmirror.com', null]
  let lastErr = null
  // 解析 npm CLI：nodeBin 可能是 PATH 上的裸 'node'，先解析真实可执行路径再找同目录 npm-cli.js
  let npmCli = npmCliFor(nodeBin)
  if (!npmCli && nodeBin) {
    try {
      const res = await runExec(nodeBin, ['-p', 'process.execPath'], { timeout: 10000 })
      const real = String(res.stdout || '').trim()
      if (real) npmCli = npmCliFor(real)
    } catch { /* 忽略，走 cmd.exe 兜底 */ }
  }
  if (!npmCli) job.logLine('警告：所选 Node 未内置 npm，回退到 PATH 中的 npm 命令')
  for (const registry of registries) {
    if (job.aborted) throw job.cancelledError()
    const args = ['install', '-g', '--prefix', globalRoot, '--no-audit', '--no-fund', '--loglevel=info']
    if (registry) args.push('--registry', registry)
    args.push(spec)
    job.logLine(`npm install -g（registry=${registry || '默认'}）：${spec} → ${globalRoot}`)
    try {
      await runNpmInstall(job, nodeBin, npmCli, args)
      if (!fs.existsSync(binPath)) throw new Error(`安装后未找到 ${binPath}`)
      job.logLine(`全局 npm 安装完成：${pkgDir}`)
      rememberGlobalRoot(globalRoot)
      return globalRoot
    } catch (e) {
      lastErr = e
      job.logLine(`npm install -g 失败（registry=${registry || '默认'}）：${e.message}${registry ? '，回退官方源重试' : ''}`)
    }
  }
  throw lastErr || new Error('npm install -g 失败')
}

// ---------- pnpm 安装（用户全局；Corepack 优先对齐，失败回退 npm 全局） ----------

function readPackageVersion(pkgDir, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    return pkg && pkg.name === name && pkg.version ? String(pkg.version) : ''
  } catch { return '' }
}

function corepackCliFor(nodeBin) {
  const cli = path.join(path.dirname(nodeBin), 'node_modules', 'corepack', 'dist', 'corepack.js')
  return fs.existsSync(cli) ? cli : null
}

function parsePnpmVersionText(text) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text || ''))
  return m ? m[1] : ''
}

function pnpmEntryFor(pkgDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    const bin = pkg && pkg.bin && typeof pkg.bin.pnpm === 'string' ? pkg.bin.pnpm : 'bin/pnpm.mjs'
    return path.join(pkgDir, bin)
  } catch {
    return path.join(pkgDir, 'bin', 'pnpm.mjs')
  }
}

async function runPnpmEntryVersion(job, nodeBin, pnpmEntry) {
  const res = await runExec(nodeBin, [pnpmEntry, '--version'], { timeout: 30000, onAbort: job.setAbort })
  return parsePnpmVersionText(res.stdout)
}

// 用 Node 自带的 Corepack 对齐/安装固定版本；enableShim 只在 PATH 上还没有 pnpm shim 时使用。
async function alignPnpmWithCorepack(job, nodeBin, expectedVersion, enableShim) {
  const corepackCli = corepackCliFor(nodeBin)
  if (!corepackCli) return false
  try {
    if (enableShim) {
      const nodeDir = path.dirname(nodeBin)
      job.logLine('Corepack：在 ' + nodeDir + ' 启用 pnpm shim')
      await runExec(nodeBin, [corepackCli, 'enable', '--install-directory', nodeDir, 'pnpm'], { timeout: 60000, onAbort: job.setAbort })
    }
    job.logLine('Corepack：把 pnpm 对齐到 v' + expectedVersion)
    await runExec(nodeBin, [corepackCli, 'install', '-g', 'pnpm@' + expectedVersion], { timeout: 300000, onAbort: job.setAbort })
    prependProcessPath([path.dirname(nodeBin)])
    return true
  } catch (e) {
    job.logLine('Corepack 对齐失败：' + e.message)
    return false
  }
}

// npm 全局安装 pnpm 到用户 PATH 上的全局根（与 DSH 使用同一个 root）。
async function installPnpmGlobal(job, nodeBin, globalRoot, expectedVersion) {
  const pkgDir = path.join(globalRoot, 'node_modules', 'pnpm')
  const pnpmEntry = pnpmEntryFor(pkgDir)
  if (readPackageVersion(pkgDir, 'pnpm') === expectedVersion && fs.existsSync(pnpmEntry)) {
    const got = await runPnpmEntryVersion(job, nodeBin, pnpmEntry)
    if (got === expectedVersion) {
      job.logLine('全局 npm 已安装 pnpm v' + expectedVersion + '（' + pkgDir + '），跳过安装')
      return globalRoot
    }
  }
  try {
    const probe = path.join(globalRoot, '.dshl-write-test-' + Date.now())
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
  } catch (e) {
    throw new Error('npm 全局目录不可写：' + globalRoot + '（' + e.message + '）')
  }
  let npmCli = npmCliFor(nodeBin)
  if (!npmCli && nodeBin) {
    try {
      const res = await runExec(nodeBin, ['-p', 'process.execPath'], { timeout: 10000 })
      const real = String(res.stdout || '').trim()
      if (real) npmCli = npmCliFor(real)
    } catch { /* 忽略，走 cmd.exe 兜底 */ }
  }
  if (!npmCli) job.logLine('警告：所选 Node 未内置 npm，回退到 PATH 中的 npm 命令')
  const registries = Config.npmRegistry ? [Config.npmRegistry] : ['https://registry.npmmirror.com', null]
  let lastErr = null
  for (const registry of registries) {
    if (job.aborted) throw job.cancelledError()
    const args = ['install', '-g', '--prefix', globalRoot, '--no-audit', '--no-fund', '--loglevel=info']
    if (registry) args.push('--registry', registry)
    args.push('pnpm@' + expectedVersion)
    job.logLine('npm install -g（registry=' + (registry || '默认') + '）：pnpm@' + expectedVersion + ' → ' + globalRoot)
    try {
      await runNpmInstall(job, nodeBin, npmCli, args)
      if (!fs.existsSync(pnpmEntry)) throw new Error('安装后未找到 ' + pnpmEntry)
      const got = await runPnpmEntryVersion(job, nodeBin, pnpmEntry)
      if (got !== expectedVersion) throw new Error('pnpm 版本校验失败：期望 ' + expectedVersion + '，实际 ' + (got || '空'))
      job.logLine('pnpm 全局安装完成：' + pkgDir)
      prependProcessPath([globalRoot])
      return globalRoot
    } catch (e) {
      lastErr = e
      job.logLine('npm install -g pnpm 失败（registry=' + (registry || '默认') + '）：' + e.message + (registry ? '，回退官方源重试' : ''))
    }
  }
  throw lastErr || new Error('npm install -g pnpm 失败')
}

async function ensureNodeBin(job, nodeBin) {
  if (nodeBin) return nodeBin
  const { detectEnv } = require('./env-detect')
  const report = await detectEnv(false)
  if (!report.node || report.node.status !== 'ok' || !report.node.path) throw new Error('需要先安装 Node.js')
  // node 可能是 PATH 上的裸命令；先解析成绝对路径，Corepack/npm 解析才可靠。
  try {
    const res = await runExec(report.node.path, ['-p', 'process.execPath'], { timeout: 10000 })
    const real = String(res.stdout || '').trim()
    if (real) return real
  } catch { /* 保留探测路径 */ }
  return report.node.path
}

// 安装/对齐 pnpm：先看 PATH 上是否已命中期望版本；Corepack 可用时优先对齐，否则回退 npm 全局安装。
async function installPnpm(job, nodeBin, preferredGlobalRoot) {
  const expectedVersion = (job.opts && job.opts.pnpmVersion) || Config.pnpmVersion || DEFAULT_PNPM_VERSION
  const envDetect = require('./env-detect')
  let detected = await envDetect.detectPnpm({ expectedVersion })
  if (detected.status === 'ok') {
    job.logLine('pnpm 已就绪：v' + detected.version + '（' + (detected.source || 'path') + (detected.path ? ' · ' + detected.path : '') + '）')
    return { globalRoot: preferredGlobalRoot, detected }
  }
  job.logLine('pnpm 未就绪：' + detected.detail + (detected.path ? ' · ' + detected.path : ''))

  if (detected.source === 'corepack') {
    // 版本读不出来通常说明 shim 目标已失效；此时需要重新生成 shim，而不仅是切版本。
    const repairShim = !detected.version
    if (await alignPnpmWithCorepack(job, nodeBin, expectedVersion, repairShim)) {
      detected = await envDetect.detectPnpm({ expectedVersion })
      if (detected.status === 'ok') {
        job.logLine('pnpm 已通过 Corepack 对齐：v' + detected.version)
        return { globalRoot: preferredGlobalRoot, detected }
      }
    }
  } else if (!detected.path && corepackCliFor(nodeBin)) {
    if (await alignPnpmWithCorepack(job, nodeBin, expectedVersion, true)) {
      detected = await envDetect.detectPnpm({ expectedVersion })
      if (detected.status === 'ok') {
        job.logLine('pnpm 已通过 Corepack 安装并启用：v' + detected.version)
        return { globalRoot: preferredGlobalRoot, detected }
      }
    }
  }

  const globalRoot = preferredGlobalRoot || await resolveGlobalRoot(nodeBin)
  await installPnpmGlobal(job, nodeBin, globalRoot, expectedVersion)
  detected = await envDetect.detectPnpm({ expectedVersion })
  if (detected.status !== 'ok') {
    job.logLine('警告：pnpm 已安装，但当前 PATH 命中的不是期望版本（' + detected.detail + (detected.path ? ' · ' + detected.path : '') + '）')
  } else {
    job.logLine('pnpm 已就绪：v' + detected.version + '（' + (detected.source || 'path') + (detected.path ? ' · ' + detected.path : '') + '）')
  }
  return { globalRoot, detected }
}

// 已装全局 DSH 版本（npm i -g 落点）
function readInstalledVersion(pkgDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    return (pkg && pkg.name === '@deepseek-ai/dsh' && pkg.version) || ''
  } catch { return '' }
}

// 解析 npm 全局根：优先"当前生效的那一份 DSH 所在的前缀"（装到哪儿就更新哪儿，避免两份 DSH）；
// 没有已装全局版时按其真实 prefix（与用户命令行 npm 完全一致）；问不到才用默认值兜底
async function resolveGlobalRoot(nodeBin) {
  if (process.env.DSHL_NPM_GLOBAL_ROOT) return process.env.DSHL_NPM_GLOBAL_ROOT // 测试覆盖
  // 已装的全局 DSH 优先：npm 的前缀与当前生效的安装可能不是同一个目录（zip 版 Node 与 MSI 混装、
  // PATH 顺序变化、用户改过 .npmrc prefix）——那时按 npm 前缀再装一份会出现两个 DSH，
  // "PATH 上生效的工具链唯一"就破了。形态不是 global（托管/npx/源码）时不受影响，走下面的 npm 前缀。
  const live = liveGlobalPrefix()
  if (live) {
    log('npm 全局根：沿用当前生效的全局安装 ' + live)
    return live
  }
  const fallback = npmGlobalRoot()
  const candidates = []
  try {
    const r = await runExec('npm', ['config', 'get', 'prefix'], { timeout: 20000 })
    if (r.stdout && r.stdout.trim()) candidates.push(String(r.stdout).trim())
  } catch { /* 无系统 npm */ }
  if (nodeBin) {
    const cli = npmCliFor(nodeBin)
    if (cli) {
      try {
        const r = await runExec(nodeBin, [cli, 'config', 'get', 'prefix'], { timeout: 20000 })
        if (r.stdout && r.stdout.trim()) candidates.push(String(r.stdout).trim())
      } catch { /* 忽略 */ }
    }
  }
  const found = candidates.find((p) => p && /[/\\]/.test(p))
  return found || fallback
}

// 托管目录安装（回退路径）：原子安装，永远装到 dsh-new，成功后毫秒级切换；旧版保留到切换成功
async function installDshManaged(job, nodeBin) {
  const dshDir = path.join(runtimeBase(), 'dsh')
  const freshDir = path.join(runtimeBase(), 'dsh-new')
  const oldDir = path.join(runtimeBase(), 'dsh-old')
  const version = (job.opts && job.opts.dshVersion) || Config.dshVersion || 'latest' // 无指定版本一律装 latest（首次安装不落老版本）
  const spec = version === 'latest' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${version}`
  try { fs.rmSync(freshDir, { recursive: true, force: true }) } catch { /* noop */ }
  try { fs.rmSync(oldDir, { recursive: true, force: true }) } catch { /* noop */ }
  fs.mkdirSync(path.dirname(freshDir), { recursive: true })
  try {
    const npmOk = await npmInstallTo(job, nodeBin, freshDir, spec)
    if (!npmOk) throw new Error('DSH 安装失败（npmmirror 镜像与 npm 官方源均未成功）')
    // 原子切换：旧版 → dsh-old（备份）→ dsh-new → dsh → 删除备份
    if (fs.existsSync(dshDir)) fs.renameSync(dshDir, oldDir)
    fs.renameSync(freshDir, dshDir)
    try { fs.rmSync(oldDir, { recursive: true, force: true }) } catch { /* 备份删不掉不影响 */ }
    job.logLine('DSH 目录已原子切换完成')
    return dshDir
  } catch (e) {
    try { fs.rmSync(freshDir, { recursive: true, force: true }) } catch { /* noop */ }
    throw e
  }
}

/**
 * 存量收敛（**只处理 DSH 自己那一份**）：新版在全局根装好并校验通过之后，清掉用户级 Node 目录里
 * 那份旧 DSH（包目录 + dsh/dsh.cmd/dsh.ps1 三个 shim）。不做这一步就会出现"两份 DSH"——探测候选根
 * 同时包含用户级 Node 目录与全局根，于是可能"启动的是旧的、更新的是新的"。
 *
 * 边界（按约定）：
 *  - 只删 DSH；目录里其他全局包一律不碰、不迁移（跨 Node 大版本时原生模块 ABI 会变），只如实列账；
 *  - 旧 Node 目录本身不删（那是能跑的 Node，也在用户 PATH 上；删它属于侵入），只报告它还在；
 *  - 校验通过之前绝不删（否则会出现"旧的没了、新的没装好"）。
 */
function cleanupLegacyDshInUserNodeDir(job, newPrefix) {
  try {
    if (!IS_WIN && !process.env.DSHL_USER_NODE_DIR) return
    const oldDir = userNodeDir()
    if (!oldDir) return
    const nm = path.join(oldDir, 'node_modules')
    const oldPkg = path.join(nm, '@deepseek-ai', 'dsh')
    if (!fs.existsSync(path.join(oldPkg, 'package.json'))) return
    if (newPrefix && path.resolve(oldDir).toLowerCase() === path.resolve(newPrefix).toLowerCase()) return // 同一处，不误删
    fs.rmSync(oldPkg, { recursive: true, force: true })
    let shims = 0
    for (const name of ['dsh', 'dsh.cmd', 'dsh.ps1']) {
      try { fs.unlinkSync(path.join(oldDir, name)); shims++ } catch { /* 没有就算了 */ }
    }
    job.logLine(`已清理旧残留：${oldPkg}${shims ? ` + ${shims} 个 dsh shim` : ''}（新版已装在 ${newPrefix || '全局根'} 并通过校验）`)
    const others = nodeDirGlobalPackages(oldDir).filter((g) => !isDistributionPackage(g))
    if (others.length) {
      job.logLine(`旧 Node 目录仍保留（${oldDir}）：里面还有 ${others.length} 个全局包，按约定不迁移、也不删除：${others.slice(0, 8).join('、')}${others.length > 8 ? ' 等' : ''}`)
    } else {
      job.logLine(`旧 Node 目录已无其他全局包（${oldDir}）；目录与 PATH 项保留，如需清理可在环境页处理`)
    }
  } catch (e) {
    job.logLine('旧残留清理失败（不影响本次安装）：' + (e && e.message ? e.message : String(e)))
  }
}

// DSH 安装主入口：优先全局 npm（统一渠道）；失败回退托管目录（旧逻辑兜底）。
// 返回 { prefix, kind }：prefix 是落位根（全局= npm 前缀，托管=托管包目录），kind 供后续步骤区分
// （只有全局安装才有"npm 前缀目录要进用户 PATH"这一步）。
async function installDsh(job, nodeBin, resolvedGlobalRoot) {
  try {
    const globalRoot = resolvedGlobalRoot || await resolveGlobalRoot(nodeBin)
    const prefix = await installDshGlobal(job, nodeBin, globalRoot)
    return { prefix, kind: 'global' }
  } catch (e) {
    job.logLine(`全局 npm 安装失败（回退托管目录）：${e.message}`)
    return { prefix: await installDshManaged(job, nodeBin), kind: 'managed' }
  }
}

/**
 * 落点自检（v1.4.4 事故的直接教训）：原来的验收是**自证**——dsh-verify 拿安装侧自己的 prefix 复验，
 * 必然通过，却证明不了"探测侧也找得到它"。这里改用独立于记账值的判据再确认一次：
 *   ① 落点就是 npm 默认全局根（%APPDATA%\npm 等）→ 探测侧的默认候选；
 *   ② 落点本身是一个 Node 安装目录（npm 内建前缀 = node.exe 所在目录）→ 探测侧的 Node 目录候选；
 *   ③ npm 自己报的 prefix 就是它 → 探测侧尾查问的正是这个。
 * 三条都不成立才记一行警告（宁可少报也不误报：候选根与 npm 的前缀都列出来，便于当场定位）。
 */
async function checkLandingFindable(job, kind, prefix, nodeBin) {
  try {
    if (!prefix || kind !== 'global') return
    const envDetect = require('./env-detect')
    const norm = (p) => { try { return path.resolve(String(p)).toLowerCase() } catch { return String(p).toLowerCase() } }
    const target = norm(prefix)
    if (norm(npmGlobalRoot()) === target) return
    const nodeBins = IS_WIN ? ['node.exe'] : [path.join('bin', 'node')]
    if (nodeBins.some((b) => fs.existsSync(path.join(prefix, b)))) return
    // 问 npm 时按"所选 Node 自带的 npm"与"PATH 上的 npm"各问一次：安装侧 resolveGlobalRoot 是先 PATH 后
    // nodeBin，两种答案都算命中，避免因为顺序差异误报
    const asked = [await envDetect.readNpmPrefix(nodeBin), await envDetect.readNpmPrefix(null)]
    if (asked.some((p) => p && norm(p) === target)) return
    job.logLine(`警告：安装落点不在环境探测的候选根内（落点 ${prefix}；npm 报的前缀 ${asked.filter(Boolean).join(' / ') || '未知'}）——若随后报"未检测到 DeepSeek Harness"，请把这一行连同诊断报告一起反馈`)
  } catch { /* 自检失败不影响安装本身 */ }
}

async function verifyDsh(job, nodeBin, prefix) {
  const dshBin = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(dshBin)) throw new Error(`DSH 入口缺失：${dshBin}`)
  const res = await runExec(nodeBin, [dshBin, '--version'], { timeout: 60000, onAbort: job.setAbort })
  const ver = String(res.stdout || '').trim()
  if (!/^\d/.test(ver)) throw new Error(`DSH 验证失败：--version 输出异常（${ver || '空'}）`)
  job.logLine(`DSH 验证通过：v${ver}`)
  return dshBin
}

async function installPlugin(job) {
  const src = ASSETS_DIR ? path.join(ASSETS_DIR, 'plugins', 'dsh-notify.mjs') : ''
  const dest = path.join(HOME, 'plugins', 'dsh-notify', 'dsh-notify.mjs')
  if (!src || !fs.existsSync(src)) throw new Error(`插件资产缺失：${src}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  job.logLine(`通知插件安装完成：${dest}`)
}

// ---------- 状态机 ----------

let currentJob = null
let jobSeq = 0

const KIND_LABELS = { source: '源码版', global: '全局 npm 安装', npx: 'npx 缓存', managed: '托管安装' }

// dsh-npm 阶段预估耗时：默认种子值（npm 安装 3-6 分钟，取 4 分钟为种子；EWMA 学习后贴近本机真实水平）；
// 真实耗时会在每台机器上持续学习（EWMA 平滑），首装之后即贴近本机真实水平
const NPM_STAGE_ESTIMATE_MS = 240000
// 各阶段名义耗时（与 buildStages 权重一致；Node 内置包解压秒级 → 名义 10s；dsh-npm 用学习值）
const STAGE_NOMINAL_MS = { 'node-dl': 10000, 'node-ex': 10000, 'pnpm': 30000, 'dsh-npm': NPM_STAGE_ESTIMATE_MS, 'dsh-verify': 5000, 'plugin': 3000 }

// 进度展示缓动：当前为纯线性（EASE_MIX=0，显示=真实进度）。
//   历史实验：'in'（加速冲线）/ 'inout'（两头慢）均因体感与剩余时间不一致被否——线性最诚实。
//   如需恢复缓动：EASE_STYLE='in'|'inout'，EASE_MIX>0（∈[0,1]，与线性混合度）
const EASE_STYLE = 'in'
const EASE_MIX = 0
const EASE_POW = 1.6
function easePercent(raw) {
  const t = Math.max(0, Math.min(1, raw / 100))
  if (!EASE_MIX) return raw
  const s = EASE_STYLE === 'inout' ? t * t * (3 - 2 * t) : Math.pow(t, EASE_POW)
  return ((1 - EASE_MIX) * t + EASE_MIX * s) * 100
}

// 安装统计（本机学习值）：~/.dsh/dshl-runtime/install-stats.json
function installStatsPath() {
  return path.join(runtimeBase(), 'install-stats.json')
}
function loadInstallStats() {
  try {
    const s = JSON.parse(fs.readFileSync(installStatsPath(), 'utf8'))
    const ms = Number(s.dshNpmMs)
    // 下限 60s：旧版（pnpm 快路径）学习值 ~40s 会导致 npm 安装期间进度条提前跑满；EWMA 会逐步校正
    if (Number.isFinite(ms) && ms > 10000) return { dshNpmMs: Math.max(60000, Math.round(ms)) }
  } catch { /* 首次安装或文件损坏 */ }
  return { dshNpmMs: NPM_STAGE_ESTIMATE_MS }
}
function saveInstallStats(s) {
  try {
    fs.mkdirSync(path.dirname(installStatsPath()), { recursive: true })
    fs.writeFileSync(installStatsPath(), JSON.stringify(s))
  } catch { /* 写失败不影响安装 */ }
}
// 学习真实耗时：EWMA 0.6×旧值 + 0.4×本次实际（单次波动只影响四成，越装越准）
function learnNpmDuration(actualMs) {
  const s = loadInstallStats()
  s.dshNpmMs = Math.round(s.dshNpmMs * 0.6 + actualMs * 0.4)
  saveInstallStats(s)
  return s.dshNpmMs
}

// 阶段权重由 STAGE_NOMINAL_MS 自动计算（改种子/学习值无需手调）：
// Node 阶段（内置包，秒级~一分钟）占小块；DSH 主程序安装（npm，数分钟）是绝对大头；尾部验证/插件小块
const STAGE_LABELS = {
  'node-dl': '准备 Node.js',
  'node-ex': '校验并安装 Node.js', // 官方 MSI 走 msiexec；zip 兜底是解压落位 —— 两种都算"安装"
  pnpm: '安装 pnpm（用户全局）',
  'dsh-npm': '安装 DeepSeek Harness 主程序',
  'dsh-verify': '验证 DeepSeek Harness',
  plugin: '安装桌面通知',
}
// 安装项归一化：安装 Node/DSH 时自动带上 pnpm；单独安装 pnpm 时复用当前已就绪的 Node。
function normalizeInstallItems(items) {
  const valid = ['node', 'pnpm', 'dsh', 'plugin']
  const list = [...new Set((items || []).filter((i) => valid.includes(i)))]
  if ((list.includes('node') || list.includes('dsh')) && !list.includes('pnpm')) list.push('pnpm')
  return list
}
function buildStages(items) {
  const order = ['node-dl', 'node-ex', 'pnpm', 'dsh-npm', 'dsh-verify', 'plugin']
  const wanted = order.filter((id) => {
    if (id === 'node-dl' || id === 'node-ex') return items.includes('node')
    if (id === 'pnpm') return items.includes('pnpm')
    if (id === 'dsh-npm' || id === 'dsh-verify') return items.includes('dsh')
    return items.includes('plugin')
  })
  if (!wanted.length) return []
  const total = wanted.reduce((sum, id) => sum + (STAGE_NOMINAL_MS[id] || 10000), 0)
  const stages = []
  let acc = 0
  wanted.forEach((id, i) => {
    acc += STAGE_NOMINAL_MS[id] || 10000
    const isLast = i === wanted.length - 1
    stages.push({
      id,
      label: STAGE_LABELS[id],
      start: i === 0 ? 0 : Math.round(((acc - (STAGE_NOMINAL_MS[id] || 10000)) / total) * 1000) / 10,
      end: isLast ? 100 : Math.round((acc / total) * 1000) / 10,
    })
  })
  return stages
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status, // running | done | failed | cancelled
    items: job.items,
    stages: job.stages.map((s) => ({ id: s.id, label: s.label, status: s.status })),
    currentStage: job.currentStage,
    percent: Math.round(easePercent(job.percent)), // 展示进度走缓动曲线（内部仍按真实进度计算）
    stageProgress: job.stageProgress || 0,
    stageText: job.stageText,
    startedAt: job.startedAt,
    estimateMs: job.estimateMs || null,
    estimateNpmMs: job.estimateNpmMs || null,
    stageNominalMs: STAGE_NOMINAL_MS,
    silent: !!(job.opts && job.opts.silent), // 静默任务（后台迁移）：完成时不自动启动服务
    migrate: !!(job.opts && job.opts.migrate), // 迁移任务：失败重试节流用
    nodeMode: job.nodeInstallMode || '', // Node 的实际安装方式（msi / zip-user / zip-managed / reuse）
    error: job.error || null,
  }
}

function pushJob(job, lines) {
  try { onPushFn({ job: publicJob(job), lines: lines || null }) } catch { /* noop */ }
}

let pendingLines = []
let flushTimer = null
function flushPending() {
  if (!currentJob || !pendingLines.length) return
  const lines = pendingLines.splice(0, pendingLines.length)
  try { onPushFn({ job: publicJob(currentJob), lines }) } catch { /* noop */ }
}
function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = null; flushPending() }, 120)
}

function startInstall(items, opts = {}) {
  if (currentJob && currentJob.status === 'running') {
    const e = new Error('已有安装任务正在进行')
    e.alreadyRunning = true
    throw e
  }
  const list = normalizeInstallItems(items)
  if (!list.length) throw new Error('没有需要安装的项目')
  const nodePlan = nodeReplacePlan(list)
  const buildList = nodePlan.list
  const stageDefs = buildStages(buildList)
  const stats = loadInstallStats()
  const estimateNpmMs = stats.dshNpmMs
  const estimateMs = stageDefs.reduce((sum, s) => sum + (s.id === 'dsh-npm' ? estimateNpmMs : (STAGE_NOMINAL_MS[s.id] || 10000)), 0)
  const job = {
    id: ++jobSeq,
    startedAt: Date.now(),
    estimateMs,
    estimateNpmMs,
    items: buildList,
    opts: opts || {},
    nodePlan, // 换 Node 的本地事实（旧目录里有没有 DSH、还有哪些全局包）→ runJob 里据此记账与收尾
    nodeInstallMode: '', // 实际采用的安装方式：msi | zip-user | zip-managed | reuse（事后解释"装成了什么"）
    status: 'running',
    stages: stageDefs.map((s) => ({ ...s, status: 'pending' })),
    currentStage: -1,
    percent: 0,
    stageText: '',
    error: null,
    log: [], // 环形日志（最近 500 行）
    aborted: false,
    abortRef: { onAbort: null },
    child: null,
    stageProgress: 0,
    currentDownloadFile: null,
  }
  job.cancelledError = () => { const e = new Error('安装已取消'); e.cancelled = true; return e }
  job.logLine = (line) => {
    appendInstallLog(line)
    log(line)
    job.log.push({ t: Date.now(), line })
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500)
    pendingLines.push(line)
    scheduleFlush()
  }
  job.setAbort = (fn) => { job.abortRef.onAbort = fn }
  job.pushProgress = () => {
    const s = job.stages[job.currentStage]
    if (!s) return
    job.percent = s.start + (s.end - s.start) * Math.min(1, Math.max(0, job.stageProgress || 0))
    job.stageText = s.label
    // 节流：整数百分比变化才推送，避免下载回调刷屏
    const pct = Math.round(job.percent)
    if (job._lastPushedPct !== pct) { job._lastPushedPct = pct; pushJob(job) }
  }
  job.enterStage = (idx) => {
    job.currentStage = idx
    job.stageProgress = 0
    for (let i = 0; i < job.stages.length; i++) {
      job.stages[i].status = i < idx ? 'done' : i === idx ? 'active' : 'pending'
    }
    const s = job.stages[idx]
    job.percent = s.start
    job.stageText = s.label
    job.logLine(`—— 阶段：${s.label} ——`)
    pushJob(job)
  }
  job.finishStage = () => {
    const s = job.stages[job.currentStage]
    if (s) { s.status = 'done'; job.stageProgress = 1; job.percent = s.end }
    pushJob(job)
  }
  // 阶段时钟：对没有真实进度回调的长阶段（dsh-npm），按预估耗时推进百分比。
  // 渐近爬升（永不停步）：frac = CAP × (1 − e^(−t/τ))，τ = est/2.5，CAP = 0.985。
  //   - 预估时刻 ≈ 阶段 88%，之后越爬越慢但绝不冻结（实际超时也不会卡死在某百分比）；
  //   - 阶段真正完成时 finishStage 直接跳到终点（跳幅很小）。
  job.startStageClock = (estMs) => {
    const s = job.stages[job.currentStage]
    if (!s) return null
    const CAP = 0.985
    const TAU = Math.max(1000, estMs / 2.5)
    job._stageClockStart = Date.now()
    const tick = () => {
      const t = Date.now() - job._stageClockStart
      const frac = CAP * (1 - Math.exp(-t / TAU))
      job.stageProgress = frac
      job.pushProgress()
    }
    tick()
    return setInterval(tick, 1000)
  }
  job.stopStageClock = (timer) => { if (timer) clearInterval(timer) }
  currentJob = job
  job.logLine(`开始一键安装：${buildList.join(', ')}`)
  pushJob(job)
  void runJob(job)
  return job
}

// 复用用户级 Node 之前先验版本：目录里有 node.exe ≠ 能用
// （用户可能把 Node 18 装在那儿，旧版启动器也可能留下过旧版本）。
// 判据与 env-detect 同源（DEFAULT_ENGINE_RANGE = ^22.19.0 || >=24.0.0）。
// 探测失败（拿不到版本）一律不复用：重装一次的成本远低于"装完仍报版本过低、重试无效"。
function decideUserNodeReuse(input) {
  const o = input || {}
  if (!o.exists) return { reuse: false, reason: 'no-existing' }
  if (typeof o.version !== 'string') return { reuse: false, reason: 'unknown' } // 非字符串一律当"拿不到版本"
  const clean = o.version.trim().replace(/^v/i, '')
  if (!clean) return { reuse: false, reason: 'unknown' }
  try {
    if (semver.satisfies(clean, o.range || envDetect.DEFAULT_ENGINE_RANGE, { includePrerelease: true })) {
      return { reuse: true, reason: 'ok' }
    }
  } catch { /* 版本串解析失败：按不可用处理 */ }
  return { reuse: false, reason: 'too-old' }
}

async function probeUserNodeVersion(nodeBin, job) {
  try {
    // runExec 解析成 { stdout, stderr }（不是裸字符串）——别再拼成 "[object Object]"
    const out = await runExec(nodeBin, ['-v'], { timeout: 15000 })
    const text = typeof out === 'string' ? out : (out && typeof out.stdout === 'string' ? out.stdout : '')
    return text.trim()
  } catch (e) {
    if (job) job.logLine('用户级 Node.js 版本探测失败：' + (e && e.message ? e.message : String(e)))
    return ''
  }
}

// 版本管理器探测的安全包装（探测本身出错不该影响安装决策）
function detectVersionManagerSafe() {
  try { return detectVersionManager() } catch { return '' }
}

// 当前探测到的可用 Node（取最近一次探测结果；还没探过就现探一次）。复用决策以此为准，
// 不轻信调用方传来的信息——界面上的按钮可能已经过期。
async function readDetectedNode() {
  try {
    const envDetect = require('./env-detect')
    let report = envDetect.cachedReport()
    if (!report) report = await envDetect.detectEnv(false)
    const node = report && report.node
    if (!node || node.status !== 'ok' || !node.path) return null
    return { path: node.path, version: String(node.version || '') }
  } catch { return null }
}

// 复用现有 Node 时的可执行文件：探测结果 → 调用方给的信息 → 官方 MSI 登记的位置（PATH 失效时的兜底）
async function findUsableNodeBin(job, installedMsi) {
  if (job.opts && job.opts.nodeBin) return job.opts.nodeBin
  const detected = await readDetectedNode()
  if (detected) return detected.path
  const dir = installedMsi && installedMsi.installPath
  if (dir) {
    const bin = path.join(dir, IS_WIN ? 'node.exe' : 'node')
    if (fs.existsSync(bin)) {
      const v = await probeUserNodeVersion(bin, job)
      if (decideUserNodeReuse({ exists: true, version: v }).reuse) return bin
    }
  }
  return ''
}

// 用户级 zip 安装（兜底路径）：落位 %LOCALAPPDATA%\Programs\nodejs，并让语义与官方 MSI 对齐
// （复刻那份 npmrc → 全局包同样落在 %APPDATA%\npm），最后写入用户 PATH。
async function installNodeUserLevel(job, stageIdx) {
  const dest = userNodeDir()
  const existing = path.join(dest, IS_WIN ? 'node.exe' : 'node')
  const hasExisting = fs.existsSync(existing)
  const probeFn = typeof job.nodeVersionProbe === 'function' ? job.nodeVersionProbe
    : (job.opts && typeof job.opts.nodeVersionProbe === 'function' ? job.opts.nodeVersionProbe : null)
  const probed = hasExisting ? (probeFn ? await probeFn(existing) : await probeUserNodeVersion(existing, job)) : ''
  const verdict = decideUserNodeReuse({ exists: hasExisting, version: probed })
  let nodeBin = null
  if (verdict.reuse) {
    job.logLine(`用户级 Node.js 已存在且版本可用（${probed}）：${dest}，跳过下载/解压`)
    nodeBin = existing
    job.finishStage()
    job.enterStage(stageIdx('node-ex'))
    job.finishStage()
  } else {
    if (verdict.reason === 'too-old') job.logLine(`用户级 Node.js ${probed} 不满足 ${envDetect.DEFAULT_ENGINE_RANGE}：忽略旧版本并重新安装`)
    else if (verdict.reason === 'unknown') job.logLine('用户级 Node.js 版本无法确认：不复用，重新安装')
    let backup = ''
    if (fs.existsSync(dest)) {
      backup = dest + '.old-' + Date.now()
      try { fs.renameSync(dest, backup); job.logLine('旧 Node 目录已移到备份：' + backup) }
      catch (e) { backup = ''; job.logLine('旧 Node 目录备份失败（继续覆盖安装）：' + (e && e.message ? e.message : String(e))) }
    }
    try {
      nodeBin = await installNode(job, dest, () => {
        job.finishStage()
        job.enterStage(stageIdx('node-ex'))
      })
    } catch (e) {
      if (backup) job.logLine('安装失败：旧目录保留在 ' + backup)
      throw e
    }
    if (backup) { try { fs.rmSync(backup, { recursive: true, force: true }) } catch { /* noop */ } }
    job.finishStage()
  }
  writeMsiEquivalentNpmrc(job, dest)
  await addToUserPath(job, [dest, npmGlobalRoot()], { prepend: true })
  return nodeBin
}

async function runJob(job) {
  const stageIdx = (id) => job.stages.findIndex((s) => s.id === id)
  let nodeBin = null
  let nodeDest = null
  let globalRoot = null
  try {
    if (job.items.includes('node')) {
      job.enterStage(stageIdx('node-dl'))
      const useUserLevel = userLevelNodeInstall()
      job.nodeInstallMode = 'zip-managed'
      if (useUserLevel) {
        // 1) 决策：复用优先 → 官方 MSI（默认）→ 用户级 zip（兜底）→ 拒绝（给出可行动作）
        const detectedNode = await readDetectedNode()
        const force = !!(job.opts && job.opts.forceNodeInstall)
        // 隔离脚本/测试可以注入探针来模拟"这个目录里是旧版本"：有探针时以它为准
        const probeFn = typeof job.nodeVersionProbe === 'function' ? job.nodeVersionProbe
          : (job.opts && typeof job.opts.nodeVersionProbe === 'function' ? job.opts.nodeVersionProbe : null)
        let nodeOk = !force && !!detectedNode
        let nodeVersion = detectedNode ? detectedNode.version : ''
        if (probeFn && detectedNode) {
          const userBin = path.join(userNodeDir(), IS_WIN ? 'node.exe' : 'node')
          const probed = await probeFn(userBin)
          nodeOk = !force && decideUserNodeReuse({ exists: true, version: probed }).reuse
          nodeVersion = String(probed || '').trim().replace(/^v/i, '')
        }
        const mode = (job.opts && job.opts.nodeInstallMode) || process.env.DSHL_NODE_INSTALL || Config.nodeInstallMode || 'msi'
        const installedMsi = job.opts && job.opts.installedMsi !== undefined ? job.opts.installedMsi : await readInstalledNodeMsi()
        // 版本合格还不够：注册表说装了、文件却不在（产品被破坏/手工删过）时，"复用"是兑现不了的。
        // 这里先探一次它登记的那个 node.exe，把"能不能真复用"作为决策输入 —— 免得决定复用了才发现没有可执行文件。
        const msiUsable = installedMsi && installedMsi.installPath
          ? decideUserNodeReuse({ exists: fs.existsSync(path.join(installedMsi.installPath, IS_WIN ? 'node.exe' : 'node')), version: await probeUserNodeVersion(path.join(installedMsi.installPath, IS_WIN ? 'node.exe' : 'node'), null) }).reuse
          : undefined
        const plan = decideNodeInstallPlan({
          mode,
          range: (job.opts && job.opts.engineRange) || envDetect.DEFAULT_ENGINE_RANGE,
          nodeOk,
          nodeVersion,
          installedMsi,
          msiUsable,
          versionManager: detectVersionManagerSafe(),
        })
        job.logLine(`Node 安装方式决策：${plan.action}（${plan.reason}${msiUsable === false ? '：注册表登记的 Node 找不到可执行文件' : ''}）`)
        if (job.nodePlan && job.nodePlan.dshInNodeDir) {
          job.logLine(`检测到全局 DSH 就在用户级 Node 目录里（${job.nodePlan.nodeDir}）：本次会自动带上 DSH，并在新版装好、校验通过后清理旧残留`)
        }
        if (job.nodePlan && job.nodePlan.otherGlobals.length) {
          const list = job.nodePlan.otherGlobals
          job.logLine(`该目录下另有 ${list.length} 个全局包（不迁移：跨 Node 大版本时原生模块 ABI 会变）：${list.slice(0, 8).join('、')}${list.length > 8 ? ' 等' : ''}`)
        }
        if (plan.action === 'refuse') {
          throw new Error(plan.reason === 'msi-broken'
            ? `本机注册了官方 Node.js v${plan.version}，但找不到它的可执行文件（安装可能被破坏或文件被删除）；`
              + '请在「应用和功能」里对 Node.js 执行「修复」或先卸载，然后重试（不会同时装第二个版本：那会让两个安装程序争用同一目录）'
            : `本机已通过官方 MSI 安装 Node.js v${plan.version}，不满足 DSH 要求 ${plan.range}；`
              + '请在「应用和功能」里升级 Node.js 后重试（不会同时装第二个版本：那会让两个安装程序争用同一目录）')
        }
        if (plan.action === 'reuse') {
          // 复用已有 Node：什么都不装（"不影响已装用户"的关键路径）
          const reuseBin = await findUsableNodeBin(job, installedMsi)
          if (!reuseBin) {
            throw new Error('检测到可用的 Node.js，但定位不到它的可执行文件；请在「应用和功能」里修复 Node.js 或改用用户级安装（设置 → 运行环境）后重试')
          }
          nodeBin = reuseBin
          job.nodeInstallMode = 'reuse'
          job.logLine(`沿用现有 Node.js（${plan.reason}${plan.version ? ' v' + plan.version : ''}）：${reuseBin}`)
          job.finishStage()
          job.enterStage(stageIdx('node-ex'))
          job.finishStage()
        } else if (plan.action === 'install-msi') {
          const r = await installNodeViaMsi(job, () => {
            job.finishStage()
            job.enterStage(stageIdx('node-ex'))
          })
          if (r.ok) {
            nodeBin = r.nodeBin
            job.nodeInstallMode = 'msi'
            job.finishStage()
            job.logLine('官方安装包已注册到「应用和功能」（与官网 .msi 一致，可修复/卸载）')
            // 机器 PATH 由 MSI 负责；用户 PATH 里的 %APPDATA%\npm（全局命令靠它才调得动）幂等确认一次
            await addToUserPath(job, [npmGlobalRoot()], { prepend: true })
          } else {
            // 2) 兜底：官方 MSI 用不了（策略禁止 / 用户取消授权 / 报错）→ 用户级 zip。
            //    语义保持一致（复刻 MSI 那份 npmrc → 全局包同样落在 %APPDATA%\npm），只少机器级注册。
            job.logLine(`官方安装包不可用（${r.detail}）：回退用户级安装（官网 .zip；全局包仍落在 ${npmGlobalRoot()}，不进「应用和功能」）`)
            nodeBin = await installNodeUserLevel(job, stageIdx)
            job.nodeInstallMode = 'zip-user'
          }
        } else {
          // install-user：版本管理器在场（不与它争 PATH）或显式配置成用户级
          job.logLine(plan.reason.startsWith('version-manager-')
            ? `检测到版本管理器 ${plan.reason.replace('version-manager-', '')}：改走用户级安装，避免与它争 PATH`
            : '按配置走用户级安装')
          nodeBin = await installNodeUserLevel(job, stageIdx)
          job.nodeInstallMode = 'zip-user'
        }
        job.logLine(`Node.js 就绪：${nodeBin}（方式：${job.nodeInstallMode}）`)
      } else {
        const tmpDest = path.join(runtimeBase(), 'node', '_installing-' + Date.now())
        try {
          nodeBin = await installNode(job, tmpDest, () => {
            job.finishStage()
            job.enterStage(stageIdx('node-ex'))
          })
          nodeDest = tmpDest
        } catch (e) {
          try { fs.rmSync(tmpDest, { recursive: true, force: true }) } catch { /* noop */ }
          throw e
        }
        job.finishStage()
        job.logLine(`Node.js 就绪：${nodeBin}`)
      }
    }
    if (nodeBin) prependProcessPath([path.dirname(nodeBin), npmGlobalRoot()])
    if (job.items.includes('pnpm')) {
      job.enterStage(stageIdx('pnpm'))
      nodeBin = await ensureNodeBin(job, nodeBin)
      // ensureNodeBin 之后 nodeBin 一定是绝对路径（裸 'node' 会被解析成真实 exe）→ 把它的目录补进进程 PATH，
      // 后续 npm 的原生模块生命周期脚本（cmd /c node …）才找得到 node
      if (nodeBin) prependProcessPath([path.dirname(nodeBin), npmGlobalRoot()])
      globalRoot = await resolveGlobalRoot(nodeBin)
      const pnpmResult = await installPnpm(job, nodeBin, globalRoot)
      if (pnpmResult && pnpmResult.globalRoot) globalRoot = pnpmResult.globalRoot
      job.finishStage()
    }
    if (job.items.includes('dsh')) {
      job.enterStage(stageIdx('dsh-npm'))
      nodeBin = await ensureNodeBin(job, nodeBin)
      // 阶段时钟按本机预估耗时渐近爬升（CAP 98.5% 封顶，永不冻结），npm 真正完成时 finishStage 跳到阶段终点
      const npmT0 = Date.now()
      const clock = job.startStageClock(job.estimateNpmMs)
      let prefix
      let dshKind = ''
      try {
        const r = await installDsh(job, nodeBin, globalRoot)
        prefix = r.prefix
        dshKind = r.kind
      } finally {
        job.stopStageClock(clock)
      }
      // 学习真实耗时：更新本机预估（EWMA），下次安装的进度/剩余时间更准
      const actualMs = Date.now() - npmT0
      const learned = learnNpmDuration(actualMs)
      job.logLine(`DSH 安装实际耗时 ${Math.round(actualMs / 1000)}s，本机预估已更新为 ${Math.round(learned / 1000)}s`)
      job.finishStage()
      job.enterStage(stageIdx('dsh-verify'))
      await verifyDsh(job, nodeBin, prefix)
      // 落点自检：独立确认"装到哪儿"能被探测侧找回（见 checkLandingFindable 注释）
      await checkLandingFindable(job, dshKind, prefix, nodeBin)
      // PATH 上生效的工具链唯一：npm 的 binstub（dsh / dsh.cmd）就落在 --prefix 目录，
      // 该目录必须在用户 PATH 上（否则新终端里没有 dsh 命令）。只加 npmGlobalRoot() 这个默认值
      // 会漏掉 zip 版 Node（前缀=node 目录）与自定义 .npmrc prefix 的机器；重复添加会被去重挡掉。
      if (dshKind === 'global') await addToUserPath(job, [prefix], { prepend: true })
      // 存量收敛：新版已装好并校验通过 → 清掉用户级 Node 目录里那份旧 DSH（只迁 DSH，其余全局包不碰）
      if (dshKind === 'global') cleanupLegacyDshInUserNodeDir(job, prefix)
      job.finishStage()
    }
    if (job.items.includes('plugin')) {
      job.enterStage(stageIdx('plugin'))
      await installPlugin(job)
      job.finishStage()
    }
    // 托管 Node 落位：把 _installing-<ts> 重命名为真实版本目录
    if (nodeBin && nodeDest) {
      const ver = await (async () => {
        try {
          const out = await runExec(nodeBin, ['-v'], { timeout: 10000 })
          return String(out.stdout || '').trim().replace(/^v/, '')
        } catch { return '' }
      })()
      const finalDest = path.join(runtimeBase(), 'node', ver || `ver-${Date.now()}`)
      try { fs.rmSync(finalDest, { recursive: true, force: true }) } catch { /* noop */ }
      fs.renameSync(nodeDest, finalDest)
      job.logLine(`托管 Node 落位：${finalDest}`)
    }
    job.status = 'done'
    job.percent = 100
    job.stageText = '环境安装完成'
    for (const s of job.stages) s.status = 'done'
    job.logLine('环境安装完成，即将启动服务')
    pushJob(job)
    flushPending()
    try { onDoneFn() } catch { /* noop */ }
  } catch (err) {
    job.child = null
    if (err && err.cancelled) {
      job.status = 'cancelled'
      job.error = '安装已取消'
      job.logLine('安装已取消')
    } else {
      job.status = 'failed'
      job.error = err && err.message ? err.message : String(err)
      job.logLine(`安装失败：${job.error}`)
      const s = job.stages[job.currentStage]
      if (s && s.status === 'active') s.status = 'error'
    }
    job.stageText = job.status === 'cancelled' ? '安装已取消' : '安装失败'
    pushJob(job)
    flushPending()
  } finally {
    try { job.abortRef.onAbort = null } catch { /* noop */ }
    job.child = null
  }
}

function cancelInstall() {
  const job = currentJob
  if (!job || job.status !== 'running') return false
  job.aborted = true
  if (job.child) killChildTree(job.child)
  try { if (job.abortRef.onAbort) job.abortRef.onAbort() } catch { /* noop */ }
  try { if (job.currentDownloadFile) fs.unlinkSync(job.currentDownloadFile) } catch { /* noop */ }
  job.logLine('收到取消请求')
  return true
}

function getJob() {
  if (!currentJob) return null
  return {
    job: publicJob(currentJob),
    log: currentJob.log.slice(-400),
  }
}

module.exports = {
  initInstaller,
  startInstall,
  cancelInstall,
  getJob,
  installLogPath,
  runtimeBase,
  KIND_LABELS,
  userNodeDir,
  npmGlobalRoot,
  rememberGlobalRoot,
  liveGlobalPrefix,
  nodeReplacePlan,
  nodeDirGlobalPackages,
  checkLandingFindable,
  decideNodeInstallPlan,
  interpretMsiResult,
  parseNodeJsRegQuery,
  readInstalledNodeMsi,
  detectVersionManager,
  cleanupLegacyDshInUserNodeDir,
  writeMsiEquivalentNpmrc,
  MSI_NPMRC_BYTES,
  resolveGlobalRoot,
  normalizeInstallItems,
  buildStages,
  DEFAULT_PNPM_VERSION,
  downloadToFile,
  decideUserNodeReuse,
  DEFAULT_DL_STALL_MS,
}
