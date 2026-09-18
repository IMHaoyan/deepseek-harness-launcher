// dsh-update.js — DSH 更新：检测全自动、更新全手动
// 策略（用户选定）：
//  - 静默检查最新版（节奏 = 启动后 15 秒一次 + 按渠道周期，由 main.js 按 checkTickMs() 武装的定时器执行：
//    alpha 1 小时 / latest 6 小时）；
//    模块内只剩一个 30 分钟"最小间隔地板"，防的是启动器被反复重启时每次启动都联网；发现新版 → 主页卡片 +
//    托盘气泡一次，绝不自动更新；
//  - 用户点击卡片"立即更新"后才执行更新（全局 npm：npm update -g --prefix 全局根，npmmirror 优先）；
//  - 托管形态走统一引擎（内部优先全局 npm，失败回退托管原子安装，失败旧版不动）；
//  - npx 形态先迁移到全局 npm 再更新（失败回退 npx 预热）；源码版仅提示；
//  - 全局形态发现新版即后台"预装"一整套可切换的安装树（见"预装与改名切换"节）：
//    点击更新时只做同卷目录改名（秒级），把 40s 的解包落盘挪到用户无感的检查阶段。
'use strict'
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const semver = require('semver')

// 检查的最小间隔地板 —— **不是**检查节奏（节奏是 main.js 按 checkTickMs() 武装的周期定时器）。
// 它只防一种情况：启动器被反复重启（dev 热重启 / 崩溃后重启 / 用户来回重启托盘）时，每次启动都联网查一遍；
// 离线时一次检查最坏要等两个源各 90 秒（见 fetchLatest 的 registry 回退），所以这道地板不能省。
// 必须显著小于**最短的那个** tick（alpha 的 1 小时）：tick 从进程启动开始计时、首次检查在 +15s，
// 地板一旦接近或等于 tick，就会把每个 tick 都挡在门外，节奏会悄悄翻倍
// —— tests/dsh-update-cadence.test.js 钉住了这条不变式。
const CHECK_MIN_GAP_MS = 30 * 60 * 1000

// 检查节奏：每个渠道一个 tick。alpha 发版快，1 小时；latest 维持 6 小时。
// 数字放在本模块而不是 main.js：节奏随渠道走，而渠道语义由本模块拥有（channelOf）——
// 两处各写一份「alpha 是几小时」迟早会分叉。main.js 只按本函数武装/重新武装定时器（含用户切渠道时）。
const CHECK_TICK_MS = { latest: 6 * 60 * 60 * 1000, alpha: 60 * 60 * 1000 }
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
  prewarmed: false, // 新版依赖树是否已就绪（npm/npx 缓存预热，或整树预装完成）
  staged: false, // 是否已预装出"可整目录顶上"的安装树（true 时点击更新只剩改名 + 重启服务）
  stageVersion: '', // 预装树对应的版本号（与 latest 不一致即视为无效）
}

let checking = false
let updating = false
let warming = null // 当前预热任务（防重入）
let staging = null // 已就绪的预装树：{ version, installDir, stagePkg, stagePrefix, stageRoot, binPath }
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

// 当前渠道的检查周期。查不到就回落到 latest：宁可少查，也不能让脏配置把周期变成 undefined
// （setInterval(fn, undefined) 等价于 0 延迟，会把检查变成疯转）。
function checkTickMs() {
  return CHECK_TICK_MS[channelOf()] || CHECK_TICK_MS.latest
}

function emitLifecycle(event, detail) {
  try { if (lifecycleEmit) lifecycleEmit(event, detail) } catch { /* noop */ }
}

// 更新事务状态：写入/清空（best-effort，仅用于诊断与回滚依据）
// 返回值表示"是否真的落盘"：改名切换前的那次写入必须成功，否则崩溃在两次改名之间就没有修复凭据。
function writeUpdateState(value) {
  if (!statePath) return false
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(Object.assign({ updatedAt: new Date().toISOString() }, value), null, 2))
    return true
  } catch (e) { log('dsh-update: state write failed: ' + (e && e.message ? e.message : String(e))); return false }
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

/**
 * 改名切换事务的恢复：按文件系统事实决定收场方式（补完 / 退回 / 无需修复）。
 * 崩在两次改名之间时安装目录会短暂不存在 —— 但旧树与预装树至少有一个还在，改名就能救回来。
 * 返回 null 表示"改名救不了"，交给原来的重装路径。
 */
async function recoverSwapTransaction(st, nodeBin, ctx) {
  const installDir = String(st.installDir || '')
  const backupDir = String(st.backupDir || '')
  const stagePkg = String(st.stagePkg || '')
  const target = String(ctx.to || '')
  if (!installDir || !backupDir) return null
  const installed = readPkgAt(installDir)
  const staged = stagePkg ? readPkgAt(stagePkg) : null
  const probe = staged ? await probeDshVersion(nodeBin, path.join(stagePkg, 'lib', 'bin.js')) : ''
  const decided = decideSwapRecovery({
    target,
    installVersion: installed ? installed.version : '',
    backupExists: fs.existsSync(backupDir),
    stagedPkgExists: !!staged,
    stagedVersion: staged ? staged.version : '',
    probeVersion: probe,
  })
  const stageRoot = stageRootOf(installDir)
  const finish = (payload) => {
    try { clearUpdateState() } catch { /* noop */ }
    if (!warming) cleanupStage(stageRoot, '')
    return payload
  }
  if (decided.action === 'done') {
    log('dsh-update: 上次的改名切换其实已完成，只清理事务与暂存残留')
    emitLifecycle('update.dsh', { step: 'interrupted-swap-done', from: ctx.from, to: target })
    return finish({ recovered: true, to: target, mode: 'swap-done' })
  }
  if (decided.action === 'intact') {
    // 切换还没开始，安装目录完好（旧版可用）：不动它，也不谎称"已修复"
    log(`dsh-update: 上次的切换尚未开始（安装目录为 v${installed.version}），无需修复`)
    emitLifecycle('update.dsh', { step: 'interrupted-swap-idle', from: ctx.from, to: target })
    return finish({ recovered: false, reason: 'swap-not-started' })
  }
  if (decided.action === 'complete') {
    try {
      fs.mkdirSync(path.dirname(installDir), { recursive: true }) // 作用域目录可能已随旧树一起被移走
      if (installed) fs.renameSync(installDir, path.join(path.dirname(backupDir), 'rejected-' + Date.now()))
      fs.renameSync(stagePkg, installDir)
    } catch (err) {
      log('dsh-update: 补完切换失败，改用重装：' + ((err && err.message) || String(err)))
      return null
    }
    log(`dsh-update: 上次未完成的切换已补完 → v${target}`)
    emitLifecycle('update.dsh', { step: 'interrupted-swap-completed', from: ctx.from, to: target })
    notify('DeepSeek Harness', `上次未完成的 DSH 更新已补完（v${target}）`)
    return finish({ recovered: true, to: target, mode: 'swap-completed' })
  }
  if (decided.action === 'restore') {
    const r = await restoreSwap({ installDir, backupDir }, nodeBin)
    if (!r.ok) {
      log('dsh-update: 退回旧树失败，改用重装：' + (r.error || ''))
      return null
    }
    log(`dsh-update: 预装树不可用，已退回原来的 v${r.version || '?'}`)
    emitLifecycle('update.dsh', { step: 'interrupted-swap-restored', from: ctx.from, to: target })
    notify('DeepSeek Harness', `上次 DSH 更新未完成，已退回原来的 v${r.version || ctx.from || '旧版本'}`)
    return finish({ recovered: false, reason: 'rolled-back', to: r.version })
  }
  return null // fallback：安装目录丢了又没有备份，只能重装
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
  let nodeBin = 'node'
  try {
    const r = await envDetect.detectEnv(false)
    if (r && r.plan) nodeBin = r.plan.nodeCmd || 'node'
  } catch { /* 用默认 node */ }
  // 改名切换事务：改名是 O(1) 的，先按文件系统事实收场，能不重装就不重装
  if (st.swap && st.installDir) {
    const handled = await recoverSwapTransaction(st, nodeBin, { from, to })
    if (handled) return handled
    log('dsh-update: 改名切换事务无法就地修复，改用重装路径')
  }
  notify('DeepSeek Harness', `上次 DSH 更新未完成（${from || '?'} → ${to}），正在自动修复…`)
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
  staging = null // 旧渠道的预装树作废（暂存目录名是版本号，下次检查会自己清场）
  setState({ status: 'idle', error: '', latest: '', latestChannel: '', prewarmed: false, staged: false, stageVersion: '' })
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
  if (Config.npmRegistry) return [Config.npmRegistry] // 用户显式指定：只认它（保持原行为）
  const order = ['https://registry.npmmirror.com', null]
  const ok = String(Config.dshRegistryOk || '')
  // 'default' 是"不带 --registry、用 npm 自身配置的源"的记号（null 与 '' 在数组里不好比较）
  const preferred = ok === 'default' ? null : ok
  if (preferred === '' || !order.some((r) => r === preferred)) return order
  return [preferred, ...order.filter((r) => r !== preferred)]
}

// 记住"上次真正成功的源"，下次把它提到最前：省掉每次先试一个不通用源的固定损耗。
// 只在成功时写（失败不写）——绝不把坏源记成首选。
function noteRegistryOk(registry) {
  const val = registry || 'default'
  if (!Config || Config.dshRegistryOk === val) return
  Config.dshRegistryOk = val
  try { saveConfig() } catch { /* 记不上不影响本次安装 */ }
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
      if (semver.valid(line)) { noteRegistryOk(registry); return { version: line, registry, channel } }
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
// --prefer-offline：目标版本是显式钉死的，缓存命中时省掉元数据往返；注意**不能**加给 `npm view`
// （那会把"最新版"读成缓存里的旧值，检测直接失效）。
async function runGlobalUpdate(nodeBin, globalRoot, version) {
  for (const registry of registries()) {
    const args = ['install', '-g', '--prefix', globalRoot, `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund', '--prefer-offline']
    if (registry) args.push('--registry', registry)
    // 用当前环境 npm（用户级/系统均可）并显式指定全局根，确保落在与 npm i -g 相同的目录
    const r = await runNpm(args, { nodeBin, timeoutMs: 25 * 60 * 1000 })
    if (r.ok) { noteRegistryOk(registry); return r }
    log(`dsh-update: npm install -g 失败（registry=${registry || '默认'}）：${r.error}${registry ? '，回退官方源重试' : ''}`)
  }
  return { ok: false, error: '全局更新失败' }
}

async function runNpxWarm(latest, nodeBin) {
  // 预热 npx 缓存：npm exec 会把新版本装进 _npx 缓存并执行 --version（DSH 自带 --version 验证）
  return runNpm(['exec', '--yes', '--package', `@deepseek-ai/dsh@${latest}`, '--', 'dsh', '--version'], { nodeBin })
}

// ---------- 预装（staging）与改名切换 ----------
// 为什么需要：只把 tarball 灌进 npm 缓存（旧的 warmLatest）省掉的是"下载"，省不掉"解包落盘"——
// npm install -g 每次都要把整棵树重新写一遍（实测 213MB / 2.5 万个文件 ≈ 40s），这才是更新慢的主因
// （对照：缓存已热时重铺仍是 40s；同 prefix 重装同版本 1.5s）。
// 做法：发现新版本时用**与线上完全相同的命令**（npm install -g --prefix <暂存 prefix>）在后台装好一整套
// 包目录，点击更新时只做同卷目录改名（实测 0.04s），把那 40s 挪到用户无感的检查阶段。
// 三条硬约束（任一条错了都会"切完起不来"）：
//   1) 暂存 prefix 必须与全局根同卷（由 installDir 反推），跨卷改名会退化成整树拷贝；
//   2) 暂存的包目录布局必须与线上同构 —— 所以用同一条 -g 命令，而不是 --install-strategy=nested
//      （后者不做去重，实测树会从 213MB 膨胀到 592MB，等于给用户永久加 2.8 倍磁盘占用）；
//   3) 顶上之前必须探测（--version）确认新树真能跑；bin 入口布局变了就不切，退回完整安装。
const STAGE_DIR_NAME = '.dshl-stage'
const STAGE_TIMEOUT_MS = 25 * 60 * 1000

/** 从已安装包目录反推 npm 前缀：<prefix>/node_modules/@deepseek-ai/dsh → <prefix>；形态不符返回 ''。 */
function npmPrefixOf(installDir) {
  const dir = String(installDir || '')
  if (!dir) return ''
  const scopeDir = path.dirname(dir) // <prefix>/node_modules/@deepseek-ai（注意作用域目录还要再上一层）
  const nmDir = path.dirname(scopeDir) // <prefix>/node_modules
  return path.basename(nmDir) === 'node_modules' ? path.dirname(nmDir) : ''
}

/** 暂存根目录：与安装目录同卷（都由 installDir 反推）。 */
function stageRootOf(installDir) {
  const prefix = npmPrefixOf(installDir)
  return prefix ? path.join(prefix, STAGE_DIR_NAME) : ''
}

/**
 * 暂存/切换路径规划（纯函数）。备份目录按版本号确定性命名 —— 同一版本在任何一次调用里都必须算出
 * 同一条路径，否则"事务里记的备份路径"和"实际改名的路径"会对不上，崩溃恢复就找不到旧树了。
 * （同名的旧备份在切换前会被删掉，不会互相顶替。）
 */
function planSwapPaths(input) {
  const src = input || {}
  const installDir = String(src.installDir || '')
  const version = String(src.version || '')
  const stageRoot = stageRootOf(installDir)
  if (!stageRoot || !semver.valid(version)) return null
  const stagePrefix = path.join(stageRoot, version)
  return {
    prefix: npmPrefixOf(installDir),
    stageRoot,
    stagePrefix,
    stagePkg: path.join(stagePrefix, 'node_modules', '@deepseek-ai', 'dsh'),
    backupDir: path.join(stageRoot, 'old-' + version),
  }
}

/**
 * 预装树可用性判定（纯函数）：只有"版本对得上 + 探测跑得起来 + bin 布局没变"才允许顶上。
 * @returns {{action:'use'} | {action:'discard', reason:string}}
 */
function decideStagedInstall(input) {
  const src = input || {}
  const target = String(src.targetVersion || '')
  if (!target) return { action: 'discard', reason: 'no-target' }
  if (src.installDirExists !== true) return { action: 'discard', reason: 'no-install-dir' }
  if (src.stagedPkgExists !== true) return { action: 'discard', reason: 'staging-incomplete' }
  if (String(src.stagedVersion || '') !== target) return { action: 'discard', reason: 'staged-version-mismatch' }
  if (String(src.probeVersion || '') !== target) return { action: 'discard', reason: 'probe-failed' }
  // 线上 .bin 的 shim 指向包内相对路径；bin 入口布局变了，换目录就会让 shim 失效
  if (src.installedBinLayout && String(src.stagedBinLayout || '') !== String(src.installedBinLayout)) {
    return { action: 'discard', reason: 'bin-layout-changed' }
  }
  return { action: 'use', reason: '' }
}

/**
 * 中断事务的切换恢复判定（纯函数）：按文件系统事实决定怎么收场，不猜。
 * @returns {{action:'done'|'complete'|'restore'|'intact'|'fallback', reason:string}}
 */
function decideSwapRecovery(input) {
  const src = input || {}
  const target = String(src.target || '')
  const installed = String(src.installVersion || '')
  if (target && installed === target) return { action: 'done', reason: 'swap-completed' }
  if (src.backupExists === true) {
    const usable = src.stagedPkgExists === true
      && String(src.stagedVersion || '') === target
      && String(src.probeVersion || '') === target
    return usable ? { action: 'complete', reason: 'staged-usable' } : { action: 'restore', reason: 'staged-unusable' }
  }
  // 安装目录还在（只是还没换到目标版本）→ 切换根本没开始，旧版完好，什么都别动
  if (installed) return { action: 'intact', reason: 'swap-not-started' }
  return { action: 'fallback', reason: 'install-missing' }
}

/** 过期暂存目录选择（纯函数）：只认版本号目录与 old-/rejected- 备份，其余名字一律不碰（不误删）。 */
function staleStageEntries(names, keep) {
  const k = String(keep || '')
  return (names || []).filter((n) => typeof n === 'string' && n && n !== k
    && (!!semver.valid(n) || /^(old|rejected)-/.test(n)))
}

/** 读取某个目录下的 @deepseek-ai/dsh 包信息；非本包/不可读返回 null。 */
function readPkgAt(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (!pkg || pkg.name !== '@deepseek-ai/dsh') return null
    const bin = pkg.bin
    const binLayout = typeof bin === 'string'
      ? 'string:' + bin
      : (bin && typeof bin === 'object' ? Object.keys(bin).sort().map((k) => k + '=' + String(bin[k])).join(',') : '')
    return { version: String(pkg.version || ''), binLayout }
  } catch { return null }
}

/** 探测：用指定 node 跑一次 dsh --version（实测 0.14s，足够做"新树能不能跑"的门禁）。 */
function probeDshVersion(nodeBin, binPath) {
  return new Promise((resolve) => {
    if (!binPath || !fs.existsSync(binPath)) return resolve('')
    let child = null
    try {
      child = spawn(nodeBin || 'node', [binPath, '--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { return resolve('') }
    let out = ''
    const t = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 30000)
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', () => { clearTimeout(t); resolve('') })
    child.on('exit', () => { clearTimeout(t); resolve(String(out).trim().split(/\r?\n/)[0].trim()) })
  })
}

/** 清理暂存目录：删掉 keep 之外的版本目录与 old-/rejected- 备份，返回删掉的名字。 */
function cleanupStage(stageRoot, keep) {
  if (!stageRoot) return []
  let names = []
  try { names = fs.readdirSync(stageRoot) } catch { return [] }
  const removed = []
  for (const name of staleStageEntries(names, keep)) {
    try { fs.rmSync(path.join(stageRoot, name), { recursive: true, force: true }); removed.push(name) } catch { /* 删不掉下次再删 */ }
  }
  return removed
}

/** 后台预装：把目标版本完整装进暂存 prefix 并探测确认可用。只为全局形态服务。 */
async function stageLatest(version, nodeBin, kind, installDir) {
  // 托管形态有 env-install 自己的原子安装，npx 形态没有可切换的目录：都不走这里
  if (kind !== 'global') return { ok: false, reason: 'kind-' + (kind || 'unknown') }
  const paths = planSwapPaths({ installDir, version })
  if (!paths) return { ok: false, reason: 'no-install-dir' }
  const installed = readPkgAt(installDir)
  if (!installed) return { ok: false, reason: 'installed-pkg-unreadable' }
  try {
    fs.rmSync(paths.stagePrefix, { recursive: true, force: true }) // 清掉上次的半成品
    fs.mkdirSync(paths.stagePrefix, { recursive: true })
  } catch (err) {
    return { ok: false, reason: 'stage-not-writable: ' + ((err && err.message) || String(err)) }
  }
  cleanupStage(paths.stageRoot, version) // 其他版本的暂存已过期
  let last = { ok: false, error: '未执行' }
  for (const registry of registries()) {
    const args = ['install', '-g', '--prefix', paths.stagePrefix, `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund', '--prefer-offline']
    if (registry) args.push('--registry', registry)
    last = await runNpm(args, { nodeBin, timeoutMs: STAGE_TIMEOUT_MS })
    if (last.ok) { noteRegistryOk(registry); break }
    log(`dsh-update: stage install failed (registry=${registry || '默认'}): ${last.error}`)
  }
  if (!last.ok) {
    try { fs.rmSync(paths.stagePrefix, { recursive: true, force: true }) } catch { /* noop */ }
    return { ok: false, reason: last.error || 'npm 预装失败' }
  }
  const staged = readPkgAt(paths.stagePkg)
  const probe = staged ? await probeDshVersion(nodeBin, path.join(paths.stagePkg, 'lib', 'bin.js')) : ''
  const decided = decideStagedInstall({
    targetVersion: version,
    installDirExists: fs.existsSync(installDir),
    stagedPkgExists: !!staged,
    stagedVersion: staged ? staged.version : '',
    probeVersion: probe,
    stagedBinLayout: staged ? staged.binLayout : '',
    installedBinLayout: installed.binLayout,
  })
  if (decided.action !== 'use') {
    log(`dsh-update: staged tree rejected (${decided.reason})：退回完整安装路径`)
    try { fs.rmSync(paths.stagePrefix, { recursive: true, force: true }) } catch { /* noop */ }
    return { ok: false, reason: decided.reason }
  }
  staging = {
    version,
    installDir,
    stagePkg: paths.stagePkg,
    stagePrefix: paths.stagePrefix,
    stageRoot: paths.stageRoot,
    binPath: path.join(paths.stagePkg, 'lib', 'bin.js'),
  }
  log(`dsh-update: staged v${version} ready（点击更新只需改名切换）：${paths.stagePkg}`)
  setState({ prewarmed: true, staged: true, stageVersion: version })
  return { ok: true, version }
}

/**
 * 改名切换：旧树让位 → 预装树顶上 → 探测。任一步失败都把旧树改回来（旧版完好是最低要求）。
 * 调用方必须已经停掉服务：Windows 上跑着的进程会锁住文件，改名会失败。
 */
async function swapStagedInto(input) {
  const src = input || {}
  const installDir = String(src.installDir || '')
  const version = String(src.version || '')
  const nodeBin = src.nodeBin || 'node'
  const info = src.info || staging // info 可注入：测试用真实目录演练切换，不依赖后台预装
  if (!info || !version || info.version !== version || info.installDir !== installDir) return { ok: false, reason: 'no-staged-tree' }
  const paths = planSwapPaths({ installDir, version })
  if (!paths) return { ok: false, reason: 'no-install-dir' }
  // 顶上之前再判一次（预装到现在之间磁盘上可能被别的东西改过）
  const installed = readPkgAt(installDir)
  const staged = readPkgAt(paths.stagePkg)
  const probe = staged ? await probeDshVersion(nodeBin, path.join(paths.stagePkg, 'lib', 'bin.js')) : ''
  const decided = decideStagedInstall({
    targetVersion: version,
    installDirExists: fs.existsSync(installDir),
    stagedPkgExists: !!staged,
    stagedVersion: staged ? staged.version : '',
    probeVersion: probe,
    stagedBinLayout: staged ? staged.binLayout : '',
    installedBinLayout: installed ? installed.binLayout : '',
  })
  if (decided.action !== 'use') {
    staging = null
    setState({ staged: false, stageVersion: '' })
    return { ok: false, reason: decided.reason }
  }
  // 记事务（含切换路径）必须在第一次改名之前落盘：崩在两次改名之间时安装目录会短暂不存在，
  // recoverInterruptedUpdate 全靠这份凭据把旧树改名回来。
  const txOk = writeUpdateState({
    kind: 'global',
    from: String(src.from || ''),
    to: version,
    phase: 'start',
    swap: true,
    installDir,
    stagePkg: paths.stagePkg,
    stagePrefix: paths.stagePrefix,
    backupDir: paths.backupDir,
  })
  if (!txOk) return { ok: false, reason: 'tx-state-unwritable' }
  const t0 = Date.now()
  try {
    fs.rmSync(paths.backupDir, { recursive: true, force: true })
    fs.renameSync(installDir, paths.backupDir) // 旧树让位（同卷改名，O(1)）
  } catch (err) {
    return { ok: false, reason: 'rename-out-failed: ' + ((err && err.message) || String(err)) }
  }
  try {
    fs.renameSync(paths.stagePkg, installDir) // 预装树顶上（同卷改名，O(1)）
  } catch (err) {
    try { fs.renameSync(paths.backupDir, installDir) } catch { /* 连回退改名也失败：留给 recoverInterruptedUpdate 按事务状态修 */ }
    return { ok: false, reason: 'rename-in-failed: ' + ((err && err.message) || String(err)) }
  }
  // 改名成功 ≠ 新树能跑：立刻探测，不过就把旧树改回来
  const after = await probeDshVersion(nodeBin, path.join(installDir, 'lib', 'bin.js'))
  if (after !== version) {
    const back = await restoreSwap({ installDir, backupDir: paths.backupDir }, nodeBin)
    log(`dsh-update: post-swap probe failed (${after || '空'})，改名回退 ${back.ok ? 'ok' : 'failed'}`)
    return { ok: false, reason: 'post-swap-probe-failed' }
  }
  staging = null
  setState({ staged: false, stageVersion: '' })
  return { ok: true, ms: Date.now() - t0, installDir, backupDir: paths.backupDir, stageRoot: paths.stageRoot, installVersion: version }
}

/** 切换回退：新树退回暂存目录（保留现场供诊断），旧树改名回原位。 */
async function restoreSwap(state, nodeBin) {
  const installDir = state && state.installDir
  const backupDir = state && state.backupDir
  if (!installDir || !backupDir) return { ok: false, error: '缺少切换路径' }
  const rejected = path.join(path.dirname(backupDir), 'rejected-' + Date.now())
  try {
    // 恢复路径要自己保证落点存在：崩在两次改名之间时，作用域目录也可能一起没了
    fs.mkdirSync(path.dirname(installDir), { recursive: true })
    if (fs.existsSync(installDir)) fs.renameSync(installDir, rejected)
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) } }
  try {
    fs.renameSync(backupDir, installDir)
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) } }
  const probed = await probeDshVersion(nodeBin || 'node', path.join(installDir, 'lib', 'bin.js'))
  return { ok: true, version: probed, rejected }
}

/** 切换成功后的收尾：删掉旧树备份与暂存残留（正在预装的那份不能碰）。 */
function finalizeSwap(state) {
  if (!state || !state.installDir) return
  try { fs.rmSync(state.backupDir, { recursive: true, force: true }) } catch { /* 删不掉不影响 */ }
  if (!warming) cleanupStage(state.stageRoot, '')
}

// ---------- 后台就绪（发现新版本后执行，纯尽力而为，失败静默） ----------
// 全局形态：预装一整套可切换的安装树（见上节）——点击更新只剩改名 + 重启服务；
// 预装失败退回旧的"灌 npm 缓存"路径，行为与从前一致。
// 托管/npx 形态：仍只预热缓存（托管有 env-install 自己的原子安装，npx 没有可切换的目录）。
async function warmLatest(latest, nodeBin, kind, installDir) {
  if (warming) return warming
  warming = (async () => {
    try {
      if (kind === 'global' && installDir) {
        const r = await stageLatest(latest, nodeBin, kind, installDir)
        if (r.ok) return
        // 缓存已经热过就别重复灌一遍（每次检查都会重试预装，失败原因通常不在缓存上）
        if (state.prewarmed) return
        log('dsh-update: staging unavailable (' + r.reason + ')，退回缓存预热')
      }
      if (kind === 'npx') {
        await runNpxWarm(latest, nodeBin)
      } else {
        // managed / global 兜底：临时目录完整安装（--ignore-scripts 只拉包不跑构建），npm 共享缓存被灌满全依赖树
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

// reason: 触发原因（'startup' / 'timer' / 'manual'）；force=true 跳过最小间隔地板（设置页手动"检查更新"）
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
  const sinceLastCheck = now - (Number(Config.dshUpdateCheckedAt) || 0)
  if (!force && sinceLastCheck < CHECK_MIN_GAP_MS) {
    // 被地板挡掉的那次要留痕：否则日志里"没查"和"查了说没事"长得一模一样，检查频率只能靠猜
    log(`dsh-update: 距上次检查 ${Math.round(sinceLastCheck / 60000)} 分钟（地板 ${CHECK_MIN_GAP_MS / 60000} 分钟），本次 ${reason || 'startup'} 检查跳过`)
    return
  }
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
    // 记的是"上次尝试"而不是"上次成功"：写在判空之前，取版本失败也落盘。
    // 这样离线时反复重启启动器不会每次都去等两个源各 90 秒；失败的重试机会落在地板到期后的下一次
    // 启动检查或下一个周期 tick 上（alpha 1 小时 / latest 6 小时；把这次写入挪到判空之后会拆掉地板的这层保护）。
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
    const installDir = (report.dsh && report.dsh.dir) || ''
    if (semver.gt(latest.version, current, { includePrerelease: true })) {
      log(`dsh-update: new version v${latest.version} available (current v${current}, kind=${plan.kind}, channel=${latest.channel || channelOf()}, reason=${reason || 'timer'})`)
      const newVersionSeen = prevLatest !== latest.version
      // 换了目标版本：上一版的预装树作废（暂存目录名就是版本号，stageLatest 会自己清场）
      if (newVersionSeen) staging = null
      setState(Object.assign({ status: 'available' }, newVersionSeen ? { prewarmed: false, staged: false, stageVersion: '' } : {}))
      // 后台就绪（不阻塞检测）：全局形态预装一整套可切换的安装树，点击"立即更新"时只剩改名 + 重启服务。
      // 仅缓存预热过（prewarmed 但没 staged）时也再试一次预装——预装失败过不该永久放弃。
      if (!state.prewarmed || (plan.kind === 'global' && installDir && !state.staged)) {
        void warmLatest(latest.version, plan.nodeCmd, plan.kind, installDir)
      }
      // 手动检查不弹通知（控制台行内已有提示）；自动检查按版本跨重启去重：同一版本只提醒一次。
      // 通知里不给耗时承诺：点击那一刻的耗时取决于预装是否已完成，具体秒数在按钮 tooltip 上按状态给。
      if (reason !== 'manual') {
        const claimed = claimAvailableNotice ? claimAvailableNotice(latest.version) : lastNotifiedVersion !== latest.version
        if (claimed) {
          lastNotifiedVersion = latest.version
          notify('DeepSeek Harness', plan.kind === 'source'
            ? `新版本 v${latest.version} 可用：当前为源码安装，请打开DSHL 控制台点"手动更新"（git pull && pnpm run build）`
            : `新版本 v${latest.version} 可用：点右上角「有更新」或控制台「立即更新」即可升级（会重启服务，进行中的对话会中断）`)
        }
      }
    } else {
      log(`dsh-update: v${current} 已是最新（latest v${latest.version}）`)
      setState({ status: 'up-to-date' })
      // 已是最新：暂存目录里剩下的都是过期物（含切换失败留下的 rejected-*），顺手清掉。
      // 正在预装时不动（那份还在写盘，删了只会让本次预装白跑）。
      if (!warming) cleanupStage(stageRootOf(installDir), '')
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
    let swapState = null // 改成名切换成功后留下的切换现场（回滚/收尾都按它走）

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
      // 首选：把后台预装好的整棵树改名顶上（实测 0.04s，替掉 40s 的解包落盘）
      const installDir = (report.dsh && report.dsh.dir) || ''
      const sw = await swapStagedInto({ nodeBin: plan.nodeCmd, installDir, version: latest, from: fromVersion })
      if (sw.ok) {
        swapState = sw
        log(`dsh-update: staged swap ok in ${sw.ms}ms（备份保留至校验/回滚结束）：${sw.backupDir}`)
      } else {
        // 没有预装树（用户点得太快 / 预装失败 / 被渠道切换作废）→ 退回完整安装，行为与从前一致
        if (sw.reason !== 'no-staged-tree') log('dsh-update: staged swap unavailable (' + sw.reason + ')，改用 npm install -g')
        const r = await runGlobalUpdate(plan.nodeCmd, globalRoot, latest)
        if (!r.ok) {
          if (wasRunning) {
            try { await startService() } catch { /* noop */ } // 旧版完好，直接拉回
            if (reloadWebTabs) reloadWebTabs()
          }
          throw new Error(r.error)
        }
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
        // 改名切换过的：旧树还在暂存目录里，改名回来就是回滚（省掉一次重装旧版的 40s）
        const rb = swapState
          ? await restoreSwap(swapState, plan.nodeCmd)
          : await runGlobalUpdate(plan.nodeCmd, globalRootForRollback, fromVersion)
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
        // 改名回退也可能只做了一半：此时安装目录可能不存在，事务状态就是唯一的修复凭据，不能清
        if (!swapState) { try { clearUpdateState() } catch { /* noop */ } }
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
      // 还没回滚过、且手上就有旧树（改名切换留下的备份）→ 直接恢复：
      // 让用户面对一个"起不来的新版"没有意义。decideRollback 只在"知道旧版本号"时才给回滚动作，
      // 拿不到旧版本号（fromVersion 为空）的场景在这里补上。
      if (swapState && !rollbackUsed) {
        rollbackUsed = true
        log(`dsh-update: ${outcome.reason}，用改名把旧树恢复回来 …`)
        emitLifecycle('update.dsh', { step: 'rollback-start', from: fromVersion, to: latest, reason: outcome.reason })
        const rb = await restoreSwap(swapState, plan.nodeCmd)
        if (rb.ok) {
          try { await refreshEnv(true) } catch { /* noop */ }
          if (wasRunning) {
            try { await startService() } catch { /* noop */ }
            if (reloadWebTabs) reloadWebTabs()
          }
          const backVersion = rb.version || fromVersion || '旧版本'
          log(`dsh-update: restored previous tree (v${backVersion})`)
          emitLifecycle('update.dsh', { step: 'rollback-ok', from: fromVersion, to: latest, mode: 'swap' })
          notify('DeepSeek Harness', `DSH v${latest} 未能确认更新成功（${outcome.reason}），已恢复原来的 v${backVersion}`)
          setState({ status: 'error', error: `v${latest} 未生效，已恢复 v${backVersion}` })
          try { clearUpdateState() } catch { /* noop */ }
          return
        }
        // 恢复本身也可能只做了一半：把事务留在盘上，交给下次启动的 recoverInterruptedUpdate
        log('dsh-update: restore by rename failed（保留更新事务，交给下次启动修复）: ' + (rb.error || ''))
        notify('DeepSeek Harness', outcome.message + '；已保留更新事务，重启启动器会自动修复')
        setState({ status: 'error', error: outcome.message })
        return
      }
      notify('DeepSeek Harness', outcome.message)
      log(`dsh-update: reported failure after install (${outcome.reason}, startOk=${startOk}, runningVersion=${runningVersion || '?'}, latest=${latest})`)
      emitLifecycle('update.dsh', { step: 'updated-start-failed', from: fromVersion, to: latest, kind: plan.kind, startOk, runningVersion })
      // 新版已经顶上但没确认成功：备份留着（路径已记日志），不在这里删，给人工退路
      if (!swapState) { try { clearUpdateState() } catch { /* noop */ } }
      setState({ status: 'error', error: outcome.message })
      return
    }
    notify('DeepSeek Harness', outcome.message)
    log(`dsh-update: updated to v${latest}${/凭据已变化/.test(outcome.message) ? ' (page credential changed)' : ''}`)
    emitLifecycle('update.dsh', { step: 'updated', from: fromVersion, to: latest, kind: plan.kind })
    finalizeSwap(swapState) // 更新确认成功：删掉旧树备份与暂存残留
    try { clearUpdateState() } catch { /* noop */ }
    setState({ status: 'updated', current: latest })
  } catch (err) {
    log('dsh-update: update failed: ' + (err && err.message ? err.message : String(err)))
    emitLifecycle('update.dsh', { step: 'failed', error: ((err && err.message) || String(err)).slice(0, 128) })
    setState({ status: 'error', error: err && err.message ? err.message : String(err) })
    // 已明确失败（非被中断）：写终态，避免下次启动被自愈逻辑当成"未完成的更新"重装一遍。
    // 但改名切换事务不能标 failed —— 下次启动要靠它判断"补完 / 退回"。
    if (txInfo && !swapState) { try { writeUpdateState(Object.assign({}, txInfo, { phase: 'failed' })) } catch { /* noop */ } }
  } finally {
    updating = false
  }
}

module.exports = {
  initDshUpdater,
  checkOnce,
  checkTickMs,
  updateNow,
  getState,
  warmLatest,
  decideRollback,
  decideUpdateTarget,
  decideUpdateOutcome,
  // 预装/改名切换（纯函数，供测试直接验证判定逻辑）
  npmPrefixOf,
  stageRootOf,
  planSwapPaths,
  decideStagedInstall,
  decideSwapRecovery,
  staleStageEntries,
  // 切换动作本身也导出：测试用真实目录演练"顶上 / 退回"，而不是只测判定
  swapStagedInto,
  restoreSwap,
  noteChannelChange,
  recoverInterruptedUpdate,
}
