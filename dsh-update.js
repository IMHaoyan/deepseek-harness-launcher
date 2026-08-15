// dsh-update.js — DSH 自动更新：定期检查 @deepseek-ai/dsh 最新版，托管/全局/npx 形态自动升级到最新（无确认交互）
// 设计：
//  - 检查节流 24 小时（dshUpdateCheckedAt 落配置）；检查与更新全程静默，只在更新成功后弹托盘通知；
//  - 托管安装：复用 env-install 安装引擎重装（npm install --prefix 覆盖旧版），其 onDone 已接好"重新探测 + 启动服务"；
//  - 全局安装：系统 npm 执行 `npm update -g @deepseek-ai/dsh`（registry 失败自动回退 npmmirror）；
//  - npx 缓存：`npm exec --yes --package @deepseek-ai/dsh@<v> -- dsh --version` 预热缓存（检测取最高版本）；
//  - 源码版：不动开发者仓库，仅记日志。
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

let checking = false
let lastNotifiedVersion = '' // 同一新版本只通知一次

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
  return Config.npmRegistry ? [Config.npmRegistry] : [null, 'https://registry.npmmirror.com']
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
    log(`dsh-update: npm view 失败（registry=${registry || '默认'}）：${r.error}${registry === null ? '，回退镜像源重试' : ''}`)
  }
  return null
}

async function runGlobalUpdate() {
  for (const registry of registries()) {
    const args = ['update', '-g', '@deepseek-ai/dsh']
    if (registry) args.push('--registry', registry)
    // 全局安装必须用"拥有 %APPDATA%\npm 全局目录"的系统 npm（PATH），不能用托管 Node 的 npm
    const r = await runNpm(args, { nodeBin: null })
    if (r.ok) return r
    log(`dsh-update: npm update -g 失败（registry=${registry || '默认'}）：${r.error}${registry === null ? '，回退镜像源重试' : ''}`)
  }
  return { ok: false, error: '全局更新失败' }
}

async function runNpxWarm(latest, nodeBin) {
  // 预热 npx 缓存：npm exec 会把新版本装进 _npx 缓存并执行 --version（DSH 自带 --version 验证）
  return runNpm(['exec', '--yes', '--package', `@deepseek-ai/dsh@${latest}`, '--', 'dsh', '--version'], { nodeBin })
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

function finishAfterUpdate(latest, wasRunning, owned) {
  Config.dshVersion = 'latest' // 自动保持最新语义
  Config.dshUpdateCheckedAt = Date.now()
  try { saveConfig() } catch (err) { log('dsh-update: save config failed: ' + err.message) }
  if (lastNotifiedVersion !== latest) {
    lastNotifiedVersion = latest
    const hint = wasRunning && !owned ? '；接管中的运行实例不受控制，需手动重启生效' : ''
    notify('DeepSeek Harness', `已自动更新到 v${latest}${hint}`)
  }
  log(`dsh-update: updated to v${latest}`)
}

async function autoUpdate(kind, latest, nodeBin) {
  const state = getServerState ? getServerState() : { running: false, owned: false }
  const wasRunning = state.running
  const owned = state.owned
  // 更新前停掉自有服务；接管的第三方实例不动（文件更新后提示手动重启）
  if (wasRunning && owned) {
    log('dsh-update: stopping service before update')
    try { await stopService() } catch (err) { log('dsh-update: stop failed: ' + err.message) }
  }

  if (kind === 'managed') {
    try {
      envInstall.startInstall(['dsh'], { dshVersion: latest, autoUpdate: true })
      const status = await waitForJob()
      if (status !== 'done') {
        log(`dsh-update: managed update job ${status}, restoring service`)
        if (wasRunning && owned) await startService() // 更新失败：用旧版拉起，避免服务停摆
        return
      }
      // 成功：安装引擎 onDone 已接好"重新探测 + 启动服务"，这里只补配置与通知
      finishAfterUpdate(latest, wasRunning, owned)
    } catch (err) {
      log(`dsh-update: managed update failed: ${err.message}`)
      if (wasRunning && owned) await startService()
    }
    return
  }

  if (kind === 'global') {
    const r = await runGlobalUpdate()
    if (!r.ok) { log(`dsh-update: global update failed: ${r.error}`); if (wasRunning && owned) await startService(); return }
  } else if (kind === 'npx') {
    const r = await runNpxWarm(latest, nodeBin)
    if (!r.ok) { log(`dsh-update: npx warm-up failed: ${r.error}`); if (wasRunning && owned) await startService(); return }
  } else {
    log(`dsh-update: kind=${kind} 不支持自动更新（仅托管/全局/npx），跳过`)
    return
  }

  // 重新探测 + 恢复服务（旧版已停止，拉起的是新版）
  try { await refreshEnv(true) } catch (err) { log('dsh-update: refresh failed: ' + err.message) }
  if (wasRunning && owned) {
    try { await startService() } catch (err) { log('dsh-update: restart failed: ' + err.message) }
  }
  finishAfterUpdate(latest, wasRunning, owned)
}

async function checkOnce(reason) {
  if (checking) return
  if (!Config || !envDetect || !envInstall) return
  // 用户手动安装任务进行中时不打扰
  const snap = envInstall.getJob()
  if (snap && snap.job && snap.job.status === 'running') {
    log('dsh-update: install job in progress, check skipped')
    return
  }
  const now = Date.now()
  if (now - (Number(Config.dshUpdateCheckedAt) || 0) < CHECK_INTERVAL_MS) return
  checking = true
  try {
    const report = await envDetect.detectEnv(false)
    if (!report || !report.plan) { log('dsh-update: environment not ready, check skipped'); return }
    const plan = report.plan
    const current = plan.dshVersion || ''
    if (!current) { log('dsh-update: installed version unknown, check skipped'); return }
    const latest = await fetchLatest(plan.nodeCmd)
    if (!latest) return
    Config.dshUpdateCheckedAt = now
    try { saveConfig() } catch { /* noop */ }
    if (semver.gt(latest.version, current, { includePrerelease: true })) {
      log(`dsh-update: new version v${latest.version} (current v${current}, kind=${plan.kind}, reason=${reason || 'timer'})`)
      await autoUpdate(plan.kind, latest.version, plan.nodeCmd)
    } else {
      log(`dsh-update: v${current} 已是最新（latest v${latest.version}）`)
    }
  } catch (err) {
    log('dsh-update: check failed: ' + (err && err.message ? err.message : String(err)))
  } finally {
    checking = false
  }
}

module.exports = { initDshUpdater, checkOnce }
