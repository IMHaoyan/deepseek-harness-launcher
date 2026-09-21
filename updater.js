// updater.js — electron-updater 接入：GitHub Releases 自动更新（NSIS 安装版专用）
// 行为：启动后延迟自动检查（已打包时）→ 发现新版后台下载 → 下载完成弹通知；
//       设置页可手动"检查更新"与"重启并安装"；正常退出时如已有下载好的更新则自动安装。
//
// 渠道（设置页可切，默认 latest）：
//   latest —— 稳定版：allowPrerelease=false，GitHub provider 只认 /releases/latest（不含预发布）。
//   alpha  —— 预发布版：allowPrerelease=true + channel=alpha，provider 顺着 releases 从新到旧找第一个
//             语义化 tag，优先取 alpha.yml；该 release 没有 alpha.yml 时**回落到 latest.yml**，
//             所以 alpha 渠道的用户既拿得到 alpha 包，也不会漏掉正式版。
//   发布侧配套：`npm run release` 按版本号里的预发布段决定发到哪个渠道（x.y.z-alpha.N → alpha.yml，
//   x.y.z → latest.yml），见 tools/release.mjs。
//   切回 latest 不会降级：见 applyChannel 里对 electron-updater `allowDowngrade` 副作用的处理。
'use strict'

const { app } = require('electron')
const { autoUpdater } = require('electron-updater')
const semver = require('semver')

let log = () => {}
let onNotify = null // (title, message) => void
let onFlash = null // () => void（托盘闪烁提醒）
let sendToPanel = null // (json) => void
let beforeInstall = null // () => Promise<void>（安装前收尾，如停掉自管的 DSH 服务）
let onEvent = null // (event, detail) => void（生命周期事件，可选）
let readChannel = () => 'latest' // () => 'latest' | 'alpha'（值来自配置，主进程说了算）

// 更新渠道只认这两个值；未知/缺失一律回落到 latest（fail-closed：绝不因为配置写坏就去拉预发布包）。
const CHANNELS = ['latest', 'alpha']
function normalizeChannel(value) {
  return value === 'alpha' ? 'alpha' : 'latest'
}

const state = {
  status: 'idle', // idle | dev | checking | up-to-date | downloading | downloaded | error
  current: '0.0.0',
  latest: '',
  percent: 0,
  error: '',
  channel: 'latest',
}

let initDone = false
let autoChecked = false

function snapshot() {
  return JSON.stringify(Object.assign({}, state))
}

function push() {
  try { if (sendToPanel) sendToPanel(snapshot()) } catch { /* noop */ }
}

function setStatus(status, extra = {}) {
  Object.assign(state, { status }, extra)
  push()
}

function isPackaged() {
  try { return app.isPackaged } catch { return false }
}

/** 把配置里的渠道落到 electron-updater 上（channel + allowPrerelease 必须成对设置）。 */
function applyChannel() {
  const channel = normalizeChannel(readChannel())
  state.channel = channel
  autoUpdater.channel = channel
  autoUpdater.allowPrerelease = channel === 'alpha'
  // ⚠️ electron-updater 的 channel setter 会把 allowDowngrade 一并置 true，且**永不还原**
  // （AppUpdater.js：「`allowDowngrade` will be automatically set to `true`. If this behavior is
  // not suitable for you, simple set `allowDowngrade` explicitly after.」）。不显式关掉的话：
  // 装了 v1.4.8-alpha.4 的机器切回 latest 后，latest.yml 给的 v1.4.7 更旧，
  // 判定式 `return this.allowDowngrade && isLatestVersionOlder` 会返回 true ——
  // 界面上真的出现「可更新到 v1.4.7」，而且会下载、会在退出时自动安装（= 静默降级）。
  // 2026-09-21 实测于另一台机器（渠道 latest、已装 v1.4.8-alpha.4）。
  autoUpdater.allowDowngrade = false
  return channel
}

/**
 * 目标版本是否**严格高于**当前版本。
 * 取不到合法版本号时 fail-open（放行）：宁可多给一次更新，也不要拦住真实的升级。
 * @param {string} target 更新源给的版本号
 * @param {string} current 当前安装的版本号
 */
function isNewerVersion(target, current) {
  try {
    if (!semver.valid(target) || !semver.valid(current)) return true
    return semver.gt(target, current, { includePrerelease: true })
  } catch { return true }
}

function initUpdater(opts = {}) {
  if (initDone) return
  initDone = true
  log = opts.log || log
  onNotify = opts.onNotify || null
  onFlash = opts.onFlash || null
  sendToPanel = opts.sendToPanel || null
  beforeInstall = opts.beforeInstall || null
  onEvent = opts.onEvent || null
  readChannel = typeof opts.getChannel === 'function' ? opts.getChannel : readChannel
  state.current = opts.currentVersion || app.getVersion()

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  applyChannel()

  autoUpdater.on('checking-for-update', () => setStatus('checking'))
  autoUpdater.on('update-available', (info) => {
    // 兜底闸（与 applyChannel 那道一起）：更新源给的版本必须**真的比当前新**。
    // 不新就当作"已是最新"——界面文案与真实动作必须一致，降级绝不能披着"可更新到"的外衣。
    if (!isNewerVersion(info.version, state.current)) {
      log(`updater: 忽略不比当前新的版本 v${info.version}（当前 v${state.current}）`)
      setStatus('up-to-date', { latest: '', error: '' })
      return
    }
    log(`updater: new version available v${info.version} (current v${state.current})`)
    setStatus('downloading', { latest: info.version, percent: 0, error: '' })
  })
  autoUpdater.on('update-not-available', () => {
    log('updater: already up to date')
    // 必须清掉 latest：否则上一次"已下载"留下的版本号会一直在，界面就会拿它渲染「可更新到 vX」
    setStatus('up-to-date', { latest: '', error: '' })
  })
  autoUpdater.on('download-progress', (p) => {
    setStatus('downloading', { percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log(`updater: v${info.version} downloaded, will install on quit`)
    setStatus('downloaded', { latest: info.version, percent: 100, error: '' })
    if (onEvent) { try { onEvent('update.launcher', { status: 'downloaded', latest: info.version }) } catch { /* noop */ } }
    if (onFlash) { try { onFlash() } catch { /* noop */ } }
    if (onNotify) {
      // 第三参数带上版本号：主进程据此做"同一版本只提醒一次"的跨重启去重
      onNotify('DeepSeek Harness Launcher', `新版本 v${info.version} 已下载完成：点设置页"更新到 v${info.version}"立即安装（退出重启也会自动安装）`, { version: info.version })
    }
  })
  autoUpdater.on('error', (err) => {
    log('updater error: ' + (err && err.message ? err.message : String(err)))
    // 已下载完成后的退出安装类错误不应覆盖"已就绪"状态
    if (state.status !== 'downloaded') setStatus('error', { error: err && err.message ? err.message : String(err) })
    if (onEvent) { try { onEvent('update.launcher', { status: 'error', error: (err && err.message || String(err)).slice(0, 128) }) } catch { /* noop */ } }
  })
}

function getState() {
  state.current = app.getVersion()
  if (!isPackaged() && state.status === 'idle') state.status = 'dev'
  return snapshot()
}

async function check() {
  state.current = app.getVersion()
  if (!isPackaged()) {
    log('updater: dev mode, online update disabled')
    setStatus('dev', { error: '' })
    return
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    log('updater check failed: ' + (err && err.message ? err.message : String(err)))
    setStatus('error', { error: err && err.message ? err.message : String(err) })
  }
}

// 启动后自动检查（只做一次；静默下载，不打断用户）
function autoCheck() {
  if (!isPackaged() || autoChecked) return
  autoChecked = true
  log('updater: auto check for updates')
  void check()
}

/**
 * 渠道改变时调用（必须在配置已更新之后）：
 *   1. 把新渠道落到 electron-updater；
 *   2. 作废已经下载/正在下载的那个包 —— 它属于旧渠道，继续显示「更新到 vX」会让人以为切过来就生效了；
 *      重新检查会按新渠道再下一个（旧文件留在缓存目录，electron-updater 自己管）。
 */
function onChannelChanged() {
  const channel = applyChannel()
  log('updater: channel switched to ' + channel)
  // 无条件作废：latest 虽然只在 downloading/downloaded 时写过，但保留条件判断会让
  // "切渠道那一刻恰好不是这两个状态"的历史值残留下来，并被界面渲染成「可更新到 vX」——
  // 而它属于旧渠道，点下去装的是别的东西（2026-09-21 的 v1.4.7 事件就是这个形态）。
  state.latest = ''
  state.percent = 0
  state.status = 'idle'
  push()
  return channel
}

async function installNow() {
  if (!isPackaged()) { setStatus('dev'); return }
  if (state.status !== 'downloaded') { await check(); return }
  log('updater: quit and install now')
  try { if (beforeInstall) await beforeInstall() } catch (err) { log('updater beforeInstall failed: ' + err.message) }
  // isSilent=false, isForceRunAfter=true：安装后自动重新拉起启动器
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

module.exports = { initUpdater, getState, check, autoCheck, installNow, onChannelChanged, normalizeChannel, isNewerVersion, CHANNELS }
