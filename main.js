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
const { pathToFileURL } = require('url')
const semver = require('semver')
const envDetect = require('./env-detect')
const envInstall = require('./env-install')
const updater = require('./updater')
const balance = require('./balance')
const dshUpdater = require('./dsh-update')
const { redact } = require('./redact')
const runGuard = require('./run-guard')
const lifecycle = require('./lifecycle')
const health = require('./health')
const diagnostics = require('./diagnostics')
const market = require('./market')
const stopGuard = require('./service-stop-guard')
const handover = require('./service-handover')

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
    else if (a === '--panel') out.panel = true
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

// 按当前配置重算运行端口（配置缺失/非法一律回退默认 3080）。
// seed=true（仅启动时）：命令行 --port 优先，作为本次会话的种子；运行时（设置页/一键换端口）一律以 Config.port 为准，
// 否则 CLI 端口会永久压住切换后的新端口（bug：换端口"一直卡住"）。
function applyRuntimePort(seed = false) {
  const p = (seed && args.port) || (SELF_TEST ? 3999 : (Number.isInteger(Config.port) && Config.port >= 1024 && Config.port <= 65535 && Config.port !== 0 ? Config.port : 3080))
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
const DIAG_DIR = path.join(LOG_DIR, 'diagnostics')
const ACTIVE_RUN = path.join(LOG_DIR, 'active-run.json')
const CONFIG_PATH = SELF_TEST
  ? path.join(os.tmpdir(), 'dshl-selftest-config.json')
  : path.join(HOME, 'dshl', 'config.json')
const SELFTEST_RESULT = path.join(os.tmpdir(), 'dshl-selftest-result.txt')
const ASSETS_DIR = path.join(__dirname, 'assets')
const WWWROOT = path.join(__dirname, 'wwwroot')
const OFFLINE_HTML = path.join(WWWROOT, 'offline.html')

// ---------- 配置 ----------
const Config = { zoom: 100, webZoom: 100, theme: 'light', notify: true, useSystemBrowser: false, autoRestart: true, tabsEnabled: false, port: 0, feedbackWebhook: '', windowWidth: 0, windowHeight: 0, webWindowWidth: 0, webWindowHeight: 0, webWindowMaximized: false, webWindowX: null, webWindowY: null, harnessRoot: '', nodePath: '', dshVersion: 'latest', dshChannel: 'latest', nodeMajor: 22, nodeMirror: '', npmRegistry: '', dshUpdateCheckedAt: 0, dshMigrateRetryAt: 0, defExcludeTryVersion: '', panelHideNotified: false, balanceApiKey: '', balanceBaseUrl: '', crashNoticeSeen: '', crashNoticeDismissed: '', pluginMarketAutoTryVersion: '', pluginMarketDeclined: false }
let firstRun = false
let harnessRoot = ''
let webZoomLoaded = false // 对话界面缩放是否来自用户持久化设置（未设置过才跟随系统默认）

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
      // 安装完成后：重新探测环境，就绪则自动启动服务并弹出 DSH 独立窗口；
      // 若探测暂未就绪（竞态/文件延迟），由 onTick 补启动。
      // 静默任务（后台迁移）：只切换检测结果，不自动启动/重启服务（避免打断正在运行的会话）。
      const snap = envInstall.getJob()
      const silent = !!(snap && snap.job && snap.job.silent)
      void (async () => {
        await refreshEnv(true)
        if (silent) {
          log('silent install done, detection switched (service left as-is)')
          return
        }
        if (envReady()) {
          log('environment ready after install, starting service')
          await handleStart()
          void maybeAutoInstallPluginMarket() // 首次安装环境完成后：默认装上插件市场
          if (server.running()) {
            await sleep(400)
            openWebUi() // 新手完成感：服务就绪后自动打开 DeepSeek Harness
          }
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
    void maybeAutoInstallPluginMarket() // 环境/服务刚就绪：补上插件市场默认安装
  }
}

// 后台静默迁移：托管/npx 形态 → 全局 npm（统一 npm 渠道；失败 24h 节流重试，不影响原渠道使用）
function maybeMigrateDsh() {
  if (!envReport || !envReport.dsh || !envReport.dsh.kind) return
  const kind = envReport.dsh.kind
  if (kind !== 'managed' && kind !== 'npx') return
  const snap = envInstall.getJob()
  if (snap && snap.job && snap.job.status === 'running') return
  if (Date.now() < (Number(Config.dshMigrateRetryAt) || 0)) return
  const nodeOk = envReport.node && envReport.node.status === 'ok'
  const items = nodeOk ? ['dsh'] : ['node', 'dsh']
  log(`DSH 当前为 ${kind === 'managed' ? '托管' : 'npx'} 安装，后台迁移到全局 npm（node=${nodeOk ? 'ok' : 'missing'}）…`)
  try {
    envInstall.startInstall(items, {
      migrate: true,
      silent: true,
      dshVersion: envReport.dsh.version || Config.dshVersion,
    })
  } catch (err) {
    log('DSH 迁移启动失败：' + (err && err.message ? err.message : String(err)))
  }
}

// ---------- Defender 排除项（安装/升级后首次运行自动尝试一次：预读排除项 → 缺则 UAC 授权添加） ----------
// 无法静默：加排除项必须管理员（UAC 弹一次）；Win11 默认"篡改保护"开启时即使管理员也拒绝，仅记录日志。
// 每个 dshl 版本只尝试一次（defExcludeTryVersion 记账），避免每次启动都弹 UAC。

function runPwsh(script, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (err.code || 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
    } catch (e) {
      resolve({ ok: false, code: 1, stdout: '', stderr: e.message })
    }
  })
}

async function readDefenderExclusions() {
  const r = await runPwsh('(Get-MpPreference).ExclusionPath', { timeoutMs: 60000 })
  if (!r.ok) throw new Error(r.stderr.trim() || r.stdout.trim() || '无法读取 Defender 排除项')
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== '::')
}

// 提权添加排除项：外层普通权限 PowerShell 用 -Verb RunAs 拉起内层（EncodedCommand 免转义），结果写入临时文件
async function addDefenderExclusions(paths) {
  const resultFile = path.join(os.tmpdir(), `dshl-defender-${process.pid}-${Date.now()}.txt`)
  const inner = [
    `$r = '${resultFile.replace(/'/g, "''")}'`,
    `try { Add-MpPreference -ExclusionPath @(${paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',')}) -ErrorAction Stop; 'OK' | Out-File -FilePath $r -Encoding utf8 } catch { 'ERR: ' + $_.Exception.Message | Out-File -FilePath $r -Encoding utf8 }`,
  ].join('; ')
  const b64 = Buffer.from(inner, 'utf16le').toString('base64')
  const outer = `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-EncodedCommand','${b64}')`
  const r = await runPwsh(outer, { timeoutMs: 300000 })
  let text = ''
  try { text = fs.readFileSync(resultFile, 'utf8').trim() } catch { /* 无结果文件 = UAC 被取消/拒绝 */ }
  try { fs.unlinkSync(resultFile) } catch { /* noop */ }
  if (!text) text = 'ERR: UAC 被取消或被拒绝' + (r.stderr.trim() ? '（' + r.stderr.trim().slice(0, 200) + '）' : '')
  return text
}

async function maybeApplyDefenderExclusion() {
  if (!app.isPackaged || !IS_WIN) return
  if (Config.defExcludeTryVersion === app.getVersion()) return
  Config.defExcludeTryVersion = app.getVersion()
  try { saveConfig() } catch { /* noop */ }
  const paths = [
    path.dirname(app.getPath('exe')), // dshl 安装目录
    path.join(process.env.APPDATA || '', 'npm'), // npm 全局目录（DSH 包）
    path.join(os.homedir(), '.dsh'), // DSH 配置 / profile / 会话
  ].filter(Boolean)
  log('defender: 检查排除项（' + paths.join('；') + '）…')
  try {
    const cur = await readDefenderExclusions()
    const missing = paths.filter((p) => !cur.some((c) => c.toLowerCase() === p.toLowerCase()))
    if (!missing.length) {
      log('defender: 排除项已存在，跳过')
      return
    }
    log('defender: 缺少排除项 ' + missing.join('、') + '，请求添加（将弹出一次 UAC 授权）…')
    const result = await addDefenderExclusions(missing)
    log('defender: ' + result)
  } catch (e) {
    log('defender: 检查/添加排除项失败：' + (e && e.message ? e.message : String(e)))
  }
}

// 安装任务进度/日志推送（主进程 → 面板；面板未打开时由环形缓冲兜底，重开时快照恢复）
function pushEnv(patch) {
  const j = patch && patch.job
  // 静默迁移任务失败：记录重试节流（24h），避免每次启动都重复长时间失败安装
  if (j && j.migrate && j.status === 'failed') {
    Config.dshMigrateRetryAt = Date.now() + 24 * 60 * 60 * 1000
    try { saveConfig() } catch { /* noop */ }
    log(`DSH 迁移到全局 npm 失败，24 小时后自动重试：${j.error || ''}`)
  }
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
    // 统一脱敏：sk- key / token / 鉴权头 / URL 凭据在落盘前替换（反馈与诊断包复用同一文本，因此天然安全）
    fs.appendFileSync(TRAY_LOG, `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${redact(message)}\n`)
  } catch { /* 日志失败不致命 */ }
}

// 逐字段应用配置（loadConfig 与"健康快照恢复后重载"共用，保证校验规则一致）
function applyConfigJson(cfg) {
  if (cfg.theme === 'light' || cfg.theme === 'dark' || cfg.theme === 'system') Config.theme = cfg.theme
  if (typeof cfg.notify === 'boolean') Config.notify = cfg.notify
  if (typeof cfg.useSystemBrowser === 'boolean') Config.useSystemBrowser = cfg.useSystemBrowser
  if (typeof cfg.autoRestart === 'boolean') Config.autoRestart = cfg.autoRestart
  // tabsEnabled：设置页开关已移除，恒为关闭（精简标题栏）；历史配置里的值不再生效
  if (Number.isInteger(cfg.port) && cfg.port >= 1024 && cfg.port <= 65535) Config.port = cfg.port
  if (typeof cfg.feedbackWebhook === 'string') Config.feedbackWebhook = cfg.feedbackWebhook
  if (Number.isInteger(cfg.windowWidth) && cfg.windowWidth >= PANEL_MIN_W) Config.windowWidth = cfg.windowWidth
  if (Number.isInteger(cfg.windowHeight) && cfg.windowHeight >= PANEL_MIN_H) Config.windowHeight = cfg.windowHeight
  // 独立窗口几何：尺寸（≥640×480）+ 最大化 + 位置（多显示器变更时打开侧校验回退居中）
  if (Number.isInteger(cfg.webWindowWidth) && cfg.webWindowWidth >= 640) Config.webWindowWidth = cfg.webWindowWidth
  if (Number.isInteger(cfg.webWindowHeight) && cfg.webWindowHeight >= 480) Config.webWindowHeight = cfg.webWindowHeight
  if (typeof cfg.webWindowMaximized === 'boolean') Config.webWindowMaximized = cfg.webWindowMaximized
  if (Number.isInteger(cfg.webWindowX) && Number.isInteger(cfg.webWindowY)) { Config.webWindowX = cfg.webWindowX; Config.webWindowY = cfg.webWindowY }
  if (typeof cfg.harnessRoot === 'string' && cfg.harnessRoot) Config.harnessRoot = cfg.harnessRoot
  if (typeof cfg.nodePath === 'string' && cfg.nodePath) Config.nodePath = cfg.nodePath
  if (typeof cfg.dshVersion === 'string' && cfg.dshVersion) Config.dshVersion = cfg.dshVersion
  if (cfg.dshChannel === 'alpha' || cfg.dshChannel === 'latest') Config.dshChannel = cfg.dshChannel
  if (Number.isInteger(cfg.nodeMajor)) Config.nodeMajor = cfg.nodeMajor
  if (typeof cfg.nodeMirror === 'string') Config.nodeMirror = cfg.nodeMirror
  if (typeof cfg.npmRegistry === 'string') Config.npmRegistry = cfg.npmRegistry
  if (Number.isFinite(cfg.dshUpdateCheckedAt) && cfg.dshUpdateCheckedAt > 0) Config.dshUpdateCheckedAt = cfg.dshUpdateCheckedAt
  if (Number.isFinite(cfg.dshMigrateRetryAt) && cfg.dshMigrateRetryAt > 0) Config.dshMigrateRetryAt = cfg.dshMigrateRetryAt
  if (typeof cfg.defExcludeTryVersion === 'string') Config.defExcludeTryVersion = cfg.defExcludeTryVersion
  if (typeof cfg.panelHideNotified === 'boolean') Config.panelHideNotified = cfg.panelHideNotified
  // 对话界面缩放：用户改过才持久化；没改过时启动跟随系统默认（见 init）
  if (Number.isInteger(cfg.webZoom) && cfg.webZoom >= 50 && cfg.webZoom <= 300) { Config.webZoom = cfg.webZoom; webZoomLoaded = true }
  if (typeof cfg.balanceApiKey === 'string' && cfg.balanceApiKey) Config.balanceApiKey = cfg.balanceApiKey
  if (typeof cfg.balanceBaseUrl === 'string' && cfg.balanceBaseUrl) Config.balanceBaseUrl = cfg.balanceBaseUrl
  // 崩溃提示的"已读/已关闭"记账：按上次崩溃的启动时间戳去重，避免同一条提示每次开面板都出现
  if (typeof cfg.crashNoticeSeen === 'string') Config.crashNoticeSeen = cfg.crashNoticeSeen
  if (typeof cfg.crashNoticeDismissed === 'string') Config.crashNoticeDismissed = cfg.crashNoticeDismissed
  // 插件市场（dshmarket）自动安装记账：每个启动器版本只自动尝试一次
  if (typeof cfg.pluginMarketAutoTryVersion === 'string') Config.pluginMarketAutoTryVersion = cfg.pluginMarketAutoTryVersion
  if (typeof cfg.pluginMarketDeclined === 'boolean') Config.pluginMarketDeclined = cfg.pluginMarketDeclined
}

function loadConfig() {
  firstRun = !fs.existsSync(CONFIG_PATH)
  if (firstRun) return
  try {
    applyConfigJson(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
  } catch { log('config parse failed, using defaults') }
}

// 健康快照恢复后：从磁盘重新加载配置到内存 Config（避免"文件已回退、内存还是旧值"的错位）
function mergeConfigFromDisk() {
  try {
    applyConfigJson(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
    log('config re-merged from disk after recovery')
  } catch (err) { log('config reload failed: ' + err.message) }
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
// 服务启停互斥标志：停止过程中重复点击/重复调用只允许一次真正执行；看门狗兜底复位
// （底层 taskkill 卡住时标志会永久停在 true → 表现为"点停止没反应、按钮变灰、服务不停"）。
// 逻辑在 service-stop-guard.js（纯函数、可单测）。
const STOP_WATCHDOG_MS = stopGuard.DEFAULT_TIMEOUT_MS

function beginServiceStop() {
  return stopGuard.beginStop({
    timeoutMs: STOP_WATCHDOG_MS,
    onTimeout: () => {
      log(`stop watchdog fired after ${STOP_WATCHDOG_MS}ms：停止流程未在预期时间内结束，已强制复位（服务可能仍在运行，请查看日志/手动结束进程）`)
      try { lifecycle.emit('service.stopTimeout', { ms: STOP_WATCHDOG_MS }) } catch { /* noop */ }
      broadcastState()
    },
  })
}

function endServiceStop() {
  stopGuard.endStop()
}

function serviceStopping() {
  return stopGuard.isStopping()
}

// DSH 自重启识别（详见 service-handover.js）：我们的 child 退出后，端口可能正被它克隆出的后继持有。
// 认领窗口分两档：端口空档且没有匹配候选时短等（真崩溃不必拖久），有匹配候选时等够它 bind。
const HANDOVER_POLL_MS = 300
const HANDOVER_SETTLE_MS = 3000
const HANDOVER_MAX_MS = 8000 // 冷启动 DSH 绑端口实测 3.5~4.5s，留余量
const HANDOVER_SCAN_MS = 600 // 进程表取证节流（PowerShell 单次约 0.7~1s，不能进每轮的轮询）
const CMDLINE_TIMEOUT_MS = 6000 // PowerShell 冷启动 + AV 扫描实测可到 3~4s，超时会让识别退化成"外部实例"
const TOKEN_TAIL_MS = 15000 // child 退出后继续读它的 stdout 多久：克隆体可能继承同一根管道
const TOKEN_GRACE_MS = 1200 // stdout 已到 EOF 时的收尾宽限（确认没有半行 token 卡在缓冲里）
const ADOPT_DOWN_CONFIRM_MS = 6000 // 端口连续多久没人应答才判定服务消失
const TRACK_WATCHDOG_MS = 2000 // onTick 周期：非自有世代的存活性采样间隔
const OWNER_VERIFY_EVERY_TICKS = 10 // 认领/接管世代约每 20s 复核一次端口持有者
const RESTART_COOLDOWN_MS = 10000

const server = {
  child: null,
  adoptedPid: 0,
  adoptedAlive: false,
  claimedPid: 0, // DSH 自重启后继：命令行与本轮启动签名一致，已认领
  claimedAlive: false,
  launchSig: null, // { script, args }，与实际 spawn argv 同源（认领的唯一判据）
  authPending: false, // 服务在跑但没拿到本轮访问凭据（token），页面需要一次由启动器发起的重启
  tokenPending: false, // 认领后的 stdout 尾读窗口内，token 有无尚未定案
  tailGen: -1, // 尾读窗口所属世代
  tailOpen: false, // 该世代的 stdout 是否仍在读（克隆体可能继承了管道）
  settling: false, // 交接裁决中
  settlingServing: false, // 裁决期间端口是否有人应答（面板据此在"运行中/正在自动重启"之间取舍）
  handover: null, // 最近一次交接裁决（{ at, fromPid, toPid, verdict, source, elapsedMs }），诊断用
  handoverPromise: null, // 进行中的裁决：停止/退出路径先等它收敛，避免"停了旧的、活着新的"
  gen: 0, // 世代号：spawn/接管/停止自增，让过期的尾读与裁决自我作废（认领不换世代）
  stopping: false,
  blockedReason: '',
  suggestedPort: 0,
  launchUrl: null, // 本轮服务 stdout 打印的访问地址（新 DSH 带一次性 token，形如 ?token=xxx）；null=未知/无鉴权
  expectCrash: false, // 测试/主动 kill 用：这次退出是我们造成的，跳过交接裁决直接走崩溃路径
  owned() { return !!this.child && this.child.exitCode === null && this.child.signalCode === null },
  claimed() { return this.claimedPid !== 0 && this.claimedAlive },
  // 我们负责的服务 = 自己拉起的 + 认领的后继（两者都会被停止/换端口/健康记账；外部接管实例不算）
  managed() { return this.owned() || this.claimed() },
  running() { return this.managed() || (this.adoptedPid !== 0 && this.adoptedAlive) },
  origin() {
    if (this.owned()) return 'owned'
    if (this.claimed()) return 'claimed'
    return this.adoptedPid ? 'external' : 'none'
  },
  displayPid() {
    if (this.owned()) return this.child.pid
    return this.claimed() ? this.claimedPid : this.adoptedPid
  },
}

// WebUI 应加载的地址：新 DSH（v0.1.2-rc.1 起）每次启动生成一次性 launch token，
// 首次访问带 token 的地址才能换取浏览器 cookie（默认 30 天），之后裸地址凭 cookie 也可用。
// 有 token 就带 token 加载（顺带续期），没有（旧版 DSH / 外部接管服务看不到其 stdout）退回裸地址。
function uiUrl() {
  return server.launchUrl || WEB_URL
}

// 服务阶段（供 WebUI 壳/说明页展示）：starting=正在启动 / stopping=正在停止 / restarting=看护重启中 / ready=就绪 / stopped=未运行
let serverRestarting = false
function servicePhase() {
  if (server.child && server.child.__starting) return 'starting'
  if (serviceStopping()) return 'stopping'
  // 交接裁决中不能塌成"已停止"：端口还有人应答就是运行中，否则算自动重启中
  if (server.settling) return server.running() || server.settlingServing ? 'ready' : 'restarting'
  if (serverRestarting) return 'restarting'
  if (server.running()) return 'ready'
  return 'stopped'
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

// 读某 PID 的完整命令行。拿不到一律返回 ''：调用方按"不可判定"处理，绝不凭猜测认领别人的进程。
async function readCmdline(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  if (IS_WIN) {
    const r = await runPwsh(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`, { timeoutMs: CMDLINE_TIMEOUT_MS })
    return r.ok ? r.stdout.trim() : ''
  }
  try {
    // /proc 以 NUL 分隔 argv，本身没有引号语义：含空格的参数补上引号，交给 splitCmdline 原样还原
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      .map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ')
  } catch { return '' }
}

// 可能是"我们这一轮 DSH 的后继"的进程：命令行里出现启动脚本的 node 进程。
// needle 只用来缩小 POSIX 侧的扫描范围；真正的判定在 matchLaunchSig（逐参数比对）。
async function dshSuccessorCandidates(needle) {
  const out = []
  if (IS_WIN) {
    const r = await runPwsh('Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId);$($_.CommandLine)" }', { timeoutMs: CMDLINE_TIMEOUT_MS })
    if (!r.ok) return out
    for (const line of r.stdout.split(/\r?\n/)) {
      const sep = line.indexOf(';')
      if (sep < 0) continue
      const pid = parseInt(line.slice(0, sep), 10)
      if (Number.isInteger(pid)) out.push({ pid, cmdline: line.slice(sep + 1) })
    }
    return out
  }
  const text = await new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,args='], { timeout: CMDLINE_TIMEOUT_MS }, (err, stdout) => resolve(err ? '' : String(stdout || '')))
  })
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+([\s\S]*)$/)
    if (!m) continue
    if (needle && !m[2].includes(needle)) continue
    out.push({ pid: parseInt(m[1], 10), cmdline: m[2] })
  }
  return out
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
      // 新版 DSH 对裸地址直接回 401 鉴权页（"dsh web authentication required..."），同样计为指纹命中
      done(/DeepSeek Harness|dsh web authentication required/i.test(text), 'fingerprint')
    })
  })
}

// 端口上已经有服务在跑：先验身份，是 DSH 才接管（外部实例拿不到它的 stdout，只能靠既有 cookie 访问），
// 否则拒绝并建议空闲端口。启动入口与"自重启交接裁决"共用这一条路径，判定与文案必须一致。
async function handlePortOccupied(source) {
  const probe = await probeDsh()
  if (probe.ok) {
    server.gen++ // 旧世代的尾读/裁决就此作废
    clearClaimed()
    server.adoptedPid = await findListenPid()
    server.adoptedAlive = server.adoptedPid !== 0
    server.launchUrl = null
    server.launchSig = null
    log(`detected existing DSH on port ${PORT} (PID ${server.adoptedPid}), adopting`)
    lifecycle.emit('service.adopt', { pid: server.adoptedPid, port: PORT, source: source || 'start' })
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
  lifecycle.emit('service.blocked', { port: PORT, reason: 'port-conflict' })
  return false
}

async function startServer() {
  if (server.owned() || server.claimed()) return true // 已有我们负责的服务在跑（含认领的自重启后继）
  server.blockedReason = ''
  server.suggestedPort = 0
  if (await portOpen()) return handlePortOccupied('start')
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
  const spawnArgs = buildDshArgv(plan)
  server.gen++ // 新世代：上一轮的尾读与交接裁决一律作废
  server.handoverPromise = null
  clearClaimed()
  const gen = server.gen
  server.launchUrl = null // 新进程的 launch token 只在本轮 stdout 中出现
  server.launchSig = { script: spawnArgs[0], args: spawnArgs.slice(1) } // 与实际 argv 同源，认领判据不会漂
  let child
  try {
    child = spawn(nodeCmd, spawnArgs, {
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
  // 落盘 + "退出后仍短暂读尾巴"：DSH 自重启的克隆体可能继承同一根 stdout 管道，
  // 它打印的 dsh web: …?token= 是我们唯一能拿到的新凭据来源（token 每进程随机，别处读不到）。
  const tail = { closed: false, timer: null }
  server.tailGen = gen
  server.tailOpen = true
  const closeTail = () => {
    if (tail.closed) return
    tail.closed = true
    if (tail.timer) { clearTimeout(tail.timer); tail.timer = null }
    try { outS.end() } catch { /* noop */ }
    try { errS.end() } catch { /* noop */ }
    try { child.stdout.destroy() } catch { /* noop */ }
    try { child.stderr.destroy() } catch { /* noop */ }
    // 尾读窗口关闭仍没等到 token：认领世代确定无法自行恢复页面凭据，交给面板引导一次重启
    if (server.tailGen === gen) server.tailOpen = false
    if (server.gen === gen && server.tokenPending) markAuthPending()
  }
  // 到点必关：只有关闭方（新认领/停止）之外的路径才需要自己排定时器，否则管道句柄会一直挂着
  const armTail = () => { if (!tail.closed && !tail.timer) tail.timer = setTimeout(closeTail, TOKEN_TAIL_MS) }
  // stdout 到 EOF = 克隆体没有继承这根管道，再等也不会有新 token：短宽限后收尾（15s 上限仍兜住继承管道的情况）
  child.stdout.once('end', () => {
    if (tail.closed) return
    if (tail.timer) clearTimeout(tail.timer)
    tail.timer = setTimeout(closeTail, TOKEN_GRACE_MS)
  })
  const writeSafe = (s, d) => { if (!tail.closed) { try { s.write(d) } catch { /* 已 end 的写入异常不该变成 uncaught 噪声 */ } } }
  // 解析 dsh web 启动时打印的访问地址：新 DSH（v0.1.2-rc.1 起）每次启动生成一次性
  // launch token，页面须带 token 首次访问换取浏览器 cookie（默认 30 天）。
  // 捕获后立即刷新 WebUI：首次加载可能早于本行到达而停在鉴权页/空白，由 refreshWebUiOnReady 与鉴权兜底补上。
  child.__launchBuf = ''
  const onData = (d) => {
    writeSafe(outS, d)
    if (server.gen !== gen) return // 过期世代的输出：不再解读
    child.__launchBuf = (child.__launchBuf + String(d)).slice(-8192)
    let nl
    while ((nl = child.__launchBuf.indexOf('\n')) >= 0) {
      const line = child.__launchBuf.slice(0, nl).trim()
      child.__launchBuf = child.__launchBuf.slice(nl + 1)
      const href = handover.parseDshWebLine(line, { host: HOST, port: PORT }) // 只认本机当前端口的带 token 地址
      if (!href) continue
      server.launchUrl = href
      if (server.tokenPending) {
        server.tokenPending = false
        server.authPending = false
        lifecycle.emit('service.tokenCaptured', { pid: server.displayPid(), port: PORT })
        log('captured DSH 自重启后的新 launch token，页面凭据已续上')
      } else {
        log('captured dsh web launch URL (token auth page)')
      }
      if (server.running()) void refreshWebUiOnReady(false) // 加载早于本行到达的标签会停在鉴权页/空白，立即补拉
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', (d) => { writeSafe(errS, d) })
  child.__starting = true
  child.on('exit', (code, signal) => {
    if (server.child !== child) {
      // 过期世代（换端口/停止/孩子被后继取代）：还在等 token 就留到尾读窗口，否则立即收尾
      if (server.tokenPending) armTail(); else closeTail()
      return
    }
    server.child = null
    const expected = !!server.stopping || !!child.__starting
    lifecycle.emit('service.exit', { code, signal, expected })
    if (server.stopping) { server.launchUrl = null; closeTail(); return }
    if (child.__starting) { server.launchUrl = null; return } // 启动阶段退出由 startServer 的等待循环报告失败
    server.launchUrl = null // 旧 token 作废；新进程若继承管道，token 会晚于本行到达并重新填上
    armTail()
    if (server.expectCrash) { // 测试/自伤：没有交接可判，直接走崩溃路径
      server.expectCrash = false
      handleUnexpectedExit(child.pid, code, signal, 0, 'expected')
      return
    }
    server.handoverPromise = runHandover(child.pid, code, signal).catch((err) => {
      log('handover 裁决异常（按崩溃处理）：' + (err && err.message ? err.message : String(err)))
      server.settling = false
      server.settlingServing = false
      handleUnexpectedExit(child.pid, code, signal, 0, 'error')
    })
  })
  server.child = child
  log('starting DSH web (hidden window)')
  lifecycle.emit('service.start', { port: PORT, pid: child.pid })
  broadcastState() // 立刻把 phase=starting 推给面板（否则启动期间面板一直显示上一次的"已停止"）
  const deadline = Date.now() + READY_TIMEOUT_SEC * 1000
  while (Date.now() < deadline) {
    if (server.child !== child) return false // 已被 stop 打断
    if (child.exitCode !== null) return false
    if (await portOpen()) {
      // 端口有人应答 ≠ 我们的服务起来了。事故里就是这一步把别人的应答当成了就绪，
      // 于是我们的孩子与后继抢同一端口 → EADDRINUSE 循环。必须核对监听者是谁。
      const listener = await findListenPid()
      const verdict = handover.classifyReadiness({ listenerPid: listener, childPid: child.pid, sigMatched: false })
      if (verdict === 'ready' || verdict === 'ready-unverified') return markReady(child, verdict)
      const matched = await matchSuccessorPid(listener)
      claimSuccessor(matched, listener, { fromPid: child.pid, source: 'startup', elapsedMs: 0 })
      abandonChild(child) // 我们的孩子从没绑上端口：留着只会反复抢端口（异步强杀，不阻塞裁决）
      if (server.claimed()) return true
      return handlePortOccupied('ready-refused')
    }
    await sleep(500)
  }
  // 就绪超时：必须收拾干净再返回 false。
  // 否则子进程与 __starting 都留着 → servicePhase() 永远返回 'starting'（WebUI 永久卡在
  // "正在启动服务…"）、scheduleHealthyCapture 也没安排，而面板还显示"运行中"。
  log(`DSH did not become ready in ${READY_TIMEOUT_SEC}s, killing PID ${child.pid}`)
  lifecycle.emit('service.readyTimeout', { pid: child.pid, port: PORT, timeoutSec: READY_TIMEOUT_SEC })
  child.__starting = false
  if (server.child === child) { server.child = null; server.launchUrl = null }
  if (healthTimer) { clearTimeout(healthTimer); healthTimer = null }
  server.stopping = true
  try { await killPid(child.pid, true) } catch { /* noop */ }
  server.stopping = false
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

// ---------- DSH 自重启的识别与交接 ----------
// 判定逻辑在 service-handover.js（纯函数、可单测），这里只管时序与副作用。

// 我们启动 DSH 的实际 argv —— 唯一来源：spawn 与"后继认领判据"共用，改一处不会漂。
// DSH web 应用自 v0.1.0-rc.8 起默认自动打开系统默认浏览器（--no-open 关闭）；
// 更早版本不认识该参数（传了会报 unknown option 直接退出），按版本号判断是否传。
function buildDshArgv(plan) {
  const dshVer = String(plan.dshVersion || '').replace(/^v/, '')
  let noOpen = false
  try { noOpen = semver.gte(dshVer, '0.1.0-rc.8', { includePrerelease: true }) } catch { noOpen = false }
  const argv = [plan.dshBin, 'web', '--host', HOST, '--port', String(PORT)]
  if (noOpen) argv.push('--no-open')
  return argv
}

function clearClaimed() {
  server.claimedPid = 0
  server.claimedAlive = false
  server.tokenPending = false
  server.authPending = false
}

// 裁决窗口必须显式结束：settling 挂着会让 servicePhase() 永远停在"重启中"，
// 还会让 onTick 的非自有世代看护一直跳过。
function endSettling() {
  server.settling = false
  server.settlingServing = false
}

// 尾读窗口已耗尽仍无 token：服务在跑，但页面凭据只能靠一次由启动器发起的重启拿回来。
// 这是认领 DSH 自重启后继后的常态（token 每进程随机、且新进程的 stdout 不归我们），不是异常。
function markAuthPending() {
  server.tokenPending = false
  server.authPending = true
  log('DSH 自重启后未拿到新的访问凭据（launch token），页面需要一次重启')
  lifecycle.emit('service.selfRestartNoToken', { pid: server.claimedPid, port: PORT })
  if (!SELF_TEST) {
    for (const t of webTabs) {
      const wc = t.view && t.view.webContents
      if (wc && !wc.isDestroyed()) { t.blank = true; try { wc.loadURL(loadingUrl('auth', t.id, loadingParams())) } catch { /* noop */ } }
    }
    webPushState()
    notify('DeepSeek Harness', '服务已自行重启并正常运行；页面需要一次重新连接，可在启动器面板点「重启服务」')
  }
  broadcastState()
}

// 端口持有者能否被本轮启动签名解释（= 我们的后继）。
// 已知持有者时只查那一个 PID 的命令行（PowerShell 冷启动慢，全表扫描留给"还没人绑端口"的情况）。
// 取不到候选或读不到命令行一律返回 0：宁可判成外部实例，绝不误认领。
async function matchSuccessorPid(listenerPid) {
  const sig = server.launchSig
  if (!sig || !sig.script) return 0
  if (listenerPid) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cmd = await readCmdline(listenerPid)
      if (cmd) return handover.matchLaunchSig(cmd, sig).ok ? listenerPid : 0
      if (attempt === 0) await sleep(300) // 多半是 PowerShell 超时，再给一次机会
    }
    return 0
  }
  const cands = await dshSuccessorCandidates(path.basename(sig.script))
  const hit = cands.find((c) => handover.matchLaunchSig(c.cmdline, sig).ok)
  return hit ? hit.pid : 0
}

function markReady(child, ownerVerdict) {
  child.__starting = false
  log(`DSH ready on ${WEB_URL} (PID ${child.pid}${ownerVerdict === 'ready-unverified' ? '，端口持有者未核验' : ''})`)
  lifecycle.emit('service.ready', { pid: child.pid, port: PORT, owner: ownerVerdict })
  scheduleHealthyCapture(child.pid) // 存活 120s 兜底；页面加载成功是快路径
  // 任何一次成功就绪都重新武装看护（手动启动/自动重启同理；清掉"已停止"历史）。
  // 计数窗口不在这里清空：服务"起来就崩"的循环必须继续累计，否则回退/halt 永远到不了阈值。
  readySince = Date.now()
  autoRestartStopped = false
  return true
}

// 端口上的服务不属于我们时，我们那个从没绑上端口的孩子只会反复抢端口：摘句柄后强杀。
// 先摘 server.child，让它自己的 exit 走"过期世代"分支（不触发崩溃路径，也不误关尾读窗口）。
function abandonChild(child) {
  child.__starting = false
  if (server.child === child) server.child = null
  server.stopping = true
  return killPid(child.pid, true).then(() => { server.stopping = false })
}

// 认领 DSH 自重启的后继：同一个端口、同一份数据，只是换了 PID。
// 不发通知、不闪烁、不累加崩溃计数（自重启不是故障）；也不清计数窗口（清空需要健康证明）。
function claimSuccessor(matchedPid, listenerPid, meta) {
  if (!matchedPid || matchedPid !== listenerPid) return false
  server.claimedPid = matchedPid
  server.claimedAlive = true
  server.tokenPending = true // 尾读窗口内；到点仍无 token → authPending，页面切"需要新凭据"说明页
  server.authPending = false
  server.settling = false
  server.settlingServing = false
  server.handover = { at: new Date().toISOString(), fromPid: meta.fromPid || 0, toPid: matchedPid, verdict: 'self-restart', source: meta.source || 'handover', elapsedMs: meta.elapsedMs || 0 }
  cancelRestartRetry()
  healthFault = false // 新世代：交接空档期里的页面加载失败不该毒化健康门
  scheduleHealthyCapture(matchedPid) // 认领世代同样要能证明健康（120s 兜底，否则计数窗口永远清不掉）
  // 尾读窗口已经关过（stdout 早到 EOF）：这一代不可能再拿到 token，立即定案，别把 tokenPending 挂死
  if (!server.launchUrl && !server.tailOpen) markAuthPending()
  log(`DSH 自重启已确认：新进程 PID ${matchedPid}（命令行与本轮启动签名一致），不计为崩溃${meta.elapsedMs ? `，交接耗时 ${meta.elapsedMs}ms` : ''}`)
  lifecycle.emit('service.handover', { fromPid: meta.fromPid || 0, toPid: matchedPid, verdict: 'self-restart', source: meta.source || 'handover', port: PORT, elapsedMs: meta.elapsedMs || 0 })
  broadcastState()
  return true
}

// child 退出后的裁决窗口：端口可能已被后继持有、可能还在 bind、也可能真是崩溃。
async function runHandover(fromPid, code, signal) {
  const gen = server.gen
  const started = Date.now()
  let listener = 0
  let matched = 0
  let lastScan = 0
  let verdict = 'pending'
  server.settling = true
  server.settlingServing = await portOpen()
  while (true) {
    listener = await findListenPid()
    if (Date.now() - lastScan >= HANDOVER_SCAN_MS) {
      lastScan = Date.now()
      matched = await matchSuccessorPid(listener)
    }
    verdict = handover.classifyHandover({
      listenerPid: listener,
      matchedPid: matched,
      elapsedMs: Date.now() - started,
      settleMs: HANDOVER_SETTLE_MS,
      maxMs: HANDOVER_MAX_MS,
    })
    server.settlingServing = listener > 0 ? true : await portOpen()
    // 被停止/新启动/退出打断：裁决作废，交由打断方收尾
    if (server.gen !== gen || reallyExit || serviceStopping()) { endSettling(); return }
    broadcastState() // 面板在裁决期也要看到真实状态（不能停在"已停止"）
    if (verdict !== 'pending') break
    await sleep(HANDOVER_POLL_MS)
  }
  const elapsedMs = Date.now() - started
  endSettling()
  if (verdict === 'self-restart') {
    claimSuccessor(matched, listener, { fromPid, source: 'handover', elapsedMs })
    return
  }
  if (verdict === 'external') {
    log(`端口 ${PORT} 被另一个进程持有（PID ${listener}），按"已在运行的服务"处理`)
    await handlePortOccupied('handover')
    broadcastState()
    return
  }
  handleUnexpectedExit(fromPid, code, signal, elapsedMs)
}

// 真崩溃路径：语义与改动前保持一致（标故障、切说明页、通知+闪烁、交给看护）
function handleUnexpectedExit(fromPid, code, signal, elapsedMs, source) {
  const verdictSource = source || 'handover'
  markHealthFault()
  // 就绪后很快又崩 = 崩溃循环特征：计入硬止损计数（与计数窗口独立）
  if (readySince && Date.now() - readySince < RESTART_STABLE_MS) fastCrashStreak += 1
  else fastCrashStreak = 0
  log(`DSH exited unexpectedly (code ${code === null || code === undefined ? '未知' : code}${signal ? ', signal ' + signal : ''})`)
  server.handover = { at: new Date().toISOString(), fromPid: fromPid || 0, toPid: 0, verdict: 'crash', source: verdictSource, elapsedMs: elapsedMs || 0 }
  lifecycle.emit('service.handover', { fromPid: fromPid || 0, toPid: 0, verdict: 'crash', source: verdictSource, port: PORT, elapsedMs: elapsedMs || 0 })
  // 页面立即切到"服务正在自动重启…"说明页（文字说明 + 刷新按钮；就绪后由 refreshWebUiOnReady 自动切回）
  if (!SELF_TEST) {
    const reason = autoRestartStopped ? 'offline' : (Config.autoRestart ? 'restart' : 'offline')
    for (const t of webTabs) {
      const wc = t.view && t.view.webContents
      if (wc && !wc.isDestroyed()) { t.blank = true; try { wc.loadURL(loadingUrl(reason, t.id, loadingParams())) } catch { /* noop */ } }
    }
    webPushState()
  }
  // 已显式停止自动恢复时不再重复打扰（通知+闪烁只发一次，halt 时已交代）
  if (!autoRestartStopped) {
    startFlash()
    notify('DeepSeek Harness', '服务意外退出', WEB_URL)
  }
  broadcastState()
  void maybeAutoRestart()
}

// 返回 true = 本次真的执行了停止；false = 已有停止在进行（被防重入挡下）
async function stopServer() {
  // 诊断：每次进入都记（含调用栈），确认调用次数与来源
  if (process.env.DSHL_DEBUG_STOP === '1') log('stopServer enter\n' + new Error('enter').stack)
  // 幂等/防重入：停止过程中再次调用直接返回（由 beginServiceStop 判定并置位，含看门狗）
  if (!beginServiceStop()) {
    if (process.env.DSHL_DEBUG_STOP === '1') log('stopServer ignored (already stopping)\n' + new Error('stack').stack)
    else log('stopServer ignored (already stopping)')
    return false
  }
  broadcastState() // 立刻让面板显示"正在停止服务…"并禁用按钮
  try {
    // 交接裁决进行中：等它定案再动手，否则会"停了旧的、活着新的"（用户点停止却停不掉服务）
    if (server.settling && server.handoverPromise) {
      await Promise.race([server.handoverPromise.catch(() => {}), sleep(3000)])
      server.settling = false
      server.settlingServing = false
    }
    if (process.env.DSHL_DEBUG_STOP === '1') log(`stopServer branch owned=${server.owned()} claimed=${server.claimed()} adopted=${server.adoptedPid} child=${server.child ? server.child.pid : 'null'} exitCode=${server.child ? server.child.exitCode : 'n/a'}`)
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
    } else if (server.claimed()) {
      // 认领的自重启后继是我们这一代服务的一部分：按我们的服务停止它（它没有句柄，只能按 PID + 端口收敛判断）
      const pid = server.claimedPid
      cancelRestartRetry()
      await killPid(pid, false)
      await sleep(1000)
      if (await portOpen()) await killPid(pid, true)
      clearClaimed()
      server.launchUrl = null
      server.launchSig = null
      log(`DSH 自重启进程已停止 (PID ${pid})`)
    } else if (server.adoptedPid !== 0) {
      const pid = server.adoptedPid
      await killPid(pid, false)
      await sleep(1000)
      if (await portOpen()) await killPid(pid, true)
      log(`adopted DSH stopped (PID ${pid})`)
      server.adoptedPid = 0
      server.adoptedAlive = false
    }
    return true
  } finally {
    endServiceStop()
    cancelRestartRetry() // 用户主动停止 = 取消待触的延后重启，看护不得把服务复活
  }
}

// 认领的自重启后继拿不到新凭据时的恢复入口：由启动器重启一次服务，新进程的 stdout 归我们，
// token 就能重新捕获。这会切断正在跑的会话，所以只响应用户点击，绝不自动触发。
async function restartForAuth() {
  if (!server.authPending && !server.claimed()) { log('restartForAuth ignored（当前无需恢复页面凭据）'); return }
  log('restartForAuth：由启动器重启服务以恢复页面访问凭据')
  const stopped = await stopServer()
  if (!stopped) return
  const ok = await handleStart()
  if (ok) void refreshWebUiOnReady(true)
  broadcastState()
}

// 端口切换：重启我们负责的服务（自己拉起的或认领的自重启后继）到新端口，并把所有打开的标签页重载到新地址
async function restartServerOnNewPort() {
  if (!server.managed()) return false
  await stopServer()
  const ok = await startServer()
  if (ok) {
    for (const t of webTabs) {
      const wc = t.view && t.view.webContents
      if (wc && !wc.isDestroyed()) { try { wc.loadURL(uiUrl()) } catch { /* noop */ } }
    }
  }
  return ok
}

// 自动重启看护：服务意外退出后自动拉起（设置页开关，默认开；10s 冷却 + 10 分钟内最多 5 次，防崩溃死循环）
// 计数口径：按"最近 10 分钟内的重启次数"（时间窗），而不是"连续失败次数"——因为服务只要绑上端口就
// 算就绪，把计数清零会让"能绑端口但几秒后崩溃"的循环永远停在 1 次，回退/halt 永远不可达。
// 只有服务稳定存活 RESTART_STABLE_MS（120s，与健康快照同口径）后才清空时间窗。
// 终态原则（借鉴 dsh-desktop "失败代际不自动复活"）：回退健康配置后仅允许一次重试，仍失败 → 显式停止
// 自动恢复（autoRestartStopped），不再发起新一轮循环；人工启动成功后自动重新武装。
const RESTART_WINDOW_MS = 10 * 60 * 1000 // 计数窗口
const RESTART_MAX = 5 // 窗口内允许的自动重启次数
const RESTART_STABLE_MS = 120 * 1000 // 服务存活多久才算"稳定"（清空计数窗口）
let restartWindow = [] // 最近窗口内的自动重启时间戳
let lastRestartAt = 0
let autoRestartStopped = false
let readySince = 0 // 本轮服务就绪时刻（0 = 未就绪）

function restartAttemptsInWindow() {
  const cutoff = Date.now() - RESTART_WINDOW_MS
  restartWindow = restartWindow.filter((t) => t > cutoff)
  return restartWindow.length
}

// 测试/自检用：把计数窗口直接填成 N 次（避免真跑 10 分钟）
function seedRestartAttempts(n) {
  const now = Date.now()
  restartWindow = Array.from({ length: Math.max(0, n) }, () => now)
}

// 冷却/停止中把一次重启请求"吃掉"是看护静默停摆的根因：必须排补偿定时器，不能直接 return
let restartRetryTimer = null

function cancelRestartRetry() {
  if (restartRetryTimer) { clearTimeout(restartRetryTimer); restartRetryTimer = null }
}

function restartRetryPending() {
  return !!restartRetryTimer
}

function scheduleRestartRetry(waitMs, reason) {
  if (restartRetryTimer) return // 已排定：一次待触重启足够，别叠成多个定时器
  const ms = Math.max(200, Math.round(waitMs))
  log(`自动重启延后 ${ms}ms（${reason}），已排定补偿定时器`)
  lifecycle.emit('service.autoRestartDeferred', { waitMs: ms, reason })
  restartRetryTimer = setTimeout(() => {
    restartRetryTimer = null
    void maybeAutoRestart()
  }, ms)
}

function clearRestartTracking() {
  restartWindow = []
  lastRestartAt = 0
  readySince = 0
  cancelRestartRetry() // 计数与冷却一起复位：留着待触定时器会凭空发起一轮重启
}

function haltAutoRestart() {
  if (autoRestartStopped) return
  autoRestartStopped = true
  log('auto-restart stopped (recovery exhausted), waiting for user')
  lifecycle.emit('service.autoRestartHalted', { attempts: restartAttemptsInWindow(), restoredAt: lastRecoveryAt || '' })
  notify('DeepSeek Harness', '自动恢复已停止：服务仍无法稳定运行，请打开启动器面板查看日志并手动处理')
  broadcastState()
}

async function maybeAutoRestart() {
  if (!Config.autoRestart || reallyExit) return
  if (autoRestartStopped) return // 已显式停止：等待用户人工处理（启动成功后重新武装）
  if (server.running()) { cancelRestartRetry(); return } // 已在服务（自己拉起/认领后继/接管外部），不需要重启
  if (serviceStopping()) { scheduleRestartRetry(1000, 'stop in progress'); return }
  // 环境报告可能尚未建立（启动探测未完成/自检路径）：这里兜底探测一次再判断
  if (!envReport) {
    try { envReport = await envDetect.detectEnv(false) } catch { /* 保持 null，按未就绪跳过 */ }
  }
  if (!envReady()) { log('auto-restart skipped: environment not ready'); return }
  const now = Date.now()
  const deferred = handover.planCooldownRetry({ now, lastRestartAt, cooldownMs: RESTART_COOLDOWN_MS })
  if (deferred) { scheduleRestartRetry(deferred.waitMs, 'cooldown'); return }
  // 硬止损：就绪后立即崩溃连续达到阈值 —— 不依赖计数窗口，窗口被任何路径清掉也一定能停
  if (fastCrashStreak >= RESTART_MAX) {
    const target = health.pickRestoreTarget(health.configHash(), lastRestoredSlot)
    if (!recoveryDone && target !== null) {
      log(`fast-crash streak ${fastCrashStreak}：服务就绪后立即崩溃，尝试回退配置`)
      lifecycle.emit('service.autoRestartExhausted', { attempts: fastCrashStreak, reason: 'fast-crash-streak' })
      await attemptConfigRecovery(true)
    } else {
      log(`fast-crash streak ${fastCrashStreak}：服务就绪后立即崩溃，停止自动恢复（硬止损）`)
      haltAutoRestart()
    }
    return
  }
  const attempts = restartAttemptsInWindow()
  if (attempts >= RESTART_MAX) {
    if (recoveryDone) {
      // 已回退过一次仍失败：显式终态，不进入新一轮循环（避免无进展的反复重启/通知/闪烁）
      haltAutoRestart()
      return
    }
    log(`auto-restart attempts exhausted (${attempts} in 10min)`)
    lifecycle.emit('service.autoRestartExhausted', { attempts })
    await attemptConfigRecovery() // 崩溃循环：自动回退上一个健康配置（每次运行最多一次）
    return
  }
  lastRestartAt = now
  restartWindow.push(now)
  lifecycle.emit('service.autoRestart', { attempt: restartWindow.length })
  serverRestarting = true
  await sleep(3000) // 等端口彻底释放
  const ok = await startServer()
  serverRestarting = false
  if (ok) {
    log('service auto-restarted')
    void refreshWebUiOnReady()
    broadcastState()
    notify('DeepSeek Harness', '服务已自动重启', WEB_URL)
  } else {
    log('auto-restart failed')
    broadcastState()
    void refreshWebUiPhase() // 重启失败：说明页切到"服务未启动"状态
  }
}

// ---------- 稳定性：活跃运行证据 / 健康门 / 健康快照 / 崩溃回退 / 诊断（借鉴 dsh-desktop） ----------
let runGuardHandle = null // run-guard 会话句柄（markClean 必需，禁止跨会话缓存）
let healthCaptured = false // 本次运行是否已捕获健康快照（single-flight）
let healthTimer = null
let healthFault = false // 就绪后到捕获前出现加载失败/异常退出 → 本次不捕获
let fastCrashStreak = 0 // 就绪后 RESTART_STABLE_MS 内再次崩溃的连续次数：不依赖计数窗口的硬止损
let recoveryDone = false // 本次运行最多一次配置回退
let lastRestoredSlot = ''
let lastRecoveryAt = ''

// 健康门判据：服务就绪 +（页面加载成功 或 就绪后存活 120s）；两者都满足才允许写健康快照
// 世代来源含认领的自重启后继（它就是我们这一代服务）；纯接管的外部实例不算（我们无从证明它健康）。
function maybeCaptureHealthy(reason) {
  if (SELF_TEST) return
  if (!server.running() || !server.managed()) return
  if (healthCaptured) return
  try {
    const r = health.captureHealthy({
      dshlVersion: app.getVersion(),
      dshKind: envReport && envReport.dsh ? envReport.dsh.kind : '',
      dshVersion: envReport && envReport.plan ? (envReport.plan.dshVersion || '') : '',
      nodeVersion: envReport && envReport.node ? (envReport.node.version || '') : '',
      port: PORT,
      reason,
    })
    healthCaptured = true
    if (r.status === 'captured') {
      lifecycle.emit('health.capture', { slotId: r.slotId, reason })
      log(`health: captured slot ${r.slotId} (reason=${reason})`)
    } else if (r.status === 'skipped') {
      lifecycle.emit('health.capture', { skipped: r.restoredSlotId })
      log(`health: skip marker consumed (restored slot ${r.restoredSlotId})`)
    }
  } catch (e) {
    log('health capture failed: ' + (e && e.message ? e.message : String(e)))
  }
}

// 服务就绪后安排延迟捕获（页面加载成功是快路径；120s 存活是慢速兜底）
// 这里同时承担"稳定性证明"：只有连续存活满 RESTART_STABLE_MS 才清空崩溃计数窗口——
// 页面加载成功不算证明（起来就崩的服务也能加载出页面，否则崩溃循环永远攒不到回退阈值）。
function scheduleHealthyCapture(pid) {
  if (SELF_TEST) return
  if (healthTimer) clearTimeout(healthTimer)
  healthTimer = setTimeout(() => {
    healthTimer = null
    // 仍是无故障的同一代服务（未被重启/接管/失败覆盖）才算稳定；认领的后继同样适用
    if (!server.managed() || server.displayPid() !== pid || healthFault) return
    clearRestartTracking()
    fastCrashStreak = 0
    log(`service stable for ${Math.round(RESTART_STABLE_MS / 1000)}s：清空自动重启计数窗口`)
    if (!healthCaptured) maybeCaptureHealthy('survived-120s')
  }, RESTART_STABLE_MS)
}

function markHealthFault() {
  healthFault = true
}

// 崩溃循环（连续 5 次自动重启失败）→ 自动回退到上一个健康配置（每次运行最多一次）
async function attemptConfigRecovery(force) {
  if (recoveryDone) return
  const target = health.pickRestoreTarget(health.configHash(), lastRestoredSlot)
  if (!force && !health.shouldRecover(restartAttemptsInWindow(), target !== null)) return
  if (target === null) return
  recoveryDone = true
  try {
    const r = health.restore(target)
    if (r.status !== 'restored') {
      log('config recovery: restore no-op')
      return
    }
    lastRestoredSlot = r.slotId
    lastRecoveryAt = new Date().toISOString()
    mergeConfigFromDisk() // 文件已回退，内存 Config 同步
    applyRuntimePort() // 端口可能随快照回退
    // 配置可能已变化（nodePath/harnessRoot/port）：重新探测环境，重试基于新配置而非旧缓存
    try { await refreshEnv(true) } catch (e) { log('config recovery: env refresh failed: ' + e.message) }
    clearRestartTracking() // 回退后重新计数（只允许这一次重试）
    log(`config recovered from slot ${r.slotId} (backup ${path.basename(r.backupPath)})`)
    lifecycle.emit('recovery.restore', { slotId: r.slotId, backup: path.basename(r.backupPath), at: lastRecoveryAt })
    notify('DeepSeek Harness Launcher', '服务反复启动失败，已自动回退到上一个正常配置；原配置已备份为 ' + path.basename(r.backupPath) + '（日志目录可查）')
    broadcastState()
    // 回退后仅允许这一次重试；仍失败（且不是端口被占用等已交代的场景）→ 显式停止自动恢复
    if (envReady()) {
      await sleep(2000)
      const ok = await handleStart()
      if (!ok && !server.blockedReason && !server.running()) {
        haltAutoRestart()
      }
    } else {
      haltAutoRestart() // 回退后环境仍不可用：交给面板引导
    }
  } catch (err) {
    log('config recovery failed: ' + (err && err.message ? err.message : String(err)))
  }
}

// ---------- 诊断报告（脱敏后保存，保留最近 3 份） ----------
function safeParseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function buildDiagReport() {
  return diagnostics.collectReport({
    appVersion: app.getVersion(),
    platform: process.platform + '-' + process.arch,
    envSummary: envDetect.envSummary(envReport) || {},
    installState: envInstall.getJob() || {},
    updaterState: safeParseJson(updater.getState()) || {},
    dshUpdateState: dshUpdater.getState() || {},
    serverState: {
      running: server.running(), owned: server.owned(), origin: server.origin(), managed: server.managed(),
      pid: server.displayPid(), port: PORT, blocked: server.blockedReason || '',
      claimed: server.claimed(), authPending: server.authPending, settling: server.settling,
      hasLaunchToken: !!server.launchUrl, handover: server.handover || null,
    },
    configRedacted: JSON.stringify(Config, null, 2),
    lastExit: runGuardHandle && runGuardHandle.previousRun ? 'crashed' : 'clean',
    lastCrashAt: (runGuardHandle && runGuardHandle.previousRun && runGuardHandle.previousRun.startedAt) || '',
    lifecycleTail: lifecycle.tail(60).join('\n'),
    tails: [
      { label: 'dshl.log（尾部 300 行）', text: tailOf(TRAY_LOG, 300) },
      { label: 'server.out.log（尾部 100 行）', text: tailOf(OUT_LOG, 100) },
      { label: 'server.err.log（尾部 100 行）', text: tailOf(ERR_LOG, 100) },
    ],
  })
}

function saveCrashDiagnostics() {
  try {
    const file = diagnostics.saveReport(buildDiagReport())
    if (file) lifecycle.emit('diagnostics.saved', { reason: 'crash', file: path.basename(file) })
  } catch (err) {
    log('diagnostics failed: ' + (err && err.message ? err.message : String(err)))
  }
}

// ---------- 插件市场：变更后重启服务生效 ----------
// 与 DSH 更新同一套「停服务 → 装/卸 → 起服务 → 强制重载页面」，期间页面切"正在应用插件变更…"。
async function applyPluginChange(verb, version) {
  const name = market.PLUGIN_NAME + (version ? '@' + version : '')
  log(`market: ${verb} ${name} → restarting service`)
  lifecycle.emit('update.dsh', { step: verb + '-plugin', name })
  if (server.running()) {
    webLoadTabs('plugin')
    await stopServer()
  }
  const ok = await handleStart()
  if (ok) {
    refreshWebUiOnReady(true)
    notify('DeepSeek Harness', verb === 'install' ? `插件市场已安装（${name}），服务已重启生效` : '插件市场已卸载，服务已重启生效')
  } else {
    notify('DeepSeek Harness', `插件市场${verb === 'install' ? '已安装' : '已卸载'}，但服务重启失败，请查看面板日志`)
  }
  broadcastState()
}

// 插件市场默认安装（幂等，可多处调用）：
//   - 触发点：① 启动时（环境已就绪）② 一键安装环境完成后 ③ 延后启动真正拉起服务后
//   - 每个启动器版本最多真正尝试一次（pluginMarketAutoTryVersion 记账）；
//   - 环境一直不就绪（首次安装还没装完）时不记账、不重试安装，等下次触发点再来；
//   - 用户主动卸载过（pluginMarketDeclined）就不再自动装回来。
let marketAutoInstalling = false
async function maybeAutoInstallPluginMarket() {
  if (SELF_TEST) return
  if (marketAutoInstalling) return
  if (Config.pluginMarketDeclined) return
  if (market.installed().installed) return
  const ver = app.getVersion()
  if (Config.pluginMarketAutoTryVersion === ver) return // 本版本已尝试过（失败也不反复打扰）
  if (!envReady()) {
    // 环境还没装好：不记账（留给环境装好后的触发点），直接返回
    log('market: 环境未就绪，暂不自动安装插件市场')
    return
  }
  marketAutoInstalling = true
  try {
    Config.pluginMarketAutoTryVersion = ver
    try { saveConfig() } catch { /* noop */ }
    log(`market: 自动安装 ${market.PLUGIN_NAME} …`)
    // 等服务就绪后再动：安装要停服务（pnpm 改写 profile 依赖树时不能有进程占用）。
    // 首次安装环境后服务刚拉起，最多等 3 分钟。
    const deadline = Date.now() + 180 * 1000
    while (Date.now() < deadline && !server.running()) await sleep(1000)
    const r = await market.install()
    if (r.ok) {
      await applyPluginChange('install', r.version || market.getState().version)
    } else {
      log('market: 自动安装失败：' + (r.error || '未知原因'))
      notify('DeepSeek Harness Launcher', '插件市场自动安装失败（可在设置页手动重试）：' + String(r.error || '').slice(0, 120))
    }
    broadcastState()
  } finally {
    marketAutoInstalling = false
  }
}

// ---------- 通知 ----------
// 同标题 + 同内容在窗口期内只弹一次：崩溃循环/反复重启时不再刷屏（日志仍逐条留证，含被抑制的记录）
const NOTIFY_DEDUPE_MS = 30000
const recentNotifies = new Map()

function notify(title, message, url) {
  const key = title + '\u0000' + message
  const now = Date.now()
  const last = recentNotifies.get(key) || 0
  if (now - last < NOTIFY_DEDUPE_MS) {
    log(`[notify] suppressed duplicate within ${Math.round(NOTIFY_DEDUPE_MS / 1000)}s: ${title}: ${message}`)
    return
  }
  recentNotifies.set(key, now)
  if (recentNotifies.size > 64) { // 长期运行不积累：顺手清掉已过期项
    for (const [k, t] of recentNotifies) if (now - t >= NOTIFY_DEDUPE_MS) recentNotifies.delete(k)
  }
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
  else if (ok && server.claimed()) notify('DeepSeek Harness', `服务已自行重启并由启动器接管（PID ${server.displayPid()}），不影响正在运行的会话`)
  else if (ok) notify('DeepSeek Harness', `检测到已在运行的服务（PID ${server.displayPid()}），已接管`)
  else if (server.blockedReason) notify('DeepSeek Harness', server.blockedReason + '（启动器面板已打开，可一键切换）')
  else if (envReady()) notify('DeepSeek Harness', '服务启动失败，请打开启动器面板查看日志')
  else notify('DeepSeek Harness', '运行环境未就绪，请打开启动器面板一键安装')
}

// 统一启动入口：面板按钮 / 托盘菜单 / 启动时共用。
// 返回 true = 服务确实在跑（自己拉起或接管外部实例）；false = 未就绪/环境未就绪/启动失败。
// 调用方（尤其 dsh-update 的"更新后校验"）必须依赖返回值判定，而不是 try/catch——本函数不抛错。
async function handleStart() {
  // 停止过程中点"启动"：直接拒绝（否则会在旧进程还没退干净时再 spawn 一个）
  if (serviceStopping()) {
    log('handleStart ignored (stop in progress)')
    return false
  }
  if (!envReport) {
    try { envReport = await envDetect.detectEnv(false) } catch { /* 保持 null */ }
  }
  if (!envReady()) {
    startWhenReady = true
    log('environment not ready, start skipped（面板"运行环境"页可一键安装；就绪后自动补启动）')
    broadcastState()
    return false
  }
  startWhenReady = false
  const ok = await startServer()
  notifyStartResult(ok)
  if (ok) refreshWebUiOnReady()
  else if (server.blockedReason && !SELF_TEST) showPanel() // 端口被其他程序占用：自动弹出面板（警示卡 + 一键换端口）
  broadcastState()
  return !!ok
}

// 一键换端口（面板警示卡 / WebUI 端口冲突说明页共用）：保存建议端口并立即尝试启动
async function switchToSuggestedPort(port) {
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1024 || p > 65535) return false
  if (server.suggestedPort && p !== server.suggestedPort) return false // 只接受当前建议的端口
  Config.port = p
  saveConfig()
  applyRuntimePort()
  server.blockedReason = ''
  server.suggestedPort = 0
  await handleStart()
  broadcastState()
  return true
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
// 仅打包版执行：dev 模式误删/误写自启项会把用户的开机自启改写成 dev electron 路径。
function migrateLegacyAutostart() {
  if (!IS_WIN || SELF_TEST) return
  if (!app.isPackaged) { log('dev mode: skip legacy autostart migration'); return }
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

// 启动器面板默认尺寸：窗口可调整的最小尺寸（480×740）。
// 高度按"主页最低端版本行无需滚动"实测校准：面板 CSS 缩放 125%（系统 150% ÷ 1.2）时内容约需 720px，
// 再留 20px 余量覆盖不同 Windows 标题栏高度差异（100% 缩放时内容约 540px，同样无需滚动）。
const PANEL_MIN_W = 480
const PANEL_MIN_H = 650

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
  const w = Config.windowWidth >= PANEL_MIN_W ? Config.windowWidth : dft[0]
  const h = Config.windowHeight >= PANEL_MIN_H ? Config.windowHeight : dft[1]
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
  attachContextMenu(win.webContents, true)
  // F12 打开面板 DevTools（UI 可视化调试：改样式立即生效）
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      e.preventDefault()
      try { win.webContents.toggleDevTools() } catch { /* noop */ }
    }
  })
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
      "document.title === '' || !document.body || document.body.innerHTML.length < 10 || (document.body.innerText || '').indexOf('authentication required') >= 0",
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
// withDev=true（启动器面板）：额外提供"打开开发者工具"与"刷新"，用于 UI 可视化调试
function attachContextMenu(wc, withDev) {
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
    if (withDev) {
      if (items.length) items.push({ type: 'separator' })
      items.push(
        {
          label: '打开开发者工具（调试UI）',
          click: () => { try { wc.openDevTools({ mode: 'detach' }) } catch { /* noop */ } },
        },
        { label: '刷新面板', click: () => { try { wc.reload() } catch { /* noop */ } } },
      )
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
    tabs: webTabs.map((t) => ({ id: t.id, title: t.title, blank: !!t.blank })),
    activeId: webActiveId,
    rightId: webRightId,
    splitOn: webSplitOn,
    splitRatio: webSplitRatio,
    maximized: webWin.isMaximized(),
    tabsEnabled: Config.tabsEnabled, // 恒为 false（设置页开关已移除）：壳渲染精简标题栏
    service: servicePhase(),
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

// 服务状态说明页（白屏自愈 / 启动中 / 重启中 / 未启动 / 端口被占用）：文案随服务阶段生成，pane=标签 id 供页内按钮回传
function loadingUrl(reason, tabId, extra) {
  let q = `reason=${reason}&pane=${tabId || ''}`
  if (extra && extra.detail) q += '&detail=' + encodeURIComponent(String(extra.detail).slice(0, 500))
  if (extra && extra.suggest) q += '&suggest=' + encodeURIComponent(String(extra.suggest))
  return `${pathToFileURL(path.join(WWWROOT, 'loading.html')).href}?${q}`
}
function reasonForPhase(phase) {
  if (server.blockedReason) return 'blocked' // 端口被其他程序占用：说明页直接展示冲突原因与一键换端口
  if (server.authPending && server.running()) return 'auth' // 自重启后继在服务，但拿不到它的访问凭据
  if (phase === 'starting') return 'start'
  if (phase === 'restarting') return 'restart'
  if (phase === 'ready') return 'failed'
  return 'offline'
}

// 端口冲突时说明页的附加参数（冲突详情 + 建议端口）
function loadingParams() {
  return server.blockedReason ? { detail: server.blockedReason, suggest: server.suggestedPort || '' } : {}
}

// 新建标签页：视图先在后台创建并加载，激活时才挂载（切换无白屏）
// targetUrl / targetTitle：分屏"在新标签页中打开"时复制来源页地址与标题
// opts.loading：服务未就绪时先加载状态说明页（窗口秒开），就绪后由 refreshWebUiOnReady 自动切到真实页面
// opts.loadingReason：说明页文案（start/restart/offline/failed/update）；缺省按当前服务阶段推导
function webCreateTab(targetUrl, targetTitle, opts = {}) {
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
  const tab = { id, view, title: targetTitle || 'DeepSeek Harness', blank: false }
  webTabs.push(tab)
  const wc = view.webContents
  const markBlank = (b) => { tab.blank = b; webPushState() }
  // 外部链接（target=_blank / window.open）→ 统一交给系统默认浏览器打开，避免被 Electron 吞掉
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) { try { shell.openExternal(url) } catch { /* noop */ } }
    return { action: 'deny' }
  })
  try { view.setBackgroundColor('#F9FAFB') } catch { /* 旧版无此 API，忽略 */ }
  wc.on('page-title-updated', (_e, t) => { tab.title = t || 'DeepSeek Harness'; webPushState() })
  wc.on('focus', () => { webFocusedId = id; refreshPaneOverlays() })
  // 加载失败（服务未起/端口不通）→ 标记白屏，并立即换成"服务状态说明页"（文字说明 + 当前页刷新按钮），
  // 服务就绪后 refreshWebUiOnReady 会自动切回真实页面；自检模式保持原逻辑（检查空白页）
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return
    // 用户主动取消（ERR_ABORTED/-3）不算白屏
    if (code === -3) return
    markHealthFault() // 主窗口加载失败：本次运行不捕获健康快照
    markBlank(true)
    if (!SELF_TEST) {
      try { wc.loadURL(loadingUrl(reasonForPhase(servicePhase()), id, loadingParams())) } catch { /* noop */ }
    }
  })
  wc.on('zoom-changed', (_e, direction) => {
    const f = wc.getZoomFactor()
    const next = direction === 'in' ? Math.min(f + 0.05, 3) : Math.max(f - 0.05, 0.5)
    for (const t2 of webTabs) {
      if (!t2.view.webContents.isDestroyed()) { try { t2.view.webContents.setZoomFactor(next) } catch { /* noop */ } }
    }
    Config.webZoom = Math.round(next * 100)
    saveConfig() // 对话窗口 Ctrl+滚轮缩放同样持久化（重启不丢）
    showWebZoomOverlay(wc)
    broadcastState()
  })
  wc.on('did-finish-load', () => {
    // 每次加载完成后应用当前设定（失败页/错误页会把缩放重置为 100%）
    try { wc.setZoomFactor(Config.webZoom / 100) } catch { /* noop */ }
    markBlank(false)
    injectPaneOverlay(tab)
    // 健康门快路径：真实应用页面（非状态说明页）加载成功 = 本代服务健康的最强证据。
    // authPending 时页面只会是 401 凭据页，不算应用真的可用。
    if (!SELF_TEST) {
      const loaded = (() => { try { return wc.getURL() || '' } catch { return '' } })()
      if (loaded.startsWith(WEB_URL) && !server.authPending) maybeCaptureHealthy('page-loaded')
    }
    // 鉴权兜底：新 DSH 的 401 提示页（"dsh web authentication required..."）。
    // 有 token → 换带 token 地址重载换取 cookie；没有（认领的自重启后继拿不到它的 stdout）
    // → 标记为需要一次由启动器发起的重启，页面给明确指引，而不是让人对着 401 猜。
    {
      const url = wc.getURL() || ''
      if ((url.startsWith(WEB_URL) || url === WEB_URL) && !url.includes('token=')) {
        try {
          wc.executeJavaScript("(function(){var b=document.body;return !!(b&&b.innerText.indexOf('authentication required')>=0&&b.innerText.length<300)})()")
            .then((hit) => {
              if (!hit || wc.isDestroyed()) return
              if (server.launchUrl) { try { wc.loadURL(uiUrl()) } catch { /* noop */ } return }
              if (server.claimed() && !server.authPending) markAuthPending()
            })
            .catch(() => { /* noop */ })
        } catch { /* noop */ }
      }
    }
  })
  // 快捷键（焦点在页面内也生效）：Ctrl+\ 分屏、Ctrl+Del 关闭聚焦分屏、Shift+Alt+S 交换左右、F5/Ctrl+R 刷新聚焦页
  wc.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return
    const key = (input.key || '').toLowerCase()
    if (input.control && key === '\\') { _event.preventDefault(); webToggleSplit() }
    else if (input.control && input.key === 'Delete') { _event.preventDefault(); webCloseFocused() }
    else if (input.shift && input.alt && key === 's') { _event.preventDefault(); webSwap() }
    else if (input.key === 'F5' || (input.control && key === 'r')) { _event.preventDefault(); webReloadFocusedPane() }
  })
  view.webContents.loadURL((opts.loading && !SELF_TEST) ? loadingUrl(opts.loadingReason || reasonForPhase(servicePhase()), id, loadingParams()) : (targetUrl || uiUrl())).catch(() => { /* 服务未启动时空白，由自愈兜底 */ })
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
    var reload = document.createElement('div'); reload.textContent = '刷新此页';
    var openTab = document.createElement('div'); openTab.textContent = '在新标签页中打开此网页';
    menu.appendChild(swap); menu.appendChild(reload); menu.appendChild(openTab);
    bar.appendChild(btnMenu); bar.appendChild(btnClose);
    root.appendChild(bar); root.appendChild(menu);
    var host = document.body || document.documentElement;
    host.appendChild(st); host.appendChild(root);
    var send = function(name, payload) { try { window.browserBridge.send(name, payload); } catch (e) {} };
    var hideMenu = function() { menu.classList.remove('open'); };
    btnClose.addEventListener('click', function() { hideMenu(); send('closePane'); });
    btnMenu.addEventListener('click', function() { menu.classList.toggle('open'); });
    swap.addEventListener('click', function() { hideMenu(); send('swapPanes'); });
    reload.addEventListener('click', function() { hideMenu(); send('fixPane', { id: '${paneId}' }); });
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
  if (!Config.tabsEnabled) return // 功能恒关：分屏整体禁用
  webSplitOn = !webSplitOn
  if (webSplitOn && !webRightId) {
    if (webTabs.length > 1) {
      webRightId = webTabs.find((t) => t.id !== webActiveId).id
    } else if (webActiveId) {
      // 单标签分屏（Edge 行为）：复制当前页作为右分屏，原页保持左侧
      const cur = webTabs.find((t) => t.id === webActiveId)
      let url = uiUrl()
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
  let url = uiUrl()
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

// 刷新"当前聚焦页面"（无聚焦则活动标签）：F5 / Ctrl+R / 顶栏 ↻ / 分屏 ⋯ 菜单共用入口
function webReloadFocusedPane() {
  const id = webFocusedId || webActiveId
  if (id) void webReloadPane(id)
}

// "修复"按钮：先确保服务在跑（没起才启动，已起不动它），再重载该标签为真实应用
async function webReloadPane(id) {
  const tab = webTabs.find((t) => t.id === id)
  if (!tab) return
  const wc = tab.view && tab.view.webContents
  if (!wc || wc.isDestroyed()) return
  tab.blank = false
  webPushState()
  // 服务没在跑 → 走统一启动入口（幂等；服务已在运行则直接返回，不打断会话）。
  // 若端口被占/环境未就绪，handleStart 会置 blockedReason / startWhenReady，面板可据此处理。
  if (!server.running()) await handleStart()
  const phase = servicePhase()
  // 就绪 → 真实页面；未就绪 → 状态说明页（说明 + 刷新按钮）；自检模式保持原逻辑
  const url = (SELF_TEST || phase === 'ready') ? uiUrl() : loadingUrl(reasonForPhase(phase), tab.id, loadingParams())
  try { wc.loadURL(url) } catch { /* noop */ }
}

// 关闭当前聚焦的分屏：分屏时关聚焦侧（左关左保留右），未分屏时关当前标签
function webCloseFocused() {
  if (!Config.tabsEnabled) return // 功能恒关：不关闭唯一标签
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
  // 设置项"使用系统浏览器打开DSH"开启 → 交给系统默认浏览器（每次新开标签页）；
  // 带 token 地址首次访问才能在浏览器侧换取 cookie
  if (Config.useSystemBrowser) {
    try { shell.openExternal(uiUrl()) } catch { /* noop */ }
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
  // 焦点在壳（标签栏）时 F5 / Ctrl+R 同样刷新当前聚焦页面（默认菜单已移除，不会误触发壳重载）
  webWin.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && (input.key || '').toLowerCase() === 'r'))) {
      _event.preventDefault()
      webReloadFocusedPane()
    }
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
  webCreateTab(undefined, undefined, { loading: !!opts.loading, loadingReason: opts.loadingReason }) // 首个标签页：后台加载，挂载即显示（loading=先开状态说明页）
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

// 服务就绪时自愈：逐个检查标签页视图，状态说明页/空白错误页 → 重新加载真实应用；健康页面不打扰
// force=true：无条件重载所有标签（DSH 版本升级后必须用新版本页面替换旧会话）
async function refreshWebUiOnReady(force = false) {
  for (const t of webTabs) {
    const wc = t.view.webContents
    if (wc.isDestroyed()) continue
    if (force || (wc.getURL() || '').includes('loading.html') || await isPageBlank(wc)) {
      try { wc.loadURL(uiUrl()) } catch { /* noop */ }
    }
  }
}

// 把 WebUI 窗口所有标签切到状态说明页（DSH 更新/重启期间给出文字说明与进度，避免白屏）
function webLoadTabs(reason) {
  if (SELF_TEST) return
  for (const t of webTabs) {
    const wc = t.view && t.view.webContents
    if (wc && !wc.isDestroyed()) {
      t.blank = true
      try { wc.loadURL(loadingUrl(reason, t.id, loadingParams())) } catch { /* noop */ }
    }
  }
  webPushState()
}

// 启动失败/阶段变化后：把还在显示"启动中"的说明页刷新为当前实际状态（未启动/重启中/卡住）
async function refreshWebUiPhase() {
  if (SELF_TEST) return
  for (const t of webTabs) {
    const wc = t.view.webContents
    if (wc.isDestroyed()) continue
    if ((wc.getURL() || '').includes('loading.html')) {
      try { wc.loadURL(loadingUrl(reasonForPhase(servicePhase()), t.id, loadingParams())) } catch { /* noop */ }
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
    // 服务来源：owned=本工具拉起 / claimed=认领的 DSH 自重启后继 / external=接管外部实例 / none=未运行
    origin: server.origin(),
    managed: server.managed(),
    settling: server.settling, // 交接裁决中（面板不能塌成"已停止"）
    authPending: server.authPending, // 服务在跑但缺访问凭据，需要一次由启动器发起的重启
    hasLaunchToken: !!server.launchUrl,
    handover: server.handover || null,
    restartRetryPending: restartRetryPending(),
    phase: servicePhase(), // starting | restarting | ready | stopped（面板"启动中…"状态与按钮禁用依赖它）
    pid: server.displayPid(),
    url: WEB_URL,
    port: PORT,
    blocked: server.blockedReason || '',
    suggestedPort: server.suggestedPort || 0,
    version: app.getVersion(),
    firstRun: firstRun,
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
    dshUpdate: dshUpdater.getState(),
    log: logTail,
    // 稳定性状态（面板"上次未正常退出/已回退配置"提示用）
    lastExit: runGuardHandle ? (runGuardHandle.previousRun ? 'crashed' : 'clean') : 'unknown',
    lastCrashAt: (runGuardHandle && runGuardHandle.previousRun && runGuardHandle.previousRun.startedAt) || '',
    // 是否还要展示崩溃提示：该次崩溃已被用户"知道了/关闭"过就不再重复打扰
    crashNotice: !!(runGuardHandle && runGuardHandle.previousRun && runGuardHandle.previousRun.startedAt !== Config.crashNoticeDismissed),
    recoveredAt: lastRecoveryAt || '',
    autoRestartStopped: autoRestartStopped,
    pluginMarket: market.getState(),
    diagnosticsDir: DIAG_DIR,
  })
}

let lastBroadcast = ''
function broadcastState() {
  const json = stateJson()
  if (json === lastBroadcast) return
  lastBroadcast = json
  if (win && !win.isDestroyed()) { try { win.webContents.send('dsh:state', json) } catch { /* noop */ } }
  webPushState() // WebUI 壳同步服务阶段（白屏说明文案依赖）
}

// 判断 WebUI 窗口当前是否正在被用户聚焦（聚焦时不弹提醒、不闪烁图标）
function webUiFocused() {
  try { return !!(webWin && !webWin.isDestroyed() && webWin.isFocused()) } catch { return false }
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
      if (Config.notify && !webUiFocused()) {
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

// 非自有世代（认领的自重启后继 / 接管的外部实例）看护状态：连续负样本计数 + 持有者复核节流
let trackedDownTicks = 0
let ownerCheckTicks = 0

async function watchTrackedService() {
  const trackedPid = server.claimed() ? server.claimedPid : server.adoptedPid
  const up = server.claimed() ? server.claimedAlive : server.adoptedAlive
  if (await portOpen()) {
    trackedDownTicks = 0
    if (!up) {
      if (server.claimed()) server.claimedAlive = true
      else server.adoptedAlive = true
      log(`服务重新在线（PID ${trackedPid}）`)
      void refreshWebUiOnReady() // 错误页/空白页需要一次补拉
      broadcastState()
    }
    // 端口有应答 ≠ 应答者还是原来那个进程：定期复核持有者，否则认领状态会悄悄失真
    if (++ownerCheckTicks >= OWNER_VERIFY_EVERY_TICKS) {
      ownerCheckTicks = 0
      const listener = await findListenPid()
      if (listener && trackedPid && listener !== trackedPid) {
        log(`端口持有者已变化（PID ${trackedPid} → ${listener}），重新裁决`)
        lifecycle.emit('service.handover', { fromPid: trackedPid, toPid: listener, verdict: 'recheck', source: 'watchdog', port: PORT, elapsedMs: 0 })
        server.settling = false
        if (server.claimed()) clearClaimed()
        else { server.adoptedPid = 0; server.adoptedAlive = false }
        void runHandover(trackedPid, null, null)
      }
    }
    return
  }
  // 端口没人应答：先分清"还在交接/正在 bind"与"真的没了"
  const listener = await findListenPid()
  if (listener && listener !== trackedPid) {
    trackedDownTicks = 0
    server.settling = false
    if (server.claimed()) clearClaimed()
    else { server.adoptedPid = 0; server.adoptedAlive = false }
    void runHandover(trackedPid, null, null)
    return
  }
  if (!handover.shouldDeclareGone({ downStreak: ++trackedDownTicks, tickMs: TRACK_WATCHDOG_MS, confirmMs: ADOPT_DOWN_CONFIRM_MS })) return
  if (!up) return // 早已判定消失，不重复通知
  if (server.claimed()) { clearClaimed(); server.handoverPromise = null }
  else { server.adoptedPid = 0; server.adoptedAlive = false }
  log(`服务端口连续 ${Math.round(ADOPT_DOWN_CONFIRM_MS / 1000)}s 无人应答（原 PID ${trackedPid || '未知'}），按意外退出处理`)
  handleUnexpectedExit(trackedPid, null, null, 0, 'watchdog')
}

function onTick() {
  // 环境未就绪时周期性重测（缓存 30s 节流），用户在外部装好 Node/DSH 后自动就绪
  if (!envReady()) void refreshEnv(false)
  maybeStartDeferred() // 安装完成/启动请求时环境未就绪 → 就绪后自动补启动
  // 交接裁决自己驱动状态，不叠第二份探测
  if (!server.settling && (server.claimed() || server.adoptedPid)) void watchTrackedService()
  scanNotify()
}

// ---------- 问题反馈（飞书群机器人 webhook：POST 到固定地址，作者群内即时收到） ----------
const FEEDBACK_BODY_MAX = 60000 // 反馈内容上限（本地落盘同样截断，避免异常超大文件）
const FEISHU_WEBHOOK_RE = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[0-9a-fA-F-]+$/
const FEISHU_TEXT_MAX_BYTES = 120000 // 飞书文本消息请求体上限 150KB（官方文档），留余量防 JSON 转义膨胀

// 内置反馈通道：assets/feishu-webhook.txt（.gitignore 排除，不进仓库；打包时随安装包分发）
// 群机器人 webhook 仅能向指定群发文本消息，泄露可随时在群设置里重置，风险面小
function embeddedFeishuWebhook() {
  try {
    const t = fs.readFileSync(path.join(ASSETS_DIR, 'feishu-webhook.txt'), 'utf8').trim()
    return FEISHU_WEBHOOK_RE.test(t) ? t : ''
  } catch { return '' }
}

// 生效通道 = config.json 手动覆盖（作者换群用，界面无入口）|| 内置
function effectiveFeishuWebhook() {
  const custom = String(Config.feedbackWebhook || '').trim()
  return FEISHU_WEBHOOK_RE.test(custom) ? custom : embeddedFeishuWebhook()
}

// 按 UTF-8 字节数截断（飞书上限按请求体字节计）：从尾部截，保住标题/描述/环境/日志头部
function trimUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const suffix = '\n\n…（内容超出飞书消息长度上限，已截断；完整版已保存在本地日志目录 feedback/ 下）'
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') + suffixBytes <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + suffix
}

// 发送文本消息到飞书群机器人：成功返回 true，失败抛出可读错误（含飞书错误码）
async function sendToFeishu(text, hook) {
  const url = hook || effectiveFeishuWebhook()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok && data.code === undefined) throw new Error('HTTP ' + res.status)
  if (data.code !== 0 && data.StatusCode !== 0) {
    throw new Error(data.msg || data.StatusMessage || ('飞书错误码 ' + data.code))
  }
  return true
}

function tailOf(file, lines) {
  try {
    const txt = fs.readFileSync(file, 'utf8')
    return txt.split(/\r?\n/).slice(-lines).join('\n')
  } catch { return '(无日志文件：' + path.basename(file) + ')' }
}

function buildFeedbackPack(text, contact, includeLogs) {
  const version = app.getVersion()
  const subject = `[DSHL 反馈] v${version} - ${String(text).slice(0, 40).replace(/\r?\n/g, ' ')}`
  const env = envDetect.envSummary(envReport)
  const parts = [
    '# DeepSeek Harness Launcher 问题反馈',
    '',
    '## 问题描述',
    text,
  ]
  if (contact) parts.push('', '## 联系方式', contact)
  parts.push('', '## 环境信息',
    `- 版本：v${version}`,
    `- 平台：${process.platform} ${os.release()}`,
    `- 服务地址：${WEB_URL}（端口 ${PORT}）`,
    `- 服务状态：${server.running() ? '运行中' : '已停止'}${server.blockedReason ? '（' + server.blockedReason + '）' : ''}`,
    `- 环境就绪：${envReady() ? '是' : '否'}`,
    `- 环境报告：${JSON.stringify(env)}`,
  )
  if (includeLogs) {
    parts.push('', '## 日志 dshl.log（末尾 200 行）', '```', tailOf(TRAY_LOG, 200), '```')
    parts.push('', '## 日志 server.out.log（末尾 100 行）', '```', tailOf(OUT_LOG, 100), '```')
    parts.push('', '## 日志 server.err.log（末尾 100 行）', '```', tailOf(ERR_LOG, 100), '```')
  }
  let body = parts.join('\n')
  if (body.length > FEEDBACK_BODY_MAX) body = body.slice(0, FEEDBACK_BODY_MAX) + '\n\n…（超出长度限制，已截断）'
  // 统一脱敏：server.out/err 是 DSH 子进程 stdout/stderr 原样落盘（含 "?token=<一次性启动令牌>"），
  // 反馈正文会 POST 到外部 webhook，因此落盘与发送前都必须过 redact（dshl.log 在写入时已脱敏）。
  body = redact(body)
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const dir = path.join(LOG_DIR, 'feedback')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
  const filePath = path.join(dir, `feedback-${ts}.md`)
  try { fs.writeFileSync(filePath, body, 'utf8') } catch { /* noop */ }
  return { subject, body, filePath }
}

// ---------- IPC 命令桥（Bridge.cs 移植） ----------
// 来源校验：只有两个"自己人"页面可以调命令——启动器面板（index.html）与独立窗口壳（browser.html）。
// 其余一律拒绝，尤其是挂在每个页面视图上的 browser-preload 桥：DSH 页面（或用户在其中跳转到的任意
// 站点）若能在同页拿到 window.browserBridge，就能调 browser:* 改端口/重启服务/关窗口，必须封死。
function isTrustedSender(event) {
  try {
    const wc = event.sender
    if (win && !win.isDestroyed() && wc === win.webContents) return true
    if (webWin && !webWin.isDestroyed() && wc === webWin.webContents) return true
  } catch { /* 取不到按不可信处理 */ }
  return false
}

function registerIpc() {
  ipcMain.handle('dsh:cmd', async (event, name, value) => {
    try {
      if (process.env.DSHL_DEBUG_STOP === '1' && name !== 'getState') log(`ipc: ${name} (trusted=${isTrustedSender(event)})`)
      if (!isTrustedSender(event)) {
        log('bridge: rejected command from untrusted sender (' + String(name) + ')')
        return '{}'
      }
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
        case 'browser:fixPane': await webReloadPane(value && value.id); return '{}'
        case 'browser:authRestart': await restartForAuth(); return '{}'
        case 'browser:blockSwitch': await switchToSuggestedPort((value && value.port) || server.suggestedPort); return '{}'
        case 'browser:winMin': if (webWin && !webWin.isDestroyed()) { try { webWin.minimize() } catch { /* noop */ } } return '{}'
        case 'browser:winMax': {
          if (webWin && !webWin.isDestroyed()) {
            try { if (webWin.isMaximized()) webWin.unmaximize(); else webWin.maximize() } catch { /* noop */ }
          }
          return '{}'
        }
        case 'browser:winClose': if (webWin && !webWin.isDestroyed()) { try { webWin.hide() } catch { /* noop */ } } return '{}'
        case 'start': await handleStart(); return '{}'
        case 'stop': {
          // 停止中重复点击：直接返回，不再重复 taskkill / 重复弹"服务已停止"通知
          if (serviceStopping()) {
            if (process.env.DSHL_DEBUG_STOP === '1') log('stop ignored (already stopping)')
            return JSON.stringify({ ok: false, stopping: true })
          }
          if (process.env.DSHL_DEBUG_STOP === '1') log(`stop begin (owned=${server.owned()} adopted=${server.adoptedPid} running=${server.running()})`)
          // 不在这里置位：由 stopServer → beginServiceStop 统一置位（含看门狗）。
          // 先广播一次"停止中"由 stopServer 内部置位后负责，避免两处状态不同步。
          const ok = await stopServer()
          if (ok !== false) notify('DeepSeek Harness', '服务已停止')
          broadcastState()
          if (process.env.DSHL_DEBUG_STOP === '1') log('stop handler done')
          return JSON.stringify({ ok: true })
        }
        case 'openWeb': openDshOrPanel(); return '{}' // 环境未就绪/端口被占用时自动改打开启动器面板
        case 'openUrlExternal': try { shell.openExternal(uiUrl()) } catch { /* noop */ } return '{}'
        case 'openNpmDsh': try { shell.openExternal('https://www.npmjs.com/package/@deepseek-ai/dsh') } catch { /* noop */ } return '{}'
        case 'openLogs': try { shell.openPath(LOG_DIR) } catch { /* noop */ } return '{}'
        case 'openGithub': try { shell.openExternal('https://github.com/IMHaoyan/deepseek-harness-launcher') } catch { /* noop */ } return '{}'
        case 'openRecharge': try { shell.openExternal('https://platform.deepseek.com/usage') } catch { /* noop */ } return '{}'
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
          // 对话界面缩放：50-300，同步应用到所有 DSH 页面视图；用户设置持久化（重启不丢）
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
            saveConfig() // 用户设置持久化：重启后仍保持该缩放
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
          Config.webZoom = defaultWebZoomPct()
          Config.theme = 'light'
          Config.notify = true
          Config.useSystemBrowser = false
          Config.autoRestart = true
          const portBefore = PORT
          Config.port = 0
          Config.feedbackWebhook = ''
          Config.windowWidth = 0
          Config.windowHeight = 0
          Config.webWindowWidth = 0
          Config.webWindowHeight = 0
          Config.webWindowMaximized = false
          Config.webWindowX = null
          Config.webWindowY = null
          Config.harnessRoot = ''
          Config.nodePath = ''
          Config.dshVersion = 'latest' // 重置默认：安装/升级都装 latest
          Config.dshChannel = 'latest' // 更新渠道也回默认
          Config.nodeMajor = 22
          Config.nodeMirror = ''
          Config.npmRegistry = ''
          Config.dshUpdateCheckedAt = 0
          Config.dshMigrateRetryAt = 0
          Config.defExcludeTryVersion = ''
          Config.panelHideNotified = false
          Config.balanceApiKey = ''
          Config.balanceBaseUrl = ''
          Config.crashNoticeSeen = ''
          Config.crashNoticeDismissed = ''
          applyRuntimePort()
          // 端口复位到默认 3080：若自己拉起的服务跑在自定义端口，重启到默认端口并重载页面
          if (PORT !== portBefore && server.managed()) await restartServerOnNewPort()
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
        case 'setDshChannel': {
          const ch = value === 'alpha' ? 'alpha' : 'latest'
          if (Config.dshChannel !== ch) {
            Config.dshChannel = ch
            Config.dshUpdateCheckedAt = 0 // 换渠道后立刻重新检查，不必等 24h 节流
            saveConfig()
            log('dsh-update: channel switched to ' + ch)
            void dshUpdater.checkOnce('manual', true)
          }
          broadcastState()
          return '{}'
        }
        case 'feedbackBuild': {
          const text = String(value && value.text || '').trim()
          if (!text) return '{}'
          const contact = String(value && value.contact || '').trim().slice(0, 200)
          return JSON.stringify(buildFeedbackPack(text, contact, value && value.includeLogs !== false))
        }
        case 'feedbackSend': {
          const text = String(value && value.text || '').trim()
          if (!text) return JSON.stringify({ ok: false, error: '请先填写问题描述' })
          const contact = String(value && value.contact || '').trim().slice(0, 200)
          const pack = buildFeedbackPack(text, contact, value && value.includeLogs !== false)
          if (!effectiveFeishuWebhook()) {
            return JSON.stringify({ ok: false, needWebhook: true, filePath: pack.filePath })
          }
          try {
            await sendToFeishu(trimUtf8(pack.body, FEISHU_TEXT_MAX_BYTES))
            log('feedback sent to feishu bot')
            return JSON.stringify({ ok: true, filePath: pack.filePath })
          } catch (err) {
            log('feedback send failed: ' + err.message)
            return JSON.stringify({ ok: false, error: '发送失败：' + err.message + '（可改用"复制全部"手动提交）', filePath: pack.filePath })
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
            if (server.managed()) {
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
          await switchToSuggestedPort(value && value.port)
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
        case 'diagnosticNow': {
          // 手动生成诊断报告（反馈前可先产出）：保存到日志目录诊断文件夹，保留最近 3 份
          const file = diagnostics.saveReport(buildDiagReport())
          try { if (file) lifecycle.emit('diagnostics.saved', { reason: 'manual', file: path.basename(file) }) } catch { /* noop */ }
          notify('DeepSeek Harness Launcher', file ? `诊断报告已保存：${path.basename(file)}（"打开日志目录"可查看）` : '诊断报告保存失败，请查看日志')
          return JSON.stringify({ ok: !!file, file })
        }
        case 'openDiagnosticsDir': try { shell.openPath(DIAG_DIR) } catch { /* noop */ } return '{}'
        case 'ackCrashNotice': {
          // 用户点击崩溃提示的「知道了/×」：按该次崩溃的启动时间戳记账，之后不再重复提示
          const at = (runGuardHandle && runGuardHandle.previousRun && runGuardHandle.previousRun.startedAt) || ''
          Config.crashNoticeDismissed = at
          try { saveConfig() } catch { /* noop */ }
          broadcastState()
          return JSON.stringify({ ok: true, at })
        }
        // ---------- 插件市场（dshmarket 安装/卸载） ----------
        case 'marketGetState': return JSON.stringify(market.getState())
        case 'marketInstall': {
          const r = await market.install()
          broadcastState()
          if (r.ok && !r.already) await applyPluginChange('install', market.getState().version)
          return JSON.stringify(r)
        }
        case 'marketUninstall': {
          const r = await market.uninstall()
          broadcastState()
          if (r.ok && !r.already) await applyPluginChange('uninstall', '')
          return JSON.stringify(r)
        }
        case 'marketDecline': {
          // 用户在设置里明确卸载 → 不再自动装回来（直到手动重新安装）
          Config.pluginMarketDeclined = !!value
          try { saveConfig() } catch { /* noop */ }
          return JSON.stringify({ ok: true, declined: Config.pluginMarketDeclined })
        }
        case 'openDshDir': { // 源码形态"手动更新"：打开源码仓库目录
          const dir = envReport && envReport.dsh && envReport.dsh.dir
          if (dir) {
            try {
              const err = await shell.openPath(dir)
              return JSON.stringify({ ok: !err, error: err || '', dir })
            } catch (e) { return JSON.stringify({ ok: false, error: e.message, dir }) }
          }
          return JSON.stringify({ ok: false, error: '未找到 DSH 安装目录' })
        }
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
        case 'balanceGet': {
          const dshInfo = balance.readDshKeyInfo(realHome)
          const hasSaved = !!Config.balanceApiKey
          return JSON.stringify({
            key: Config.balanceApiKey || dshInfo.key, // 明文回传（本地面板"接口设置"中显示）
            hasKey: hasSaved || !!dshInfo.key,
            keySource: hasSaved ? 'saved' : (dshInfo.key ? 'dsh' : 'none'),
            baseUrl: Config.balanceBaseUrl,
            dshBaseUrl: dshInfo.baseUrl || '',
          })
        }
        case 'balanceSave': {
          if (value && typeof value === 'object') {
            if (typeof value.key === 'string' && value.key.trim()) Config.balanceApiKey = value.key.trim()
            if (typeof value.baseUrl === 'string' && value.baseUrl.trim()) Config.balanceBaseUrl = value.baseUrl.trim()
            saveConfig()
          }
          return '{}'
        }
        case 'balanceClear': {
          Config.balanceApiKey = ''
          Config.balanceBaseUrl = ''
          saveConfig()
          return '{}'
        }
        case 'balanceQuery': {
          const v = value && typeof value === 'object' ? value : {}
          const dshInfo = balance.readDshKeyInfo(realHome)
          const typedKey = (typeof v.key === 'string' && v.key.trim()) ? v.key.trim() : ''
          const typedBase = (typeof v.baseUrl === 'string' && v.baseUrl.trim()) ? v.baseUrl.trim() : ''
          const key = typedKey || Config.balanceApiKey || dshInfo.key
          const base = typedBase || Config.balanceBaseUrl || dshInfo.baseUrl || balance.OFFICIAL_BASE
          const result = await balance.queryBalance(base, key)
          if (result.ok) {
            log('balance query ok: ' + result.data.balance_infos.map((i) => `${i.currency} ${i.total}`).join(', ') + ' via ' + result.data.endpoint)
          } else {
            log('balance query failed: ' + result.error)
          }
          return JSON.stringify(result)
        }
        case 'updaterGetState': return updater.getState()
        case 'updaterCheck': void updater.check(); return updater.getState()
        case 'updaterInstall': void updater.installNow(); return updater.getState()
        case 'dshUpdateNow': void dshUpdater.updateNow(); return '{}'
        case 'dshCheckNow': void dshUpdater.checkOnce('manual', true); return '{}'
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
  server.settling = false
  server.settlingServing = false
  cancelRestartRetry()
  const child = server.child
  if (child && child.exitCode === null) {
    server.stopping = true
    const pid = child.pid
    await killPid(pid, true)
    server.child = null
    server.stopping = false
    log(`DSH force-stopped on exit (PID ${pid})`)
  }
  server.child = null
  // 认领的自重启后继同样是我们负责的服务：退出前一并结束，否则留下无人看护的孤儿（下次只能无凭据接管）
  if (server.claimed()) {
    const pid = server.claimedPid
    await killPid(pid, true)
    clearClaimed()
    server.launchSig = null
    log(`DSH 自重启进程已随启动器退出 (PID ${pid})`)
  }
}

// ---------- 退出（停止我们负责的服务：自己拉起的 + 认领的自重启后继） ----------
async function requestExit() {
  if (reallyExit) return
  reallyExit = true
  stopFlash()
  saveWebWindowState() // 退出前落盘独立窗口几何（防抖定时器可能尚未触发）
  if (server.managed()) await stopServerFast()
  log('tray exiting')
  try { saveConfig() } catch { /* noop */ }
  try { if (runGuardHandle) runGuardHandle.markClean() } catch { /* 证据清理失败不阻断退出 */ }
  lifecycle.emit('app.exit', { reason: 'tray' })
  if (tray) { try { tray.destroy() } catch { /* noop */ } tray = null }
  app.quit()
}

// ---------- 自检（对齐 C# selftest：READY / STOPPED / WEBVIEW OK） ----------
// killPid 返回时子进程的 exit 事件往往还没派发完：需要轮询等状态跃迁，不能同步读
async function waitUntil(fn, timeoutMs = 5000, stepMs = 200) {
  const t0 = Date.now()
  for (;;) {
    try { if (fn()) return true } catch { /* 判定失败继续等 */ }
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(stepMs)
  }
}
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
      "typeof window.dshBridge !== 'undefined' && window._lastZoom !== undefined && typeof window._running === 'boolean' && document.getElementById('btnZoom') !== null && document.getElementById('btnWebZoom') !== null && document.getElementById('btnPort') !== null && document.getElementById('feedbackContact') !== null && document.getElementById('btnFeedback') !== null && document.getElementById('btnUpdateNow') !== null && document.getElementById('btnBalanceRefresh') !== null && document.getElementById('balanceValue') !== null && document.getElementById('btnRecharge') !== null && document.getElementById('btnBalanceOpenSettings') !== null && document.getElementById('balanceKey') !== null && document.getElementById('btnBalanceTest') !== null && document.getElementById('btnBalanceBack') !== null && document.getElementById('btnWizardStart') !== null && document.getElementById('wizardPercent') !== null && document.getElementById('btnWizardRetry') !== null && document.getElementById('btnDshUpdateNow') !== null && document.getElementById('launcherVersion') !== null && document.getElementById('dshVersion') !== null && document.getElementById('dshChannelChips') !== null && document.getElementById('dshChannelChips').children.length === 2 && document.getElementById('urlText') !== null && document.getElementById('urlText').classList.contains('link') && document.getElementById('btnReset') !== null ? 'panel-ok' : 'panel-missing'",
    )
    selftestPrint(`WEBVIEW OK: ${title} | ${panel}`)
    // 自愈链路：服务已停止 → webview 重载为空白；重启服务 → 自动恢复真实应用
    await wc.loadURL(uiUrl()).catch(() => { /* 服务已停，预期失败 */ })
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
    // 看护自动重启：直接杀死服务进程，应自动拉起（标记为预期崩溃：跳过交接裁决，专测崩溃路径）
    server.expectCrash = true
    const deadPid = server.displayPid()
    try { process.kill(deadPid, 'SIGKILL') } catch { /* noop */ }
    const revived = await new Promise((resolve) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (servicePhase() === 'ready' && server.running() && server.displayPid() !== deadPid) { clearInterval(iv); resolve(true) }
        else if (Date.now() - t0 > 25000) { clearInterval(iv); resolve(false) }
      }, 500)
    })
    if (!revived) { selftestPrint('FAILED: auto-restart watchdog did not revive service'); app.exit(2); return }
    selftestPrint('AUTO-RESTART OK (revived PID ' + server.displayPid() + ')')
    // —— 集成演练：DSH 内「重启服务」= 克隆自己再退出 → 必须认领，不得判成崩溃后抢端口 ——
    {
      clearRestartTracking() // 上一轮 AUTO-RESTART 的重启计数会污染"没被当成崩溃"的断言
      autoRestartStopped = false
      const sig2 = server.launchSig
      // 必须是"已经就绪"的自有服务：启动阶段被杀不会被判成交接（那是 startServer 的职责）
      const readyGen = await waitUntil(() => server.owned() && !server.child.__starting && servicePhase() === 'ready', 30000)
      const plan2 = envReport && envReport.plan
      const oldPid2 = server.child ? server.child.pid : server.displayPid()
      if (!readyGen || !plan2 || !sig2 || !oldPid2) {
        selftestPrint('FAILED: SELF-RESTART 前置不足（需要自有服务与启动签名）')
        app.exit(2); return
      }
      // 克隆体：argv 与启动签名逐字一致；stdio=ignore → 我们收不到它的 launch token（认领后的真实主路径）
      const clone = spawn(plan2.nodeCmd, [sig2.script, ...sig2.args], {
        cwd: plan2.cwd || harnessRoot,
        env: { ...process.env, DSH_HOME: HOME },
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      })
      clone.unref()
      // 只看本次演练新增的事件：tail 的固定窗口会把上一轮 AUTO-RESTART 的事件也算进来
      let lifecycleOffset = 0
      try { lifecycleOffset = fs.statSync(lifecycle.getPath()).size } catch { /* 取不到就退化为窗口内判定 */ }
      const readNewEvents = () => {
        try {
          const fd = fs.openSync(lifecycle.getPath(), 'r')
          try {
            const size = fs.fstatSync(fd).size
            const len = Math.max(0, size - lifecycleOffset)
            const buf = Buffer.alloc(len)
            fs.readSync(fd, buf, 0, len, lifecycleOffset)
            return String(buf).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
          } finally { fs.closeSync(fd) }
        } catch { return [] }
      }
      await killPid(oldPid2, true) // 我们追踪的进程消失，端口由克隆体接管 = 事故现场
      const claimedOk = await waitUntil(() => server.claimed() && server.displayPid() !== oldPid2, 20000, 400)
      const events = readNewEvents()
      const ho = [...events].reverse().find((e) => e.event === 'service.handover')
      const st = JSON.parse(stateJson())
      const authOk = await waitUntil(() => server.authPending, 8000)
      const claimChecks = [
        claimedOk,
        !!ho && !events.some((e) => e.event === 'service.autoRestart'),
        restartAttemptsInWindow() === 0,
        !!ho && !!(ho.detail && ho.detail.verdict === 'self-restart'),
        servicePhase() === 'ready',
        st.origin === 'claimed' && st.managed === true && st.owned === false,
        authOk,
      ]
      const claimPass = claimChecks.every(Boolean)
      selftestPrint(`SELF-RESTART ${claimPass ? 'OK' : 'FAILED'} (PID ${oldPid2} → ${server.displayPid()}, 崩溃重启次数=${restartAttemptsInWindow()}, authPending=${server.authPending})`)
      if (!claimPass) {
        selftestPrint(`FAILED: SELF-RESTART checks=${JSON.stringify(claimChecks)} settling=${server.settling} running=${server.running()} origin=${st.origin}`)
        await stopServer() // 克隆体还占着自检端口：不清掉会污染下一次 selftest
        app.exit(2); return
      }
      // 认领的服务必须停得掉（否则"面板说属于我们、实际无人管"）
      await stopServer()
      const stopPass = !server.claimed() && !server.running() && !(await portOpen())
      selftestPrint(`SELF-RESTART-STOP ${stopPass ? 'OK' : `FAILED (claimed=${server.claimedPid} portOpen=${await portOpen()})`}`)
      if (!stopPass) { selftestPrint('FAILED: claimed successor not stopped'); app.exit(2); return }
    }
    // —— 集成演练：冷却期内的一次崩溃必须由补偿定时器接住（旧行为=直接 return，看护静默停摆）——
    {
      const back = await startServer()
      if (!back) { selftestPrint('FAILED: RESTART-COOLDOWN 前置启动失败'); app.exit(1); return }
      server.expectCrash = true
      lastRestartAt = Date.now() // 伪装"刚刚自动重启过"，让这次退出正好落在冷却窗口里
      const deadPid3 = server.child.pid
      await killPid(deadPid3, true)
      const scheduled = await waitUntil(() => restartRetryPending(), 6000)
      const revived3 = await waitUntil(() => servicePhase() === 'ready' && server.running() && server.displayPid() !== deadPid3, 25000, 500)
      // 用户主动停止必须取消待触的延后重启
      server.expectCrash = true
      lastRestartAt = Date.now()
      const deadPid4 = server.displayPid()
      await killPid(deadPid4, true)
      const rescheduled = await waitUntil(() => restartRetryPending(), 6000)
      await stopServer()
      const cancelled = !restartRetryPending()
      const coolOk = scheduled && revived3 && rescheduled && cancelled
      selftestPrint(`RESTART-COOLDOWN ${coolOk ? 'OK' : 'FAILED'} (deferred=${scheduled}, revived=${revived3}, re-deferred=${rescheduled}, cancelledOnStop=${cancelled})`)
      if (!coolOk) { selftestPrint('FAILED: cooldown retry broken'); app.exit(2); return }
      clearRestartTracking()
      autoRestartStopped = false
    }
    // —— 硬止损：就绪后立即崩溃连续达阈值 → 即使计数窗口为空也必须停止自动恢复 ——
    {
      clearRestartTracking() // 模拟"窗口被清空"的坏情况：靠 streak 仍必须停下来
      autoRestartStopped = false
      recoveryDone = true // 本场景只验 halt 分支
      fastCrashStreak = RESTART_MAX
      await maybeAutoRestart()
      const halted = autoRestartStopped === true && !server.running() && !restartRetryPending()
      selftestPrint(`FAST-CRASH-HALT ${halted ? 'OK' : 'FAILED'} (stopped=${autoRestartStopped}, running=${server.running()}, retryPending=${restartRetryPending()})`)
      if (!halted) { selftestPrint('FAILED: fast-crash hard stop broken'); app.exit(2); return }
      autoRestartStopped = false
      fastCrashStreak = 0
      clearRestartTracking()
    }
    // —— 通知去重：同标题+同内容在窗口期内只弹一次（崩溃循环不再刷屏）——
    {
      const tag = 'dedupe-' + Date.now()
      notify('SELFTEST', tag)
      notify('SELFTEST', tag)
      let text = ''
      try { text = fs.readFileSync(TRAY_LOG, 'utf8') } catch { /* noop */ }
      const lines = text.split(/\r?\n/)
      const shown = lines.filter((l) => l.includes('[notify] SELFTEST: ' + tag)).length
      const suppressed = lines.filter((l) => l.includes('suppressed duplicate') && l.includes(tag)).length
      const dedupeOk = shown === 1 && suppressed === 1
      selftestPrint(`NOTIFY-DEDUPE ${dedupeOk ? 'OK' : 'FAILED'} (shown=${shown}, suppressed=${suppressed})`)
      if (!dedupeOk) { selftestPrint('FAILED: notify dedupe broken'); app.exit(2); return }
    }
    const tStop = Date.now()
    await stopServerFast() // 验证退出路径的快速停止（应远小于 1s）
    selftestPrint(`EXIT-STOP FAST: ${Date.now() - tStop}ms`)
    broadcastState()
    // 日志轮转验证
    try { fs.appendFileSync(TRAY_LOG, 'x'.repeat(LOG_MAX_BYTES + 1000)) } catch { /* noop */ }
    rotateFileSync(TRAY_LOG)
    if (!fs.existsSync(TRAY_LOG + '.1')) { selftestPrint('FAILED: log rotation'); app.exit(2); return }
    selftestPrint('LOG ROTATION OK')
    // —— 稳定性机制自检：run-guard / redact / lifecycle / health ——
    try {
      const gp = path.join(LOG_DIR, 'active-run.test.json')
      const g1 = runGuard.beginRun(gp, { startedAt: new Date().toISOString(), pid: process.pid, version: 'selftest' })
      const g2 = runGuard.beginRun(gp, { startedAt: new Date().toISOString(), pid: process.pid, version: 'selftest-2' })
      const prevOk = !!(g2.previousRun && g2.previousRun.pid === process.pid)
      g1.markClean() // 旧进程延迟退出：不得删 g2 的 marker
      const keepOk = fs.existsSync(gp)
      g2.markClean()
      const cleanOk = !fs.existsSync(gp)
      selftestPrint(`RUN-GUARD ${prevOk && keepOk && cleanOk ? 'OK' : 'FAILED'}`)
      // 未清理 → 下次检测到崩溃证据（g3 不 markClean 模拟崩溃，g4 应检测到）
      const g3 = runGuard.beginRun(gp, { startedAt: new Date().toISOString(), pid: process.pid, version: 'selftest-3' })
      const g4 = runGuard.beginRun(gp, { startedAt: new Date().toISOString(), pid: process.pid, version: 'selftest-4' })
      const crashDetect = !!(g4.previousRun && g4.previousRun.pid === process.pid)
      g4.markClean()
      selftestPrint(`RUN-GUARD CRASH-DETECT ${crashDetect ? 'OK' : 'FAILED'}`)
    } catch (err) { selftestPrint('RUN-GUARD FAILED: ' + err.message) }
    {
      const ok = redact('sk-abcdefghijklmnopqrstuvwxyz123456') === 'sk-***' && redact('plain text 123') === 'plain text 123'
      selftestPrint(`REDACT ${ok ? 'OK' : 'FAILED'}`)
    }
    {
      // 崩溃计数时间窗：填充到阈值必须"看得见"，清空后必须归零（否则回退/halt 永远不可达）
      seedRestartAttempts(RESTART_MAX)
      const full = restartAttemptsInWindow()
      clearRestartTracking()
      const cleared = restartAttemptsInWindow()
      selftestPrint(`RESTART-WINDOW ${full === RESTART_MAX && cleared === 0 ? 'OK' : 'FAILED'} (full=${full} cleared=${cleared})`)
    }
    try {
      lifecycle.emit('app.started', { version: 'selftest', seq: 'roundtrip' })
      const lcOk = lifecycle.tail(10).some((l) => { try { return JSON.parse(l).detail && JSON.parse(l).detail.seq === 'roundtrip' } catch { return false } })
      selftestPrint(`LIFECYCLE ${lcOk ? 'OK' : 'FAILED'}`)
    } catch (err) { selftestPrint('LIFECYCLE FAILED: ' + err.message) }
    try {
      // 健康快照往返：捕获 → 篡改 → 恢复 → skip marker 消费（临时路径，不影响真实配置）
      if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(Config, null, 2))
      const before = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const h1 = health.captureHealthy({ dshlVersion: 'selftest', reason: 'selftest' })
      const snapDir = path.join(HOME, 'dshl', 'health-snapshots')
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(Object.assign({}, before, { theme: 'dark' }), null, 2))
      const target = health.pickRestoreTarget(health.configHash())
      const h2 = health.restore(target)
      const after = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const snapCfg = JSON.parse(fs.readFileSync(path.join(snapDir, h1.slotId, 'config.json'), 'utf8'))
      const restoreOk = h1.status === 'captured' && h2.status === 'restored' && after.theme === snapCfg.theme && fs.existsSync(h2.backupPath)
      selftestPrint(`HEALTH ${restoreOk ? 'OK' : 'FAILED'}`)
      const h3 = health.captureHealthy({ dshlVersion: 'selftest', reason: 'selftest-2' })
      selftestPrint(`HEALTH SKIP-MARKER ${h3.status === 'skipped' ? 'OK' : 'FAILED'}`)
      // —— 集成演练：连续失败(5) → 自动回退（真实接线：maybeAutoRestart → attemptConfigRecovery → restore）——
      const cfgSaved = fs.readFileSync(CONFIG_PATH, 'utf8')
      const hRec = health.captureHealthy({ dshlVersion: 'selftest', reason: 'recovery-drill' })
      // 篡改配置（模拟"用户改了配置后从未健康启动"），并把重试计数推向触发阈值
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(Object.assign({}, Config, { theme: 'dark', port: 3888 }), null, 2))
      seedRestartAttempts(RESTART_MAX) // 直接填满计数窗口（避免真等 10 分钟）
      lastRestartAt = 0
      fastCrashStreak = 0 // 前面的演练故意杀过服务：先清掉，确保走"窗口阈值"这条路径
      recoveryDone = false
      lastRestoredSlot = ''
      lastRecoveryAt = ''
      await maybeAutoRestart() // 应触发恢复：恢复配置 + 备份 + 计数复位 + 重新拉起服务
      const cfgAfterRec = fs.readFileSync(CONFIG_PATH, 'utf8')
      const recJson = JSON.parse(stateJson())
      const recEvent = lifecycle.tail(30).some((l) => { try { return JSON.parse(l).event === 'recovery.restore' } catch { return false } })
      const recOk = cfgAfterRec === cfgSaved
        && restartAttemptsInWindow() === 0
        && recoveryDone === true
        && !!lastRecoveryAt
        && !!lastRestoredSlot
        && recJson.recoveredAt === lastRecoveryAt
        && recEvent
      selftestPrint(`RECOVERY ${recOk ? 'OK' : 'FAILED'}`)
      if (server.owned()) await stopServerFast() // 恢复演练拉起过服务：收尾停掉
      // —— 恢复失败后的显式停止：不再发起新一轮崩溃循环（借鉴 dsh-desktop "失败代际不自动复活"） ——
      seedRestartAttempts(RESTART_MAX)
      lastRestartAt = 0
      await maybeAutoRestart() // recoveryDone=true → halt 分支（不再重启服务、只发一次通知）
      const haltEvent = lifecycle.tail(30).some((l) => { try { return JSON.parse(l).event === 'service.autoRestartHalted' } catch { return false } })
      const haltState = JSON.parse(stateJson())
      const haltOk = autoRestartStopped === true
        && haltState.autoRestartStopped === true
        && haltEvent
        && !server.running()
      selftestPrint(`RECOVERY-HALT ${haltOk ? 'OK' : 'FAILED'}`)
      // 复位，避免影响后续检查
      autoRestartStopped = false
      clearRestartTracking()
      recoveryDone = false
      lastRecoveryAt = ''
      // 清理 selftest 快照目录，避免残留
      try { fs.rmSync(snapDir, { recursive: true, force: true }) } catch { /* noop */ }
    } catch (err) { selftestPrint('HEALTH FAILED: ' + err.message) }
    try {
      // 诊断接线自检：直接落入日志的敏感行（绕过 log() 脱敏）→ 报告文本必须脱敏；stateJson 暴露稳定性字段
      fs.appendFileSync(TRAY_LOG, 'FAKEKEY sk-abcdefghijklmnopqrstuvwxyz123456 redact-check\n')
      saveCrashDiagnostics()
      const files = fs.readdirSync(DIAG_DIR).filter((f) => f.startsWith('diag-')).sort()
      const newest = files[files.length - 1]
      const st = JSON.parse(stateJson())
      let diagOk = false
      if (newest) {
        const text = fs.readFileSync(path.join(DIAG_DIR, newest), 'utf8')
        const noLeak = !text.includes('sk-abcdefghijklmnopqrstuvwxyz123456')
        const masked = text.includes('sk-***')
        const stateOk = typeof st.lastExit === 'string' && typeof st.lastCrashAt === 'string' && typeof st.diagnosticsDir === 'string'
        diagOk = noLeak && masked && stateOk
      }
      selftestPrint(`DIAG-REPORT ${diagOk ? 'OK' : 'FAILED'}`)
    } catch (err) { selftestPrint('DIAG-REPORT FAILED: ' + err.message) }
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

// 对话界面默认缩放：在 cssZoomPct 基础上收敛到 100–125%
// 锚点：系统 150% → 125%（比"通用正常物理大小"大 25%，用户品味基准，与 150% 档实测一致）；
// 修掉旧公式两端问题：100% 系统不再 83%（缩水）、200% 系统不再 167%（物理 3.3×）。
function defaultWebZoomPct() {
  return Math.min(Math.max(cssZoomPct(), 100), 125)
}

// ---------- 初始化 ----------
function init() {
  loadConfig()
  // 设置项已从界面移除（v1.0.16+）：行为锁定默认值——DSH 用启动器独立窗口打开、意外退出自动重启看护
  Config.useSystemBrowser = false
  Config.autoRestart = true
  applyRuntimePort(true) // 端口配置生效（启动时 CLI --port 作种子；运行时切换以 Config.port 为准）
  initEnvRuntime()
  Config.zoom = systemZoom() // 启动器缩放默认跟随系统（不持久化，每次启动重读）
  if (!webZoomLoaded) Config.webZoom = defaultWebZoomPct() // 对话界面缩放默认：用户未设置过时用收敛默认；改过则用持久化值
  // 主题设置驱动原生标题栏与所有渲染进程的 prefers-color-scheme（tab 栏壳深色变量随之生效）
  try { nativeTheme.themeSource = Config.theme } catch { /* noop */ }
  // 移除默认应用菜单：其 Ctrl+R 加速键会重载"壳窗口"而非对话页面（视图在主进程持有，壳重载≠页面刷新）。
  // 刷新统一走 F5 / Ctrl+R（页面级）/ 顶栏 ↻ 按钮；改用前后行为一致。
  try { Menu.setApplicationMenu(null) } catch { /* noop */ }
  harnessRoot = resolveHarnessRoot()
  loadIcons()
  fs.mkdirSync(LOG_DIR, { recursive: true })
  // —— 稳定性：活跃运行证据 / 生命周期事件 / 健康快照 / 诊断（借鉴 dsh-desktop） ——
  try {
    runGuardHandle = runGuard.beginRun(ACTIVE_RUN, {
      startedAt: new Date().toISOString(),
      pid: process.pid,
      version: app.getVersion(),
    })
    if (runGuardHandle && !runGuardHandle.previousRun) log('run-guard: clean previous exit')
  } catch (err) { log('run-guard begin failed: ' + err.message) }
  // 开发者热重启（tools/dev.mjs 写 .dev-restart.json 后强杀）：这次退出是"预期"的，
  // 不算崩溃证据，避免每次改主进程代码都弹一次崩溃提示卡 + 生成诊断报告。
  try {
    const devMarker = path.join(LOG_DIR, '.dev-restart.json')
    if (fs.existsSync(devMarker)) {
      const info = JSON.parse(fs.readFileSync(devMarker, 'utf8'))
      fs.unlinkSync(devMarker)
      const prevPid = runGuardHandle && runGuardHandle.previousRun ? runGuardHandle.previousRun.pid : 0
      if (info && (!info.pid || !prevPid || Number(info.pid) === Number(prevPid))) {
        runGuardHandle.previousRun = undefined
        log(`run-guard: dev restart detected (prev PID ${info.pid || '?'}), crash evidence ignored`)
      } else {
        log('run-guard: dev restart marker found but PID mismatch, keeping crash evidence')
      }
    }
  } catch (err) { log('run-guard: dev marker check failed: ' + (err && err.message ? err.message : String(err))) }
  lifecycle.initLifecycle({ dir: LOG_DIR, log })
  health.initHealth({ configPath: CONFIG_PATH, snapshotDir: path.join(HOME, 'dshl', 'health-snapshots'), log })
  diagnostics.initDiagnostics({ dir: DIAG_DIR, log })
  registerIpc()
  createWindow()

  if (SELF_TEST) {
    win.webContents.once('did-finish-load', () => { void runSelfTest() })
    return
  }

  buildTray()
  log('tray started')
  lifecycle.emit('app.started', { version: app.getVersion(), platform: process.platform })
  // 上次非受控退出证据：通知 + 自动收集诊断报告（脱敏，保留 3 份）
  if (runGuardHandle && runGuardHandle.previousRun) {
    const prev = runGuardHandle.previousRun
    lifecycle.emit('crash.previousRun', Object.assign({}, 'unreadable' in prev
      ? { unreadable: true }
      : { pid: prev.pid, startedAt: prev.startedAt, version: prev.version }))
    if (!SELF_TEST) saveCrashDiagnostics()
    // 每次崩溃都会重新提示一次（按该次崩溃的启动时间戳去重，用户关掉后不再重复）
    if (prev.startedAt && prev.startedAt !== Config.crashNoticeSeen) {
      Config.crashNoticeSeen = prev.startedAt
      Config.crashNoticeDismissed = ''
      try { saveConfig() } catch { /* noop */ }
      if (!SELF_TEST && Config.notify) {
        notify('DeepSeek Harness Launcher', `上次启动器未正常退出：诊断报告已保存（${DIAG_DIR}），可交给开发者排查`)
      }
    }
  }
  // 自动更新（electron-updater → GitHub Releases）：状态推送走 dsh:updater，下载完成弹通知 + 托盘闪烁
  updater.initUpdater({
    log,
    currentVersion: app.getVersion(),
    onNotify: (title, message) => notify(title, message),
    onFlash: startFlash,
    sendToPanel: (json) => { if (win && !win.isDestroyed()) { try { win.webContents.send('dsh:updater', json) } catch { /* noop */ } } },
    beforeInstall: async () => { if (server.managed()) await stopServerFast() },
    onEvent: (event, detail) => lifecycle.emit(event, detail),
  })
  // DSH 更新（dsh-update.js）：检测全自动、更新全手动（主页卡片按钮触发）
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
    loadWebTabs: (reason) => webLoadTabs(reason),
    reloadWebTabs: () => { void refreshWebUiOnReady(true) },
    onState: () => broadcastState(),
    lifecycleEmit: (event, detail) => lifecycle.emit(event, detail),
    statePath: path.join(HOME, 'dshl', 'dsh-update-state.json'),
  })
  // 插件市场（market.js）：把 dshmarket 装进 DSH 的 web profile（dsh plugin add/remove 薄封装）
  market.initMarket({ home: realHome, envDetect, log })
  if (firstRun) {
    // 全新机模拟（DSHL_FRESH_TEST=1）时不动真实系统的开机自启
    if (process.env.DSHL_FRESH_TEST !== '1' && !autostartEnabled()) setAutostart(true) // 默认开启开机自启与消息提醒
    saveConfig()
  }
  clearStaleNotify()
  migrateLegacyAutostart()
  // 启动默认触发一次"打开 DeepSeek Harness"：先开窗口（立即反馈，显示启动说明页），服务就绪后自动切到真实页面。
  // 环境未就绪时：跳过服务启动，首次运行直接弹出面板（自动进入"运行环境"页引导一键安装）。
  void (async () => {
    await refreshEnv(true)
    maybeMigrateDsh()
    // 上次 DSH 更新若被中断（装到一半退出启动器），安装目录会残留半套文件 → 先自愈再探测/拉服务
    try { await dshUpdater.recoverInterruptedUpdate() } catch (err) { log('dsh-update: 中断恢复异常：' + (err && err.message ? err.message : String(err))) }
    void maybeApplyDefenderExclusion() // 安装/升级后首次运行：尝试添加 Defender 排除项（一次 UAC）
    if (!envReady()) {
      if (firstRun || args.panel) showPanel()
      log('environment not ready, panel available for one-click install')
      return
    }
    void maybeAutoInstallPluginMarket() // 插件市场默认安装（每个版本只自动尝试一次）
    if (args.panel) {
      showPanel()
      await handleStart()
      return
    }
    // 默认：先开窗（窗口立即出现，"正在启动服务…"说明页 + 进度条），服务异步就绪后自动进入真实页面
    // loadingReason='start'：此刻服务尚未拉起（phase=stopped），避免说明页误显示"服务未启动"
    openWebUi({ loading: !server.running(), loadingReason: 'start' })
    await handleStart()
    if (!server.running() && !SELF_TEST) void refreshWebUiPhase() // 启动失败：说明页切换为对应状态（未启动/卡住等）
  })()
  setInterval(onTick, TRACK_WATCHDOG_MS)
  // 开发模式热刷新（npm run dev / VS Code F5）：wwwroot 产物变化 → 面板窗口自动重载，无需重启启动器。
  // 面板壳（browser.html）变化时独立窗口壳一并重载（分屏视图挂的是 DSH 页面，不受影响）。
  if (!app.isPackaged) {
    let devReloadTimer = null
    try {
      fs.watch(WWWROOT, () => {
        clearTimeout(devReloadTimer)
        devReloadTimer = setTimeout(() => {
          if (win && !win.isDestroyed()) { try { win.webContents.reload() } catch { /* noop */ } }
          if (webWin && !webWin.isDestroyed()) { try { webWin.reload() } catch { /* noop */ } }
          log('dev: wwwroot changed → panel hot-reloaded')
        }, 150)
      })
      log('dev: panel hot reload enabled (npm run dev)')
    } catch (err) { log('dev: hot reload watch failed: ' + (err && err.message ? err.message : String(err))) }
  }
  // 启动后 10 秒静默检查启动器更新（仅打包版；轻量只读 GitHub latest.yml，10s 避开新窗口弹出瞬间即可，开发模式跳过）
  setTimeout(() => updater.autoCheck(), 10000)
  // DSH 更新检查：启动后 15 秒首次（此时环境探测/服务启动均已完成，检测越早用户越早看到新版提示），
  // 此后每 6 小时一次（模块内 24h 节流；只检测绝不自动更新）
  // 发现新版后由 dsh-update.warmLatest 立即后台预热缓存，用户点"立即更新"时秒级完成
  setTimeout(() => { void dshUpdater.checkOnce('startup') }, 15000)
  setInterval(() => { void dshUpdater.checkOnce('timer') }, 6 * 60 * 60 * 1000)
}

// ---------- 应用生命周期 ----------
if (IS_WIN) { try { app.setAppUserModelId('com.dshl.launcher') } catch { /* noop */ } }
app.on('before-quit', () => {
  reallyExit = true
  saveWebWindowState()
  try { if (runGuardHandle) runGuardHandle.markClean() } catch { /* noop */ } // 覆盖更新安装等非托盘路径的退出
  lifecycle.emit('app.exit', { reason: 'quit' })
}) // 覆盖更新安装等非托盘路径的退出
app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ })
app.on('activate', () => openDshOrPanel()) // macOS Dock 点击
// 开发者热重启（tools/dev.mjs 用 taskkill /F 结束进程）与其它受控终止：收到 SIGTERM 后先清理
// active-run 标记再退出，否则每次热重启都会在下次启动被当成"上次非正常退出"，弹出崩溃提示。
process.on('SIGTERM', () => {
  try { if (runGuardHandle) runGuardHandle.markClean() } catch { /* noop */ }
  try { lifecycle.emit('app.exit', { reason: 'sigterm' }) } catch { /* noop */ }
  app.quit()
})
process.on('uncaughtException', (err) => {
  // 只记录，不清理 active-run marker：本进程未受控退出（随后可能被系统/用户强杀），
  // marker 必须留下作为"上次非正常退出"的证据，交给下次启动弹通知 + 自动收集诊断报告。
  try { lifecycle.emit('app.uncaught', { err: ((err && err.message) || String(err)).slice(0, 128) }) } catch { /* noop */ }
  try { log('uncaught: ' + ((err && err.stack) || err)) } catch { /* noop */ }
})

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
