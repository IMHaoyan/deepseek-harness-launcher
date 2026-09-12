// console-surface.js — DSHL 控制台视图（WebContentsView）生命周期封装。
// 只负责“控制台这一层”的渲染载体；服务状态、命令与页面数据仍由 main.js 持有。
'use strict'

const { WebContentsView } = require('electron')

function createConsoleSurface(opts) {
  const options = opts || {}
  const ownerWindow = options.ownerWindow
  const htmlPath = options.htmlPath
  const preloadPath = options.preloadPath
  const onLayout = typeof options.onLayout === 'function' ? options.onLayout : null
  const onError = typeof options.onError === 'function' ? options.onError : null
  const onWebContents = typeof options.onWebContents === 'function' ? options.onWebContents : null

  let view = null
  let visible = false
  let loaded = false
  let pendingPage = ''
  let disposed = false

  function isAlive() {
    return !!(view && !disposed && !view.webContents.isDestroyed())
  }

  function ensure() {
    if (disposed || !ownerWindow || ownerWindow.isDestroyed()) return null
    if (isAlive()) return view

    view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: preloadPath,
      },
    })
    try { view.setBackgroundColor('#F9FAFB') } catch { /* 旧版 Electron 忽略 */ }

    const wc = view.webContents
    if (onWebContents) { try { onWebContents(wc, view) } catch { /* noop */ } }
    wc.on('zoom-changed', () => {
      try { wc.setZoomLevel(0) } catch { /* noop */ }
    })
    wc.on('did-finish-load', () => {
      loaded = true
      if (pendingPage) {
        const page = pendingPage
        pendingPage = ''
        pushPage(page)
      }
    })
    wc.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      if (onError) onError(new Error(`console surface load failed: ${code} ${desc} ${url}`))
    })
    wc.loadFile(htmlPath).catch((err) => {
      if (onError) onError(err)
    })
    return view
  }

  function pushPage(page) {
    const p = String(page || '')
    if (!p) return
    if (!isAlive()) return
    if (!loaded) {
      pendingPage = p
      return
    }
    try { view.webContents.send('console:page', JSON.stringify({ page: p })) } catch { /* noop */ }
  }

  function focus() {
    if (!isAlive()) return
    try { view.webContents.focus() } catch { /* noop */ }
  }

  function show(page) {
    if (disposed) return null
    const v = ensure()
    if (!v) return null
    visible = true
    if (page) pushPage(page)
    if (onLayout) onLayout()
    focus()
    return v
  }

  function hide() {
    if (visible) {
      visible = false
      if (onLayout) onLayout()
    }
  }

  function toggle(page) {
    if (visible) {
      hide()
      return false
    }
    show(page)
    return true
  }

  function send(channel, payload) {
    if (!isAlive()) return
    try { view.webContents.send(channel, payload) } catch { /* noop */ }
  }

  function reload() {
    if (!isAlive()) return
    loaded = false
    try { view.webContents.reload() } catch { /* noop */ }
  }

  function dispose() {
    const wc = isAlive() ? view.webContents : null
    disposed = true
    visible = false
    loaded = false
    pendingPage = ''
    if (wc) {
      try { wc.close() } catch { /* noop */ }
    }
    view = null
  }

  return {
    show,
    hide,
    toggle,
    send,
    pushPage,
    reload,
    dispose,
    isOpen: () => visible,
    view: () => (isAlive() ? view : null),
  }
}

module.exports = { createConsoleSurface }