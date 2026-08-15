// updater.js — electron-updater 接入：GitHub Releases 自动更新（NSIS 安装版专用）
// 行为：启动后延迟自动检查（已打包时）→ 发现新版后台下载 → 下载完成弹通知；
//       设置页可手动"检查更新"与"重启并安装"；正常退出时如已有下载好的更新则自动安装。
'use strict'

const { app } = require('electron')
const { autoUpdater } = require('electron-updater')

let log = () => {}
let onNotify = null // (title, message) => void
let onFlash = null // () => void（托盘闪烁提醒）
let sendToPanel = null // (json) => void
let beforeInstall = null // () => Promise<void>（安装前收尾，如停掉自管的 DSH 服务）

const state = {
  status: 'idle', // idle | dev | checking | up-to-date | downloading | downloaded | error
  current: '0.0.0',
  latest: '',
  percent: 0,
  error: '',
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

function initUpdater(opts = {}) {
  if (initDone) return
  initDone = true
  log = opts.log || log
  onNotify = opts.onNotify || null
  onFlash = opts.onFlash || null
  sendToPanel = opts.sendToPanel || null
  beforeInstall = opts.beforeInstall || null
  state.current = opts.currentVersion || app.getVersion()

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

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
    if (onFlash) { try { onFlash() } catch { /* noop */ } }
    if (onNotify) {
      onNotify('DeepSeek Harness Launcher', `新版本 v${info.version} 已下载完成，退出重启后自动安装（也可在设置页点"重启并安装"立即更新）`)
    }
  })
  autoUpdater.on('error', (err) => {
    log('updater error: ' + (err && err.message ? err.message : String(err)))
    // 已下载完成后的退出安装类错误不应覆盖"已就绪"状态
    if (state.status !== 'downloaded') setStatus('error', { error: err && err.message ? err.message : String(err) })
  })
}

function getState() {
  state.current = app.getVersion()
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

async function installNow() {
  if (!isPackaged()) { setStatus('dev'); return }
  if (state.status !== 'downloaded') { await check(); return }
  log('updater: quit and install now')
  try { if (beforeInstall) await beforeInstall() } catch (err) { log('updater beforeInstall failed: ' + err.message) }
  // isSilent=false, isForceRunAfter=true：安装后自动重新拉起启动器
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

module.exports = { initUpdater, getState, check, autoCheck, installNow }
