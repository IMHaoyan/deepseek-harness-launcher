// tests/notify-policy.test.js — 通知分类开关 / 版本去重（node --test）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const policy = require('../notify-policy')

test('总开关关闭：所有分类与未分类一律静默', () => {
  const cfg = { notify: false, notifyCategories: policy.defaultCategories() }
  assert.equal(policy.categoryEnabled(cfg, 'service'), false)
  assert.equal(policy.categoryEnabled(cfg, 'recovery'), false)
  assert.equal(policy.categoryEnabled(cfg, 'update'), false)
  assert.equal(policy.categoryEnabled(cfg, undefined), false)
})

test('未知分类 / 未分类不受分类开关限制，只受总开关约束', () => {
  const cfg = { notify: true, notifyCategories: { service: false, recovery: false, update: false } }
  assert.equal(policy.categoryEnabled(cfg, undefined), true)
  assert.equal(policy.categoryEnabled(cfg, 'something-else'), true)
  assert.equal(policy.categoryEnabled({ notify: true }, undefined), true)
})

test('分类开关关闭只抑制该分类', () => {
  const cfg = { notify: true, notifyCategories: { service: false, recovery: true, update: true } }
  assert.equal(policy.categoryEnabled(cfg, 'service'), false)
  assert.equal(policy.categoryEnabled(cfg, 'recovery'), true)
  assert.equal(policy.categoryEnabled(cfg, 'update'), true)
})

test('缺省 / 类型不符的分类配置按默认值 true 处理', () => {
  assert.deepEqual(policy.normalizeNotifyCategories(undefined), { service: true, recovery: true, update: true })
  assert.deepEqual(policy.normalizeNotifyCategories({ service: 'no', recovery: 0, update: null }), { service: true, recovery: true, update: true })
  assert.deepEqual(policy.normalizeNotifyCategories({ service: false, update: true }), { service: false, recovery: true, update: true })
  assert.deepEqual(policy.normalizeNotifyCategories(['x']), { service: true, recovery: true, update: true })
  assert.equal(policy.categoryEnabled({ notify: true, notifyCategories: 'broken' }, 'service'), true)
})

test('版本去重：同版本只提醒一次，换版本恢复提醒', () => {
  const cfg = { notify: true, notifyCategories: policy.defaultCategories() }
  const first = policy.claimVersionNotice({}, 'launcher', '1.2.0')
  assert.equal(first.claimed, true)
  assert.equal(first.store.launcher, '1.2.0')

  const again = policy.claimVersionNotice(first.store, 'launcher', '1.2.0')
  assert.equal(again.claimed, false)

  const next = policy.claimVersionNotice(again.store, 'launcher', '1.3.0')
  assert.equal(next.claimed, true)
  // DSH 记账位互不影响
  assert.equal(next.store.dsh, '')

  const dsh = policy.claimVersionNotice(next.store, 'dsh', '1.2.0')
  assert.equal(dsh.claimed, true)
  assert.equal(dsh.store.launcher, '1.3.0')
  assert.ok(cfg)
})

test('版本去重：空 / 非字符串版本不认领；未知记账位不认领', () => {
  assert.equal(policy.claimVersionNotice({}, 'launcher', '').claimed, false)
  assert.equal(policy.claimVersionNotice({}, 'launcher', undefined).claimed, false)
  assert.equal(policy.claimVersionNotice({}, 'launcher', 123).claimed, false)
  assert.equal(policy.claimVersionNotice({}, 'nope', '1.0.0').claimed, false)
})

test('版本去重：记账值类型损坏时按未提醒处理', () => {
  const r = policy.claimVersionNotice({ launcher: 42, dsh: null }, 'launcher', '2.0.0')
  assert.equal(r.claimed, true)
  assert.deepEqual(r.store, { launcher: '2.0.0', dsh: '' })
})