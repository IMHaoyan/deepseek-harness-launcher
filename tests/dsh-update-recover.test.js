// tests/dsh-update-recover.test.js — 中断的 DSH 更新自愈判定（node --test）
// 只覆盖"不触发真实安装"的分支：这些分支决定了下一次启动会不会去重装。
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dshUpdater = require('../dsh-update')

function initWith(t, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-recover-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const statePath = path.join(dir, 'dsh-update-state.json')
  if (value !== undefined) fs.writeFileSync(statePath, JSON.stringify(value))
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'latest' }, statePath, log: () => {}, notify: () => {} })
  return statePath
}

test('没有事务状态文件：什么都不做', async (t) => {
  initWith(t, undefined)
  assert.deepEqual(await dshUpdater.recoverInterruptedUpdate(), { recovered: false, reason: 'no-pending' })
})

test('已失败 / 已修复的事务不再被当成中断：状态文件保留供诊断', async (t) => {
  for (const phase of ['failed', 'repair-failed']) {
    const p = initWith(t, { kind: 'global', from: '0.1.1', to: '0.1.2', phase })
    const r = await dshUpdater.recoverInterruptedUpdate()
    assert.equal(r.reason, 'no-pending')
    assert.ok(fs.existsSync(p), `phase=${phase} 的状态文件应保留`)
  }
})

test('phase=start 但缺目标版本：清掉标记，不猜版本重装', async (t) => {
  const p = initWith(t, { kind: 'global', from: '0.1.1', phase: 'start' })
  const r = await dshUpdater.recoverInterruptedUpdate()
  assert.equal(r.reason, 'no-target')
  assert.ok(!fs.existsSync(p), '标记应被清除')
})

test('phase=start 且修复无法执行：标记 repair-failed，避免每次启动都重试', async (t) => {
  // 未注入 envInstall/envDetect，修复必然失败 —— 正好覆盖失败分支
  const p = initWith(t, { kind: 'global', from: '0.1.1', to: '0.1.2', phase: 'start' })
  const r = await dshUpdater.recoverInterruptedUpdate()
  assert.equal(r.reason, 'failed')
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).phase, 'repair-failed')
})
