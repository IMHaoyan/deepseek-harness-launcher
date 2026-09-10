// trust.js — IPC 命令桥的信任判定（纯决策函数：无 IO、无 Electron 依赖，便于单测）
//
// 为什么需要它：每个 WebUI 页面视图都挂了 browser-preload 桥，所以 DSH 页面（或用户在其中跳转到的
// 任意站点）也能拿到 window.browserBridge。若不校验来源，那个页面就能调 browser:* 改端口/重启服务/
// 关窗口。判定规则收在这里，主进程只负责把 event.sender 归类成描述对象。
//
// 发送方分类：
//   panel —— 启动器面板（index.html）：自己人，全部命令放行
//   shell —— 独立窗口壳（browser.html）：自己人，全部命令放行
//   tab   —— WebUI 窗口里的页面视图（WebContentsView）：默认一律拒绝，唯一例外是说明页（见下）
//   none  —— 不是我们的任何视图：一律拒绝
'use strict'

// 说明页自己会用的命令（ui-src/loading.js）：重载此页 / 换端口并启动 / 重启服务以恢复访问。
// 信任边界必须收在这三条上——DSH 页面（或用户在其中跳转到的站点）拿不到这份信任。
const LOADING_PAGE_COMMANDS = new Set(['browser:fixPane', 'browser:blockSwitch', 'browser:authRestart'])

/**
 * URL 是否就是说明页本身。允许带 query/hash（loadingUrl() 生成的就是 `…loading.html?reason=…`），
 * 但不能用裸 startsWith：`…loading.htmlX` 这类同前缀地址不该被当成说明页。
 * @param {string} url 发送方当前 URL
 * @param {string} loadingPageUrl 本机 wwwroot/loading.html 的 file:// URL（不含 query）
 * @returns {boolean}
 */
function isLoadingPageUrl(url, loadingPageUrl) {
  if (typeof url !== 'string' || typeof loadingPageUrl !== 'string') return false
  if (!url || !loadingPageUrl) return false
  return url === loadingPageUrl || url.startsWith(loadingPageUrl + '?') || url.startsWith(loadingPageUrl + '#')
}

/**
 * 命令准入判定：只有自己人页面、以及"确实是本机说明页"的标签视图可以调命令。
 * @param {{kind: 'panel'|'shell'|'tab'|'none', url?: string}} sender 发送方（由主进程归类）
 * @param {string} loadingPageUrl 本机 wwwroot/loading.html 的 file:// URL
 * @param {string} name IPC 命令名
 * @returns {'allow'|'deny'}
 */
function decideCommand(sender, loadingPageUrl, name) {
  const kind = sender && sender.kind
  if (kind === 'panel' || kind === 'shell') return 'allow'
  if (kind !== 'tab') return 'deny'
  if (!LOADING_PAGE_COMMANDS.has(name)) return 'deny'
  return isLoadingPageUrl(sender.url, loadingPageUrl) ? 'allow' : 'deny'
}

module.exports = { LOADING_PAGE_COMMANDS, isLoadingPageUrl, decideCommand }
