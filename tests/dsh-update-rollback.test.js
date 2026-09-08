// tests/dsh-update-rollback.test.js — DSH 更新后回滚决策（纯函数）测试
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { decideRollback } = require('../dsh-update')

const base = { startOk: true, runningVersion: '1.0.0', latest: '1.0.0', fromVersion: '0.9.0', kind: 'global', rollbackUsed: false }

test('启动成功且版本对上 → 不回滚', () => {
  assert.deepEqual(decideRollback(base), { action: 'none' })
})

test('启动失败 → 全局 npm 且未回滚过 → 回滚（start-failed）', () => {
  const r = decideRollback({ ...base, startOk: false })
  assert.deepEqual(r, { action: 'rollback', reason: 'start-failed' })
})

test('启动成功但版本不匹配 → 回滚（version-mismatch）', () => {
  const r = decideRollback({ ...base, runningVersion: '0.9.0' })
  assert.deepEqual(r, { action: 'rollback', reason: 'version-mismatch' })
})

test('已回滚过 → 不再回滚，仅报告', () => {
  const r = decideRollback({ ...base, startOk: false, rollbackUsed: true })
  assert.deepEqual(r, { action: 'report', startOk: false, runningVersion: '1.0.0' })
})

test('非全局形态（npx/managed/source）失败 → 不回滚仅报告', () => {
  for (const kind of ['npx', 'managed', 'source']) {
    const r = decideRollback({ ...base, kind, startOk: false })
    assert.equal(r.action, 'report')
  }
})

test('fromVersion 为空或等于 latest → 不回滚（失败时仅报告；全好时不触发）', () => {
  assert.equal(decideRollback({ ...base, startOk: false, fromVersion: '' }).action, 'report')
  assert.equal(decideRollback({ ...base, startOk: false, fromVersion: '1.0.0' }).action, 'report')
  assert.equal(decideRollback({ ...base, fromVersion: '' }).action, 'none')
})
