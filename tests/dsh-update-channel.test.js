// tests/dsh-update-channel.test.js — DSH 更新渠道解析（node --test）
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const dshUpdater = require('../dsh-update')

function withChannel(value) {
  dshUpdater.initDshUpdater({ Config: { dshChannel: value } })
  return dshUpdater.getState().channel
}

test('未配置渠道时默认 latest（保持历史行为）', () => {
  assert.equal(withChannel(undefined), 'latest')
  assert.equal(withChannel(''), 'latest')
})

test('显式选择 alpha 时检查更新走 alpha 渠道', () => {
  assert.equal(withChannel('alpha'), 'alpha')
})

test('非法渠道值一律回落到 latest，不把用户带进未知渠道', () => {
  assert.equal(withChannel('beta'), 'latest')
  assert.equal(withChannel('next'), 'latest')
  assert.equal(withChannel(1), 'latest')
})
