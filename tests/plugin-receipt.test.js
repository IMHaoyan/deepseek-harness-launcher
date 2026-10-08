// tests/plugin-receipt.test.js — 动作回执（卡片上那行 ✓）的生命周期。
//
// 由来（2026-10-08 用户实测）：装完技能管理 v1.1.13 之后，卡片底部一直挂着
// 「✓ 已安装 @michengai/dsh-skills-manager@1.1.13」，直到启动器退出才消失 ——
// 因为 lastChange 只是 market/bridge 里一个进程内字段，写入点有 4 处、清零点 0 处。
// 它表达的是"刚刚发生了什么"（那一刻的 toast 已经说过一次），不是状态；而"还没生效"另由顶部
// pending 条承担。所以它必须有保质期：**生效即清**（applyPluginChange 成功）+ **超时兜底**（tick）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')
const bridgeSrc = read('bridge.js')
const market = require('../market')

// ---------- market：进程内回执 ----------

test('market：写回执必须带时刻（没有时刻就没法过期）', () => {
  market.noteLastChange('receipt-pkg-a', '已安装 receipt-pkg-a@1.0.0')
  const s = market.getState('receipt-pkg-a')
  assert.equal(s.lastChange, '已安装 receipt-pkg-a@1.0.0')
  assert.ok(Number.isFinite(s.lastChangeAt) && s.lastChangeAt > 0, 'lastChangeAt 必须是有效时刻')
})

test('market.clearLastChanges：一次清掉所有插件，且可重复调用', () => {
  market.noteLastChange('receipt-pkg-b', '已安装 b')
  market.noteLastChange('receipt-pkg-c', '已卸载 c')
  assert.ok(market.clearLastChanges() >= 2)
  assert.equal(market.getState('receipt-pkg-b').lastChange, '')
  assert.equal(market.getState('receipt-pkg-c').lastChange, '')
  assert.equal(market.getState('receipt-pkg-b').lastChangeAt, 0, '时刻也要归零')
  assert.equal(market.clearLastChanges(), 0, '再清一次没有东西可清')
})

test('market.expireLastChanges：过期的清掉、新鲜的留着、没时刻的老回执不动', () => {
  market.noteLastChange('receipt-pkg-d', '已安装 d')       // 新鲜
  market.noteLastChange('receipt-pkg-e', '已安装 e')       // 装旧
  market.stateOf('receipt-pkg-e').lastChangeAt = Date.now() - 10 * 60 * 1000
  market.noteLastChange('receipt-pkg-f', '旧格式回执')      // 没有时刻
  market.stateOf('receipt-pkg-f').lastChangeAt = 0

  const cleared = market.expireLastChanges(60 * 1000)
  assert.equal(cleared, 1, '只有过期那条被清')
  assert.equal(market.getState('receipt-pkg-d').lastChange, '已安装 d', '新鲜的要留着')
  assert.equal(market.getState('receipt-pkg-e').lastChange, '')
  assert.equal(market.getState('receipt-pkg-f').lastChange, '旧格式回执', '拿不准来源的宁可多留一会儿')
  // 非法保质期不清任何东西（fail-closed：配置坏了不该顺手把回执抹了）
  assert.equal(market.expireLastChanges(0), 0)
  assert.equal(market.expireLastChanges(-1), 0)
  assert.equal(market.expireLastChanges('x'), 0)
  market.clearLastChanges()
})

// ---------- bridge：同一套语义（切片执行真实实现 + 注入假 state） ----------

test('bridge：回执带时刻，clear / expire 语义与 market 一致', () => {
  const start = bridgeSrc.indexOf('function noteLastChange(text) {')
  const end = bridgeSrc.indexOf('\n}\n', bridgeSrc.indexOf('function expireLastChanges(maxAgeMs) {')) + 3
  assert.ok(start > 0 && end > start, '找不到 bridge 的回执实现')
  const src = bridgeSrc.slice(start, end)
  const state = { lastChange: '', lastChangeAt: 0 }
  const api = new Function('state', src + '\nreturn { noteLastChange, clearLastChanges, expireLastChanges }')(state)

  api.noteLastChange('已安装远程连接插件 v2.0.0')
  assert.equal(state.lastChange, '已安装远程连接插件 v2.0.0')
  assert.ok(state.lastChangeAt > 0)
  assert.equal(api.expireLastChanges(60 * 1000), 0, '新鲜的不清')
  state.lastChangeAt = Date.now() - 10 * 60 * 1000
  assert.equal(api.expireLastChanges(60 * 1000), 1, '过期的要清')
  assert.equal(state.lastChange, '')
  api.noteLastChange('已卸载远程连接插件')
  assert.equal(api.clearLastChanges(), 1, '生效即清')
  assert.equal(state.lastChange, '')
  assert.equal(api.lastChangeAt, undefined)
  assert.equal(state.lastChangeAt, 0)
})

// ---------- main：卡片上的显示规则 ----------

test('pluginReceiptText：过期的回执不再上卡片，没时刻的老回执照旧显示', () => {
  const start = main.indexOf('function pluginReceiptText(raw) {')
  const end = main.indexOf('\n}\n', start) + 3
  assert.ok(start > 0, '找不到 pluginReceiptText')
  const TTL = 60 * 1000
  const fn = new Function('LAST_CHANGE_TTL_MS', main.slice(start, end) + '\nreturn pluginReceiptText')(TTL)

  assert.equal(fn({ lastChange: '', lastChangeAt: Date.now() }), '')
  assert.equal(fn({ lastChange: '已安装 x@1.0.0', lastChangeAt: Date.now() }), '已安装 x@1.0.0', '刚发生的要显示')
  assert.equal(fn({ lastChange: '已安装 x@1.0.0', lastChangeAt: Date.now() - (TTL + 1000) }), '', '超过保质期不上卡片')
  assert.equal(fn({ lastChange: '已安装 x@1.0.0', lastChangeAt: 0 }), '已安装 x@1.0.0', '没时刻的老回执照旧显示')
  assert.equal(fn({ lastChange: '已安装 x@1.0.0' }), '已安装 x@1.0.0')
  assert.equal(fn(null), '', '字段缺失不许抛错')
})

// ---------- 接线 ----------

test('生效即清：applyPluginChange 成功那条路上，回执与 pending 一起退场', () => {
  const start = main.indexOf('async function applyPluginChange(verb, version, spec = {}) {')
  const end = main.indexOf('\n}\n', start) + 3
  const fn = main.slice(start, end)
  const okBranch = fn.slice(fn.indexOf('if (ok) {'), fn.indexOf('} else {'))
  assert.match(okBranch, /clearPendingPluginRestart\(\)/, '挂起标记照旧要清')
  assert.match(okBranch, /clearPluginReceipts\(\)/, '生效即清：回执也要在同一刻退场')
  assert.match(okBranch, /refreshWebUiOnReady\(true\)/, '原来的刷新不能丢')
  assert.match(fn, /clearPluginReceipts\(\)/, '辅助函数要被调用（别只写在注释里）')
})

test('超时兜底：tick 里清过期回执并推状态，策略是 main 里唯一一处常量', () => {
  assert.match(main, /const LAST_CHANGE_TTL_MS = 60 \* 1000/, '保质期要是一个明确的常量')
  const tick = main.slice(main.indexOf('function onTick() {'), main.indexOf('\n}\n', main.indexOf('function onTick() {')))
  assert.match(tick, /expirePluginReceipts\(\)/, 'onTick 必须做超时兜底')
  const start = main.indexOf('function expirePluginReceipts() {')
  const fn = main.slice(start, main.indexOf('\n}\n', start) + 3)
  assert.match(fn, /market\.expireLastChanges\(LAST_CHANGE_TTL_MS\)/, 'market 的回执按同一份策略过期')
  assert.match(fn, /bridge\.expireLastChanges\(LAST_CHANGE_TTL_MS\)/, 'bridge 的回执同理')
  assert.match(fn, /if \(n > 0\)[\s\S]{0,200}broadcastState\(\)/, '清掉了才推状态（让那行真的消失）')
  assert.match(fn, /log\('\[plugins\] '/, '退场要留一条日志（便于事后解释）')
})

test('卡片接线：三类卡片的回执都过 pluginReceiptText，不再直接摊原始字段', () => {
  assert.match(main, /lastChange: pluginReceiptText\(raw\)/, 'npm 插件卡片')
  assert.match(main, /lastChange: pluginReceiptText\(m\)/, '插件市场卡片')
  assert.match(main, /lastChange: pluginReceiptText\(b\)/, '手机连接卡片')
  assert.doesNotMatch(main, /lastChange: raw\.lastChange \|\| ''/, '不该再直接摊原始字段')
  // 写回执的两个模块都要带时刻（不然过期判据永远拿不到值）
  assert.match(read('market.js'), /s\.lastChangeAt = Date\.now\(\)/, 'market 写回执要带时刻')
  assert.match(bridgeSrc, /state\.lastChangeAt = Date\.now\(\)/, 'bridge 写回执要带时刻')
  assert.match(read('market.js'), /lastChangeAt: s\.lastChangeAt/, 'market 要把时刻交给主进程')
  assert.match(bridgeSrc, /lastChangeAt: state\.lastChangeAt/, 'bridge 同理')
})
