// tests/page-keys.test.js — 按键归属契约（2026-09-30）
//
// 为什么需要这份测试：
//
// dshl 接管页面快捷键用的是「黑名单吞键」——只对极少数组合 preventDefault，其余放行给
// DSH 的 DOM 键盘分发。好处是上游新增绑定自动生效；坏处是**没有任何机制**会提醒你
// "新加的这条拦截抢走了 DSH 正在用的键"。
//
// 已经发生过的事故：给查找条加 Ctrl+F 时没排除 Shift。按住 Shift 时 Electron 的
// input.key 是 'F'，小写化后与 'f' 相等，于是 Ctrl+Shift+F 被当成「页面查找」吞掉，
// DSH 的「分叉会话」静默失效。Ctrl+Shift+R 是同一个根因的第二处。
//
// 所以这里把归属钉成契约：
//   1) CASES —— 可读的表格，逐条写明谁归谁、为什么
//   2) 归属网格 —— 把"被 dshl 接管的组合集合"整体钉死：任何新增拦截都会让网格变红，
//      逼改动者先回答"这个组合在不在 DSH 的绑定空间里"
//   3) 形态护栏 —— 断言 DSH 实际使用的绑定形态绝不被接管
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { routeKey, ACTIONS, SCOPE_PAGE, SCOPE_SHELL } = require('../page-keys')

const PAGE = { scope: SCOPE_PAGE, tabsEnabled: true, findOpen: false, findInputFocused: false }
const PAGE_NO_SPLIT = { ...PAGE, tabsEnabled: false } // 分屏恒关（当前线上形态）
const SHELL = { scope: SCOPE_SHELL, findOpen: false, findInputFocused: false }
const FIND_OPEN = { ...PAGE, findOpen: true }
const FIND_TYPING = { ...FIND_OPEN, findInputFocused: true }

/** 造一个 before-input-event 的 input；未指定的修饰键一律 false（Electron 不会给 undefined）。 */
function k(key, mods = {}) {
  return { type: 'keyDown', key, control: false, meta: false, shift: false, alt: false, ...mods }
}

// ---------- ① 可读的归属表 ----------
const CASES = [
  // ── 本次修复的泄漏：带 Shift/Alt 的字母变体必须放行 ──
  // 根因：Shift 会让 input.key 变成大写，小写化后与裸键相等，于是 Shift 变体被误吞。
  // 而 Ctrl+Shift+<字母> 正是 DSH 白名单**允许**绑定的形态（默认值里就有 Ctrl+Shift+F/O/B）。
  ['DSH 分叉会话 Ctrl+Shift+F 放行', k('F', { control: true, shift: true }), PAGE, null],
  ['Ctrl+Shift+Alt+F 放行', k('F', { control: true, shift: true, alt: true }), PAGE, null],
  ['DSH 刷新当前页面 Ctrl+Alt+R 放行', k('r', { control: true, alt: true }), PAGE, null],
  ['Ctrl+Shift+R 放行（与 Ctrl+Shift+F 同一根因）', k('R', { control: true, shift: true }), PAGE, null],
  ['分屏恒关时 Ctrl+\\ 放行（否则是"按下无反应"的死键）', k('\\', { control: true }), PAGE_NO_SPLIT, null],

  // ── dshl 自己要保住的动作 ──
  ['裸 Ctrl+F 归 dshl（查找）', k('f', { control: true }), PAGE, { action: 'find-open' }],
  ['Cmd+F 归 dshl（macOS 查找惯例）', k('f', { meta: true }), PAGE, { action: 'find-open' }],
  ['裸 Ctrl+R 归 dshl（刷新）', k('r', { control: true }), PAGE, { action: 'pane-reload' }],
  ['F5 归 dshl（刷新）', k('F5'), PAGE, { action: 'pane-reload' }],
  ['Ctrl+Del 归 dshl（关闭聚焦分屏）', k('Delete', { control: true }), PAGE, { action: 'pane-close' }],
  ['Shift+Alt+S 归 dshl（交换分屏）', k('s', { shift: true, alt: true }), PAGE, { action: 'pane-swap' }],
  ['分屏开启时 Ctrl+\\ 归 dshl', k('\\', { control: true }), PAGE, { action: 'split-toggle' }],

  // ── 查找条打开期间的模态接管（关掉即归还）──
  ['查找条打开：Esc 关闭', k('Escape'), FIND_OPEN, { action: 'find-close' }],
  ['查找条打开：F3 上一处', k('F3'), FIND_OPEN, { action: 'find-prev' }],
  ['查找条打开：F4 下一处', k('F4'), FIND_OPEN, { action: 'find-next' }],
  ['查找输入框回车：正向', k('Enter'), FIND_TYPING, { action: 'find-submit', forward: true }],
  ['查找输入框 Shift+回车：反向', k('Enter', { shift: true }), FIND_TYPING, { action: 'find-submit', forward: false }],
  ['查找条开着但焦点不在输入框：回车放行给 DSH', k('Enter'), FIND_OPEN, null],
  ['查找条关闭：Esc 放行给 DSH', k('Escape'), PAGE, null],

  // ── 窗口壳 scope：壳上没有分屏上下文 ──
  ['壳：Ctrl+F 查找', k('f', { control: true }), SHELL, { action: 'find-open' }],
  ['壳：F5 刷新', k('F5'), SHELL, { action: 'pane-reload' }],
  ['壳：Ctrl+\\ 不接管', k('\\', { control: true }), SHELL, null],
  ['壳：Ctrl+Del 不接管', k('Delete', { control: true }), SHELL, null],
  ['壳：Shift+Alt+S 不接管', k('s', { shift: true, alt: true }), SHELL, null],
  ['壳：Ctrl+Shift+F 放行', k('F', { control: true, shift: true }), SHELL, null],

  // ── 一律放行的边界 ──
  ['非 keyDown 一律放行', { type: 'keyUp', key: 'f', control: true }, PAGE, null],
  ['无修饰键的普通键放行', k('n'), PAGE, null],
  ['DSH 默认绑定 Ctrl+Alt+N 放行', k('n', { control: true, alt: true }), PAGE, null],
  ['DSH 默认绑定 Ctrl+Alt+K 放行', k('k', { control: true, alt: true }), PAGE, null],
  ['DSH 默认绑定 Ctrl+Alt+Enter 放行', k('Enter', { control: true, alt: true }), PAGE, null],
  ['DSH 默认绑定 Ctrl+/ 放行', k('/', { control: true }), PAGE, null],
  ['DSH 默认绑定 Ctrl+` 放行', k('`', { control: true }), PAGE, null],
]

test('归属表：逐条核对', () => {
  for (const [label, input, state, expected] of CASES) {
    assert.deepEqual(routeKey(input, state), expected, label)
  }
})

test('返回的动作名必须在 ACTIONS 里（main.js 的 switch 靠它对号入座）', () => {
  for (const [, input, state] of CASES) {
    const hit = routeKey(input, state)
    if (hit) assert.ok(ACTIONS.includes(hit.action), `未知动作：${hit.action}`)
  }
})

// ---------- ② 归属网格 ----------
// 输入空间 = 真实键盘的 (物理键, 修饰键) → Electron 给出的 input.key。
// 字母在 Shift 下变大写 —— 这正是本次事故的物理来源，必须如实模拟。
const KEYS = [
  { code: 'KeyF', plain: 'f', upper: true },
  { code: 'KeyR', plain: 'r', upper: true },
  { code: 'KeyS', plain: 's', upper: true },
  { code: 'KeyN', plain: 'n', upper: true },
  { code: 'KeyK', plain: 'k', upper: true },
  { code: 'KeyB', plain: 'b', upper: true },
  { code: 'Backslash', plain: '\\', shifted: '|' },
  { code: 'Backquote', plain: '`', shifted: '~' },
  { code: 'Slash', plain: '/', shifted: '?' },
  { code: 'Escape', plain: 'Escape' },
  { code: 'F3', plain: 'F3' },
  { code: 'F5', plain: 'F5' },
  { code: 'Enter', plain: 'Enter' },
  { code: 'Delete', plain: 'Delete' },
]
const MODS = [
  [], ['control'], ['meta'], ['shift'], ['alt'],
  ['control', 'shift'], ['control', 'alt'], ['shift', 'alt'], ['control', 'shift', 'alt'],
]

function makeInput(entry, mods) {
  const shift = mods.includes('shift')
  let key = entry.plain
  if (entry.shifted !== undefined && shift) key = entry.shifted
  else if (entry.upper && shift) key = entry.plain.toUpperCase()
  return {
    type: 'keyDown', key,
    control: mods.includes('control'), meta: mods.includes('meta'),
    shift, alt: mods.includes('alt'),
  }
}
const labelOf = (entry, mods) => [...mods, entry.code].join('+')
const isOwned = (entry, mods) => routeKey(makeInput(entry, mods), PAGE_NO_SPLIT)

// 契约本体：dshl 在当前形态（分屏恒关）下接管的**全部**组合。
// 新增拦截会让这份清单变化 → 网格失败 → 必须先论证该组合不在 DSH 的绑定空间里。
//
// 每条的安全依据（DSH 的 bindingIssue 判定）：
//   · Ctrl/Cmd+字母（单修饰键）        → unsupported-browser，DSH 不允许绑
//   · Shift+Alt+<字母>（无 primary）   → unsupported-browser
//   · Ctrl+Delete 及各种修饰键变体     → reserved（Delete 在保留键表里，DSH 永不允许）
//   · 全部 *+F5                        → 见下方"已知理论重叠"，DsH 从不使用功能键
//   · Ctrl/Cmd+meta 组合              → reserved（非 mac 平台带 meta 一律保留）
//   · Ctrl+Shift+Alt+S                → 见下方"已知理论重叠"
const EXPECTED_OWNED = [
  // F5：判据 input.key === 'F5' 没有修饰键守卫，因此所有变体都被接管
  'F5 → pane-reload',
  'control+F5 → pane-reload',
  'meta+F5 → pane-reload',
  'shift+F5 → pane-reload',
  'alt+F5 → pane-reload',
  'control+shift+F5 → pane-reload',
  'control+alt+F5 → pane-reload',
  'shift+alt+F5 → pane-reload',
  'control+shift+alt+F5 → pane-reload',
  // Delete：判据 input.control && input.key === 'Delete'，control 在即接管
  //（DSH 对 Delete 一律判 reserved，所以这些变体是安全的）
  'control+Delete → pane-close',
  'control+shift+Delete → pane-close',
  'control+alt+Delete → pane-close',
  'control+shift+alt+Delete → pane-close',
  // 查找：只认裸 Ctrl/Cmd+F（本次修复保证了 Shift/Alt 变体不在这里）
  'control+KeyF → find-open',
  'meta+KeyF → find-open',
  // 刷新：只认裸 Ctrl+R
  'control+KeyR → pane-reload',
  // 交换分屏：判据只看 shift+alt，因此 3 修饰键版本也会被接管（已知理论重叠）
  'shift+alt+KeyS → pane-swap',
  'control+shift+alt+KeyS → pane-swap',
]

test('归属网格：被接管的组合集合与契约逐条一致', () => {
  const owned = []
  for (const entry of KEYS) {
    for (const mods of MODS) {
      const hit = isOwned(entry, mods)
      if (hit) owned.push(`${labelOf(entry, mods)} → ${hit.action}`)
    }
  }
  assert.deepEqual(
    owned.slice().sort(),
    EXPECTED_OWNED.slice().sort(),
    '被 dshl 接管的组合集合变了。新增拦截前先确认：这个组合在不在 DSH 的绑定空间里？',
  )
})

// ---------- ③ 形态护栏 ----------
const exactly = (mods, ...names) => mods.length === names.length && names.every((n) => mods.includes(n))

test('DSH 实际使用的绑定形态绝不被接管', () => {
  // 三种形态来自 DSH 的默认值与其白名单：
  //   Ctrl+Shift+<字母>（Ctrl+Shift+F 分叉会话 / O 在本地打开 / B 右侧栏）
  //   Ctrl+Alt+<字母>  （Ctrl+Alt+N 新会话 / K 搜索 / P 工作区文件 …）
  //   Ctrl+<符号>      （白名单特例：Ctrl+/ 速查、Ctrl+\ 分栏、Ctrl+` 终端）
  const leaked = []
  for (const entry of KEYS) {
    for (const mods of MODS) {
      const shape =
        (exactly(mods, 'control', 'shift') && entry.upper) ||
        (exactly(mods, 'control', 'alt') && entry.upper) ||
        (exactly(mods, 'control') && ['Backslash', 'Slash', 'Backquote'].includes(entry.code))
      if (shape && isOwned(entry, mods) !== null) leaked.push(labelOf(entry, mods))
    }
  }
  assert.deepEqual(leaked, [], '这些组合 DSH 能绑且正在用，dshl 不得接管：' + leaked.join('、'))
})

// 已知理论重叠（**不在**上面的形态护栏内，因为 DSH 从不用这些形态；改动时不得扩大）：
//   · *+F5 一族        —— 判据 input.key === 'F5' 无修饰键守卫。DSH 的 17 个默认绑定里
//                         一个功能键都没有，且 bindingIssue 对 0 修饰键一律拒绝。
//   · Ctrl+Shift+Alt+S —— 判据只看 shift+alt。DSH 白名单放行 3+ 修饰键，但其默认值不用。
// 真要收掉这两族，改动是：F5 加修饰键守卫、交换分屏加 !input.control ——
// 代价分别是丢掉 Ctrl+F5 强制刷新、丢掉一个没人用过的 4 键组合。留着比收掉更划算。
