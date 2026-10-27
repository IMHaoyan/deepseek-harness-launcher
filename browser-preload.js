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

// ---------- 文件链接：Ctrl/Cmd+点击 → 用系统默认程序打开 ----------
//
// 背景：DSH 的 Markdown 文件链接渲染成 `<button title="<链接原文>">`，普通点击落到右侧栏预览，
// 不会交给操作系统。这里在 preload 隔离世界里加一个捕获阶段监听，把明确带修饰键的点击截下来：
//   Ctrl/Cmd+点击        → shell.openPath（Windows 上等于双击：exe 直接运行、文档用默认程序打开）
//   Ctrl/Cmd+Shift+点击  → 在文件管理器里定位（Explorer 选中该文件）
//
// 为什么放在 preload 而不是页面脚本：这条能力不暴露到主世界（不挂到 browserBridge 上），
// 页面（含渲染进聊天的任意内容）没法主动调用，只有真实用户手势能触发。
// 信任域与桌面壳桥一致：主进程同步给出 DSH 页的 host/port，只有本机 DSH 页才挂监听；
// 主进程收到请求后仍会用 trust.isDshAppUrl 复核发送方，并校验"绝对本地路径 + 文件存在"。
//
// 2026-10-27 真机反馈：能直接拿到绝对路径的入口只有两类 —— Markdown 文件链接写成绝对路径时，
// 以及 deliverables 文件卡片（title 是 Host 解析后的绝对路径）。另外三类全被静默漏掉：
//   ① 相对路径链接（回答里最常见的 `[x](dsh-update.js#L24)`，title 就是相对路径）；
//   ② 图片链接（DSH 对可解析图片**故意不写 title**，选择器 button[title] 直接落空）；
//   ③ @ 提及 chip（title 是原始 mention 文本 `@path` / `@"path with spaces"`）。
// 后两类的共同点是：preload 手里只有 href/mention 文本，没有会话工作区根目录，自己拼不出绝对路径。
//
// 因此分三条路：
//   A) title 能归一化成"本地绝对路径"→ 拦截点击，直接请主进程打开（无副作用，原行为）；
//   B) title 是相对路径（相对链接 / 相对 @ 提及）→ 从点击所在会话节点 `data-conversation-session`
//      拿 sessionId，同步请主进程用 DSH 自己的 ~/.dsh/storages/workspace.json（会话 → 工作区根目录）
//      还原绝对路径；还原成功同样拦下点击直接打开。2026-10-27 第二轮真机证据：文本文件的预览头部
//      只显示**相对路径**（图片等 bytes 预览才有 absolutePath），所以相对路径不能靠预览兜底。
//   C) title 缺失 / 还原不出来（图片链接等）→ 放行 DSH 打开右侧栏预览，再观察预览头部
//      `[data-textpreview-path]`（title = Host 解析后的绝对路径）在 2 秒内新出现 / 变为可见的那一条。
//      代价是预览面板会照常打开，与今天拦截失败时的既有行为一致，不是新增副作用。
const FILE_OPEN = { ORIGIN: 'dshl:file-open:origin', RESOLVE: 'dshl:file-open:resolve', OPEN: 'dsh:file-open' }
// 与 file-open.js 的校验保持一致：盘符或 UNC（DSH 的 title 可能是 C:\ 或 C:/）
const FILE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/u
// 文档预览头部的路径标签（PathLabel，title 是 Host 解析后的绝对路径）
const PREVIEW_PATH_SELECTOR = '[data-textpreview-path]'
// 从"放行点击"到"预览头部出现绝对路径"的等待上限；DSH 打开预览、读元数据都在本机，通常 <300ms
const PREVIEW_WAIT_MS = 2000
const PREVIEW_POLL_MS = 120
let previewWatch = null

/** 同步问主进程：本机 DSH 页的地址。拿不到就按"不启用"处理（fail-closed）。 */
function readFileOpenOrigin() {
  try {
    const value = ipcRenderer.sendSync(FILE_OPEN.ORIGIN)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** 只有本机 DSH 页才挂这个快捷方式：说明页（file://）、外部站点、其它标签页都不挂。 */
function isFileOpenPage(origin) {
  try {
    const url = new URL(String(location.href || ''))
    const port = origin.port === undefined || origin.port === null ? '' : String(origin.port)
    return url.protocol === 'http:'
      && url.hostname === origin.host
      && String(url.port) === port
  } catch {
    return false
  }
}

/**
 * 把文件入口的文本归一化成可直接交给主进程的路径；不是本地绝对路径就返回空串。
 * 兼容 @ 提及语法（`@C:\a.txt` / `@"C:\Program Files\a b.txt"`）和 DSH 的前斜杠写法。
 * @param {unknown} raw title / mention 原文
 * @returns {string}
 */
function absoluteFilePath(raw) {
  const value = unmentioned(raw)
  return FILE_PATH_RE.test(value) ? value : ''
}

/** 去掉 @ 提及前缀与可选引号，返回用户真正写的路径文本（绝对/相对都可能）。 */
function unmentioned(raw) {
  let value = typeof raw === 'string' ? raw.trim() : ''
  if (value.startsWith('@')) value = value.slice(1).trim()
  const quoted = /^(["'])([\s\S]*)\1$/u.exec(value)
  if (quoted !== null) value = quoted[2].trim()
  return value
}

/** 按钮的 title 原文（没有就是空串）。 */
function buttonTitle(button) {
  try {
    if (button === null) return ''
    return String(button.getAttribute('title') || '').trim()
  } catch {
    return ''
  }
}

/**
 * 点击位置所在会话的 id（DSH 会话正文节点带 data-conversation-session）。
 * 优先最近的祖先；不在会话正文里（例如预览面板里的链接）就退回页面上第一个会话。
 */
function sessionIdNear(button) {
  try {
    const owner = button !== null && typeof button.closest === 'function'
      ? button.closest('[data-conversation-session]')
      : null
    const element = owner ?? (typeof document !== 'undefined' && typeof document.querySelector === 'function'
      ? document.querySelector('[data-conversation-session]')
      : null)
    if (!element || typeof element.getAttribute !== 'function') return ''
    const value = element.getAttribute('data-conversation-session')
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 让主进程把「会话 + 相对路径」还原成绝对路径（同步：点击当拍就要决定拦不拦）。
 * 解析失败返回空串，调用方放行 DSH 原行为。
 */
function resolveRelativePath(sessionId, relativePath) {
  try {
    const result = ipcRenderer.sendSync(FILE_OPEN.RESOLVE, { sessionId, path: relativePath })
    if (!result || result.ok !== true) return ''
    return typeof result.path === 'string' ? result.path.trim() : ''
  } catch {
    return ''
  }
}

/** 点击落到的 <button>（DSH 的文件入口都是按钮；不是按钮就返回 null）。 */
function clickButton(target) {
  try {
    if (!target || typeof target.closest !== 'function') return null
    const button = target.closest('button')
    return button && typeof button.getAttribute === 'function' ? button : null
  } catch {
    return null
  }
}

/** 预览头部是否对用户可见（隐藏的旧标签页不能当作这次点击的结果）。 */
function isVisiblePreviewNode(node) {
  try {
    if (typeof node.closest === 'function' && node.closest('[hidden],[aria-hidden="true"]') !== null) return false
    if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false
    return true
  } catch {
    return false
  }
}

/** 当前 DOM 里的预览路径：path → 是否可见（同一路径出现在多个标签页时以可见者为准）。 */
function previewPathEntries() {
  const entries = new Map()
  try {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return entries
    const nodes = document.querySelectorAll(PREVIEW_PATH_SELECTOR)
    for (const node of nodes) {
      let path = ''
      try { path = absoluteFilePath(node.getAttribute('title')) } catch { path = '' }
      if (path === '') continue
      entries.set(path, entries.get(path) === true || isVisiblePreviewNode(node))
    }
  } catch { /* 拿不到 DOM 就当作没有候选 */ }
  return entries
}

function baseNameOf(path) {
  const parts = String(path).split(/[\\/]/u)
  return (parts[parts.length - 1] || '').toLowerCase()
}

/** 在可见预览里挑出这次点击打开的那一个：优先新出现的，多个时按按钮文本里的文件名收敛。 */
function previewCandidate(watch) {
  const visible = []
  const matched = []
  for (const [path, shown] of previewPathEntries()) {
    if (!shown) continue
    if (watch.before.get(path) === true) {
      // 点击前就可见：只有按钮文本里出现同名文件时才认（重复点击同一个已打开的文件）
      if (watch.text !== '' && watch.text.includes(baseNameOf(path))) matched.push(path)
      continue
    }
    visible.push(path)
  }
  if (visible.length === 1) return visible[0]
  if (visible.length > 1) {
    const hits = visible.filter((path) => watch.text !== '' && watch.text.includes(baseNameOf(path)))
    return hits.length === 1 ? hits[0] : ''
  }
  return matched.length === 1 ? matched[0] : ''
}

function stopPreviewWatch() {
  const watch = previewWatch
  if (watch === null) return
  previewWatch = null
  try { watch.observer?.disconnect() } catch { /* noop */ }
  try { clearTimeout(watch.pollTimer) } catch { /* noop */ }
  try { clearTimeout(watch.deadlineTimer) } catch { /* noop */ }
}

/** 预览头部解析出绝对路径 → 停表并请主进程打开（同一轮只发一次）。 */
function openResolvedPreview(watch, path) {
  if (watch.done) return
  watch.done = true
  stopPreviewWatch()
  const pending = ipcRenderer.invoke(FILE_OPEN.OPEN, { path, mode: watch.mode })
  if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 失败只留主进程日志 */ })
}

/**
 * 放行点击后观察 DSH 预览头部解析出的绝对路径。
 * @param {'open'|'reveal'} mode Ctrl+Shift 时定位而不是打开
 * @param {string} buttonText 按钮可见文本（用于在多个预览页里收敛）
 */
function watchPreviewResolution(mode, buttonText) {
  stopPreviewWatch()
  const watch = {
    mode,
    text: typeof buttonText === 'string' ? buttonText.trim().toLowerCase() : '',
    before: previewPathEntries(),
    done: false,
    observer: null,
    pollTimer: null,
    deadlineTimer: null,
  }
  previewWatch = watch
  const check = () => {
    if (watch.done) return true
    const candidate = previewCandidate(watch)
    if (candidate === '') return false
    openResolvedPreview(watch, candidate)
    return true
  }
  try {
    if (typeof MutationObserver === 'function') {
      watch.observer = new MutationObserver(() => { check() })
      const root = (typeof document !== 'undefined' && document.documentElement) || document
      watch.observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['title', 'hidden', 'aria-hidden'],
      })
    }
  } catch { watch.observer = null }
  // 轮询兜底：MutationObserver 漏掉（React 原地改属性/可见性切换）时也能在 2 秒内收敛
  const tick = () => {
    if (watch.done) return
    if (check()) return
    watch.pollTimer = setTimeout(tick, PREVIEW_POLL_MS)
  }
  watch.pollTimer = setTimeout(tick, PREVIEW_POLL_MS)
  watch.deadlineTimer = setTimeout(() => {
    if (watch.done) return
    watch.done = true
    stopPreviewWatch()
  }, PREVIEW_WAIT_MS)
}

/** 直接打开/定位一个已验证的绝对路径（拦下 DSH 的右侧栏预览）。 */
function openAbsolutePath(path, event) {
  try { event.preventDefault() } catch { /* noop */ }
  try { event.stopImmediatePropagation() } catch { /* noop */ }
  const mode = event.shiftKey ? 'reveal' : 'open'
  const pending = ipcRenderer.invoke(FILE_OPEN.OPEN, { path, mode })
  if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 失败只留主进程日志 */ })
}

/** 捕获阶段拦截 Ctrl/Cmd+点击；返回是否拦截（测试/调试用）。 */
function interceptFileOpenClick(event) {
  try {
    if (!event.ctrlKey && !event.metaKey) return false
    const button = clickButton(event.target)
    if (button === null) return false
    const title = buttonTitle(button)
    // A) title 直接是本地绝对路径（含 `@C:\…` 形式的提及）：不打开预览，直接交给主进程
    const absolute = absoluteFilePath(title)
    if (absolute !== '') {
      openAbsolutePath(absolute, event)
      return true
    }
    // B) title 是相对路径（相对路径链接 / 相对 @ 提及）：用「点击所在会话 + DSH 工作区映射」还原绝对路径，
    //    能还原就同样不打开预览；还原不出来就放行 DSH 原行为，绝不猜路径。
    const relative = unmentioned(title)
    if (relative !== '') {
      const sessionId = sessionIdNear(button)
      if (sessionId !== '') {
        const resolved = resolveRelativePath(sessionId, relative)
        if (resolved !== '') {
          openAbsolutePath(resolved, event)
          return true
        }
      }
    }
    // C) title 缺失/不可解析（图片链接等）：放行 DSH 打开右侧栏预览，再从预览头部读 Host 解析后的绝对路径
    watchPreviewResolution(event.shiftKey ? 'reveal' : 'open', button.textContent)
    return false
  } catch {
    return false
  }
}

function installFileOpenShortcut(origin) {
  if (!isFileOpenPage(origin)) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  window.addEventListener('click', (event) => { interceptFileOpenClick(event) }, true)
}

const fileOpenOrigin = readFileOpenOrigin()
if (fileOpenOrigin) installFileOpenShortcut(fileOpenOrigin)
