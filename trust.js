// trust.js — IPC 命令桥的信任判定（纯决策函数：无 IO、无 Electron 依赖，便于单测）
//
// 为什么需要它：每个 WebUI 页面视图都挂了 browser-preload 桥，所以 DSH 页面（或用户在其中跳转到的
// 任意站点）也能拿到 window.browserBridge。若不校验来源，那个页面就能调 browser:* 改端口/重启服务/
// 关窗口。判定规则收在这里，主进程只负责把 event.sender 归类成描述对象。
//
// 发送方分类：
//   console —— DSHL 控制台（index.html 挂在 WebContentsView）：自己人，全部命令放行
//   shell —— 独立窗口壳（browser.html）：自己人，全部命令放行
//   tab   —— WebUI 窗口里的页面视图（WebContentsView）：默认一律拒绝，唯一例外是说明页（见下）
//   none  —— 不是我们的任何视图：一律拒绝
'use strict'

// 说明页自己会用的命令（ui-src/loading.js）：重载此页 / 换端口并启动 / 重启服务以恢复访问 /
// 执行一个恢复动作 / 跳转到控制台的某个页面。
// 信任边界必须收在这几条上——DSH 页面（或用户在其中跳转到的站点）拿不到这份信任。
//
// 为什么新增的 `browser:repairBoot` 是安全的（加在这里之前先确认这三件事仍然成立）：
//   ① 它的载荷只有一个 action id，且必须在 recovery-plan.ACTION_IDS 内；真正的目标（哪个插件、
//      哪个槽位）由主进程从账本现算，页面既无法指定也无法伪造；
//   ② 每个**写**动作还要过一次原生确认框，默认焦点在「取消」（回车不写）；
//   ③ 它不接受任何路径/包名参数，因此不存在"借说明页改任意文件"的面。
//
// `browser:openConsole` 的来历要说清楚，因为**这颗按钮以前被删过一次**（2026-09，用户要求）：
// 当时那颗按钮写的是「打开 DSHL 控制台（更换端口）」，点下去跑的却是 fixPane（重载本页），
// 属于"说了不做"—— 删的是那个谎，不是"说明页不许有导航"这条规矩。
// 2026-10 用户明确要求恢复一个「管理插件」入口，所以按下面的约束加回来：
//   ① 载荷只有一个页面 key，且必须在 recovery-plan.CONSOLE_PAGES 内（页面无法指定 URL/路径）；
//   ② 它**不改任何状态**，只是把控制台显示到那一页；
//   ③ 触发它的理由是可验证的：插件类失败时，失败页只能处理一个包，而清单能一次看完。
const LOADING_PAGE_COMMANDS = new Set([
  'browser:fixPane',
  'browser:blockSwitch',
  'browser:authRestart',
  'browser:repairBoot',
  'browser:openConsole',
])

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
 * @param {{kind: 'console'|'shell'|'tab'|'none', url?: string}} sender 发送方（由主进程归类）
 * @param {string} loadingPageUrl 本机 wwwroot/loading.html 的 file:// URL
 * @param {string} name IPC 命令名
 * @returns {'allow'|'deny'}
 */
function decideCommand(sender, loadingPageUrl, name) {
  const kind = sender && sender.kind
  if (kind === 'console' || kind === 'shell') return 'allow'
  if (kind !== 'tab') return 'deny'
  if (!LOADING_PAGE_COMMANDS.has(name)) return 'deny'
  return isLoadingPageUrl(sender.url, loadingPageUrl) ? 'allow' : 'deny'
}

/**
 * 发送方是否就是 DSH 应用页（桌面壳桥的唯一信任域）。
 *
 * 桌面壳桥（dshl:desktop-shell:*）会持久化键位、驱动原生快捷键、关窗口，只能给 DSH 应用页；
 * 说明页（file://）、外部站点、浏览器标签的其它页面一律不给。判定用「同源 + 路径前缀」，
 * 不能用裸 startsWith：`http://127.0.0.1:3080.evil` 不该过。
 * @param {string} url 发送方当前 URL（webContents.getURL()）
 * @param {string} webUrl 本机 DSH 根地址（http://127.0.0.1:<port>，不含尾斜杠）
 * @returns {boolean}
 */
function isDshAppUrl(url, webUrl) {
  if (typeof url !== 'string' || typeof webUrl !== 'string') return false
  if (!url || !webUrl) return false
  const base = webUrl.endsWith('/') ? webUrl.slice(0, -1) : webUrl
  if (!base) return false
  return url === base || url.startsWith(base + '/')
}

module.exports = { LOADING_PAGE_COMMANDS, isLoadingPageUrl, decideCommand, isDshAppUrl }
