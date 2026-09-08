// tests/health.test.js — 健康快照/恢复测试（node --test）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const health = require('../health')

function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-health-'))
  const configPath = path.join(root, 'config.json')
  const snapshotDir = path.join(root, 'health-snapshots')
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } })
  return { root, configPath, snapshotDir }
}

function initH(t, cfg) {
  const env = makeEnv(t)
  fs.writeFileSync(env.configPath, JSON.stringify(cfg || { port: 3080, theme: 'light' }, null, 2))
  health.initHealth({ configPath: env.configPath, snapshotDir: env.snapshotDir, log: () => {} })
  return env
}

const meta = { dshlVersion: '1.1.6', dshKind: 'global', dshVersion: '0.1.0', nodeVersion: 'v22', port: 3080, reason: 'page-loaded' }

test('captureHealthy 写入快照并校验', (t) => {
  const env = initH(t)
  const r = health.captureHealthy(meta)
  assert.equal(r.status, 'captured')
  const slots = health.listSlots()
  const valid = slots.filter((s) => s.valid)
  assert.equal(valid.length, 1)
  assert.equal(valid[0].configSha, health.configHash())
})

test('三槽轮转：第 1 槽为最旧，满后覆盖最旧', (t) => {
  const env = initH(t)
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(env.configPath, JSON.stringify({ port: 3080 + i }, null, 2))
    health.captureHealthy({ ...meta, port: 3080 + i })
    // 同一次轮转内时间戳可能相同：用 meta 排序仍保证 slot-1 最旧（先写），第 4 次覆盖 slot-1
  }
  const slots = health.listSlots()
  const valid = slots.filter((s) => s.valid)
  assert.equal(valid.length, 3)
  // 第 4 次捕获应当覆盖最旧的 slot-1（config 应为 port=3083）
  const slot1 = slots.find((s) => s.slotId === 'slot-1')
  const cfg = JSON.parse(fs.readFileSync(path.join(env.snapshotDir, 'slot-1', 'config.json'), 'utf8'))
  assert.equal(cfg.port, 3083)
})

test('篡改快照 config → 槽无效（sha256 校验）', (t) => {
  const env = initH(t)
  health.captureHealthy(meta)
  const cfgFile = path.join(env.snapshotDir, 'slot-1', 'config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ port: 9999 }, null, 2))
  const slots = health.listSlots()
  assert.equal(slots.filter((s) => s.valid).length, 0)
  assert.equal(health.pickRestoreTarget(health.configHash()), null)
})

test('pickRestoreTarget 选最新差异槽；当前=最新快照时 null', (t) => {
  const env = initH(t)
  health.captureHealthy(meta) // 槽：port 3080
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 3999 }, null, 2))
  health.captureHealthy({ ...meta, port: 3999 }) // 槽：port 3999（最新）
  // 当前配置 == 最新快照（known-good）：无回退目标
  assert.equal(health.pickRestoreTarget(health.configHash()), null)
  // 用户改了配置（5000）但从未健康启动：回退到最新 known-good = slot-2（3999）
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 5000 }, null, 2))
  assert.equal(health.pickRestoreTarget(health.configHash()), 'slot-2')
  // excludeSlotId 排除后回退到更早的 slot-1
  assert.equal(health.pickRestoreTarget(health.configHash(), 'slot-2'), 'slot-1')
})

test('restore 备份 broken 配置 + 原子写回 + skip marker 生效', (t) => {
  const env = initH(t)
  health.captureHealthy(meta)
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 7777 }, null, 2))
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  const cfg = JSON.parse(fs.readFileSync(env.configPath, 'utf8'))
  assert.equal(cfg.port, 3080) // 恢复为快照值
  assert.ok(fs.existsSync(r.backupPath))
  const backup = JSON.parse(fs.readFileSync(r.backupPath, 'utf8'))
  assert.equal(backup.port, 7777)
  // skip marker 存在：下次健康启动只消费、不覆盖
  const r2 = health.captureHealthy({ ...meta, port: 3080 })
  assert.equal(r2.status, 'skipped')
  assert.equal(r2.restoredSlotId, 'slot-1')
  // 再下一次恢复捕获
  const r3 = health.captureHealthy({ ...meta, port: 3080 })
  assert.equal(r3.status, 'captured')
})

test('shouldRecover 决策表', () => {
  assert.equal(health.shouldRecover(5, true), true)
  assert.equal(health.shouldRecover(4, true), false)
  assert.equal(health.shouldRecover(5, false), false)
  assert.equal(health.shouldRecover(5, null), false)
})

test('无快照时恢复 no-op；restore 未知槽抛错', (t) => {
  const env = initH(t)
  assert.equal(health.pickRestoreTarget(health.configHash()), null)
  assert.equal(health.restore('slot-1').status, 'noop')
  assert.throws(() => health.restore('slot-9'))
})
