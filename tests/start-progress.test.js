// tests/start-progress.test.js — 说明页步骤模型（node --test）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const startProgress = require('../start-progress')

test('每个说明页的步骤数与约定一致（改流程时这里会先炸）', () => {
  const expected = { start: 5, restart: 6, restartManual: 6, update: 5, plugin: 4, recovery: 6 }
  for (const [reason, n] of Object.entries(expected)) {
    assert.equal(startProgress.stepsFor(reason).length, n, reason + ' 的步骤数变了')
  }
})

test('每一步都有非空文案，且同一步骤不重复', () => {
  for (const reason of Object.keys(startProgress.PLANS)) {
    const steps = startProgress.stepsFor(reason)
    for (const s of steps) assert.ok(s.label && s.label !== s.key, reason + ' 的 ' + s.key + ' 缺文案')
    assert.equal(new Set(steps.map((s) => s.key)).size, steps.length, reason + ' 有重复步骤')
  }
})

test('要用户动手的页面没有步骤（offline/failed/blocked/auth）', () => {
  for (const reason of ['offline', 'failed', 'blocked', 'auth', 'authRestart', '']) {
    assert.deepEqual(startProgress.stepsFor(reason), [], reason + ' 不该有步骤')
  }
  assert.deepEqual(startProgress.stepsFor(undefined), [])
})

test('共用打点键在各流程里都存在（env/port/spawn/ready/load）', () => {
  for (const key of ['spawn', 'ready', 'load']) {
    for (const reason of ['start', 'restart', 'restartManual', 'update', 'plugin', 'recovery']) {
      assert.ok(startProgress.PLANS[reason].includes(key), reason + ' 缺少共用步骤 ' + key)
    }
  }
  assert.ok(startProgress.PLANS.start.includes('env'), 'start 要覆盖 handleStart 的 env 打点')
  assert.ok(startProgress.PLANS.start.includes('port'), 'start 要覆盖 startServer 的 port 打点')
  assert.ok(startProgress.PLANS.recovery.includes('restore') && startProgress.PLANS.recovery.includes('reload'), 'recovery 要覆盖回退两步')
  assert.ok(startProgress.PLANS.update.includes('install'), 'update 要覆盖安装段')
})
