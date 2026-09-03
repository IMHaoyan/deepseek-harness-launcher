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
const semver = require('semver')

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 检查节流：24 小时
const JOB_WAIT_TIMEOUT_MS = 20 * 60 * 1000 // 安装任务最长等待：20 分钟

let Config = null
let saveConfig = null
let log = () => {}
let notify = () => {}
let refreshEnv = null
let envInstall = null
let envDetect = null
let getServerState = null // () => ({ running, owned })
let stopService = null
let startService = null
let loadWebTabs = null // (reason) => 把 WebUI 窗口所有标签切到状态说明页（避免更新期间白屏）
let reloadWebTabs = null // () => 强制重载 WebUI 所有标签（新版页面替换旧会话）
let onState = null // 状态变化回调（main 里接 broadcastState）

const state = {
  status: 'idle', // idle | checking | available | updating | updated | error
  current: '',
  latest: '',
  kind: '', // 当前安装形态（source | managed | global | npx）：source 不支持自动更新，UI 按此区分
  error: '',
  prewarmed: false, // 新版完整依赖树是否已预热进 npm/npx 缓存（点击"立即更新"可秒级完成）
}

let checking = false
let updating = false
let warming = null // 当前预热任务（防重入）
let lastNotifiedVersion = '' // 同一新版本只提示一次

function initDshUpdater(o) {
  Config = o.Config
  saveConfig = o.saveConfig
  log = o.log || log
  notify = o.notify || notify
  refreshEnv = o.refreshEnv
  envInstall = o.envInstall
  envDetect = o.envDetect
  getServerState = o.getServerState
  stopService = o.stopService
  startService = o.startService
  loadWebTabs = o.loadWebTabs || null
  reloadWebTabs = o.reloadWebTabs || null
  onState = o.onState || null
}

function getState() {
  return Object.assign({}, state)
}

function pushState() {
  try { if (onState) onState() } catch { /* noop */ }
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
  return new Promise((resolve) => {
    let child = null
    try {
      if (npmCli) {
        child = spawn(nodeBin, [npmCli, ...fullArgs], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } else if (process.platform === 'win32') {
        const cmdLine = ['npm', ...fullArgs].map(quoteArg).join(' ')
        child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } else {
        child = spawn('npm', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
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
  for (const registry of registries()) {
    const args = ['view', '@deepseek-ai/dsh', 'version']
    if (registry) args.push('--registry', registry)
    const r = await runNpm(args, { nodeBin })
    if (r.ok) {
      const line = String(r.stdout).trim().split(/\r?\n/)[0].trim()
      if (semver.valid(line)) return { version: line, registry }
      log(`dsh-update: npm view 输出异常：${line || '(空)'}`)
      return null
    }
    log(`dsh-update: npm view 失败（registry=${registry || '默认'}）：${r.error}${registry ? '，回退官方源重试' : ''}`)
  }
  return null
}

async function runGlobalUpdate(nodeBin, globalRoot) {
  for (const registry of registries()) {
    const args = ['update', '-g', '--prefix', globalRoot, '@deepseek-ai/dsh']
    if (registry) args.push('--registry', registry)
    // 用当前环境 npm（用户级/系统均可）并显式指定全局根，确保落在与 npm i -g 相同的目录
    const r = await runNpm(args, { nodeBin })
    if (r.ok) return r
    log(`dsh-update: npm update -g 失败（registry=${registry || '默认'}）：${r.error}${registry ? '，回退官方源重试' : ''}`)
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
      setState(force ? { status: 'error', error: '检查失败：无法获取最新版本（网络错误）' } : { status: 'idle' })
      return
    }
    setState({ current, latest: latest.version, kind: plan.kind })
    if (semver.gt(latest.version, current, { includePrerelease: true })) {
      log(`dsh-update: new version v${latest.version} available (current v${current}, kind=${plan.kind}, reason=${reason || 'timer'})`)
      const newVersionSeen = state.latest !== latest.version
      setState(Object.assign({ status: 'available' }, newVersionSeen ? { prewarmed: false } : {}))
      // 后台预热缓存（不阻塞检测）：点"立即更新"时依赖树已在 npm/npx 缓存里，秒级完成
      if (!state.prewarmed) void warmLatest(latest.version, plan.nodeCmd, plan.kind)
      if (lastNotifiedVersion !== latest.version) {
        lastNotifiedVersion = latest.version
        notify('DeepSeek Harness', plan.kind === 'source'
          ? `新版本 v${latest.version} 可用：当前为源码安装，请打开启动器面板点"手动更新"（git pull && pnpm run build）`
          : `新版本 v${latest.version} 可用：打开启动器面板点"立即更新"即可升级（npm 安装约 2-5 分钟）`)
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
  setState({ status: 'updating', error: '' })
  try {
    const report = await envDetect.detectEnv(false)
    if (!report || !report.plan) throw new Error('运行环境未就绪，无法更新')
    const plan = report.plan
    const latest = state.latest || ''
    if (!latest) throw new Error('没有待更新的版本')

    const svc = getServerState ? getServerState() : { running: false, owned: false }
    const wasRunning = svc.running
    const owned = svc.owned

    if (plan.kind === 'managed') {
      // 托管形态：更新走统一引擎（内部优先全局 npm，失败回退托管），失败旧版不动
      if (loadWebTabs) loadWebTabs('update') // 页面切"正在更新…"说明页，避免更新期间白屏
      if (wasRunning && owned) {
        log('dsh-update: stopping service before update')
        try { await stopService() } catch (err) { log('dsh-update: stop failed: ' + err.message) }
      }
      try {
        envInstall.startInstall(['dsh'], { dshVersion: latest, autoUpdate: true })
        const status = await waitForJob()
        if (status !== 'done') throw new Error(`更新任务未完成（${status}）`)
      } catch (err) {
        log(`dsh-update: managed update failed: ${err.message}`)
        if (wasRunning && owned) {
          try { await startService() } catch { /* noop */ } // 旧版完好，直接拉回
          if (reloadWebTabs) reloadWebTabs() // 强制重载，把白屏/说明页拉回旧版页面
        }
        setState({ status: 'error', error: err.message })
        return
      }
      // 成功：安装引擎 onDone 已接好"重新探测 + 启动服务"，这里补配置与通知
      Config.dshVersion = 'latest' // 自动保持最新语义
      Config.dshUpdateCheckedAt = Date.now()
      try { saveConfig() } catch { /* noop */ }
      notify('DeepSeek Harness', `已更新到 v${latest}`)
      log(`dsh-update: updated to v${latest}`)
      setState({ status: 'updated', current: latest })
      return
    }

    if (plan.kind === 'global') {
      // 全局 npm：必须先停服务再更新（npm update -g 会在服务运行中替换包文件，
      // 旧进程+新文件会触发 DSH HMR 导致页面白屏且无自愈路径）；
      // 更新期间窗口显示"正在更新…"说明页（带进度条），完成后强制重载为新版页面
      if (loadWebTabs) loadWebTabs('update')
      if (wasRunning && owned) {
        log('dsh-update: stopping service before global update')
        try { await stopService() } catch (err) { log('dsh-update: stop failed: ' + err.message) }
      }
      const globalRoot = await envInstall.resolveGlobalRoot(plan.nodeCmd)
      const r = await runGlobalUpdate(plan.nodeCmd, globalRoot)
      if (!r.ok) {
        if (wasRunning && owned) {
          try { await startService() } catch { /* noop */ } // 旧版完好，直接拉回
          if (reloadWebTabs) reloadWebTabs()
        }
        throw new Error(r.error)
      }
    } else if (plan.kind === 'npx') {
      // npx 缓存：先迁移到全局 npm（统一渠道），失败回退 npx 预热
      if (loadWebTabs) loadWebTabs('update')
      if (wasRunning && owned) {
        log('dsh-update: stopping service before migrate')
        try { await stopService() } catch (err) { log('dsh-update: stop failed: ' + err.message) }
      }
      let migrated = false
      try {
        envInstall.startInstall(['dsh'], { dshVersion: latest, autoUpdate: true })
        const status = await waitForJob()
        if (status !== 'done') throw new Error(`迁移任务未完成（${status}）`)
        migrated = true
      } catch (err) {
        log(`dsh-update: migrate-to-global failed, fallback npx warm: ${err.message}`)
        const r = await runNpxWarm(latest, plan.nodeCmd)
        if (!r.ok) {
          if (wasRunning && owned) {
            try { await startService() } catch { /* noop */ }
            if (reloadWebTabs) reloadWebTabs()
          }
          throw new Error(r.error)
        }
      }
      if (!migrated) {
        // 回退成功：npx 预热后重新探测即可命中缓存新版本
        try { await refreshEnv(true) } catch (err) { log('dsh-update: refresh failed: ' + err.message) }
        if (wasRunning && owned) {
          try { await startService() } catch (err) { log('dsh-update: restart failed: ' + err.message) }
          if (reloadWebTabs) reloadWebTabs()
        }
        Config.dshVersion = 'latest'
        Config.dshUpdateCheckedAt = Date.now()
        try { saveConfig() } catch { /* noop */ }
        notify('DeepSeek Harness', `已更新到 v${latest}`)
        log(`dsh-update: updated to v${latest} (npx fallback)`)
        setState({ status: 'updated', current: latest })
        return
      }
    } else if (plan.kind === 'source') {
      // 源码安装：不动开发者仓库（UI 已把按钮换成"打开源码目录"，这里只兜底）
      throw new Error('源码安装请手动更新：git pull && pnpm run build（启动器不自动修改源码仓库）')
    } else {
      throw new Error(`当前安装形态（${plan.kind}）不支持更新`)
    }

    // 重新探测 + 恢复服务（旧版已停止，拉起的是新版）
    try { await refreshEnv(true) } catch (err) { log('dsh-update: refresh failed: ' + err.message) }
    if (wasRunning && owned) {
      try { await startService() } catch (err) { log('dsh-update: restart failed: ' + err.message) }
      if (reloadWebTabs) reloadWebTabs() // 强制重载：新版页面替换旧会话，杜绝残留白屏
    } else if (loadWebTabs) {
      loadWebTabs('offline') // 更新前服务未在运行：页面切"未启动"状态，而不是停留在"正在更新…"
    }
    Config.dshVersion = 'latest'
    Config.dshUpdateCheckedAt = Date.now()
    try { saveConfig() } catch { /* noop */ }
    notify('DeepSeek Harness', `已更新到 v${latest}`)
    log(`dsh-update: updated to v${latest}`)
    setState({ status: 'updated', current: latest })
  } catch (err) {
    log('dsh-update: update failed: ' + (err && err.message ? err.message : String(err)))
    setState({ status: 'error', error: err && err.message ? err.message : String(err) })
  } finally {
    updating = false
  }
}

module.exports = { initDshUpdater, checkOnce, updateNow, getState }
