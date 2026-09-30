// page-keys.js — 页面视图 / 窗口壳的按键归属决策（纯函数，无副作用、无 Electron 依赖）
//
// 为什么要把这件事单独拎出来：
//
// dshl 的接管方式是「黑名单吞键」——只对极少数组合 preventDefault，其余一律放行给页面。
// 这是对的：DSH 的快捷键服务在 web runtime 下走 DOM keydown，dshl 不碰的键它都能自己处理，
// 所以上游新增绑定不需要 dshl 做任何事。
//
// 但代价是：这里每多一条分支，就可能悄悄抢走一个 DSH 正在用的键，而且**没有任何机制会提醒你**。
// 2026-09 的事故就是这么来的：查找条加 Ctrl+F 时没排除 Shift，而按住 Shift 时
// input.key 是 'F'，小写化后与 'f' 相等 —— Ctrl+Shift+F 被当成「页面查找」吞掉，
// DSH 的「分叉会话」静默失效，直到用户逐项核对快捷键才被发现。
//
// 所以：判定全部收进这个纯函数，并由 tests/page-keys.test.js 的归属网格钉死 ——
// 任何新增拦截都会让那份网格变红，逼改动者回答「这个键和 DSH 冲突吗」。
//
// 三条铁律（改这里的条件前先读一遍）：
//   1) 只认「裸」组合。带 Shift/Alt 的变体一律让给 DSH —— 上游的默认绑定大量使用
//      Ctrl+Alt+X / Ctrl+Shift+X（那正是它白名单允许的形态）。
//   2) 有功能开关的动作必须跟着开关走。分屏恒关时仍吞 Ctrl+\ 的话，按键既被 preventDefault
//      又什么都不发生，是个死键；而 Ctrl+\ 恰好是 DSH 白名单里**允许**绑定的少数单修饰键之一。
//   3) 拿不准就放行。返回 null 的成本是「快捷键可能不生效」，误吞的成本是「用户的键凭空消失」。
'use strict'

/** 页面视图：完整接管集（查找条 + 分屏 + 聚焦分屏 + 刷新） */
const SCOPE_PAGE = 'page'
/** 窗口壳（标签栏焦点）：只接管查找与刷新；分屏一类在壳上没有对应上下文 */
const SCOPE_SHELL = 'shell'

/** 判定结果的动作名，main.js 的 switch 按这些名字派发副作用。 */
const ACTIONS = [
  'find-open', // 打开页面查找条
  'find-close', // 关闭查找条
  'find-prev', // 查找：上一处
  'find-next', // 查找：下一处
  'find-submit', // 查找条输入框回车（forward 区分正/反向）
  'split-toggle', // 切换分屏
  'pane-close', // 关闭聚焦分屏
  'pane-swap', // 交换左右分屏
  'pane-reload', // 刷新聚焦页
]

/**
 * 判定一次按键是否由 dshl 接管。
 * @param {{type?:string,key?:string,control?:boolean,meta?:boolean,shift?:boolean,alt?:boolean}} input
 *        Electron before-input-event 的 input 对象（只读取这几个字段）。
 * @param {{scope?:string,tabsEnabled?:boolean,findOpen?:boolean,findInputFocused?:boolean}} [state]
 *        scope 缺省按页面视图处理；tabsEnabled 仅在页面视图下有意义。
 * @returns {{action:string,forward?:boolean}|null} null = 放行给页面（不 preventDefault）。
 */
function routeKey(input, state) {
  const opts = state || {}
  if (!input || input.type !== 'keyDown') return null

  const scope = opts.scope === SCOPE_SHELL ? SCOPE_SHELL : SCOPE_PAGE
  const key = String(input.key || '').toLowerCase()
  // 只有查找条用 mod（macOS 上 Cmd+F 是查找惯例）；其余动作沿用历史判据 input.control，
  // 不在这里统一成 mod —— 那会顺手改掉 macOS 上的既有行为，属于超范围变更。
  const mod = !!(input.control || input.meta)

  // ① 查找条开关：只认裸 Ctrl/Cmd+F。Shift/Alt 变体必须让过去（铁律 1）。
  if (mod && key === 'f' && !input.shift && !input.alt) return { action: 'find-open' }

  // ② 查找条自身的键盘交互。这是有意的模态接管：只在查找条打开期间生效，关掉即归还。
  if (opts.findOpen) {
    if (input.key === 'Escape') return { action: 'find-close' }
    if (input.key === 'F3') return { action: 'find-prev' }
    if (input.key === 'F4') return { action: 'find-next' }
    if (opts.findInputFocused && input.key === 'Enter') return { action: 'find-submit', forward: !input.shift }
  }

  // ③ 分屏相关：只在页面视图有意义（窗口壳没有分屏上下文）。
  if (scope === SCOPE_PAGE) {
    // 跟着功能开关走（铁律 2）：分屏恒关时这里返回 null，Ctrl+\ 交还给 DSH。
    if (input.control && key === '\\' && opts.tabsEnabled) return { action: 'split-toggle' }
    if (input.control && input.key === 'Delete') return { action: 'pane-close' }
    if (input.shift && input.alt && key === 's') return { action: 'pane-swap' }
  }

  // ④ 刷新聚焦页：F5，以及裸 Ctrl+R。
  //    判据必须同时排除 Shift 与 Alt —— 与 ① 同一个根因：按住 Shift 时 input.key 是 'R'，
  //    小写化后等于 'r'，于是 Ctrl+Shift+R 也被吞。而 Ctrl+Shift+<字母> 正是 DSH 白名单
  //    **允许**绑定的形态（它的默认值里就有 Ctrl+Shift+F/O/B），必须留空档给它。
  //    Ctrl+Alt+R 则是 DSH 的「刷新当前页面」。
  if (input.key === 'F5' || (input.control && key === 'r' && !input.shift && !input.alt)) return { action: 'pane-reload' }

  return null
}

module.exports = { routeKey, ACTIONS, SCOPE_PAGE, SCOPE_SHELL }
