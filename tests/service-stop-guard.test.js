// tests/service-stop-guard.test.js — 停止防重入 + 看门狗（纯逻辑，注入假定时器）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const guard = require('../service-stop-guard')

// 假定时器：记录回调，手动触发
function fakeTimers() {
  const timers = new Map()
  let seq = 0
  return {
    set(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id },
    clear(id) { timers.delete(id) },
    fireAll() { const list = [...timers.values()]; timers.clear(); for (const t of list) t.fn() },
    size() { return timers.size },
  }
}

test('未开始时 isStopping=false', () => {
  guard._setTimersForTest()
  guard.endStop()
  assert.equal(guard.isStopping(), false)
})

test('beginStop 置位；重复 beginStop 返回 false（防重入）', () => {
  const ft = fakeTimers()
  guard._setTimersForTest(ft.set, ft.clear)
  guard.endStop()
  assert.equal(guard.beginStop({ timeoutMs: 1000 }), true)
  assert.equal(guard.isStopping(), true)
  assert.equal(guard.beginStop({ timeoutMs: 1000 }), false, '第二次必须被挡住')
  guard.endStop()
  guard._setTimersForTest()
})

test('endStop 复位并取消看门狗', () => {
  const ft = fakeTimers()
  guard._setTimersForTest(ft.set, ft.clear)
  guard.endStop()
  guard.beginStop({ timeoutMs: 1000 })
  assert.equal(ft.size(), 1)
  guard.endStop()
  assert.equal(guard.isStopping(), false)
  assert.equal(ft.size(), 0, '看门狗定时器应被取消')
  guard._setTimersForTest()
})

test('看门狗到期：强制复位 + 触发告警回调（防止标志永久卡住）', () => {
  const ft = fakeTimers()
  guard._setTimersForTest(ft.set, ft.clear)
  guard.endStop()
  let fired = 0
  guard.beginStop({ timeoutMs: 30000, onTimeout: () => { fired++ } })
  assert.equal(guard.isStopping(), true)
  ft.fireAll() // 模拟 30 秒到
  assert.equal(guard.isStopping(), false, '到期必须强制复位')
  assert.equal(fired, 1, '必须触发一次告警')
  guard._setTimersForTest()
})

test('告警回调抛错也要复位（回调异常被吞，不能因为回调炸了就卡住）', () => {
  const ft = fakeTimers()
  guard._setTimersForTest(ft.set, ft.clear)
  guard.endStop()
  guard.beginStop({ timeoutMs: 1, onTimeout: () => { throw new Error('boom') } })
  ft.fireAll() // 回调内部抛错应被吞掉，不影响复位
  assert.equal(guard.isStopping(), false)
  guard._setTimersForTest()
})

test('endStop 幂等', () => {
  guard._setTimersForTest()
  guard.endStop()
  guard.endStop()
  assert.equal(guard.isStopping(), false)
})

test('默认超时常量存在且为 30 秒', () => {
  assert.equal(guard.DEFAULT_TIMEOUT_MS, 30000)
})
