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
//   切回 latest 不会降级（allowDowngrade 保持 false）：已装的 alpha 比正式版新时保持不动，等下一个正式版。
'use strict'

const { app } = require('electron')
const { autoUpdater } = require('electron-updater')

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
  return channel
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
    log(`updater: new version available v${info.version} (current v${state.current})`)
    setStatus('downloading', { latest: info.version, percent: 0, error: '' })
  })
  autoUpdater.on('update-not-available', () => {
    log('updater: already up to date')
    setStatus('up-to-date', { error: '' })
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
  if (state.status === 'downloading' || state.status === 'downloaded') {
    state.latest = ''
    state.percent = 0
    state.status = 'idle'
  }
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

module.exports = { initUpdater, getState, check, autoCheck, installNow, onChannelChanged, normalizeChannel, CHANNELS }
