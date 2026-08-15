// main.js — DeepSeek Harness Launcher（DSHL）主进程（Electron 托盘启动器/看护工具）
// 主平台 Windows；macOS / Linux 代码保留但未正式测试。
// 逻辑移植自早期 C# 原型：Program.cs（托盘/闪烁/配置/自启/自检）
//                          DshServer.cs（服务生命周期） TcpPid.cs（端口→PID） Bridge.cs（命令桥）
'use strict'

const { app, BrowserWindow, WebContentsView, Tray, Menu, Notification, shell, ipcMain, nativeImage, nativeTheme, clipboard, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const { spawn, execFile, execFileSync } = require('child_process')
const envDetect = require('./env-detect')
const envInstall = require('./env-install')
const updater = require('./updater')
const dshUpdater = require('./dsh-update')

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'

// ---------- 命令行参数 ----------
function parseArgs(argv) {
  const out = {}
  // dev: [electron.exe, '.', --flags...]；打包后: [app.exe, --flags...]
  let list = argv.slice(1)
  if (list.length && !list[0].startsWith('-')) list = list.slice(1)
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (a === '--selftest') out.selftest = true
    else if (a === '--port' && i + 1 < list.length) {
      const p = parseInt(list[++i], 10)
      if (Number.isInteger(p)) out.port = p
    } else if (a === '--host' && i + 1 < list.length) out.host = list[++i]
    else if (a === '--harness-root' && i + 1 < list.length) out.harnessRoot = list[++i]
  }
  return out
}
const args = parseArgs(process.argv)

const SELF_TEST = !!args.selftest
const HOST = args.host || '127.0.0.1'
// 运行端口：命令行 --port 优先；其次配置项（默认 3080）；自检固定 3999。
// 运行时可变（设置页"服务端口"），启动时按配置重算，切换后由 setPort 重启服务。
let PORT = args.port || (SELF_TEST ? 3999 : 3080)
let WEB_URL = `http://${HOST}:${PORT}`
const READY_TIMEOUT_SEC = 60

// 按当前配置重算运行端口（配置缺失/非法一律回退默认 3080）
function applyRuntimePort() {
  const p = args.port || (SELF_TEST ? 3999 : (Number.isInteger(Config.port) && Config.port >= 1024 && Config.port <= 65535 && Config.port !== 0 ? Config.port : 3080))
  if (p !== PORT) {
    PORT = p
    WEB_URL = `http://${HOST}:${PORT}`
    log('runtime port applied: ' + PORT)
  }
}

// ---------- 路径（DSH_HOME 缺省回退 ~/.dsh，与 DSH 自身一致） ----------
const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const HOME = SELF_TEST ? path.join(os.tmpdir(), 'dshl-selftest-home') : realHome
const AGENTS_HOME = SELF_TEST
  ? path.join(os.tmpdir(), 'dshl-selftest-agents')
  : (process.env.DSH_AGENTS_HOME || '')
const LOG_DIR = path.join(HOME, 'dshl-logs')
const TRAY_LOG = path.join(LOG_DIR, 'dshl.log')
const NOTIFY_DIR = path.join(LOG_DIR, 'notify')
const OUT_LOG = path.join(LOG_DIR, 'server.out.log')
const ERR_LOG = path.join(LOG_DIR, 'server.err.log')
const CONFIG_PATH = SELF_TEST
  ? path.join(os.tmpdir(), 'dshl-selftest-config.json')
  : path.join(HOME, 'dshl', 'config.json')
const SELFTEST_RESULT = path.join(os.tmpdir(), 'dshl-selftest-result.txt')
const ASSETS_DIR = path.join(__dirname, 'assets')
const WWWROOT = path.join(__dirname, 'wwwroot')
const OFFLINE_HTML = path.join(WWWROOT, 'offline.html')

// ---------- 配置 ----------
const Config = { zoom: 100, webZoom: 100, theme: 'light', notify: true, useSystemBrowser: false, autoRestart: true, tabsEnabled: false, port: 0, feedbackToken: '', windowWidth: 0, windowHeight: 0, webWindowWidth: 0, webWindowHeight: 0, webWindowMaximized: false, webWindowX: null, webWindowY: null, harnessRoot: '', nodePath: '', dshVersion: '0.1.0-rc.6', nodeMajor: 22, nodeMirror: '', npmRegistry: '', dshUpdateCheckedAt: 0, panelHideNotified: false }
let firstRun = false
let harnessRoot = ''

// ---------- 环境探测/安装（env-detect.js / env-install.js） ----------
let envReport = null
let envRefreshSeq = 0
let envForceRefreshInFlight = false

function initEnvRuntime() {
  envDetect.initEnv({ realHome: realHome, Config, log })
  envInstall.initInstaller({
    HOME: realHome,
    Config,
    ASSETS_DIR,
    log,
    onPush: pushEnv,
    onDone: () => {
      // 安装完成后：重新探测环境，就绪则自动启动服务；若探测暂未就绪（竞态/文件延迟），由 onTick 补启动
      void (async () => {
        await refreshEnv(true)
        if (envReady()) {
          log('environment ready after install, starting service')
          void handleStart()
        } else {
          startWhenReady = true
          log('environment not ready right after install, deferred start armed')
        }
      })()
    },
  })
}

async function refreshEnv(force = false) {
  // 序号守卫：并发检测时只允许"最新一次调用"的结果写入 envReport，
  // 防止安装期间发起的旧检测（读到半成品文件系统）晚于安装完成后的强制检测返回、把就绪状态覆盖回未就绪。
  const seq = ++envRefreshSeq
  if (force) envForceRefreshInFlight = true
  try {
    const report = await envDetect.detectEnv(force)
    if (force) envForceRefreshInFlight = false
    // 强制检测（安装完成后）在途期间，非强制调用返回的缓存结果一律不写入，等强制结果落定
    if (!force && envForceRefreshInFlight) return envReport
    if (seq !== envRefreshSeq) { log('env refresh result dropped (newer detection in flight)'); return envReport }
    const changed = !envReport || JSON.stringify(envReport) !== JSON.stringify(report)
    envReport = report
    // 环境状态每次变化都落一行完整诊断到日志（排查"面板显示与检测结果不一致"类问题的第一现场）
    if (changed) {
      const s = envDetect.envSummary(report)
      log(`ENV-DIAG ready=${s.ready} node=${s.node.status}/${s.node.version || '-'} dsh=${s.dsh.status}/${s.dsh.kind}/${s.dsh.version || '-'} plugin=${s.plugin.status} plan=${report.plan ? 'yes' : 'no'}`)
      if (!s.ready) log('ENV-DIAG issues: ' + (s.issues.length ? s.issues.join('；') : '(none)'))
      broadcastState()
    }
    return report
  } catch (err) {
    if (force) envForceRefreshInFlight = false
    log('env detect failed: ' + err.message)
    return envReport
  }
}

function envReady() {
  return !!(envReport && envReport.plan)
}

// 环境就绪后的补启动：安装完成时/用户点启动时环境未就绪 → 记下意图，onTick 检测到就绪后自动拉起
let startWhenReady = false

function maybeStartDeferred() {
  if (startWhenReady && envReady() && !server.running()) {
    startWhenReady = false
    log('environment became ready, starting deferred service')
    void handleStart()
  }
}

// 安装任务进度/日志推送（主进程 → 面板；面板未打开时由环形缓冲兜底，重开时快照恢复）
function pushEnv(patch) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('dsh:env', JSON.stringify(patch)) } catch { /* noop */ }
  }
}

// 日志轮转：超过 1MB 自动转存 .1/.2/.3，保留最近 3 份
const LOG_MAX_BYTES = 1024 * 1024
const LOG_KEEP = 3
function rotateFileSync(file, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP) {
  try {
    if (fs.statSync(file).size <= maxBytes) return
    for (let i = keep - 1; i >= 1; i--) {
      try { if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch { /* noop */ }
    }
    try { fs.renameSync(file, `${file}.1`) } catch { /* noop */ }
  } catch { /* 文件不存在 */ }
}

function log(message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    rotateFileSync(TRAY_LOG)
    // 本地时间戳（sv-SE 格式即 YYYY-MM-DD HH:mm:ss）；此前用 toISOString 是 UTC，排查时极易与系统时间对不上
    fs.appendFileSync(TRAY_LOG, `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${message}\n`)
  } catch { /* 日志失败不致命 */ }
}

function loadConfig() {
  firstRun = !fs.existsSync(CONFIG_PATH)
  try {
    if (!firstRun) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      if (cfg.theme === 'light' || cfg.theme === 'dark' || cfg.theme === 'system') Config.theme = cfg.theme
      if (typeof cfg.notify === 'boolean') Config.notify = cfg.notify
      if (typeof cfg.useSystemBrowser === 'boolean') Config.useSystemBrowser = cfg.useSystemBrowser
      if (typeof cfg.autoRestart === 'boolean') Config.autoRestart = cfg.autoRestart
      if (typeof cfg.tabsEnabled === 'boolean') Config.tabsEnabled = cfg.tabsEnabled
      if (Number.isInteger(cfg.port) && cfg.port >= 1024 && cfg.port <= 65535) Config.port = cfg.port
      if (typeof cfg.feedbackToken === 'string') Config.feedbackToken = cfg.feedbackToken
      if (Number.isInteger(cfg.windowWidth) && cfg.windowWidth >= 480) Config.windowWidth = cfg.windowWidth
      if (Number.isInteger(cfg.windowHeight) && cfg.windowHeight >= 600) Config.windowHeight = cfg.windowHeight
      // 独立窗口几何：尺寸（≥640×480）+ 最大化 + 位置（多显示器变更时打开侧校验回退居中）
      if (Number.isInteger(cfg.webWindowWidth) && cfg.webWindowWidth >= 640) Config.webWindowWidth = cfg.webWindowWidth
      if (Number.isInteger(cfg.webWindowHeight) && cfg.webWindowHeight >= 480) Config.webWindowHeight = cfg.webWindowHeight
      if (typeof cfg.webWindowMaximized === 'boolean') Config.webWindowMaximized = cfg.webWindowMaximized
      if (Number.isInteger(cfg.webWindowX) && Number.isInteger(cfg.webWindowY)) { Config.webWindowX = cfg.webWindowX; Config.webWindowY = cfg.webWindowY }
      if (typeof cfg.harnessRoot === 'string' && cfg.harnessRoot) Config.harnessRoot = cfg.harnessRoot
      if (typeof cfg.nodePath === 'string' && cfg.nodePath) Config.nodePath = cfg.nodePath
      if (typeof cfg.dshVersion === 'string' && cfg.dshVersion) Config.dshVersion = cfg.dshVersion
      if (Number.isInteger(cfg.nodeMajor)) Config.nodeMajor = cfg.nodeMajor
      if (typeof cfg.nodeMirror === 'string') Config.nodeMirror = cfg.nodeMirror
      if (typeof cfg.npmRegistry === 'string') Config.npmRegistry = cfg.npmRegistry
      if (Number.isFinite(cfg.dshUpdateCheckedAt) && cfg.dshUpdateCheckedAt > 0) Config.dshUpdateCheckedAt = cfg.dshUpdateCheckedAt
      if (typeof cfg.panelHideNotified === 'boolean') Config.panelHideNotified = cfg.panelHideNotified
    }
  } catch { log('config parse failed, using defaults') }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(Config, null, 2))
  } catch (err) { log('failed to save config: ' + err.message) }
}

function defaultHarnessRoot() {
  if (IS_WIN) {
    const legacy = 'E:\\deepseek-harness'
    if (fs.existsSync(legacy)) return legacy
  }
  return path.join(os.homedir(), 'deepseek-harness')
}

function resolveHarnessRoot() {
  const candidates = [Config.harnessRoot, args.harnessRoot].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
    log('configured harness root not found: ' + c)
  }
  return defaultHarnessRoot()
}

// ---------- 图标（彩色 DeepSeek 鲸鱼，托盘/任务栏/打包图标统一，不再做深浅色切换） ----------
let IconNormal = null
let IconBlank = null

function loadIcons() {
  if (IS_WIN) {
    IconNormal = nativeImage.createFromPath(path.join(ASSETS_DIR, 'ds.ico'))
    IconBlank = nativeImage.createFromPath(path.join(ASSETS_DIR, 'blank.ico'))
  } else {
    // macOS / Linux：彩色鲸鱼 PNG（不再用模板图，颜色以图为准）
    IconNormal = nativeImage.createFromPath(path.join(ASSETS_DIR, 'dsTemplate.png'))
    IconBlank = nativeImage.createFromPath(path.join(ASSETS_DIR, 'blankTemplate.png'))
  }
  if (!IconNormal || IconNormal.isEmpty()) log('tray icon missing: run `npm run build:assets` first')
}

function setTrayImage(img) {
  if (tray && img && !img.isEmpty()) { try { tray.setImage(img) } catch { /* noop */ } }
}

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function debounce(fn, ms) {
  let t = null
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

// ---------- 服务器（DshServer.cs + TcpPid.cs 移植） ----------
const server = {
  child: null,
  adoptedPid: 0,
  adoptedAlive: false,
  stopping: false,
  blockedReason: '',
  suggestedPort: 0,
  owned() { return !!this.child && this.child.exitCode === null && this.child.signalCode === null },
  running() { return this.owned() || (this.adoptedPid !== 0 && this.adoptedAlive) },
  displayPid() { return this.owned() ? this.child.pid : this.adoptedPid },
}

function portOpenAt(port) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy() } catch { /* noop */ } resolve(ok) }
    const sock = net.connect({ host: HOST, port })
    sock.setTimeout(400, () => finish(false))
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

function portOpen() {
  return portOpenAt(PORT)
}

// 从 start 起向上找第一个空闲端口（最多试 30 个，越界返回 0）：给"端口被占用"场景提供可直接切换的建议
async function findFreePort(start) {
  for (let i = 0; i < 30; i++) {
    const p = start + i
    if (p < 1024 || p > 65535) break
    if (!(await portOpenAt(p))) return p
  }
  return 0
}

function findListenPid() {
  return new Promise((resolve) => {
    if (IS_WIN) {
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (err) return resolve(0)
        for (const line of String(stdout).split(/\r?\n/)) {
          if (!line.includes('LISTENING')) continue
          const parts = line.trim().split(/\s+/)
          if (parts.length >= 5 && (parts[1] || '').endsWith(':' + PORT)) {
            const pid = parseInt(parts[parts.length - 1], 10)
            return resolve(Number.isInteger(pid) ? pid : 0)
          }
        }
        resolve(0)
      })
    } else {
      execFile('lsof', ['-nP', '-iTCP:' + PORT, '-sTCP:LISTEN', '-t'], { timeout: 8000 }, (err, stdout) => {
        if (err) return resolve(0)
        const first = String(stdout || '').trim().split(/\r?\n/)[0]
        const pid = parseInt(first, 10)
        resolve(Number.isInteger(pid) ? pid : 0)
      })
    }
  })
}

// 定位 node 运行时：macOS 图形进程 PATH 里通常没有 homebrew/nvm，逐个候选探测
function nodeCandidates() {
  const list = Config.nodePath ? [Config.nodePath] : []
  list.push('node')
  if (!IS_WIN) {
    const home = os.homedir()
    list.push(
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/opt/homebrew/opt/node/bin/node',
      '/usr/local/opt/node/bin/node',
      path.join(home, '.volta', 'bin', 'node'),
      path.join(home, '.n', 'bin', 'node'),
      path.join(home, '.nvm', 'current', 'bin', 'node'),
    )
    try {
      const nvmDir = path.join(home, '.nvm', 'versions', 'node')
      for (const v of fs.readdirSync(nvmDir).sort().reverse()) list.push(path.join(nvmDir, v, 'bin', 'node'))
    } catch { /* no nvm */ }
  }
  return list
}

async function findNode() {
  for (const c of nodeCandidates()) {
    const ok = await new Promise((resolve) => {
      try {
        execFile(c, ['-v'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
          resolve(!err && /^v\d+\./.test(String(stdout).trim()))
        })
      } catch { resolve(false) }
    })
    if (ok) { log('node runtime: ' + c); return c }
  }
  return 'node'
}

// HTTP 指纹探测：确认端口后面确实是 DeepSeek Harness Web 服务，而不是其他恰好占用该端口的程序。
// 根页面 HTML 含 "DeepSeek Harness" 标题字样（自检同款判定）；非 DSH → { ok: false }，绝不接管/误杀。
function probeDsh() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port: PORT })
    const buf = []
    let settled = false
    const done = (ok, reason) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* noop */ }
      resolve({ ok, reason })
    }
    sock.setTimeout(1500, () => done(false, 'timeout')) // 本地服务毫秒级响应；仅"占端口但不回 HTTP"的程序会等到超时
    sock.once('connect', () => {
      sock.write(`GET / HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUser-Agent: dshl-probe\r\nAccept: text/html\r\nConnection: close\r\n\r\n`)
    })
    sock.once('error', () => done(false, 'connect'))
    sock.on('data', (d) => buf.push(d))
    sock.once('close', () => {
      if (settled) return
      const text = Buffer.concat(buf).toString('utf8')
      done(/DeepSeek Harness/i.test(text), 'fingerprint')
    })
  })
}

async function startServer() {
  if (server.owned()) return true
  server.blockedReason = ''
  server.suggestedPort = 0
  if (await portOpen()) {
    // 端口被占用：先验证对方身份，是 DSH 才接管
    const probe = await probeDsh()
    if (probe.ok) {
      server.adoptedPid = await findListenPid()
      server.adoptedAlive = server.adoptedPid !== 0
      log(`detected existing DSH on port ${PORT} (PID ${server.adoptedPid}), adopting`)
      return true
    }
    const pid = await findListenPid()
    server.adoptedPid = 0
    server.adoptedAlive = false
    // 自动找下一个空闲端口作为建议，面板提供"换到该端口并启动"一键入口
    const suggested = await findFreePort(PORT + 1)
    server.suggestedPort = suggested
    server.blockedReason = suggested
      ? `端口 ${PORT} 被其他程序占用（PID ${pid || '未知'}），已拒绝接管；建议切换到空闲端口 ${suggested}（启动器面板可一键切换），或关闭占用程序`
      : `端口 ${PORT} 被其他程序占用（PID ${pid || '未知'}），已拒绝接管；附近端口均被占用，请关闭占用程序后重试`
    log(server.blockedReason + '；probe=' + (probe.reason || 'fingerprint-mismatch'))
    return false
  }
  server.adoptedPid = 0
  server.adoptedAlive = false

  // 环境前置检查：按探测结果取 Node 与 DSH 入口；缺失/版本不符时不再盲 spawn
  let report = envReport
  if (!report) {
    try { report = await envDetect.detectEnv(false); envReport = report } catch (err) { log('env detect failed: ' + err.message) }
  }
  if (!report || !report.plan) {
    const why = report && report.issues && report.issues.length ? report.issues.join('；') : '环境未就绪'
    log('environment not ready: ' + why)
    return false
  }
  const plan = report.plan
  if (!fs.existsSync(plan.dshBin)) {
    log('DSH bin not found: ' + plan.dshBin)
    if (plan.kind === 'source') log('（源码版需要先构建：在仓库运行 pnpm install && pnpm run build）')
    return false
  }
  const nodeCmd = plan.nodeCmd
  const env = { ...process.env, DSH_HOME: HOME }
  if (AGENTS_HOME) env.DSH_AGENTS_HOME = AGENTS_HOME
  let child
  try {
    child = spawn(nodeCmd, [plan.dshBin, 'web', '--host', HOST, '--port', String(PORT)], {
      cwd: plan.cwd || harnessRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    log('spawn failed: ' + err.message)
    return false
  }
  rotateFileSync(OUT_LOG)
  rotateFileSync(ERR_LOG)
  const outS = fs.createWriteStream(OUT_LOG, { flags: 'a' })
  const errS = fs.createWriteStream(ERR_LOG, { flags: 'a' })
  child.stdout.on('data', (d) => { try { outS.write(d) } catch { /* noop */ } })
  child.stderr.on('data', (d) => { try { errS.write(d) } catch { /* noop */ } })
  child.__starting = true
  child.on('exit', (code, signal) => {
    try { outS.end() } catch { /* noop */ }
    try { errS.end() } catch { /* noop */ }
    if (server.child !== child) return
    server.child = null
    if (server.stopping) return
    if (child.__starting) return // 启动阶段退出由 startServer 的等待循环报告失败
    log(`DSH exited unexpectedly (code ${code}${signal ? ', signal ' + signal : ''})`)
    startFlash()
    notify('DeepSeek Harness', '服务意外退出', WEB_URL)
    broadcastState()
    void maybeAutoRestart()
  })
  server.child = child
  log('starting DSH web (hidden window)')
  const deadline = Date.now() + READY_TIMEOUT_SEC * 1000
  while (Date.now() < deadline) {
    if (server.child !== child) return false // 已被 stop 打断
    if (child.exitCode !== null) return false
    if (await portOpen()) {
      child.__starting = false
      log(`DSH ready on ${WEB_URL} (PID ${child.pid})`)
      return true
    }
    await sleep(500)
  }
  log('DSH did not become ready in time')
  return false
}

function killPid(pid, force) {
  return new Promise((resolve) => {
    if (IS_WIN) {
      const a = force ? ['/F', '/T', '/PID', String(pid)] : ['/PID', String(pid)]
      execFile('taskkill', a, { windowsHide: true, timeout: 8000 }, () => resolve())
    } else {
      try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* noop */ }
      resolve()
    }
  })
}

async function stopServer() {
  if (server.owned()) {
    server.stopping = true
    const child = server.child
    const pid = child.pid
    await killPid(pid, false) // 优雅停止；Windows taskkill 不带 /F
    const exited = await new Promise((resolve) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (child.exitCode !== null || Date.now() - t0 > 1500) { clearInterval(iv); resolve(child.exitCode !== null) }
      }, 100)
    })
    if (!exited) await killPid(pid, true) // 超时强杀
    server.child = null
    server.stopping = false
    log(`DSH stopped (PID ${pid})`)
  } else if (server.adoptedPid !== 0) {
    const pid = server.adoptedPid
    await killPid(pid, false)
    await sleep(1000)
    if (await portOpen()) await killPid(pid, true)
    log(`adopted DSH stopped (PID ${pid})`)
    server.adoptedPid = 0
    server.adoptedAlive = false
  }
}

// 端口切换：重启自己拉起的服务到新端口（WEB_URL 已更新），并把所有打开的标签页重载到新地址
async function restartServerOnNewPort() {
  if (!server.owned()) return false
  await stopServer()
  const ok = await startServer()
  if (ok) {
    for (const t of webTabs) {
      const wc = t.view && t.view.webContents
      if (wc && !wc.isDestroyed()) { try { wc.loadURL(WEB_URL) } catch { /* noop */ } }
    }
  }
  return ok
}

// 自动重启看护：服务意外退出后自动拉起（设置页开关，默认开；10s 冷却 + 最多连续 5 次，防崩溃死循环）
let restartAttempts = 0
let lastRestartAt = 0
async function maybeAutoRestart() {
  if (!Config.autoRestart || reallyExit) return
  // 环境报告可能尚未建立（启动探测未完成/自检路径）：这里兜底探测一次再判断
  if (!envReport) {
    try { envReport = await envDetect.detectEnv(false) } catch { /* 保持 null，按未就绪跳过 */ }
  }
  if (!envReady()) { log('auto-restart skipped: environment not ready'); return }
  const now = Date.now()
  if (now - lastRestartAt < 10000) return
  if (restartAttempts >= 5) { log('auto-restart attempts exhausted (5)'); return }
  lastRestartAt = now
  restartAttempts++
  await sleep(3000) // 等端口彻底释放
  const ok = await startServer()
  if (ok) {
    restartAttempts = 0
    log('service auto-restarted')
    void refreshWebUiOnReady()
    broadcastState()
    notify('DeepSeek Harness', '服务已自动重启', WEB_URL)
  } else {
    log('auto-restart failed')
    broadcastState()
  }
}

// ---------- 通知 ----------
function notify(title, message, url) {
  if (SELF_TEST) { log('[notify] ' + title + ': ' + message); return } // 自检不弹真实通知
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title,
        body: message,
        icon: IconNormal && !IconNormal.isEmpty() ? IconNormal : undefined,
      })
      n.on('click', () => openDshOrPanel())
      n.show()
    } else {
      log(`[notify] ${title}: ${message}`)
    }
  } catch (err) { log('notification failed: ' + err.message) }
}

function notifyStartResult(ok) {
  if (ok && server.owned()) notify('DeepSeek Harness', `服务已就绪：${WEB_URL}`)
  else if (ok) notify('DeepSeek Harness', `检测到已在运行的服务（PID ${server.displayPid()}），已接管`)
  else if (server.blockedReason) notify('DeepSeek Harness', server.blockedReason)
  else if (envReady()) notify('DeepSeek Harness', '服务启动失败，请打开启动器面板查看日志')
  else notify('DeepSeek Harness', '运行环境未就绪，请打开启动器面板一键安装')
}

// 统一启动入口：面板按钮 / 托盘菜单 / 启动时共用
async function handleStart() {
  if (!envReport) {
    try { envReport = await envDetect.detectEnv(false) } catch { /* 保持 null */ }
  }
  if (!envReady()) {
    startWhenReady = true
    log('environment not ready, start skipped（面板"运行环境"页可一键安装；就绪后自动补启动）')
    broadcastState()
    return
  }
  startWhenReady = false
  const ok = await startServer()
  notifyStartResult(ok)
  if (ok) refreshWebUiOnReady()
  broadcastState()
}

// 统一"打开"入口：环境未就绪或端口被占用 → 打开启动器面板（一键安装/一键换端口入口）；否则 → 独立窗口
function openDshOrPanel() {
  if (envReady() && !server.blockedReason) openWebUi()
  else showPanel()
}

// ---------- 托盘 ----------
let tray = null

function buildTray() {
  if (!IconNormal || IconNormal.isEmpty()) { log('tray icon missing, tray disabled'); return }
  tray = new Tray(IconNormal)
  tray.setToolTip('DeepSeek Harness Launcher')
  tray.on('click', () => openDshOrPanel()) // 环境未就绪时单击打开面板（一键安装入口）
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示启动器面板', click: () => showPanel() },
    { label: '打开 DeepSeek Harness', click: () => openDshOrPanel() },
    { type: 'separator' },
    { label: '退出', click: () => { void requestExit() } },
  ]))
}

// ---------- 闪烁（QQ/微信式：图标 ↔ 空白交替；持续到用户点击托盘/打开窗口为止，不错过提醒） ----------
let flashTimer = null
let flashOn = false

function startFlash() {
  if (!flashTimer) flashTimer = setInterval(onFlashTick, 600)
}

function stopFlash() {
  if (flashTimer) { clearInterval(flashTimer); flashTimer = null }
  if (flashOn) { flashOn = false; setTrayImage(IconNormal) }
}

function onFlashTick() {
  flashOn = !flashOn
  setTrayImage(flashOn ? IconBlank : IconNormal)
}

// ---------- 开机自启（Electron 原生：Windows Run 注册表项名 = AppUserModelID；macOS 系统登录项） ----------
// 注意：Windows 上 getLoginItemSettings 是把注册表里存的命令行与"当前进程命令行"做比较，
// 本工具经 vbs 以 `electron.exe .` 启动，argv 是 "." 与注册表存的绝对路径对不上 → 永远判 false。
// 因此读写都显式传同一组 path/args，比较两端一致，开关才可靠。
function autostartEnabled() {
  try {
    if (IS_WIN && !app.isPackaged) {
      return app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath()] }).openAtLogin
    }
    return app.getLoginItemSettings().openAtLogin
  } catch { return false }
}

function setAutostart(enabled) {
  try {
    const opts = { openAtLogin: enabled }
    // 开发模式必须显式给出可执行文件与参数，否则 Windows 上无法正确匹配/删除注册表项
    if (!app.isPackaged) { opts.path = process.execPath; opts.args = [app.getAppPath()] }
    app.setLoginItemSettings(opts)
    log('autostart ' + (enabled ? 'enabled' : 'disabled'))
  } catch (err) { log('autostart failed: ' + err.message) }
}

// 迁移：删除旧 C# 版"启动"文件夹快捷方式；清理历史身份的旧注册表项（com.dsh.tray / com.dsh.launcher）。
// 注意：Electron 按 AppUserModelID 匹配注册表项，身份改名为 com.dshl.launcher 后旧项成为 API 无法清除的孤儿，
// 必须手动清一次；若旧项曾存在则保留"开机自启"意图（当前项缺失时重建）。
function migrateLegacyAutostart() {
  if (!IS_WIN || SELF_TEST) return
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'dsh-tray.lnk') // 旧 C# 版遗留的自启快捷方式文件名，仅用于清理
    if (fs.existsSync(lnk)) { fs.unlinkSync(lnk); log('removed legacy C# autostart shortcut (dsh-tray.lnk)') }
  } catch { /* noop */ }
  let had = false
  for (const name of ['com.dsh.tray', 'com.dsh.launcher']) {
    try {
      execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', name, '/f'], { windowsHide: true, stdio: 'ignore', timeout: 8000 })
      had = true
      log('removed legacy autostart registry value: ' + name)
    } catch { /* 不存在则无需处理 */ }
  }
  if (had && !autostartEnabled()) setAutostart(true)
}

// ---------- 面板窗口 ----------
let win = null
let reallyExit = false

// 启动器面板默认尺寸：窗口可调整的最小尺寸（480×600）
const PANEL_MIN_W = 480
const PANEL_MIN_H = 600

function defaultPanelSize() {
  return [PANEL_MIN_W, PANEL_MIN_H]
}

// DeepSeek Harness 独立窗口默认尺寸：
// 高 = 0.8 × 物理分辨率高（物理 = 逻辑 × 系统缩放，即窗口参数直接用 0.8 × 逻辑高）
// 宽:高 = 3:2（宽 = 高 × 1.5）；屏幕居中
function defaultWebSize() {
  try {
    const d = screen.getPrimaryDisplay()
    let h = Math.round(d.size.height * 0.8)
    const maxH = Math.max(480, d.workAreaSize.height - 48)
    if (h > maxH) h = maxH
    return [Math.round(h * 1.5), h]
  } catch { return [1728, 1152] }
}

// 启动器面板定位：右下角紧贴任务栏（右缘贴屏幕、下缘贴任务栏上沿）
function positionPanel(target) {
  try {
    const wa = screen.getDisplayMatching(target.getBounds()).workArea
    const [ww, wh] = target.getSize()
    target.setPosition(wa.x + wa.width - ww, wa.y + wa.height - wh)
  } catch { /* noop */ }
}

function createWindow() {
  const dft = defaultPanelSize()
  const w = Config.windowWidth >= 480 ? Config.windowWidth : dft[0]
  const h = Config.windowHeight >= 600 ? Config.windowHeight : dft[1]
  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: PANEL_MIN_W,
    minHeight: PANEL_MIN_H,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F9FAFB',
    title: 'DeepSeek Harness 启动器面板',
    icon: path.join(ASSETS_DIR, 'ds.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  positionPanel(win) // 右下角贴任务栏
  win.loadFile(path.join(WWWROOT, 'index.html'))
  // 面板缩放只由"界面缩放"设置控制：拦截 Ctrl+滚轮，强制归零
  win.webContents.on('zoom-changed', () => {
    try { win.webContents.setZoomLevel(0) } catch { /* noop */ }
  })
  attachContextMenu(win.webContents)
  win.on('close', (e) => {
    if (!reallyExit) {
      e.preventDefault()
      win.hide()
      // 托盘引导提示只弹一次：首次关闭面板时告知"未退出、缩到托盘"，之后静默隐藏
      if (!Config.panelHideNotified) {
        Config.panelHideNotified = true
        saveConfig()
        notify('DeepSeek Harness', '已最小化到托盘，单击图标打开 DeepSeek Harness，右键可打开启动器面板')
      }
    }
  })
  win.on('resized', debounce(() => {
    if (!reallyExit && win && !win.isDestroyed()) {
      const [ww, wh] = win.getSize()
      if (ww >= PANEL_MIN_W && wh >= PANEL_MIN_H) { Config.windowWidth = ww; Config.windowHeight = wh }
    }
  }, 500))
  win.on('closed', () => { win = null })
}

function showPanel() {
  stopFlash()
  if (!win) createWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    broadcastState()
  }
}

// ---------- DeepSeek Harness 窗口（Edge 式原生分屏：WebContentsView 由主进程挂载定位，无 DOM 搬移、零闪烁） ----------
// 标签栏高度：38px × 130% ≈ 49px，再 × 85% ≈ 41.65 → 取整 42px（与 ui-src/browser.css 的 #tabbar / #divider 保持一致）
const WEB_TAB_H = 42
const WEB_DIVIDER_W = 5

let webWin = null
let webTabs = []        // { id, view(WebContentsView), title }
let webActiveId = null
let webRightId = null
let webSplitOn = false
let webSplitRatio = 0.5
let webFocusedId = null
let webSeq = 0

// 空白页检测：加载失败后 Electron 显示的是空文档（title 空、body 空）
function isPageBlank(wc) {
  try {
    return wc.executeJavaScript(
      "document.title === '' || !document.body || document.body.innerHTML.length < 10",
    ).catch(() => true)
  } catch { return Promise.resolve(true) }
}

// 缩放调整时在指定视图中央显示半透明缩放值（末次调整 1 秒后淡出）
function showWebZoomOverlay(wc) {
  if (!wc || wc.isDestroyed()) return
  const pct = Math.round(wc.getZoomFactor() * 100)
  const js = `(function(){
    var el = document.getElementById('__dshZoomOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = '__dshZoomOverlay';
      el.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:rgba(15,17,21,0.62);color:#ffffff;font:500 28px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:10px 22px;border-radius:14px;pointer-events:none;opacity:0;transition:opacity 150ms ease;';
      document.documentElement.appendChild(el);
    }
    el.textContent = '${pct}%';
    el.style.opacity = '1';
    clearTimeout(el.__dshZoomTimer);
    el.__dshZoomTimer = setTimeout(function(){ el.style.opacity = '0'; }, 1000);
  })()`
  wc.executeJavaScript(js).catch(() => { /* 页面未就绪时静默 */ })
}

// ---------- 右键编辑菜单（Electron 无默认右键菜单：为面板与 WebUI 窗口补齐 剪切/复制/粘贴/全选） ----------
function attachContextMenu(wc) {
  wc.on('context-menu', (_event, params) => {
    const items = []
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      )
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push(
        { role: 'copy', label: '复制' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' },
      )
    }
    if (params.linkURL) {
      if (items.length) items.push({ type: 'separator' })
      items.push({ label: '复制链接地址', click: () => { try { clipboard.writeText(params.linkURL) } catch { /* noop */ } } })
    }
    if (!items.length) return
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) })
  })
}

// ---------- 分屏状态与布局 ----------

// 壳页面 → 渲染状态推送
function webPushState() {
  if (!webWin || webWin.isDestroyed()) return
  webWin.webContents.send('browser:state', {
    tabs: webTabs.map((t) => ({ id: t.id, title: t.title })),
    activeId: webActiveId,
    rightId: webRightId,
    splitOn: webSplitOn,
    splitRatio: webSplitRatio,
    maximized: webWin.isMaximized(),
    tabsEnabled: Config.tabsEnabled,
  })
}

// 布局：仅把展示中的 1-2 个视图挂到 contentView 并 setBounds（原生合成器，切换零闪烁）
function webLayout() {
  if (!webWin || webWin.isDestroyed()) return
  // 最小化过渡期内容尺寸退化为 0×0：跳过本次布局，恢复后由 show/restore 事件重排，
  // 避免把视图压成零尺寸（症状：恢复后页面区整片灰，点标签才恢复）
  if (webWin.isMinimized()) return
  const [W, H] = webWin.getContentSize()
  if (W <= 0 || H <= 0) return
  const top = WEB_TAB_H
  const availH = Math.max(0, H - top)
  for (const t of webTabs) {
    if (!t.view) continue
    try { webWin.contentView.removeChildView(t.view) } catch { /* noop */ }
  }
  const left = webTabs.find((t) => t.id === webActiveId)
  if (left) {
    const right = webSplitOn ? webTabs.find((t) => t.id === webRightId && t.id !== webActiveId) : null
    if (right) {
      const lw = Math.max(0, Math.round(W * webSplitRatio) - Math.round(WEB_DIVIDER_W / 2))
      const rx = Math.round(W * webSplitRatio) + Math.round(WEB_DIVIDER_W / 2)
      left.view.setBounds({ x: 0, y: top, width: lw, height: availH })
      right.view.setBounds({ x: rx, y: top, width: Math.max(0, W - rx), height: availH })
      webWin.contentView.addChildView(left.view)
      webWin.contentView.addChildView(right.view)
    } else {
      left.view.setBounds({ x: 0, y: top, width: W, height: availH })
      webWin.contentView.addChildView(left.view)
    }
  }
  webPushState()
  refreshPaneOverlays()
}

// 新建标签页：视图先在后台创建并加载，激活时才挂载（切换无白屏）
// targetUrl / targetTitle：分屏"在新标签页中打开"时复制来源页地址与标题
function webCreateTab(targetUrl, targetTitle) {
  const id = 't' + (++webSeq)
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      zoomFactor: Config.webZoom / 100,
      // 页面视图同样挂安全桥：供注入的分屏聚焦控件（✕/⋯）回传意图
      preload: path.join(__dirname, 'browser-preload.js'),
    },
  })
  const tab = { id, view, title: targetTitle || 'DeepSeek Harness' }
  webTabs.push(tab)
  const wc = view.webContents
  try { view.setBackgroundColor('#F9FAFB') } catch { /* 旧版无此 API，忽略 */ }
  wc.on('page-title-updated', (_e, t) => { tab.title = t || 'DeepSeek Harness'; webPushState() })
  wc.on('focus', () => { webFocusedId = id; refreshPaneOverlays() })
  wc.on('zoom-changed', (_e, direction) => {
    const f = wc.getZoomFactor()
    const next = direction === 'in' ? Math.min(f + 0.05, 3) : Math.max(f - 0.05, 0.5)
    for (const t2 of webTabs) {
      if (!t2.view.webContents.isDestroyed()) { try { t2.view.webContents.setZoomFactor(next) } catch { /* noop */ } }
    }
    Config.webZoom = Math.round(next * 100)
    showWebZoomOverlay(wc)
    broadcastState()
  })
  wc.on('did-finish-load', () => {
    // 每次加载完成后应用当前设定（失败页/错误页会把缩放重置为 100%）
    try { wc.setZoomFactor(Config.webZoom / 100) } catch { /* noop */ }
    injectPaneOverlay(tab)
  })
  // 快捷键（焦点在页面内也生效）：Ctrl+\ 分屏、Ctrl+Del 关闭聚焦分屏、Shift+Alt+S 交换左右
  wc.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const key = (input.key || '').toLowerCase()
    if (input.control && key === '\\') { _event.preventDefault(); webToggleSplit() }
    else if (input.control && input.key === 'Delete') { _event.preventDefault(); webCloseFocused() }
    else if (input.shift && input.alt && key === 's') { _event.preventDefault(); webSwap() }
  })
  view.webContents.loadURL(targetUrl || WEB_URL).catch(() => { /* 服务未启动时空白，由自愈兜底 */ })
  webActivateTab(id)
  return tab
}

// 分屏聚焦控件（Edge 式）：注入到每个标签页，聚焦侧右上角浮出 ✕（关闭此分屏）与 ⋯ 菜单（切换左右分屏 / 在新标签页中打开此网页）。
// 与缩放浮层同一套路（executeJavaScript 注入，不受页面 CSP 限制）；动作经 browser-preload 桥回主进程。
function injectPaneOverlay(tab) {
  const wc = tab.view && tab.view.webContents
  if (!wc || wc.isDestroyed()) return
  const paneId = tab.id
  const js = `(function(){
    if (document.getElementById('__dshPaneRoot')) return;
    var css = [
      '#__dshPaneRoot{position:fixed;top:10px;right:10px;z-index:2147483646;display:none;flex-direction:column;align-items:flex-end;gap:6px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;pointer-events:none;}',
      '#__dshPaneRoot.show{display:flex;}',
      '#__dshPaneBar{display:flex;gap:4px;pointer-events:auto;}',
      '#__dshPaneBar button{width:26px;height:26px;border:none;border-radius:7px;background:rgba(15,17,21,0.72);color:#FFFFFF;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.25);}',
      '#__dshPaneBar button:hover{background:rgba(30,35,44,0.92);}',
      '#__dshPaneClose:hover{background:rgba(214,30,30,0.92) !important;}',
      '#__dshPaneMenu{display:none;pointer-events:auto;background:rgba(21,24,29,0.95);border:1px solid rgba(255,255,255,0.08);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,0.3);padding:5px;min-width:192px;}',
      '#__dshPaneMenu.open{display:block;}',
      '#__dshPaneMenu div{padding:8px 12px;border-radius:6px;color:#E8EAED;font-size:12px;white-space:nowrap;cursor:pointer;}',
      '#__dshPaneMenu div:hover{background:rgba(255,255,255,0.08);}'
    ].join('');
    var root = document.createElement('div'); root.id = '__dshPaneRoot';
    var st = document.createElement('style'); st.textContent = css;
    var bar = document.createElement('div'); bar.id = '__dshPaneBar';
    var btnMenu = document.createElement('button'); btnMenu.title = '更多分屏操作'; btnMenu.textContent = '\\u22EF';
    var btnClose = document.createElement('button'); btnClose.id = '__dshPaneClose'; btnClose.title = '关闭此分屏'; btnClose.textContent = '\\u2715';
    var menu = document.createElement('div'); menu.id = '__dshPaneMenu';
    var swap = document.createElement('div'); swap.textContent = '切换左右分屏';
    var openTab = document.createElement('div'); openTab.textContent = '在新标签页中打开此网页';
    menu.appendChild(swap); menu.appendChild(openTab);
    bar.appendChild(btnMenu); bar.appendChild(btnClose);
    root.appendChild(bar); root.appendChild(menu);
    var host = document.body || document.documentElement;
    host.appendChild(st); host.appendChild(root);
    var send = function(name, payload) { try { window.browserBridge.send(name, payload); } catch (e) {} };
    var hideMenu = function() { menu.classList.remove('open'); };
    btnClose.addEventListener('click', function() { hideMenu(); send('closePane'); });
    btnMenu.addEventListener('click', function() { menu.classList.toggle('open'); });
    swap.addEventListener('click', function() { hideMenu(); send('swapPanes'); });
    openTab.addEventListener('click', function() { hideMenu(); send('paneToTab', { id: '${paneId}' }); });
    document.addEventListener('click', function(e) { if (!root.contains(e.target)) hideMenu(); }, true);
    window.addEventListener('blur', function() { hideMenu(); });
  })()`
  wc.executeJavaScript(js).catch(() => { /* 页面未就绪时静默，下次 did-finish-load 重试 */ })
}

// 仅"分屏开启 + 本页是当前聚焦且正在展示的一侧"时显示控件（Edge 行为）
function refreshPaneOverlays() {
  for (const t of webTabs) {
    const wc = t.view && t.view.webContents
    if (!wc || wc.isDestroyed()) continue
    const shown = !!(webSplitOn && t.id === webFocusedId && (t.id === webActiveId || t.id === webRightId))
    wc.executeJavaScript(`(function(){var el=document.getElementById('__dshPaneRoot');if(el){el.classList.toggle('show',${shown});}})()`).catch(() => { /* noop */ })
  }
}

function webActivateTab(id) {
  if (!webTabs.find((t) => t.id === id)) return
  if (webSplitOn && webActiveId && webActiveId !== id) webRightId = webActiveId
  webActiveId = id
  webLayout()
}

function webCloseTab(id) {
  const idx = webTabs.findIndex((t) => t.id === id)
  if (idx < 0) return
  const tab = webTabs[idx]
  webTabs.splice(idx, 1)
  try { if (webWin && !webWin.isDestroyed()) webWin.contentView.removeChildView(tab.view) } catch { /* noop */ }
  try { tab.view.webContents.close() } catch { /* noop */ }
  if (webRightId === id) webRightId = null
  if (webActiveId === id) webActiveId = webTabs.length ? (webTabs[idx - 1] || webTabs[0]).id : null
  if (webTabs.length < 2) { webSplitOn = false; webRightId = null }
  // 关闭最后一个标签 → 立即补一个全新标签（窗口永远至少有 1 个标签，避免内容区整片空白）
  if (webTabs.length === 0) webCreateTab()
  webLayout()
}

function webToggleSplit() {
  if (!Config.tabsEnabled) return // 功能关闭：分屏整体禁用
  webSplitOn = !webSplitOn
  if (webSplitOn && !webRightId) {
    if (webTabs.length > 1) {
      webRightId = webTabs.find((t) => t.id !== webActiveId).id
    } else if (webActiveId) {
      // 单标签分屏（Edge 行为）：复制当前页作为右分屏，原页保持左侧
      const cur = webTabs.find((t) => t.id === webActiveId)
      let url = WEB_URL
      try {
        const u = cur.view.webContents.getURL()
        if (u && u !== '' && !u.startsWith('about:')) url = u
      } catch { /* noop */ }
      const dup = webCreateTab(url, cur.title) // 新标签被激活为左，原标签被指为右
      dup.fromSplitDup = true
      const t = webActiveId
      webActiveId = webRightId
      webRightId = t
    } else {
      webSplitOn = false // 没有任何标签：分屏无从谈起，回退
    }
  } else if (!webSplitOn) {
    // 退出分屏：关闭由"单标签分屏"自动复制的右分屏（Edge 行为），正常标签保留
    const right = webTabs.find((t) => t.id === webRightId)
    if (right && right.fromSplitDup) webCloseTab(right.id)
    webRightId = null
  }
  webLayout()
}

function webSetRatio(r) {
  webSplitRatio = Math.min(0.8, Math.max(0.2, Number(r) || 0.5))
  webLayout()
}

function webSwap() {
  if (!webSplitOn || !webRightId || !webActiveId) return
  const t = webActiveId
  webActiveId = webRightId
  webRightId = t
  webLayout()
}

// 分屏菜单"在新标签页中打开此网页"：复制该分屏当前 URL 到新标签（保持会话视图），
// 然后关闭原分屏；剩余分屏铺满（Edge 行为：退出分屏回到单视图）
function webPaneToTab(id) {
  const tab = webTabs.find((t) => t.id === id)
  if (!tab || !webSplitOn || (id !== webActiveId && id !== webRightId)) return
  let url = WEB_URL
  try {
    const u = tab.view.webContents.getURL()
    if (u && u !== '' && !u.startsWith('about:')) url = u
  } catch { /* noop */ }
  // 先退出分屏再建新标签，避免 webCreateTab 把右视图指到旧标签
  webSplitOn = false
  webRightId = null
  webCreateTab(url, tab.title)
  webCloseTab(id)
  webLayout()
}

// 关闭当前聚焦的分屏：分屏时关聚焦侧（左关左保留右），未分屏时关当前标签
function webCloseFocused() {
  if (!Config.tabsEnabled) return // 功能关闭：不关闭唯一标签
  if (!webSplitOn) { if (webActiveId) webCloseTab(webActiveId); return }
  if (webFocusedId && webFocusedId === webRightId) webCloseTab(webRightId)
  else if (webActiveId) webCloseTab(webActiveId)
  // Edge 行为：关闭任一侧即退出分屏，剩余一侧铺满
  webSplitOn = false
  webRightId = null
  webLayout()
}

// ---------- 独立窗口几何持久化（尺寸/位置/最大化，重启后恢复） ----------
function saveWebWindowState() {
  if (!webWin || webWin.isDestroyed()) return
  try {
    // 最大化/最小化时 getSize 返回的不是"常规尺寸"，只记最大化标志，不覆盖已存的正常尺寸
    if (webWin.isMaximized() || webWin.isMinimized()) {
      Config.webWindowMaximized = webWin.isMaximized()
      return
    }
    const [w, h] = webWin.getSize()
    const [x, y] = webWin.getPosition()
    if (w >= 640 && h >= 480) {
      Config.webWindowWidth = w
      Config.webWindowHeight = h
      Config.webWindowX = x
      Config.webWindowY = y
      Config.webWindowMaximized = false
    }
  } catch { /* noop */ }
}

let webStateSaveTimer = null
function scheduleSaveWebWindowState() {
  clearTimeout(webStateSaveTimer)
  webStateSaveTimer = setTimeout(saveWebWindowState, 500) // resize/move 事件密集，防抖后落盘
}

function openWebUi(opts = {}) {
  log('open DeepSeek Harness window (systemBrowser=' + Config.useSystemBrowser + ')')
  stopFlash() // 任何"打开"动作都视为已读提醒
  // 设置项"使用系统浏览器打开DSH"开启 → 交给系统默认浏览器（每次新开标签页）
  if (Config.useSystemBrowser) {
    try { shell.openExternal(WEB_URL) } catch { /* noop */ }
    return
  }
  if (webWin && !webWin.isDestroyed()) {
    if (webWin.isMinimized()) webWin.restore()
    webWin.show()
    webWin.focus()
    return
  }
  // 独立窗口尺寸：上次手动调整过的尺寸（≥最小）优先，否则默认 0.8×物理高、3:2
  const [defW, defH] = defaultWebSize()
  const webW = (Config.webWindowWidth >= 640 && Config.webWindowHeight >= 480) ? Config.webWindowWidth : defW
  const webH = (Config.webWindowWidth >= 640 && Config.webWindowHeight >= 480) ? Config.webWindowHeight : defH
  webWin = new BrowserWindow({
    width: webW,
    height: webH,
    minWidth: 640,
    minHeight: 480,
    show: !opts.hidden,
    frame: false, // 无边框：tab 栏即标题栏（Edge 式，-webkit-app-region: drag 拖动窗口）
    autoHideMenuBar: true,
    backgroundColor: '#F9FAFB',
    title: 'DeepSeek Harness',
    icon: path.join(ASSETS_DIR, 'ds.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'browser-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  // 定位：上次位置仍在某个显示器工作区内 → 原位恢复；否则居中（防拔掉副屏后窗口落在屏幕外）
  let posApplied = false
  if (Number.isInteger(Config.webWindowX) && Number.isInteger(Config.webWindowY)) {
    const px = Config.webWindowX
    const py = Config.webWindowY
    const onScreen = screen.getAllDisplays().some((d) => {
      const wa = d.workArea
      return px + webW > wa.x + 80 && px < wa.x + wa.width - 80 && py >= wa.y - 8 && py + 80 < wa.y + wa.height
    })
    if (onScreen) {
      try { webWin.setPosition(px, py) } catch { /* noop */ }
      posApplied = true
    }
  }
  if (!posApplied) {
    // 显式居中：基于主显示器工作区计算坐标（不依赖 center 选项，虚拟显示器环境下更可靠）
    try {
      const wa = screen.getPrimaryDisplay().workArea
      webWin.setPosition(Math.round(wa.x + (wa.width - webW) / 2), Math.round(wa.y + (wa.height - webH) / 2))
    } catch { /* noop */ }
  }
  if (Config.webWindowMaximized) {
    try { webWin.maximize() } catch { /* noop */ }
  }
  // 抢前台：确保窗口可见并置顶于当前层（远程串流场景防被遮挡）
  try { webWin.show(); webWin.focus(); webWin.moveTop() } catch { /* noop */ }
  log(`web win created: size=${webW}x${webH} bounds=${JSON.stringify(webWin.getBounds())}`)
  // 壳页面缩放固定 100%（Ctrl+滚轮只作用于页面视图）
  webWin.webContents.on('zoom-changed', () => {
    try { webWin.webContents.setZoomLevel(0) } catch { /* noop */ }
  })
  attachContextMenu(webWin.webContents)
  webWin.on('resize', () => { webLayout(); scheduleSaveWebWindowState() })
  webWin.on('move', () => scheduleSaveWebWindowState())
  // 最小化→恢复 / 隐藏→显示 不一定触发 resize：显式重排，防止页面区残留零尺寸（整片灰）
  webWin.on('show', () => webLayout())
  webWin.on('restore', () => webLayout())
  // 最大化状态变化 → 重排 + 壳按钮图标/提示实时切换（□ ↔ ❐）+ 持久化
  webWin.on('maximize', () => { webLayout(); webPushState(); saveWebWindowState() })
  webWin.on('unmaximize', () => { webLayout(); webPushState(); saveWebWindowState() })
  webWin.loadFile(path.join(WWWROOT, 'browser.html')).catch(() => { /* noop */ })
  webCreateTab() // 首个标签页：后台加载，挂载即显示
  // 点 ✕ 只隐藏到后台继续运行（页面与会话保持存活），托盘退出时才真正关闭
  webWin.on('close', (e) => {
    if (!reallyExit) {
      e.preventDefault()
      webWin.hide()
    }
  })
  webWin.on('closed', () => {
    webWin = null
    webTabs = []
    webActiveId = null
    webRightId = null
    webFocusedId = null
    webSplitOn = false
  })
}

// 服务就绪时自愈：逐个检查标签页视图，空白错误页 → 重新加载真实应用；健康页面不打扰
async function refreshWebUiOnReady() {
  for (const t of webTabs) {
    const wc = t.view.webContents
    if (wc.isDestroyed()) continue
    if (await isPageBlank(wc)) {
      try { wc.loadURL(WEB_URL) } catch { /* noop */ }
    }
  }
}

// ---------- 状态 ----------
function stateJson() {
  let logTail = ''
  try {
    const lines = fs.readFileSync(TRAY_LOG, 'utf8').split(/\r?\n/)
    logTail = lines.slice(-12).join('\n')
  } catch { /* noop */ }
  return JSON.stringify({
    running: server.running(),
    owned: server.owned(),
    pid: server.displayPid(),
    url: WEB_URL,
    port: PORT,
    blocked: server.blockedReason || '',
    suggestedPort: server.suggestedPort || 0,
    feedbackConfigured: !!(Config.feedbackToken || embeddedFeedbackToken()),
    version: app.getVersion(),
    autostart: autostartEnabled(),
    notify: Config.notify,
    useSystemBrowser: Config.useSystemBrowser,
    autoRestart: Config.autoRestart,
    tabsEnabled: Config.tabsEnabled,
    zoom: Config.zoom,
    cssZoom: cssZoomPct(),
    webZoom: Config.webZoom,
    theme: Config.theme,
    env: envDetect.envSummary(envReport),
    log: logTail,
  })
}

let lastBroadcast = ''
function broadcastState() {
  const json = stateJson()
  if (json === lastBroadcast) return
  lastBroadcast = json
  if (win && !win.isDestroyed()) { try { win.webContents.send('dsh:state', json) } catch { /* noop */ } }
}

// ---------- 通知 dropbox 扫描（dsh-notify 插件投递） ----------
function scanNotify() {
  let file = null
  try {
    const files = fs.readdirSync(NOTIFY_DIR).filter((f) => f.endsWith('.json')).sort()
    if (!files.length) return
    file = path.join(NOTIFY_DIR, files[0])
  } catch { return }
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (doc && typeof doc.title === 'string' && doc.title && typeof doc.message === 'string' && doc.message) {
      if (Config.notify) {
        startFlash()
        notify(doc.title, doc.message, typeof doc.url === 'string' ? doc.url : WEB_URL)
      }
    }
  } catch (err) { log('failed to parse notify file: ' + err.message) }
  try { fs.unlinkSync(file) } catch { /* noop */ }
}

function clearStaleNotify() {
  try {
    for (const f of fs.readdirSync(NOTIFY_DIR)) {
      if (f.endsWith('.json')) { try { fs.unlinkSync(path.join(NOTIFY_DIR, f)) } catch { /* noop */ } }
    }
  } catch { /* dir missing */ }
}

function onTick() {
  // 环境未就绪时周期性重测（缓存 30s 节流），用户在外部装好 Node/DSH 后自动就绪
  if (!envReady()) void refreshEnv(false)
  maybeStartDeferred() // 安装完成/启动请求时环境未就绪 → 就绪后自动补启动
  // 接管的外部实例存活性探测
  if (server.adoptedPid) {
    portOpen().then((open) => {
      if (open !== server.adoptedAlive) {
        server.adoptedAlive = open
        if (open) {
          void refreshWebUiOnReady() // 接管的外部服务恢复在线时，刷新错误页
        } else {
          log('adopted DSH exited unexpectedly')
          startFlash()
          notify('DeepSeek Harness', '服务意外退出', WEB_URL)
          void maybeAutoRestart()
        }
        broadcastState()
      }
    })
  }
  scanNotify()
}

// ---------- 问题反馈（GitHub Issues 通道：用户无需邮件客户端，提交即建 Issue，作者按仓库通知收到） ----------
const FEEDBACK_REPO = 'IMHaoyan/deepseek-harness-launcher'
const FEEDBACK_BODY_MAX = 60000 // GitHub issue body 上限 65536 字符，留余量

// 内置反馈令牌：assets/feedback-token.txt（.gitignore 排除，不进仓库；打包时随安装包分发）
// 仅需 Issues 写权限的 fine-grained token，泄露风险面极小且可随时吊销
function embeddedFeedbackToken() {
  try {
    const t = fs.readFileSync(path.join(ASSETS_DIR, 'feedback-token.txt'), 'utf8').trim()
    return t || ''
  } catch { return '' }
}

// 生效令牌 = 设置页自定义（覆盖）|| 内置
function effectiveFeedbackToken() {
  return Config.feedbackToken || embeddedFeedbackToken()
}

function tailOf(file, lines) {
  try {
    const txt = fs.readFileSync(file, 'utf8')
    return txt.split(/\r?\n/).slice(-lines).join('\n')
  } catch { return '(无日志文件：' + path.basename(file) + ')' }
}

function buildFeedbackPack(text, includeLogs) {
  const version = app.getVersion()
  const subject = `[DSHL 反馈] v${version} - ${String(text).slice(0, 40).replace(/\r?\n/g, ' ')}`
  const env = envDetect.envSummary(envReport)
  const parts = [
    '# DeepSeek Harness Launcher 问题反馈',
    '',
    '## 问题描述',
    text,
    '',
    '## 环境信息',
    `- 版本：v${version}`,
    `- 平台：${process.platform} ${os.release()}`,
    `- 服务地址：${WEB_URL}（端口 ${PORT}）`,
    `- 服务状态：${server.running() ? '运行中' : '已停止'}${server.blockedReason ? '（' + server.blockedReason + '）' : ''}`,
    `- 环境就绪：${envReady() ? '是' : '否'}`,
    `- 环境报告：${JSON.stringify(env)}`,
  ]
  if (includeLogs) {
    parts.push('', '## 日志 dshl.log（末尾 200 行）', '```', tailOf(TRAY_LOG, 200), '```')
    parts.push('', '## 日志 server.out.log（末尾 100 行）', '```', tailOf(OUT_LOG, 100), '```')
    parts.push('', '## 日志 server.err.log（末尾 100 行）', '```', tailOf(ERR_LOG, 100), '```')
  }
  let body = parts.join('\n')
  if (body.length > FEEDBACK_BODY_MAX) body = body.slice(0, FEEDBACK_BODY_MAX) + '\n\n…（超出长度限制，已截断）'
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const dir = path.join(LOG_DIR, 'feedback')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
  const filePath = path.join(dir, `feedback-${ts}.md`)
  try { fs.writeFileSync(filePath, body, 'utf8') } catch { /* noop */ }
  return { subject, body, filePath }
}

async function createGithubIssue(title, body) {
  const token = effectiveFeedbackToken()
  const res = await fetch(`https://api.github.com/repos/${FEEDBACK_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dshl-feedback',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data && data.message) || ('HTTP ' + res.status))
  return data.html_url || ''
}

// ---------- IPC 命令桥（Bridge.cs 移植） ----------
function registerIpc() {
  ipcMain.handle('dsh:cmd', async (_event, name, value) => {
    try {
      switch (name) {
        case 'getState': return stateJson()
        case 'browserInit': return JSON.stringify({ url: WEB_URL })
        case 'browser:tabNew': if (Config.tabsEnabled) webCreateTab(); return '{}'
        case 'browser:tabActivate': webActivateTab(value && value.id); return '{}'
        case 'browser:tabClose': webCloseTab(value && value.id); return '{}'
        case 'browser:splitToggle': webToggleSplit(); return '{}'
        case 'browser:splitRatio': webSetRatio(value); return '{}'
        case 'browser:closePane': webCloseFocused(); return '{}'
        case 'browser:swapPanes': webSwap(); return '{}'
        case 'browser:paneToTab': webPaneToTab(value && value.id); return '{}'
        case 'browser:winMin': if (webWin && !webWin.isDestroyed()) { try { webWin.minimize() } catch { /* noop */ } } return '{}'
        case 'browser:winMax': {
          if (webWin && !webWin.isDestroyed()) {
            try { if (webWin.isMaximized()) webWin.unmaximize(); else webWin.maximize() } catch { /* noop */ }
          }
          return '{}'
        }
        case 'browser:winClose': if (webWin && !webWin.isDestroyed()) { try { webWin.hide() } catch { /* noop */ } } return '{}'
        case 'start': await handleStart(); return '{}'
        case 'stop': await stopServer(); notify('DeepSeek Harness', '服务已停止'); broadcastState(); return '{}'
        case 'openWeb': openDshOrPanel(); return '{}' // 环境未就绪/端口被占用时自动改打开启动器面板
        case 'openUrlExternal': try { shell.openExternal(WEB_URL) } catch { /* noop */ } return '{}'
        case 'openLogs': try { shell.openPath(LOG_DIR) } catch { /* noop */ } return '{}'
        case 'openGithub': try { shell.openExternal('https://github.com/IMHaoyan/deepseek-harness-launcher') } catch { /* noop */ } return '{}'
        case 'openChangelog': try { shell.openExternal('https://github.com/IMHaoyan/deepseek-harness-launcher/releases') } catch { /* noop */ } return '{}'
        case 'toggleAutostart': setAutostart(!autostartEnabled()); broadcastState(); return '{}'
        case 'testNotify': notify('DeepSeek Harness', '测试通知：链路正常，点击本通知打开 DeepSeek Harness', WEB_URL); return '{}'
        case 'setZoom': {
          const z = Number(value)
          // 启动器缩放：50-200，会话内生效，不持久化（每次启动默认跟随系统缩放）
          if (Number.isInteger(z) && z >= 50 && z <= 200) Config.zoom = z
          broadcastState()
          return '{}'
        }
        case 'setWebZoom': {
          const z = Number(value)
          // 对话界面缩放：50-300，同步应用到所有 DSH 页面视图
          if (Number.isInteger(z) && z >= 50 && z <= 300) {
            Config.webZoom = z
            let first = null
            for (const t of webTabs) {
              const wc = t.view.webContents
              if (wc.isDestroyed()) continue
              try { wc.setZoomFactor(z / 100) } catch { /* noop */ }
              if (!first) first = wc
            }
            if (first) showWebZoomOverlay(first)
          }
          broadcastState()
          return '{}'
        }
        case 'setTheme': {
          if (value === 'light' || value === 'dark' || value === 'system') {
            Config.theme = value
            // 主题设置同时驱动：原生标题栏（启动器面板）、tab 栏壳（prefers-color-scheme）与托盘图标
            try { nativeTheme.themeSource = value } catch { /* noop */ }
            saveConfig()
          }
          broadcastState()
          return '{}'
        }
        case 'setNotify': Config.notify = !!value; saveConfig(); broadcastState(); return '{}'
        case 'resetDefaults': {
          // 恢复默认设置：所有选项回到默认值，窗口恢复默认尺寸与位置
          Config.zoom = systemZoom()
          Config.webZoom = cssZoomPct()
          Config.theme = 'light'
          Config.notify = true
          Config.useSystemBrowser = false
          Config.autoRestart = true
          Config.tabsEnabled = false
          const portBefore = PORT
          Config.port = 0
          Config.feedbackToken = ''
          Config.windowWidth = 0
          Config.windowHeight = 0
          Config.webWindowWidth = 0
          Config.webWindowHeight = 0
          Config.webWindowMaximized = false
          Config.webWindowX = null
          Config.webWindowY = null
          Config.harnessRoot = ''
          Config.nodePath = ''
          Config.dshVersion = '0.1.0-rc.6'
          Config.nodeMajor = 22
          Config.nodeMirror = ''
          Config.npmRegistry = ''
          Config.dshUpdateCheckedAt = 0
          Config.panelHideNotified = false
          applyRuntimePort()
          // 端口复位到默认 3080：若自己拉起的服务跑在自定义端口，重启到默认端口并重载页面
          if (PORT !== portBefore && server.owned()) await restartServerOnNewPort()
          if (!autostartEnabled()) setAutostart(true)
          if (win && !win.isDestroyed()) {
            const [dw, dh] = defaultPanelSize()
            win.setSize(dw, dh)
            positionPanel(win)
          }
          if (webWin && !webWin.isDestroyed()) {
            try {
              if (webWin.isMaximized()) webWin.unmaximize()
              const [ww2, wh2] = defaultWebSize()
              webWin.setSize(ww2, wh2)
              webWin.center()
            } catch { /* noop */ }
            for (const t of webTabs) {
              const wc = t.view.webContents
              if (wc.isDestroyed()) continue
              try { wc.setZoomFactor(Config.webZoom / 100) } catch { /* noop */ }
            }
          }
          saveConfig()
          broadcastState()
          return '{}'
        }
        case 'setUseSystemBrowser': Config.useSystemBrowser = !!value; saveConfig(); broadcastState(); return '{}'
        case 'setAutoRestart': Config.autoRestart = !!value; saveConfig(); broadcastState(); return '{}'
        case 'setFeedbackToken': {
          Config.feedbackToken = String(value || '').trim()
          saveConfig()
          broadcastState()
          return '{}'
        }
        case 'feedbackBuild': {
          const text = String(value && value.text || '').trim()
          if (!text) return '{}'
          return JSON.stringify(buildFeedbackPack(text, value && value.includeLogs !== false))
        }
        case 'feedbackSend': {
          const text = String(value && value.text || '').trim()
          if (!text) return JSON.stringify({ ok: false, error: '请先填写问题描述' })
          const pack = buildFeedbackPack(text, value && value.includeLogs !== false)
          if (!effectiveFeedbackToken()) {
            return JSON.stringify({ ok: false, needToken: true, filePath: pack.filePath })
          }
          try {
            const issueUrl = await createGithubIssue(pack.subject, pack.body)
            log('feedback submitted: ' + issueUrl)
            return JSON.stringify({ ok: true, issueUrl, filePath: pack.filePath })
          } catch (err) {
            log('feedback submit failed: ' + err.message)
            return JSON.stringify({ ok: false, error: '提交失败：' + err.message + '（可改用"复制全部"手动提交）', filePath: pack.filePath })
          }
        }
        case 'clipboardWrite': try { clipboard.writeText(String(value)) } catch { /* noop */ } return '{}'
        case 'setPort': {
          // 服务端口（1024–65535）：保存后立即生效——自己拉起的服务重启到新端口并重载页面；
          // 接管的外部实例不受控制，仅提示"下次由启动器启动时生效"
          const p = Number(value)
          if (!Number.isInteger(p) || p < 1024 || p > 65535) return '{}'
          Config.port = p
          saveConfig()
          const before = PORT
          applyRuntimePort()
          if (PORT !== before) {
            if (server.owned()) {
              const ok = await restartServerOnNewPort()
              notify('DeepSeek Harness', ok ? `服务已切换到端口 ${PORT}` : '新端口启动失败，请打开启动器面板查看日志')
            } else if (server.adoptedPid) {
              notify('DeepSeek Harness', `端口已保存为 ${PORT}；当前接管的外部实例不受控制，下次由启动器启动服务时生效`)
            }
          }
          broadcastState()
          return '{}'
        }
        case 'portSwitchStart': {
          // "端口被占用"场景的一键换端口：保存建议端口并立即尝试启动
          const p = Number(value && value.port)
          if (!Number.isInteger(p) || p < 1024 || p > 65535) return '{}'
          Config.port = p
          saveConfig()
          applyRuntimePort()
          server.blockedReason = ''
          server.suggestedPort = 0
          await handleStart()
          broadcastState()
          return '{}'
        }
        case 'setTabsEnabled': {
          // 关闭时：退出分屏并只保留当前标签，标题栏回到"标题 + 最小化/最大化/关闭"精简形态
          Config.tabsEnabled = !!value
          saveConfig()
          if (!Config.tabsEnabled && webWin && !webWin.isDestroyed()) {
            webSplitOn = false
            webRightId = null
            const keepId = webActiveId
            for (const t of [...webTabs]) {
              if (t.id !== keepId) webCloseTab(t.id)
            }
          }
          webPushState()
          broadcastState()
          return '{}'
        }
        case 'envDetect': {
          // 强制重新探测环境（面板"运行环境"页刷新按钮）
          const report = await refreshEnv(true)
          return JSON.stringify(envDetect.envSummary(report))
        }
        case 'envInstall': {
          const items = value && Array.isArray(value.items) ? value.items : []
          const opts = value && typeof value === 'object' ? value : {}
          delete opts.items
          try {
            envInstall.startInstall(items, opts)
            return JSON.stringify({ ok: true, state: envInstall.getJob() })
          } catch (err) {
            return JSON.stringify({ ok: false, error: err.message || String(err) })
          }
        }
        case 'envCancel': envInstall.cancelInstall(); return '{}'
        case 'envGetState': {
          // 面板（重新）打开环境页时的全量快照：任务状态 + 环形日志
          return JSON.stringify(envInstall.getJob())
        }
        case 'openInstallLog': try { shell.openPath(envInstall.installLogPath()) } catch { /* noop */ } return '{}'
        case 'envCopyDiagnostics': {
          // 一键复制完整诊断信息到剪贴板（版本/环境报告/安装任务/平台），便于反馈排查
          const diag = {
            version: app.getVersion(),
            packaged: app.isPackaged,
            platform: process.platform + '-' + process.arch,
            home: realHome,
            env: envDetect.envSummary(envReport),
            install: envInstall.getJob(),
            running: server.running(),
            pid: server.displayPid(),
          }
          try { clipboard.writeText(JSON.stringify(diag, null, 2)) } catch { /* noop */ }
          notify('DeepSeek Harness', '诊断信息已复制到剪贴板，请粘贴给开发者')
          return '{}'
        }
        case 'updaterGetState': return updater.getState()
        case 'updaterCheck': void updater.check(); return updater.getState()
        case 'updaterInstall': void updater.installNow(); return updater.getState()
        case 'exit': void requestExit(); return '{}'
        default: log('bridge: unknown command ' + name); return '{}'
      }
    } catch (err) {
      log('bridge command failed: ' + err.message)
      return '{}'
    }
  })
}

// 退出时的快速停止：强杀进程树，不等待优雅退出（DSH 无内存态需要保留，托盘退出必须秒退）
async function stopServerFast() {
  const child = server.child
  if (!child || child.exitCode !== null) { server.child = null; return }
  server.stopping = true
  const pid = child.pid
  await killPid(pid, true)
  server.child = null
  server.stopping = false
  log(`DSH force-stopped on exit (PID ${pid})`)
}

// ---------- 退出（仅停止自己拉起的服务） ----------
async function requestExit() {
  if (reallyExit) return
  reallyExit = true
  stopFlash()
  saveWebWindowState() // 退出前落盘独立窗口几何（防抖定时器可能尚未触发）
  if (server.owned()) await stopServerFast()
  log('tray exiting')
  try { saveConfig() } catch { /* noop */ }
  if (tray) { try { tray.destroy() } catch { /* noop */ } tray = null }
  app.quit()
}

// ---------- 自检（对齐 C# selftest：READY / STOPPED / WEBVIEW OK） ----------
function selftestPrint(line) {
  try { fs.appendFileSync(SELFTEST_RESULT, line + '\n') } catch { /* noop */ }
  try { console.log(line) } catch { /* noop */ }
}

async function runSelfTest() {
  try {
    log('selftest begin')
    // 环境探测（只读，绝不触发安装；selftest 用独立端口/临时 DSH_HOME，不动真实服务）
    {
      const env = await envDetect.detectEnv(true)
      envReport = env
      selftestPrint(`ENV ${env.ready ? 'OK' : 'NOT-READY'}: node=${env.node.status}${env.node.version ? ' ' + env.node.version : ''} | dsh=${env.dsh.kind || 'none'}${env.dsh.version ? ' ' + env.dsh.version : ''}${env.dsh.status === 'unbuilt' ? ' (unbuilt)' : ''} | plugin=${env.plugin.status}`)
      if (env.issues.length) selftestPrint('ENV ISSUES: ' + env.issues.join('；'))
    }
    broadcastState()
    const ready = await startServer()
    broadcastState()
    if (!ready) { selftestPrint('FAILED: server did not become ready'); app.exit(1); return }
    if (!server.owned()) {
      // 端口被外部服务占用（接管模式）：自检绝不停止外部实例
      selftestPrint('FAILED: port already in use by external server, refusing to touch it')
      app.exit(1)
      return
    }
    selftestPrint('READY ' + WEB_URL)
    selftestPrint('SYSTEM ZOOM ' + Config.zoom + ' (detected from OS)')
    selftestPrint(`ICONS OK: colored=${!IconNormal.isEmpty()} blank=${!IconBlank.isEmpty()}`)
    const [dw, dh] = defaultPanelSize()
    const [ww2, wh2] = defaultWebSize()
    const prim = screen.getPrimaryDisplay()
    const primScale = prim.scaleFactor || 1
    selftestPrint(`PANEL DEFAULT SIZE ${dw}x${dh} (min) | WEB DEFAULT SIZE ${ww2}x${wh2} logical = ${ww2 * primScale}x${wh2 * primScale} physical (0.8 of ${Math.round(prim.size.height * primScale)} physical height, 3:2)`)
    await sleep(2000)
    // 独立窗口：原生视图（WebContentsView）挂载，初始缩放应等于面板校正值（隐藏创建，避免闪现）
    openWebUi({ hidden: true })
    const wc = await new Promise((resolve) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        const act = webTabs.find((t) => t.id === webActiveId)
        if (act && !act.view.webContents.isDestroyed() && !act.view.webContents.isLoading()) { clearInterval(iv); resolve(act.view.webContents) }
        else if (Date.now() - t0 > 15000) { clearInterval(iv); resolve(null) }
      }, 200)
    })
    if (!wc) { selftestPrint('FAILED: tab view not created'); app.exit(2); return }
    const wfPct = Math.round(wc.getZoomFactor() * 100)
    if (wfPct !== cssZoomPct()) { selftestPrint(`FAILED: webui zoom ${wfPct}% != expected ${cssZoomPct()}%`); app.exit(2); return }
    selftestPrint(`WEBUI OK: initial zoom ${wfPct}% (matches panel ${cssZoomPct()}%)`)
    // 缩放提示浮层：注入到 webview 后应显示当前百分比
    showWebZoomOverlay(wc)
    await sleep(400)
    const overlayTxt = await wc.executeJavaScript(
      "(function(){var el=document.getElementById('__dshZoomOverlay');return el?el.textContent:''})()",
    ).catch(() => '')
    if (!String(overlayTxt).includes('%')) { selftestPrint('FAILED: zoom overlay not shown'); app.exit(2); return }
    selftestPrint('WEBUI OK: zoom overlay ' + overlayTxt)
    // 诊断：临时显示独立窗口并记录坐标/可见性（排查"窗口不弹出"问题）
    webWin.show()
    await sleep(400)
    selftestPrint(`WEBWIN DIAG: visible=${webWin.isVisible()} minimized=${webWin.isMinimized()} bounds=${JSON.stringify(webWin.getBounds())} workArea=${JSON.stringify(screen.getPrimaryDisplay().workArea)}`)
    webWin.hide()
    await stopServer()
    broadcastState()
    selftestPrint('STOPPED')
    if (!win || win.isDestroyed()) { selftestPrint('FAILED: window not created'); app.exit(2); return }
    const title = await win.webContents.executeJavaScript('document.title')
    const panel = await win.webContents.executeJavaScript(
      "typeof window.dshBridge !== 'undefined' && window._lastZoom !== undefined && typeof window._running === 'boolean' && document.getElementById('btnZoom') !== null && document.getElementById('btnWebZoom') !== null && document.getElementById('btnSystemBrowser') !== null && document.getElementById('btnAutoRestart') !== null && document.getElementById('btnTabsEnabled') !== null && document.getElementById('btnPort') !== null && document.getElementById('btnFeedbackCode') !== null && document.getElementById('btnFeedback') !== null && document.getElementById('btnUpdateNow') !== null && document.getElementById('urlText') !== null && document.getElementById('urlText').classList.contains('link') && document.getElementById('btnReset') !== null ? 'panel-ok' : 'panel-missing'",
    )
    selftestPrint(`WEBVIEW OK: ${title} | ${panel}`)
    // 自愈链路：服务已停止 → webview 重载为空白；重启服务 → 自动恢复真实应用
    await wc.loadURL(WEB_URL).catch(() => { /* 服务已停，预期失败 */ })
    await sleep(1500)
    if (!(await isPageBlank(wc))) { selftestPrint('FAILED: webview not blank while service down'); app.exit(2); return }
    selftestPrint('WEBUI OK: blank page while service down')
    const ready2 = await startServer()
    if (!ready2) { selftestPrint('FAILED: server restart for self-heal failed'); app.exit(1); return }
    broadcastState()
    void refreshWebUiOnReady()
    const healed = await new Promise((resolve) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        wc.executeJavaScript("document.title === 'DeepSeek Harness' && document.body && document.body.innerHTML.length > 100")
          .then((ok) => { if (ok || Date.now() - t0 > 15000) { clearInterval(iv); resolve(!!ok) } })
          .catch(() => { if (Date.now() - t0 > 15000) { clearInterval(iv); resolve(false) } })
      }, 300)
    })
    if (!healed) { selftestPrint('FAILED: webui did not self-heal'); app.exit(2); return }
    selftestPrint('WEBUI OK: self-healed to app page')
    // 看护自动重启：直接杀死服务进程，应自动拉起
    const deadPid = server.displayPid()
    try { process.kill(deadPid, 'SIGKILL') } catch { /* noop */ }
    const revived = await new Promise((resolve) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (server.running() && server.displayPid() !== deadPid) { clearInterval(iv); resolve(true) }
        else if (Date.now() - t0 > 25000) { clearInterval(iv); resolve(false) }
      }, 500)
    })
    if (!revived) { selftestPrint('FAILED: auto-restart watchdog did not revive service'); app.exit(2); return }
    selftestPrint('AUTO-RESTART OK (revived PID ' + server.displayPid() + ')')
    const tStop = Date.now()
    await stopServerFast() // 验证退出路径的快速停止（应远小于 1s）
    selftestPrint(`EXIT-STOP FAST: ${Date.now() - tStop}ms`)
    broadcastState()
    // 日志轮转验证
    try { fs.appendFileSync(TRAY_LOG, 'x'.repeat(LOG_MAX_BYTES + 1000)) } catch { /* noop */ }
    rotateFileSync(TRAY_LOG)
    if (!fs.existsSync(TRAY_LOG + '.1')) { selftestPrint('FAILED: log rotation'); app.exit(2); return }
    selftestPrint('LOG ROTATION OK')
    try { fs.rmSync(path.join(os.tmpdir(), 'dshl-selftest-home'), { recursive: true, force: true }) } catch { /* noop */ }
    try { fs.rmSync(path.join(os.tmpdir(), 'dshl-selftest-agents'), { recursive: true, force: true }) } catch { /* noop */ }
    try { fs.unlinkSync(path.join(os.tmpdir(), 'dshl-selftest-config.json')) } catch { /* noop */ }
    log('selftest ok')
    reallyExit = true
    app.exit(0)
  } catch (err) {
    selftestPrint('FAILED: ' + (err && err.message ? err.message : err))
    app.exit(1)
  }
}

// ---------- 系统缩放（Windows：每次启动实时读取"设置→屏幕→缩放"，绝不写死） ----------
function systemZoom() {
  try {
    if (IS_WIN) {
      const pct = Math.round(screen.getPrimaryDisplay().scaleFactor * 100)
      if (pct >= 75 && pct <= 200) return pct
    }
  } catch { /* noop */ }
  return 100
}

// 面板与独立 WebUI 窗口共用的缩放校正值（Windows ÷1.2；其他平台原样）
function cssZoomPct() {
  return Math.round(Config.zoom * (IS_WIN ? 100 / 120 : 1))
}

// ---------- 初始化 ----------
function init() {
  loadConfig()
  applyRuntimePort() // 端口配置生效（命令行 --port / 设置页"服务端口"）
  initEnvRuntime()
  Config.zoom = systemZoom() // 启动器缩放默认跟随系统（不持久化，每次启动重读）
  Config.webZoom = cssZoomPct() // 对话界面缩放默认 = 独立窗口当前缩放（校正后）
  // 主题设置驱动原生标题栏与所有渲染进程的 prefers-color-scheme（tab 栏壳深色变量随之生效）
  try { nativeTheme.themeSource = Config.theme } catch { /* noop */ }
  harnessRoot = resolveHarnessRoot()
  loadIcons()
  fs.mkdirSync(LOG_DIR, { recursive: true })
  registerIpc()
  createWindow()

  if (SELF_TEST) {
    win.webContents.once('did-finish-load', () => { void runSelfTest() })
    return
  }

  buildTray()
  log('tray started')
  // 自动更新（electron-updater → GitHub Releases）：状态推送走 dsh:updater，下载完成弹通知 + 托盘闪烁
  updater.initUpdater({
    log,
    currentVersion: app.getVersion(),
    onNotify: (title, message) => notify(title, message),
    onFlash: startFlash,
    sendToPanel: (json) => { if (win && !win.isDestroyed()) { try { win.webContents.send('dsh:updater', json) } catch { /* noop */ } } },
    beforeInstall: async () => { if (server.owned()) await stopServerFast() },
  })
  // DSH 自动更新（dsh-update.js）：静默检查最新版，托管/全局/npx 形态自动升级，无需用户确认
  dshUpdater.initDshUpdater({
    Config,
    saveConfig,
    log,
    notify,
    refreshEnv,
    envInstall,
    envDetect,
    getServerState: () => ({ running: server.running(), owned: server.owned() }),
    stopService: () => stopServer(),
    startService: () => handleStart(),
  })
  if (firstRun) {
    if (!autostartEnabled()) setAutostart(true) // 默认开启开机自启与消息提醒
    saveConfig()
  }
  clearStaleNotify()
  migrateLegacyAutostart()
  // 启动默认触发一次"打开 DeepSeek Harness"：服务运行成功、就绪通知弹出之后再打开独立窗口。
  // 环境未就绪时：跳过服务启动，首次运行直接弹出面板（自动进入"运行环境"页引导一键安装）。
  void (async () => {
    await refreshEnv(true)
    if (!envReady()) {
      if (firstRun) showPanel()
      log('environment not ready, panel available for one-click install')
      return
    }
    await handleStart()
    if (server.running()) {
      await sleep(400)
      openWebUi()
    }
  })()
  setInterval(onTick, 2000)
  // 启动后 20 秒静默检查一次更新（仅打包版；开发模式跳过）
  setTimeout(() => updater.autoCheck(), 20000)
  // DSH 自动更新：启动后 20 秒首次检查，此后每 6 小时尝试一次（模块内部 24 小时节流）
  setTimeout(() => { void dshUpdater.checkOnce('startup') }, 20000)
  setInterval(() => { void dshUpdater.checkOnce('timer') }, 6 * 60 * 60 * 1000)
}

// ---------- 应用生命周期 ----------
if (IS_WIN) { try { app.setAppUserModelId('com.dshl.launcher') } catch { /* noop */ } }
app.on('before-quit', () => { reallyExit = true; saveWebWindowState() }) // 覆盖更新安装等非托盘路径的退出
app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ })
app.on('activate', () => openDshOrPanel()) // macOS Dock 点击
process.on('uncaughtException', (err) => { try { log('uncaught: ' + ((err && err.stack) || err)) } catch { /* noop */ } })

try { fs.unlinkSync(SELFTEST_RESULT) } catch { /* noop */ }

if (!SELF_TEST) {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      // 已有一个实例在跑：提示用户（避免"双击了新包但好像没反应"的困惑），并打开窗口
      notify('DeepSeek Harness', '启动器已在运行（托盘图标），本次双击未启动新实例')
      openDshOrPanel()
    })
    app.whenReady().then(init)
  }
} else {
  app.whenReady().then(init)
}
