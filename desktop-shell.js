// desktop-shell.js — DSHL 把 DSH 当"桌面壳"来跑时，需要主进程提供的那一半
//
// 背景：DSH 的"桌面能力"不是看 UA，而是两件事同时成立：
//   1) html[data-platform] 存在 → dsh-client-shortcuts 的 detectEnvironment() 进 desktop runtime；
//   2) window.dshDesktop.keyboard / .shortcuts 给出**原生键盘事件源**与**键位持久化适配器**。
// 只做 1 不做 2 会让快捷键服务在构造时直接 throw（"Desktop keyboard bridge unavailable"），
// 而且所有 inject: ["shortcuts"] 的插件会连锁失败。因此本模块 init/prepare 失败时必须 fail-closed：
// preload 的同步配置返回 enabled=false，页面退回 web runtime（与今天行为一致）。
//
// 明确不提供（2026-10-27 决策）：
//   · updates —— 上游桌面版的更新指示；dshl 有自己的更新器，不需要 DSH 再显示一份
//   · browser / protocolVersion —— 侧边栏浏览器继续走 iframe 回落，不接管 Electron guest
//
// 键盘事件契约（来自 dsh-client-shortcuts 的 installNativeKeyboard）：
//   { kind: 'keyboard', revision, code, control, alt, shift, meta, repeat }
//   revision 必须等于当前快捷键配置 revision，渲染端不等就直接丢弃 —— 所以 revision 由本模块随
//   ShortcutPersistence 快照维护，并给每个转发事件盖章。
//
// 键位持久化适配器契约（desktopShortcutStorage 返回的就是本模块的 shortcuts 对象）：
//   get(definitions) -> Promise<snapshot>；edit(edit, revision) -> Promise<result>；
//   subscribe(publish) -> unsubscribe；recording(active) -> Promise；dispose()
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const CHANNELS = {
  CONFIG: 'dshl:desktop-shell:config',
  KEYBOARD: 'dshl:desktop-shell:keyboard',
  SHORTCUTS_GET: 'dshl:desktop-shell:shortcuts:get',
  SHORTCUTS_EDIT: 'dshl:desktop-shell:shortcuts:edit',
  SHORTCUTS_RECORDING: 'dshl:desktop-shell:shortcuts:recording',
  SHORTCUTS_SNAPSHOT: 'dshl:desktop-shell:shortcuts:snapshot',
  CLOSE_WINDOW: 'dshl:desktop-shell:close-window',
}

// 快捷键持久化文件与上游桌面版同路径语义（错误文案里写的就是 userData/keybindings.json）
const KEYBINDINGS_BASENAME = 'keybindings.json'

let opts = null
let ipcMain = null
let persistence = null
let revision = ''
let recording = false
let prepared = null // Promise<{ ok, error }>，防止并发重复初始化
let state = { ready: false, error: '' }
let protocol = null
let protocolPath = ''
let protocolVersion = ''

// ---------- 纯函数（可单测，不碰 Electron / 磁盘） ----------

/** @param {string} platform process.platform @returns {'windows'|'macos'|'linux'} DSH 的 platform 名 */
function shortcutPlatformName(platform) {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

/** 修饰键本身不该被当成一次按键转发（DSH 的 DOM 适配器同样忽略它们）。 */
function isModifierOnlyCode(code) {
  return typeof code === 'string' && /^(Control|Alt|Shift|Meta)(Left|Right)$/u.test(code)
}

/**
 * 把一个 Electron before-input-event 的 input 变成 DSH 原生键盘桥认识的载荷。
 * @param {object} input Electron input（type/key/code/control/alt/shift/meta/isAutoRepeat）
 * @param {string} currentRevision 当前快捷键配置 revision；空表示配置还没读出来
 * @returns {object|null} 载荷；不满足转发条件时为 null
 */
function normalizeForwardInput(input, currentRevision) {
  if (!input || typeof input !== 'object') return null
  if (input.type !== 'keyDown') return null
  if (typeof currentRevision !== 'string' || !currentRevision) return null
  const code = typeof input.code === 'string' ? input.code : ''
  if (!code || code === 'Unidentified' || isModifierOnlyCode(code)) return null
  return {
    kind: 'keyboard',
    revision: currentRevision,
    code,
    control: !!input.control,
    alt: !!input.alt,
    shift: !!input.shift,
    meta: !!input.meta,
    repeat: !!input.isAutoRepeat,
  }
}

/**
 * 给 preload 的同步配置：只有"开关打开 + 桥已就绪 + 登录辅助已被当前服务加载"才算启用（fail-closed）。
 * 第三条是升级默认开启后的安全闸：adopted 服务没装/没加载登录辅助时，切 desktop 会让登录退化成复制链接。
 * @param {{enabled:boolean, ready:boolean, loginReady?:boolean, host:string, port:number, platform:string}} value
 */
function preloadConfig(value) {
  const enabled = !!(value && value.enabled && value.ready && value.loginReady)
  return {
    enabled,
    host: typeof value?.host === 'string' ? value.host : '127.0.0.1',
    port: Number.isInteger(value?.port) ? value.port : 3080,
    platform: typeof value?.platform === 'string' ? value.platform : 'win32',
  }
}

/**
 * 按 DSH 安装形态给出 shortcuts protocol.js 的候选路径（首个存在者胜）。
 * 只做路径枚举，不判断版本；调用方再做入口与版本校验。
 * @param {{dshBin?:string, harnessRoot?:string}} layout
 * @returns {string[]} 候选绝对路径
 */
function resolveProtocolCandidates(layout) {
  const out = []
  const dshBin = layout && typeof layout.dshBin === 'string' ? layout.dshBin : ''
  const harnessRoot = layout && typeof layout.harnessRoot === 'string' ? layout.harnessRoot : ''
  if (dshBin) {
    // 全局安装：<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js
    //   → dshPkgRoot = <prefix>/node_modules/@deepseek-ai/dsh
    //   → 其依赖树里的 shortcuts 包
    const dshPkgRoot = path.resolve(path.dirname(dshBin), '..')
    out.push(path.join(dshPkgRoot, 'node_modules', '@deepseek-ai', 'dsh-client-shortcuts', 'lib', 'protocol.js'))
    // pnpm / 提升布局：@deepseek-ai/dsh 与 @deepseek-ai/dsh-client-shortcuts 平级
    out.push(path.resolve(dshPkgRoot, '..', 'dsh-client-shortcuts', 'lib', 'protocol.js'))
  }
  if (harnessRoot) {
    // 源码仓库：<root>/packages/client/shortcuts/lib/protocol.js
    out.push(path.join(harnessRoot, 'packages', 'client', 'shortcuts', 'lib', 'protocol.js'))
  }
  const seen = new Set()
  return out.filter((p) => {
    if (!p || seen.has(p)) return false
    seen.add(p)
    return true
  })
}

/** 读 JSON；失败返回 undefined（调用方决定 fail-closed 还是降级）。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** @returns {{ ok: boolean, error?: string, protocolPath?: string, version?: string, dshVersion?: string }} */
function inspectProtocol(candidates, dshRoot) {
  const existing = (candidates || []).find((file) => {
    try { return fs.statSync(file).isFile() } catch { return false }
  })
  if (!existing) return { ok: false, error: '找不到 dsh-client-shortcuts/lib/protocol.js（DSH 安装树布局不认识）' }
  const pkgRoot = path.resolve(path.dirname(existing), '..')
  const pkg = readJson(path.join(pkgRoot, 'package.json')) || {}
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  // DSH 包的版本：全局安装时 dsh 根 package.json 与 shortcuts 同属一个 monorepo 发布批次，
  // 版本必须一致；源码布局可能没有稳定版本号 → 只告警不拒绝（真正兜底是入口导出形状校验）。
  const dshPkg = dshRoot ? readJson(path.join(dshRoot, 'package.json')) : undefined
  const dshVersion = dshPkg && typeof dshPkg.version === 'string' ? dshPkg.version : ''
  if (version && dshVersion && version !== dshVersion) {
    return {
      ok: false,
      error: `DSH 与 shortcuts 包版本不一致（dsh ${dshVersion} / shortcuts ${version}），拒绝启用桌面壳`,
    }
  }
  return { ok: true, protocolPath: existing, version, dshVersion }
}

// ---------- 生命周期 ----------

/**
 * 注册 IPC、保存依赖。必须在创建任何 DSH 标签页之前调用（preload 会同步取配置）。
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain
 * @param {(line:string)=>void} options.log
 * @param {()=>boolean} options.isEnabled 配置开关（Config.desktopShell）
 * @param {()=>boolean} options.isLoginReady 登录辅助是否已被当前服务加载（激活闸门）
 * @param {()=>({host:string,port:number})} options.getOrigin
 * @param {(event:object)=>boolean} options.isTrustedSender 发送方是否 DSH 应用页
 * @param {()=>Array<{view:{webContents:object}}>} options.getTabs
 * @param {()=>void} options.closeWindow 关/隐藏 DSH 窗口
 * @param {string} options.userDataDir Electron userData 目录
 * @param {string} options.platform process.platform
 */
// 同步配置通道必须早于任何窗口创建就注册：preload 用 sendSync 在页面脚本执行前取配置，
// 没有 handler 时渲染进程会卡在同步 IPC 上（SELF_TEST 曾经因此挂死于 did-finish-load 之前）。
let configChannelRegistered = false
let configAccessors = null

/**
 * 只注册 preload 的同步配置通道（幂等）。main.js 在模块加载期就调用一次，
 * 保证 SELF_TEST 等提前创建窗口的路径也有 handler；init() 里会再兜底调用一次。
 * @param {import('electron').IpcMain} targetIpc
 * @param {{isEnabled?:()=>boolean, isLoginReady?:()=>boolean, getOrigin?:()=>({host:string,port:number}), platform?:string}} accessors
 */
function registerConfigChannel(targetIpc, accessors) {
  if (configChannelRegistered || !targetIpc) return
  configChannelRegistered = true
  configAccessors = accessors || {}
  targetIpc.on(CHANNELS.CONFIG, (event) => {
    let config = { enabled: false }
    try {
      const origin = typeof configAccessors.getOrigin === 'function' ? configAccessors.getOrigin() : {}
      config = preloadConfig({
        enabled: typeof configAccessors.isEnabled === 'function' && configAccessors.isEnabled(),
        ready: state.ready,
        loginReady: typeof configAccessors.isLoginReady === 'function' && configAccessors.isLoginReady(),
        host: origin && origin.host,
        port: origin && origin.port,
        platform: configAccessors.platform,
      })
    } catch {
      config = { enabled: false }
    }
    // 同步回复：preload 必须在页面脚本执行前就决定是否暴露 dshDesktop / data-platform
    event.returnValue = config
  })
}

function init(options) {
  if (opts) return
  opts = options || {}
  ipcMain = opts.ipcMain
  registerConfigChannel(ipcMain, {
    isEnabled: opts.isEnabled,
    isLoginReady: opts.isLoginReady,
    getOrigin: opts.getOrigin,
    platform: opts.platform,
  })

  const trusted = (event) => {
    try {
      return !!(event && event.sender && typeof opts.isTrustedSender === 'function' && opts.isTrustedSender(event))
    } catch {
      return false
    }
  }

  if (ipcMain) {
    ipcMain.handle(CHANNELS.SHORTCUTS_GET, (event, definitions) => {
      if (!trusted(event)) throw new Error('untrusted desktop shell sender')
      if (!persistence) throw new Error('desktop shortcuts bridge is not ready')
      if (!Array.isArray(definitions)) throw new Error('invalid shortcut definitions')
      persistence.setDefinitions(definitions)
      return persistence.readCurrent()
    })
    ipcMain.handle(CHANNELS.SHORTCUTS_EDIT, (event, edit, reviewedRevision) => {
      if (!trusted(event)) throw new Error('untrusted desktop shell sender')
      if (!persistence) throw new Error('desktop shortcuts bridge is not ready')
      return persistence.edit(edit, reviewedRevision)
    })
    ipcMain.handle(CHANNELS.SHORTCUTS_RECORDING, (event, active) => {
      if (!trusted(event)) throw new Error('untrusted desktop shell sender')
      recording = active === true
      return true
    })
    ipcMain.handle(CHANNELS.CLOSE_WINDOW, (event, requestRevision) => {
      if (!trusted(event)) throw new Error('untrusted desktop shell sender')
      if (typeof requestRevision === 'string' && requestRevision && revision && requestRevision !== revision) return false
      try {
        if (typeof opts.closeWindow === 'function') opts.closeWindow()
        return true
      } catch {
        return false
      }
    })
  }
}

/**
 * 连接 DSH 安装树里的 ShortcutPersistence 并开始对外提供桥能力。
 * 幂等；失败只记录并保持 ready=false（preload 会退回 web runtime）。
 * @param {{dshBin?:string, harnessRoot?:string}} layout
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function prepare(layout) {
  if (prepared) return prepared
  prepared = (async () => {
    try {
      const layoutInfo = layout || {}
      const dshRoot = layoutInfo.dshBin
        ? path.resolve(path.dirname(layoutInfo.dshBin), '..')
        : (layoutInfo.harnessRoot || '')
      const inspect = inspectProtocol(resolveProtocolCandidates(layoutInfo), dshRoot)
      if (!inspect.ok) throw new Error(inspect.error)
      protocolPath = inspect.protocolPath
      protocolVersion = inspect.version || ''
      protocol = await import(pathToFileURL(protocolPath).href)
      if (typeof protocol.ShortcutPersistence !== 'function') {
        throw new Error('protocol.js 缺少 ShortcutPersistence 导出（DSH 版本不兼容）')
      }
      const file = path.join(opts.userDataDir, KEYBINDINGS_BASENAME)
      persistence = new protocol.ShortcutPersistence({
        read: async () => {
          try {
            return await fs.promises.readFile(file, 'utf8')
          } catch (error) {
            if (error && error.code === 'ENOENT') return null
            throw error
          }
        },
        write: async (raw) => {
          await fs.promises.mkdir(path.dirname(file), { recursive: true })
          const tmp = file + '.tmp-' + process.pid
          await fs.promises.writeFile(tmp, raw)
          await fs.promises.rename(tmp, file)
        },
      }, 'desktop', shortcutPlatformName(opts.platform), true, publish)
      state = { ready: true, error: '' }
      revision = ''
      log('desktop-shell: ready（protocol ' + (protocolVersion || '?') + '，keybindings=' + file + '）')
      return { ok: true }
    } catch (error) {
      state = { ready: false, error: (error && error.message) || String(error) }
      log('desktop-shell: 不可用，退回 web runtime：' + state.error)
      return { ok: false, error: state.error }
    }
  })()
  return prepared
}

function publish(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  if (typeof snapshot.revision === 'string') revision = snapshot.revision
  for (const tab of tabs()) {
    try {
      const wc = tab && tab.view && tab.view.webContents
      if (!wc || wc.isDestroyed()) continue
      wc.send(CHANNELS.SHORTCUTS_SNAPSHOT, snapshot)
    } catch { /* 单个标签页发送失败不影响其它标签页 */ }
  }
}

/** @returns {boolean} 桥是否就绪（preload 的 enabled 也依赖它） */
function ready() {
  return state.ready && !!persistence
}

function recordingActive() {
  return recording
}

/** @returns {{ready:boolean,error:string,revision:string,protocolPath:string,version:string}} 诊断用 */
function getState() {
  return {
    ready: ready(),
    error: state.error,
    revision,
    protocolPath,
    version: protocolVersion,
  }
}

/**
 * 把一次按键转发给渲染进程的 DSH 快捷键注册表。
 * 调用方（webCreateTab 的 before-input-event）在 dshl 自己不接管该键时才调用。
 * @param {object} wc Electron WebContents
 * @param {object} input before-input-event 的 input
 * @returns {boolean} 是否真的发出
 */
function forwardKey(wc, input) {
  if (!ready() || recording) return false
  if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false
  const payload = normalizeForwardInput(input, revision)
  if (!payload) return false
  try {
    wc.send(CHANNELS.KEYBOARD, payload)
    return true
  } catch {
    return false
  }
}

/**
 * 清理 IPC；幂等。窗口销毁/应用退出时调用。
 * 注意：就绪标记文件由 main.js 统一维护（它才知道"当前服务是否加载过登录辅助"），本模块不碰磁盘标记。
 */
function dispose() {
  try { persistence?.dispose?.() } catch { /* noop */ }
  persistence = null
  revision = ''
  recording = false
  state = { ready: false, error: 'disposed' }
  prepared = null
  if (ipcMain) {
    for (const channel of [CHANNELS.SHORTCUTS_GET, CHANNELS.SHORTCUTS_EDIT, CHANNELS.SHORTCUTS_RECORDING, CHANNELS.CLOSE_WINDOW]) {
      try { ipcMain.removeHandler(channel) } catch { /* noop */ }
    }
    try { ipcMain.removeAllListeners(CHANNELS.CONFIG) } catch { /* noop */ }
  }
  configChannelRegistered = false
  configAccessors = null
}

function log(message) {
  try { opts?.log?.(message) } catch { /* noop */ }
}

function tabs() {
  try {
    const list = typeof opts?.getTabs === 'function' ? opts.getTabs() : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

module.exports = {
  CHANNELS,
  KEYBINDINGS_BASENAME,
  init,
  registerConfigChannel,
  prepare,
  ready,
  recordingActive,
  forwardKey,
  getState,
  dispose,
  // 纯函数（单测用）
  shortcutPlatformName,
  isModifierOnlyCode,
  normalizeForwardInput,
  preloadConfig,
  resolveProtocolCandidates,
  inspectProtocol,
}
