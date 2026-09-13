// update-window.js — DSHL 更新窗口（独立 BrowserWindow）生命周期封装。
//
// 为什么是独立窗口而不是控制台里的一个页面：
//   需求是「点导航栏『有更新』→ 弹出一个独立窗口，里面是更新卡片 + 更新内容」。
//   独立窗口可以自由拖动、最小化、关闭，也不影响 DSH 主窗口的分屏与控制台开关状态
//   （控制台是挂在主窗口里的 WebContentsView，复用它会让「独立窗口」语义变形）。
//
// 职责边界：只管窗口本身（创建/显示/聚焦/销毁 + 状态推送）。
// 版本判断、更新动作、更新日志抓取分别由 main.js 和页面自己负责，这里不做业务判断。
'use strict'

const { BrowserWindow } = require('electron')

const MIN_W = 560
const MIN_H = 420
const DEF_W = 720
const DEF_H = 640

function createUpdateWindow(opts) {
  const options = opts || {}
  const htmlPath = options.htmlPath
  const preloadPath = options.preloadPath
  const icon = options.icon
  const onError = typeof options.onError === 'function' ? options.onError : null
  const onClosed = typeof options.onClosed === 'function' ? options.onClosed : null
  const onWebContents = typeof options.onWebContents === 'function' ? options.onWebContents : null

  let win = null
  let loaded = false
  let pending = [] // 页面加载完成前收到的推送先攒着（否则首帧状态会丢）
  let disposed = false

  function alive() {
    return !!(win && !disposed && !win.isDestroyed())
  }

  function ensure() {
    if (disposed) return null
    if (alive()) return win

    win = new BrowserWindow({
      width: DEF_W,
      height: DEF_H,
      minWidth: MIN_W,
      minHeight: MIN_H,
      show: false, // 先隐藏，等 ready-to-show 再显示，避免白屏闪一下
      autoHideMenuBar: true,
      backgroundColor: '#F9FAFB',
      title: 'DSHL 更新',
      icon: icon || undefined,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })

    const wc = win.webContents
    if (onWebContents) { try { onWebContents(wc, win) } catch { /* noop */ } }

    win.once('ready-to-show', () => {
      if (!alive()) return
      try { win.show(); win.focus() } catch { /* noop */ }
      flush()
    })

    win.on('closed', () => {
      win = null
      loaded = false
      pending = []
      if (onClosed) { try { onClosed() } catch { /* noop */ } }
    })

    wc.on('did-finish-load', () => {
      loaded = true
      flush()
    })

    wc.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      if (onError) onError(new Error(`update window load failed: ${code} ${desc} ${url}`))
    })

    wc.loadFile(htmlPath).catch((err) => {
      if (onError) onError(err)
    })

    return win
  }

  function flush() {
    if (!loaded || !alive() || !pending.length) return
    const queue = pending
    pending = []
    for (const item of queue) sendNow(item.channel, item.payload)
  }

  function sendNow(channel, payload) {
    if (!alive()) return
    try { win.webContents.send(channel, payload) } catch { /* noop */ }
  }

  /** 推送；页面还没加载完就先排队，加载完成后补发（顺序保持）。 */
  function send(channel, payload) {
    if (!alive()) return
    if (!loaded) {
      pending.push({ channel, payload })
      if (pending.length > 20) pending.shift() // 只保留最近的若干条，避免长时间未加载时堆积
      return
    }
    sendNow(channel, payload)
  }

  function show() {
    if (disposed) return null
    const w = ensure()
    if (!w) return null
    if (w.isMinimized()) { try { w.restore() } catch { /* noop */ } }
    try { w.show(); w.focus() } catch { /* noop */ }
    return w
  }

  function close() {
    if (!alive()) return
    try { win.close() } catch { /* noop */ }
  }

  function dispose() {
    disposed = true
    pending = []
    if (win && !win.isDestroyed()) {
      try { win.destroy() } catch { /* noop */ }
    }
    win = null
  }

  return {
    show,
    send,
    close,
    dispose,
    isOpen: () => alive() && !!win.isVisible(),
    window: () => (alive() ? win : null),
  }
}

module.exports = { createUpdateWindow, UPDATE_WINDOW_DEFAULTS: { MIN_W, MIN_H, DEF_W, DEF_H } }