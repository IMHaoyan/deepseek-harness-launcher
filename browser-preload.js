// browser-preload.js — DSHL 页面视图的安全桥（contextIsolation + sandbox）
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserBridge', {
  send: (name, payload) => ipcRenderer.invoke('dsh:cmd', 'browser:' + name, payload),
  // 页面内查找专用通道：主进程只允许搜索发出命令的那个 webContents，不进入 browser:* 控制域。
  findCommand: (action, payload) => ipcRenderer.invoke('dsh:find', { action, payload }),
  onState: (cb) => ipcRenderer.on('browser:state', (_e, s) => { try { cb(s) } catch { /* noop */ } }),
  // 状态说明页的步骤进度（主进程在真实检查点推；页面按自己的 reason 过滤）
  onLoadingProgress: (cb) => ipcRenderer.on('loading:progress', (_e, p) => { try { cb(p) } catch { /* noop */ } }),
})

// ---------- 桌面壳桥（可选，默认关闭；由主进程 Config.desktopShell + 桥就绪共同门控） ----------
//
// 背景：DSH 的"桌面能力"由两件事共同决定：
//   1) html[data-platform] 存在 → dsh-client-shortcuts 的 detectEnvironment() 进 desktop runtime；
//   2) window.dshDesktop.keyboard / .shortcuts 提供原生键盘事件源与键位持久化。
// 缺 2) 会让快捷键服务构造时直接 throw，所以主进程只在桥真正就绪时才把 enabled=true 同步回来；
// 本文件拿到 false（默认值）就**什么都不做**，DSH 继续按 web runtime（今天的行为）运行。
//
// 2026-10-20 的旧决策"绝不暴露 dshDesktop"针对的是"无条件当桌面壳"：那样账号登录会切到
// desktop 分支，Host 只等浏览器回调，而 DSHL 没有官方桌面 App 的打开授权页能力，登录只能手动
// 复制链接。现在这条链路由随包分发的 host bundle（assets/dshl-desktop-signin）补齐，且整个开关
// 默认关闭、可随时退回 web —— 因此 preload 可以按主进程门控暴露标记。
//
// 明确不暴露：updates（DSH 自己的桌面更新指示；dshl 有自己的更新器）、browser/protocolVersion
// （侧边栏浏览器继续走 iframe 回落）。
const DESKTOP_SHELL = {
  CONFIG: 'dshl:desktop-shell:config',
  KEYBOARD: 'dshl:desktop-shell:keyboard',
  SHORTCUTS_GET: 'dshl:desktop-shell:shortcuts:get',
  SHORTCUTS_EDIT: 'dshl:desktop-shell:shortcuts:edit',
  SHORTCUTS_RECORDING: 'dshl:desktop-shell:shortcuts:recording',
  SHORTCUTS_SNAPSHOT: 'dshl:desktop-shell:shortcuts:snapshot',
  CLOSE_WINDOW: 'dshl:desktop-shell:close-window',
}

/**
 * 同步问主进程：本页是否该以桌面壳身份运行。同步是必须的——标记必须在页面脚本执行前决定。
 * 任何异常都按"关闭"处理（fail-closed）。
 */
function readDesktopShellConfig() {
  try {
    const value = ipcRenderer.sendSync(DESKTOP_SHELL.CONFIG)
    return value && value.enabled === true ? value : null
  } catch {
    return null
  }
}

/** 只有本机 DSH 应用页才配拿这个桥：说明页（file://）、外部站点、浏览器标签都排除。 */
function isDesktopShellPage(config) {
  try {
    const url = new URL(String(location.href || ''))
    return url.protocol === 'http:'
      && url.hostname === config.host
      && String(url.port) === String(config.port)
  } catch {
    return false
  }
}

/**
 * 在页面插件加载前写入 data-platform（detectEnvironment 在插件构造时读取这个属性）。
 * preload 运行在文档解析之前，documentElement 可能还不存在 → 等 <html> 出现后立刻写。
 */
function markDesktopPlatform(platform) {
  const marker = typeof platform === 'string' && platform ? platform : 'win32'
  const apply = () => {
    try { document.documentElement?.setAttribute('data-platform', marker) } catch { /* noop */ }
  }
  try {
    if (document.documentElement) {
      apply()
      return
    }
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return
      apply()
      observer.disconnect()
    })
    observer.observe(document, { childList: true })
  } catch {
    // 拿不到 DOM 时只损失 data-platform；桥仍会暴露，但 DSH 仍按 web runtime 跑（安全侧）
  }
}

function exposeDesktopShell(config) {
  markDesktopPlatform(config.platform)

  const keyboard = {
    /** @param {(input:object)=>void} callback 原生键盘事件（DSH 侧 installNativeKeyboard 消费） */
    subscribe(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, input) => { try { callback(input) } catch { /* 页面回调异常不能影响主进程事件流 */ } }
      ipcRenderer.on(DESKTOP_SHELL.KEYBOARD, listener)
      return () => { try { ipcRenderer.removeListener(DESKTOP_SHELL.KEYBOARD, listener) } catch { /* noop */ } }
    },
    /** 右侧栏「关闭当前页面/窗口」最后会请求原生关窗（DSH 侧 shortcuts.closeWindow()） */
    closeWindow: (revision) => ipcRenderer.invoke(DESKTOP_SHELL.CLOSE_WINDOW, revision),
  }

  const shortcuts = {
    get: (definitions) => ipcRenderer.invoke(DESKTOP_SHELL.SHORTCUTS_GET, definitions),
    edit: (edit, revision) => ipcRenderer.invoke(DESKTOP_SHELL.SHORTCUTS_EDIT, edit, revision),
    subscribe(callback) {
      if (typeof callback !== 'function') return () => {}
      const listener = (_event, snapshot) => { try { callback(snapshot) } catch { /* noop */ } }
      ipcRenderer.on(DESKTOP_SHELL.SHORTCUTS_SNAPSHOT, listener)
      return () => { try { ipcRenderer.removeListener(DESKTOP_SHELL.SHORTCUTS_SNAPSHOT, listener) } catch { /* noop */ } }
    },
    recording: (active) => ipcRenderer.invoke(DESKTOP_SHELL.SHORTCUTS_RECORDING, active === true),
    dispose: () => { /* 监听器随页面卸载释放；持久化生命周期归主进程 */ },
  }

  contextBridge.exposeInMainWorld('dshDesktop', { keyboard, shortcuts })
}

const desktopShellConfig = readDesktopShellConfig()
if (desktopShellConfig && isDesktopShellPage(desktopShellConfig)) exposeDesktopShell(desktopShellConfig)
