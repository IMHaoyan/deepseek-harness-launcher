// dsh-update.js — DSH 更新：检测全自动、更新全手动
// 策略（用户选定）：
//  - 静默检查最新版（启动后 + 每 6 小时，24 小时节流）；发现新版 → 主页卡片 + 托盘气泡一次，绝不自动更新；
//  - 用户点击卡片"立即更新"后才执行更新（全局 npm：npm update -g --prefix 全局根，npmmirror 优先）；
//  - 托管形态走统一引擎（内部优先全局 npm，失败回退托管原子安装，失败旧版不动）；
//  - npx 形态先迁移到全局 npm 再更新（失败回退 npx 预热）；源码版仅提示。
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const semver = require('semver')

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 检查节流：24 小时
const JOB_WAIT_TIMEOUT_MS = 20 * 60 * 1000 // 安装任务最长等待：20 分钟

let Config = null
let saveConfig = null
let log = () => {}
let notify = () => {}
let claimAvailableNotice = null // (version) => boolean：跨重启的"新版本可用"去重（缺省回退内存去重）
let refreshEnv = null
let envInstall = null
let envDetect = null
let getServerState = null // () => ({ running, owned })
let pageCredentialOf = null // () => ({ hasToken })，可选：当前服务是否拿到了本轮页面访问凭据（launch token）
let stopService = null
let startService = null
let loadWebTabs = null // (reason) => 把 WebUI 窗口所有标签切到状态说明页（避免更新期间白屏）
let markProgress = null // (key) => 推进说明页步骤（'install' 等；主进程未接就当没有）
let reloadWebTabs = null // () => 强制重载 WebUI 所有标签（新版页面替换旧会话）
let onState = null // 状态变化回调（main 里接 broadcastState）
let lifecycleEmit = null // (event, detail) => void（可选：生命周期事件）
let statePath = '' // 更新事务状态文件（~/.dsh/dshl/dsh-update-state.json）；空 = 不记录

const state = {
  status: 'idle', // idle | checking | available | updating | updated | error
  current: '',
  latest: '',
  latestChannel: '', // latest 这个版本号是从哪个渠道取来的（缓存与渠道同源；换渠道必须作废）
  kind: '', // 当前安装形态（source | managed | global | npx）：source 不支持自动更新，UI 按此区分
  error: '',
  prewarmed: false, // 新版完整依赖树是否已预热进 npm/npx 缓存（点击"立即更新"可秒级完成）
}

let checking = false
let updating = false
let warming = null // 当前预热任务（防重入）
let lastNotifiedVersion = '' // 同一新版本只提示一次
let rollbackUsed = false // 每次更新周期最多一次回滚
let lastFetchError = '' // 最近一次取版本失败的原因（用于给用户可读的检查失败提示）
// 用户本次会话显式选过的渠道（控制台上的渠道 chip）。显式选择本身就可能是一次版本号下降
// （latest→alpha：预发布版按 semver 优先级小于同版本正式版），那是意图内的，不该被降级闸拦掉。
// 只在用户切换渠道时写入，不随"一次安装尝试"消费 —— 否则安装失败后重试会被自己的闸拦死。
let userSwitchedChannel = ''

// 更新渠道：latest（默认，跟随 npm latest）/ alpha（跟随 npm alpha，提前拿预览版）
function channelOf() {
  return Config && Config.dshChannel === 'alpha' ? 'alpha' : 'latest'
}

function emitLifecycle(event, detail) {
  try { if (lifecycleEmit) lifecycleEmit(event, detail) } catch { /* noop */ }
}

// 更新事务状态：写入/清空（best-effort，仅用于诊断与回滚依据）
function writeUpdateState(value) {
  if (!statePath) return
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(Object.assign({ updatedAt: new Date().toISOString() }, value), null, 2))
  } catch (e) { log('dsh-update: state write failed: ' + (e && e.message ? e.message : String(e))) }
}

function clearUpdateState() {
  if (!statePath) return
  try { fs.unlinkSync(statePath) } catch { /* noop */ }
}

function readUpdateState() {
  if (!statePath) return null
  try {
    const v = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

// ---------- 中断的更新自愈 ----------
// 事务状态在更新开始时写入、成功收尾时清除。启动时若读到残留的 phase='start'，
// 说明上次更新没走完（典型：装到一半退出启动器）——npm 全局安装会残留半套文件，
// DSH 能启动但几秒后加载到缺失模块就崩，看起来就是"就绪后 code 1 反复重启"。
async function recoverInterruptedUpdate() {
  const st = readUpdateState()
  if (!st || st.phase !== 'start') return { recovered: false, reason: 'no-pending' }
  const from = String(st.from || '')
  const to = String(st.to || '')
  const kind = String(st.kind || '')
  log(`dsh-update: 检测到未完成的更新事务（${from || '?'} → ${to || '?'}, kind=${kind}）`)
  emitLifecycle('update.dsh', { step: 'interrupted', from, to, kind })
  if (!to) { clearUpdateState(); return { recovered: false, reason: 'no-target' } }
  notify('DeepSeek Harness', `上次 DSH 更新未完成（${from || '?'} → ${to}），正在自动修复…`)
  let nodeBin = 'node'
  try {
    const r = await envDetect.detectEnv(false)
    if (r && r.plan) nodeBin = r.plan.nodeCmd || 'node'
  } catch { /* 用默认 node */ }
  let ok = false
  try {
    if (kind === 'global') {
      const globalRoot = await envInstall.resolveGlobalRoot(nodeBin)
      ok = (await runGlobalUpdate(nodeBin, globalRoot, to)).ok
    } else if (kind === 'managed') {
      envInstall.startInstall(['dsh'], { dshVersion: to, autoUpdate: true })
      ok = (await waitForJob()) === 'done'
    } else {
      log('dsh-update: 该安装形态不支持自动修复（kind=' + kind + '）')
    }
  } catch (err) {
    log('dsh-update: 中断修复异常：' + (err && err.message ? err.message : String(err)))
  }
  if (!ok) {
    // 标记为已处理，避免每次启动都重试一遍失败的安装
    try { writeUpdateState({ kind, from, to, phase: 'repair-failed' }) } catch { /* noop */ }
    notify('DeepSeek Harness', `自动修复失败：请手动执行 npm i -g @deepseek-ai/dsh@${to}，或在控制台「运行环境」页重装`)
    log('dsh-update: 中断修复失败，已标记 repair-failed')
    emitLifecycle('update.dsh', { step: 'interrupted-repair-failed', from, to, kind })
    return { recovered: false, reason: 'failed' }
  }
  try { await refreshEnv(true) } catch { /* noop */ }
  clearUpdateState()
  log(`dsh-update: 未完成的更新已修复到 v${to}`)
  emitLifecycle('update.dsh', { step: 'interrupted-repaired', from, to, kind })
  notify('DeepSeek Harness', `上次未完成的 DSH 更新已修复（v${to}）`)
  return { recovered: true, to }
}

/**
 * 更新后校验决策（纯函数，便于测试；错误文本不参与决策）。
 * @param {{startOk: boolean, runningVersion: string, latest: string, fromVersion: string, kind: string, rollbackUsed: boolean}} input
 * @returns {{action: 'none'} | {action: 'rollback', reason: string} | {action: 'report', startOk: boolean, runningVersion: string}}
 */
function decideRollback(input) {
  const { startOk, runningVersion, latest, fromVersion, kind, rollbackUsed } = input
  const versionMismatch = !!latest && runningVersion !== latest
  if (!startOk || versionMismatch) {
    if (kind === 'global' && !!fromVersion && fromVersion !== latest && !rollbackUsed) {
      return { action: 'rollback', reason: startOk ? 'version-mismatch' : 'start-failed' }
    }
    return { action: 'report', startOk, runningVersion }
  }
  return { action: 'none' }
}

/**
 * 更新目标准入判定（纯函数，便于测试；错误文本不参与决策）。
 *
 * 为什么需要：`state.latest` 只是"上一次成功检查"的缓存，而 updateNow 允许从 status='error' 进入
 * ——控制台上那个「重试」按钮走的就是这条路。缓存一旦与实际安装的版本脱节（例如用户在终端里自己
 * 升过 dsh、或切过渠道），点「重试」就会照着缓存装，把用户从更高版本"更新"回更低版本；而更新后
 * 校验拦不住它（decideRollback 只比"跑起来的 == 目标"）。
 *
 * @param {{target:string, installed:string, targetChannel:string, currentChannel:string,
 *          userChoseChannel:boolean}} input
 *   target           缓存里的待安装版本号
 *   installed        当前实际安装的版本号（环境探测所得）
 *   targetChannel    缓存里的版本号来自哪个渠道
 *   currentChannel   当前配置的渠道
 *   userChoseChannel 用户本次会话是否显式选过"当前这个"渠道
 * @returns {{action:'install', nonUpgrade:boolean} | {action:'block', code:string, reason:string}}
 */
function decideUpdateTarget(input) {
  const src = input || {}
  const target = String(src.target || '')
  const installed = String(src.installed || '')
  const targetChannel = String(src.targetChannel || '')
  const currentChannel = String(src.currentChannel || '')
  if (!semver.valid(target)) {
    return { action: 'block', code: 'no-target', reason: '没有待更新的版本（缓存已作废）：请先检查更新' }
  }
  // 缓存与渠道同源：切了渠道之后，旧缓存里的版本号不再代表"现在该装什么"
  if (targetChannel !== currentChannel) {
    return {
      action: 'block',
      code: 'channel-mismatch',
      reason: `待安装的 v${target} 来自 ${targetChannel || '未知'} 渠道，当前渠道为 ${currentChannel}：请先检查更新`,
    }
  }
  if (installed && semver.valid(installed)) {
    if (semver.eq(target, installed)) {
      return { action: 'block', code: 'same-version', reason: `当前已是 v${installed}，无需更新` }
    }
    if (semver.lt(target, installed)) {
      // 目标比当前低：只有"用户显式选过这个渠道"才算意图内（latest→alpha 而 alpha 指向同版本的
      // 预发布版就是这种情况）。其余一律判为缓存过期，拒绝静默降级。
      if (!src.userChoseChannel) {
        return {
          action: 'block',
          code: 'downgrade',
          reason: `待安装的 v${target} 低于当前安装的 v${installed}（缓存可能已过期）：请先检查更新`,
        }
      }
      return { action: 'install', nonUpgrade: true }
    }
  }
  return { action: 'install', nonUpgrade: false }
}

/**
 * 更新收尾判定（纯函数，便于测试）：只有"服务起来了"且"跑起来的版本就是目标版本"才算更新成功。
 *
 * 为什么需要：此前只有 startOk 参与结论，而 decideRollback 检出的版本不符只写日志、照样弹"已更新"；
 * managed / npx 两个分支更是在校验块之前就 return 了，装不上、起不来、版本没换都报成功。
 *
 * @param {{startOk:boolean, runningVersion:string, latest:string, from:string,
 *          nonUpgrade:boolean, hasToken:boolean}} input
 * @returns {{ok:true, message:string} | {ok:false, reason:'start-failed'|'version-mismatch', message:string}}
 */
function decideUpdateOutcome(input) {
  const src = input || {}
  const latest = String(src.latest || '')
  const runningVersion = String(src.runningVersion || '')
  const verb = src.nonUpgrade === true ? '已切换到' : '已更新到'
  if (src.startOk !== true) {
    return { ok: false, reason: 'start-failed', message: `${verb} v${latest}，但服务未能启动，请打开DSHL 控制台查看日志` }
  }
  // 版本不符只在"确实探测到了版本"时才判：探测失败（空）说明不了问题，不能据此报失败
  if (latest && runningVersion && runningVersion !== latest) {
    return { ok: false, reason: 'version-mismatch', message: `${verb} v${latest}，但更新后实际运行的是 v${runningVersion}（请查看控制台日志）` }
  }
  const base = src.nonUpgrade === true ? `已切换到 v${latest}（原 v${src.from || '?'}）` : `已更新到 v${latest}`
  // 拿不到本轮 launch token（接管的外部实例）时，用户自己开的浏览器页面在服务重启后是死链，
  // 必须给出可执行的指引——点通知本身就会打开 DSH 窗口/DSHL 控制台（见 main.js 的 notify）。
  const credNote = src.hasToken === false
    ? '；页面访问凭据已变化，若页面打不开请点本通知或从DSHL 控制台重新打开'
    : ''
  return { ok: true, message: base + credNote }
}

function initDshUpdater(o) {
  Config = o.Config
  saveConfig = o.saveConfig
  log = o.log || log
  notify = o.notify || notify
  claimAvailableNotice = typeof o.claimAvailableNotice === 'function' ? o.claimAvailableNotice : null
  refreshEnv = o.refreshEnv
  envInstall = o.envInstall
  envDetect = o.envDetect
  getServerState = o.getServerState
  pageCredentialOf = o.getPageCredential || null
  stopService = o.stopService
  startService = o.startService
  loadWebTabs = o.loadWebTabs || null
  markProgress = o.markProgress || null
  reloadWebTabs = o.reloadWebTabs || null
  onState = o.onState || null
  lifecycleEmit = o.lifecycleEmit || null
  statePath = o.statePath || ''
}

function getState() {
  return Object.assign({}, state, { channel: channelOf() })
}

// 控制台切换更新渠道时调用（必须在 Config.dshChannel 已更新之后）：作废缓存里的版本号。
// 缓存与渠道同源，切了渠道它就不再可信；若不作废，"重试"会照着旧渠道的缓存装
// （由 decideUpdateTarget 的 channel-mismatch / no-target 兜底拦下，但这里直接从源头清掉）。
// 同时记下"用户显式选过这个渠道"，供降级闸区分"意图内的下降"与"缓存过期"。
function noteChannelChange() {
  userSwitchedChannel = channelOf()
  setState({ status: 'idle', error: '', latest: '', latestChannel: '', prewarmed: false })
}

function pushState() {
  try { if (onState) onState() } catch { /* noop */ }
}

// 页面访问凭据状态（由主进程注入）。hasToken=false 表示当前服务不是我们拉起的（接管的外部实例），
// 拿不到本轮 launch token：DSHL 自己的窗口没有凭据可续，用户自己开的浏览器页面在服务重启后也是死链。
// 未注入或取值异常时按"凭据正常"处理，避免产生无依据的提示。
function readPageCredential() {
  if (!pageCredentialOf) return { hasToken: true }
  try {
    const v = pageCredentialOf() || {}
    return { hasToken: v.hasToken !== false }
  } catch { return { hasToken: true } }
}

function setState(patch) {
  Object.assign(state, patch)
  pushState()
}

// 解析 npm CLI：托管/发行版 Node 自带 <dir>/node_modules/npm/bin/npm-cli.js（与 env-install 同策略）
function npmCliFor(nodeBin) {
  if (!nodeBin || nodeBin === 'node') return null
  const cli = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return fs.existsSync(cli) ? cli : null
}

function execPathOf(bin) {
  return new Promise((resolve) => {
    let c
    try {
      c = spawn(bin, ['-p', 'process.execPath'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { return resolve('') }
    let out = ''
    c.stdout.on('data', (d) => { out += String(d) })
    c.on('error', () => resolve(''))
    c.on('exit', () => resolve(String(out).trim().split(/\r?\n/)[0]))
  })
}

// cmd.exe 兜底用：首 token（程序名）不加引号，仅对含空格/& 的参数加引号（全部加引号会导致程序名解析失败）
function quoteArg(a) {
  const s = String(a)
  return /\s|&/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

async function runNpm(args, opts = {}) {
  const { nodeBin, timeoutMs = 90000 } = opts
  const fullArgs = ['--no-update-notifier', ...args]
  // 优先用 node 同目录自带的 npm-cli.js（PATH 上的裸 'node' 先解析真实路径，MSI/nvm 发行版都自带）
  let npmCli = npmCliFor(nodeBin)
  if (!npmCli && nodeBin) {
    const real = await execPathOf(nodeBin)
    if (real) npmCli = npmCliFor(real)
  }
  // 关键：把 Node 可执行文件所在目录注入子进程 PATH（与 env-install.js 的 runNpmInstall 同源）。
  // 无系统 Node 的干净机器上，koffi/node-pty 等原生包的生命周期脚本以 `cmd /c node xxx.js` 执行，
  // npm 不会把"当前运行的 node 目录"加进生命周期 PATH，找不到 node 就报 "'node' 不是内部或外部命令"
  // → npm 退出码 1：更新失败，回滚走同一个 runNpm 也会一起失败。
  // 只在 nodeBin 是绝对路径时注入：裸 'node' 靠 PATH 自己解析，dirname 会得到 '.'（不该把当前目录塞进 PATH）。
  const nodeDir = nodeBin && path.isAbsolute(String(nodeBin)) ? path.dirname(String(nodeBin)) : ''
  const env = nodeDir
    ? Object.assign({}, process.env, { PATH: nodeDir + path.delimiter + (process.env.PATH || '') })
    : process.env
  return new Promise((resolve) => {
    let child = null
    try {
      if (npmCli) {
        child = spawn(nodeBin, [npmCli, ...fullArgs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      } else if (process.platform === 'win32') {
        const cmdLine = ['npm', ...fullArgs].map(quoteArg).join(' ')
        child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      } else {
        child = spawn('npm', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'], env })
      }
    } catch (err) {
      return resolve({ ok: false, error: err.message, stdout: '', stderr: '' })
    }
    let stdout = ''
    let stderr = ''
    const t = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, timeoutMs)
    child.stdout.on('data', (d) => { stdout += String(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => { clearTimeout(t); resolve({ ok: false, error: err.message, stdout, stderr }) })
    child.on('exit', (code) => {
      clearTimeout(t)
      resolve({ ok: code === 0, error: code === 0 ? '' : `npm 退出码 ${code}`, stdout, stderr })
    })
  })
}

function registries() {
  return Config.npmRegistry ? [Config.npmRegistry] : ['https://registry.npmmirror.com', null]
}

async function fetchLatest(nodeBin) {
  const channel = channelOf()
  lastFetchError = ''
  for (const registry of registries()) {
    const args = ['view', `@deepseek-ai/dsh@${channel}`, 'version']
    if (registry) args.push('--registry', registry)
    const r = await runNpm(args, { nodeBin })
    if (r.ok) {
      const line = String(r.stdout).trim().split(/\r?\n/)[0].trim()
      if (semver.valid(line)) return { version: line, registry, channel }
      log(`dsh-update: npm view 输出异常：${line || '(空)'}`)
      return null
    }
    lastFetchError = /404/.test(r.error || '') ? `渠道 ${channel} 暂无可用版本` : (r.error || '网络错误')
    log(`dsh-update: npm view 失败（registry=${registry || '默认'}, channel=${channel}）：${r.error}${registry ? '，回退官方源重试' : ''}`)
  }
  return null
}

// 全局 npm 更新：npm i -g --prefix <全局根> @deepseek-ai/dsh@<版本>（npmmirror 优先、官方回退）
// 用 install + 显式版本（而非 npm update）：幂等且指定精确目标版本，失败重试不会留下"半套"文件；
// 超时给足 25 分钟（慢速网络全量依赖树约 13 分钟，90s 默认超时会永远杀不掉大下载）。
async function runGlobalUpdate(nodeBin, globalRoot, version) {
  for (const registry of registries()) {
    const args = ['install', '-g', '--prefix', globalRoot, `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund']
    if (registry) args.push('--registry', registry)
    // 用当前环境 npm（用户级/系统均可）并显式指定全局根，确保落在与 npm i -g 相同的目录
    const r = await runNpm(args, { nodeBin, timeoutMs: 25 * 60 * 1000 })
    if (r.ok) return r
    log(`dsh-update: npm install -g 失败（registry=${registry || '默认'}）：${r.error}${registry ? '，回退官方源重试' : ''}`)
  }
  return { ok: false, error: '全局更新失败' }
}

async function runNpxWarm(latest, nodeBin) {
  // 预热 npx 缓存：npm exec 会把新版本装进 _npx 缓存并执行 --version（DSH 自带 --version 验证）
  return runNpm(['exec', '--yes', '--package', `@deepseek-ai/dsh@${latest}`, '--', 'dsh', '--version'], { nodeBin })
}

// ---------- 预热缓存（发现新版本后后台执行，纯尽力而为） ----------
// 把新版"完整依赖树"下载进 npm/npx 缓存：用户点"立即更新"时几乎不再走网络，秒级完成。
// 失败静默（只记日志）：不影响检测/更新主流程，下次检查发现新版时会重试。
async function warmLatest(latest, nodeBin, kind) {
  if (warming) return warming
  warming = (async () => {
    try {
      if (kind === 'npx') {
        await runNpxWarm(latest, nodeBin)
      } else {
        // managed / global：临时目录完整安装（--ignore-scripts 只拉包不跑构建），npm 共享缓存被灌满全依赖树
        const tmp = path.join(os.tmpdir(), 'dshl-dsh-warm')
        fs.mkdirSync(tmp, { recursive: true })
        let ok = false
        for (const registry of registries()) {
          const args = ['install', '--prefix', tmp, `@deepseek-ai/dsh@${latest}`, '--ignore-scripts', '--no-audit', '--no-fund']
          if (registry) args.push('--registry', registry)
          const r = await runNpm(args, { nodeBin, timeoutMs: 15 * 60 * 1000 })
          if (r.ok) { ok = true; break }
          log(`dsh-update: warm failed (registry=${registry || '默认'}): ${r.error}`)
        }
        if (!ok) throw new Error('npm 预热失败')
      }
      log(`dsh-update: warm cached v${latest} (kind=${kind})`)
      setState({ prewarmed: true })
    } catch (err) {
      log('dsh-update: warm error: ' + (err && err.message ? err.message : String(err)))
      setState({ prewarmed: false })
    } finally {
      warming = null
    }
  })()
  return warming
}

function waitForJob() {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const snap = envInstall.getJob()
      const status = snap && snap.job && snap.job.status
      if (status && status !== 'running') { clearInterval(iv); resolve(status) }
      if (Date.now() - t0 > JOB_WAIT_TIMEOUT_MS) { clearInterval(iv); resolve('timeout') }
    }, 2000)
  })
}

// ---------- 检测（静默，只提示不更新） ----------

// reason: 触发原因（'startup' / 'timer' / 'manual'）；force=true 跳过 24h 节流（设置页手动"检查更新"）
async function checkOnce(reason, force) {
  if (checking || updating) return
  if (!Config || !envDetect || !envInstall) return
  // 用户手动安装任务进行中时不打扰（手动检查除外）
  const snap = envInstall.getJob()
  if (!force && snap && snap.job && snap.job.status === 'running') {
    log('dsh-update: install job in progress, check skipped')
    return
  }
  const now = Date.now()
  if (!force && now - (Number(Config.dshUpdateCheckedAt) || 0) < CHECK_INTERVAL_MS) return
  checking = true
  setState({ status: 'checking' })
  try {
    const report = await envDetect.detectEnv(false)
    if (!report || !report.plan) {
      log('dsh-update: environment not ready, check skipped')
      setState(force ? { status: 'error', error: '运行环境未就绪，无法检查 DSH 更新' } : { status: 'idle' })
      return
    }
    const plan = report.plan
    const current = plan.dshVersion || ''
    if (!current) {
      log('dsh-update: installed version unknown, check skipped')
      setState(force ? { status: 'error', error: '已安装的 DSH 版本未知，无法检查' } : { status: 'idle' })
      return
    }
    const latest = await fetchLatest(plan.nodeCmd)
    Config.dshUpdateCheckedAt = now
    try { saveConfig() } catch { /* noop */ }
    if (!latest) {
      log('dsh-update: fetch latest failed, check aborted')
      setState(force ? { status: 'error', error: '检查失败：' + (lastFetchError || '无法获取最新版本（网络错误）') } : { status: 'idle' })
      return
    }
    // prevLatest 必须在 setState 之前取：setState 之后 state.latest 已经是新版本，
    // 再比就成了死比较（恒为 false），prewarmed 永远停在 true，新版本再也不会被预热。
    const prevLatest = state.latest
    setState({ current, latest: latest.version, kind: plan.kind, latestChannel: latest.channel || channelOf() })
    if (semver.gt(latest.version, current, { includePrerelease: true })) {
      log(`dsh-update: new version v${latest.version} available (current v${current}, kind=${plan.kind}, channel=${latest.channel || channelOf()}, reason=${reason || 'timer'})`)
      const newVersionSeen = prevLatest !== latest.version
      setState(Object.assign({ status: 'available' }, newVersionSeen ? { prewarmed: false } : {}))
      // 后台预热缓存（不阻塞检测）：点"立即更新"时依赖树已在 npm/npx 缓存里，秒级完成
      if (!state.prewarmed) void warmLatest(latest.version, plan.nodeCmd, plan.kind)
      // 手动检查不弹通知（控制台行内已有提示）；自动检查按版本跨重启去重：同一版本只提醒一次
      if (reason !== 'manual') {
        const claimed = claimAvailableNotice ? claimAvailableNotice(latest.version) : lastNotifiedVersion !== latest.version
        if (claimed) {
          lastNotifiedVersion = latest.version
          notify('DeepSeek Harness', plan.kind === 'source'
            ? `新版本 v${latest.version} 可用：当前为源码安装，请打开DSHL 控制台点"手动更新"（git pull && pnpm run build）`
            : `新版本 v${latest.version} 可用：打开DSHL 控制台点"立即更新"即可升级（npm 安装约 2-5 分钟）`)
        }
      }
    } else {
      log(`dsh-update: v${current} 已是最新（latest v${latest.version}）`)
      setState({ status: 'up-to-date' })
    }
  } catch (err) {
    log('dsh-update: check failed: ' + (err && err.message ? err.message : String(err)))
    setState(force ? { status: 'error', error: err && err.message ? err.message : String(err) } : { status: 'idle' })
  } finally {
    checking = false
  }
}

// ---------- 更新（仅用户点击触发；失败旧版不动、服务拉回） ----------

async function updateNow() {
  if (updating) return
  if (state.status !== 'available' && state.status !== 'error') {
    log(`dsh-update: updateNow ignored (status=${state.status})`)
    return
  }
  updating = true
  rollbackUsed = false // 每个更新周期最多一次回滚
  let txInfo = null // 事务信息（catch 里写终态用：区分"失败"与"被中断"）
  setState({ status: 'updating', error: '' })
  try {
    const report = await envDetect.detectEnv(false)
    if (!report || !report.plan) throw new Error('运行环境未就绪，无法更新')
    const plan = report.plan
    const latest = state.latest || ''
    const fromVersion = plan.dshVersion || ''
    // 准入判定必须在写更新事务状态之前：被拦下就不能留下 phase:'start'，
    // 否则下次启动会被 recoverInterruptedUpdate 当成"未完成的更新"重装一遍。
    const gate = decideUpdateTarget({
      target: latest,
      installed: fromVersion,
      targetChannel: state.latestChannel || '',
      currentChannel: channelOf(),
      userChoseChannel: userSwitchedChannel !== '' && userSwitchedChannel === channelOf(),
    })
    if (gate.action === 'block') {
      log(`dsh-update: update blocked (${gate.code}): ${gate.reason}`)
      emitLifecycle('update.dsh', { step: 'blocked', reason: gate.code, from: fromVersion, to: latest })
      setState({ status: 'error', error: gate.reason })
      return
    }
    // 非升级（用户显式切渠道导致的版本号下降）也要在通知里说清楚，绝不静默
    const nonUpgrade = gate.nonUpgrade === true
    if (nonUpgrade) log(`dsh-update: non-upgrade install allowed by explicit channel choice (v${fromVersion} → v${latest})`)
    // 更新事务状态：写入"从哪来"（回滚依据）
    try { writeUpdateState({ kind: plan.kind, from: fromVersion, to: latest, phase: 'start' }) } catch { /* noop */ }
    txInfo = { kind: plan.kind, from: fromVersion, to: latest }
    emitLifecycle('update.dsh', { step: 'start', from: fromVersion, to: latest, kind: plan.kind })
    let globalRootForRollback = ''

    const svc = getServerState ? getServerState() : { running: false }
    const wasRunning = svc.running

    if (plan.kind === 'managed') {
      // 托管形态：更新走统一引擎（内部优先全局 npm，失败回退托管），失败旧版不动
      if (loadWebTabs) loadWebTabs('update') // 页面切"正在更新…"说明页，避免更新期间白屏
      if (wasRunning) {
        log('dsh-update: stopping service before update')
        try { await stopService() } catch (err) { log('dsh-update: stop failed: ' + err.message) }
      }
      try {
        if (markProgress) markProgress('install')
        envInstall.startInstall(['dsh'], { dshVersion: latest, autoUpdate: true })
        const status = await waitForJob()
        if (status !== 'done') throw new Error(`更新任务未完成（${status}）`)
      } catch (err) {
        log(`dsh-update: managed update failed: ${err.message}`)
        if (wasRunning) {
          try { await startService() } catch { /* noop */ } // 旧版完好，直接拉回
          if (reloadWebTabs) reloadWebTabs() // 强制重载，把白屏/说明页拉回旧版页面
        }
        setState({ status: 'error', error: err.message })
        return
      }
      // 成功：安装引擎 onDone 已接好"重新探测 + 启动服务"。这里不再直接宣告成功——统一落到下面的
      // 共享校验块（服务是否真的起来、跑起来的版本是否等于目标），否则"装上了但起不来/版本没换"
      // 也会报"已更新"。
    }

    if (plan.kind === 'global') {
      // 全局 npm：必须先停服务再更新（npm update -g 会在服务运行中替换包文件，
      // 旧进程+新文件会触发 DSH HMR 导致页面白屏且无自愈路径）；
      // 更新期间窗口显示"正在更新…"说明页（带进度条），完成后强制重载为新版页面
      if (loadWebTabs) loadWebTabs('update')
      if (wasRunning) {
        log('dsh-update: stopping service before global update')
        try { await stopService() } catch (err) { log('dsh-update: stop failed: ' + err.message) }
      }
      const globalRoot = await envInstall.resolveGlobalRoot(plan.nodeCmd)
      globalRootForRollback = globalRoot
      if (markProgress) markProgress('install')
      const r = await runGlobalUpdate(plan.nodeCmd, globalRoot, latest)
      if (!r.ok) {
        if (wasRunning) {
          try { await startService() } catch { /* noop */ } // 旧版完好，直接拉回
          if (reloadWebTabs) reloadWebTabs()
        }
        throw new Error(r.error)
      }
    } else if (plan.kind === 'npx') {
      // npx 缓存：先迁移到全局 npm（统一渠道），失败回退 npx 预热
      if (loadWebTabs) loadWebTabs('update')
      if (wasRunning) {
        log('dsh-update: stopping service before migrate')
        try { await stopService() } catch (err) { log('dsh-update: stop failed: ' + err.message) }
      }
      let migrated = false
      try {
        if (markProgress) markProgress('install')
        envInstall.startInstall(['dsh'], { dshVersion: latest, autoUpdate: true })
        const status = await waitForJob()
        if (status !== 'done') throw new Error(`迁移任务未完成（${status}）`)
        migrated = true
      } catch (err) {
        log(`dsh-update: migrate-to-global failed, fallback npx warm: ${err.message}`)
        const r = await runNpxWarm(latest, plan.nodeCmd)
        if (!r.ok) {
          if (wasRunning) {
            try { await startService() } catch { /* noop */ }
            if (reloadWebTabs) reloadWebTabs()
          }
          throw new Error(r.error)
        }
      }
      // 迁移成功、或迁移失败但 npx 预热成功，都落到下面的共享校验块：
      // "npx 预热成功"不等于页面/命令真的用上了新版本，必须靠校验确认（migrated 仅用于日志措辞）。
      log(`dsh-update: npx path done (migratedToGlobal=${migrated})`)
    } else if (plan.kind === 'source') {
      // 源码安装：不动开发者仓库（UI 已把按钮换成"打开源码目录"，这里只兜底）
      throw new Error('源码安装请手动更新：git pull && pnpm run build（启动器不自动修改源码仓库）')
    } else if (plan.kind !== 'managed') {
      // managed 的成功路径不再提前 return，会落到这里继续走更新后校验
      throw new Error(`当前安装形态（${plan.kind}）不支持更新`)
    }

    // 重新探测 + 恢复服务（旧版已停止，拉起的是新版；含"已接管"服务——更新前已统一停掉）
    try { await refreshEnv(true) } catch (err) { log('dsh-update: refresh failed: ' + err.message) }
    // startService（main.handleStart）不抛错，靠返回值判定：false = 服务没起来（含环境未就绪/端口占用）
    let startOk = true
    if (wasRunning) {
      try { startOk = (await startService()) !== false } catch (err) { startOk = false; log('dsh-update: restart threw: ' + err.message) }
      if (!startOk) log('dsh-update: restart failed (handleStart returned false)')
      if (reloadWebTabs) reloadWebTabs() // 强制重载：新版页面替换旧会话，杜绝残留白屏
    } else if (loadWebTabs) {
      // 更新前服务没在运行：只有"现在也确实没起来"才切"未启动"说明页。
      // 托管形态走安装引擎，它的 onDone 会无条件拉起服务（更新前停着的也会被拉起来）；
      // 此时再切"服务未启动"就是在说谎（页面随后由 onDone 的 refreshWebUiOnReady 拉回真实页面）。
      const runningNow = !!(getServerState && getServerState().running)
      if (!runningNow) loadWebTabs('offline')
      else log('dsh-update: service is running after update (was stopped before), keeping page as-is')
    }
    // —— 更新事务校验：服务必须真的跑起来且版本对上，否则自动回滚（仅全局 npm 形态可回滚） ——
    let runningVersion = ''
    try {
      const re2 = await envDetect.detectEnv(false)
      runningVersion = re2 && re2.plan ? (re2.plan.dshVersion || '') : ''
    } catch { /* noop */ }
    const decision = decideRollback({ startOk, runningVersion, latest, fromVersion, kind: plan.kind, rollbackUsed })
    if (decision.action !== 'none') {
      if (decision.action === 'rollback') {
        rollbackUsed = true
        const why = decision.reason
        log(`dsh-update: v${latest} 启动失败/版本不符，回滚到 v${fromVersion} …（${why}）`)
        emitLifecycle('update.dsh', { step: 'rollback-start', from: fromVersion, to: latest, reason: why })
        const rb = await runGlobalUpdate(plan.nodeCmd, globalRootForRollback, fromVersion)
        if (rb.ok) {
          try { await refreshEnv(true) } catch { /* noop */ }
          if (wasRunning) {
            const ok2 = (await startService()) !== false
            if (reloadWebTabs) reloadWebTabs()
            log(`dsh-update: rollback restart ${ok2 ? 'ok' : 'failed'}`)
          }
          Config.dshVersion = fromVersion
          Config.dshUpdateCheckedAt = Date.now()
          try { saveConfig() } catch { /* noop */ }
          notify('DeepSeek Harness', `新版本 v${latest} 启动失败，已自动回滚到 v${fromVersion}（原配置不受影响；如仍异常请查看控制台日志）`)
          log(`dsh-update: rolled back to v${fromVersion}`)
          emitLifecycle('update.dsh', { step: 'rollback-ok', from: fromVersion, to: latest })
          setState({ status: 'error', error: `v${latest} 启动失败，已回滚到 v${fromVersion}` })
          try { clearUpdateState() } catch { /* noop */ }
          return
        }
        log('dsh-update: rollback failed: ' + (rb.error || ''))
        emitLifecycle('update.dsh', { step: 'rollback-failed', from: fromVersion, to: latest })
        notify('DeepSeek Harness', `DSH v${latest} 启动失败，回滚到 v${fromVersion} 也未成功；请手动执行：npm i -g --prefix "${globalRootForRollback}" @deepseek-ai/dsh@${fromVersion}，然后重新启动服务`)
        setState({ status: 'error', error: `v${latest} 启动失败，回滚也未成功（请查看控制台日志）` })
        try { clearUpdateState() } catch { /* noop */ }
        return
      }
      log(`dsh-update: post-update verification failed (start=${startOk}, runningVersion=${runningVersion || '?'})`)
      emitLifecycle('update.dsh', { step: 'verify-failed', start: startOk, runningVersion })
    }
    Config.dshVersion = 'latest'
    Config.dshUpdateCheckedAt = Date.now()
    try { saveConfig() } catch { /* noop */ }
    const outcome = decideUpdateOutcome({
      startOk,
      runningVersion,
      latest,
      from: fromVersion,
      nonUpgrade,
      hasToken: readPageCredential().hasToken,
    })
    if (!outcome.ok) {
      notify('DeepSeek Harness', outcome.message)
      log(`dsh-update: reported failure after install (${outcome.reason}, startOk=${startOk}, runningVersion=${runningVersion || '?'}, latest=${latest})`)
      emitLifecycle('update.dsh', { step: 'updated-start-failed', from: fromVersion, to: latest, kind: plan.kind, startOk, runningVersion })
      try { clearUpdateState() } catch { /* noop */ }
      setState({ status: 'error', error: outcome.message })
      return
    }
    notify('DeepSeek Harness', outcome.message)
    log(`dsh-update: updated to v${latest}${/凭据已变化/.test(outcome.message) ? ' (page credential changed)' : ''}`)
    emitLifecycle('update.dsh', { step: 'updated', from: fromVersion, to: latest, kind: plan.kind })
    try { clearUpdateState() } catch { /* noop */ }
    setState({ status: 'updated', current: latest })
  } catch (err) {
    log('dsh-update: update failed: ' + (err && err.message ? err.message : String(err)))
    emitLifecycle('update.dsh', { step: 'failed', error: ((err && err.message) || String(err)).slice(0, 128) })
    setState({ status: 'error', error: err && err.message ? err.message : String(err) })
    // 已明确失败（非被中断）：写终态，避免下次启动被自愈逻辑当成"未完成的更新"重装一遍
    if (txInfo) { try { writeUpdateState(Object.assign({}, txInfo, { phase: 'failed' })) } catch { /* noop */ } }
  } finally {
    updating = false
  }
}

module.exports = { initDshUpdater, checkOnce, updateNow, getState, warmLatest, decideRollback, decideUpdateTarget, decideUpdateOutcome, noteChannelChange, recoverInterruptedUpdate }
