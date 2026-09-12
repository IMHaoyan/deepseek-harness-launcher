// tests/lifecycle.test.js — 生命周期 JSONL 测试（node --test）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const lifecycle = require('../lifecycle')

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-life-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } })
  return dir
}

test('emit 写入 JSONL，可 tail 读取', (t) => {
  const dir = tmpDir(t)
  lifecycle.initLifecycle({ dir, log: () => {} })
  lifecycle.emit('app.started', { version: '1.0.0' })
  lifecycle.emit('service.ready', { pid: 123, port: 3080 })
  const lines = lifecycle.tail(10)
  assert.equal(lines.length, 2)
  const e1 = JSON.parse(lines[0])
  assert.equal(e1.event, 'app.started')
  assert.equal(e1.detail.version, '1.0.0')
  assert.ok(e1.ts)
  const e2 = JSON.parse(lines[1])
  assert.equal(e2.detail.pid, 123)
})

test('未知事件名忽略', (t) => {
  const dir = tmpDir(t)
  lifecycle.initLifecycle({ dir })
  lifecycle.emit('not.a.real.event', { x: 1 })
  assert.equal(lifecycle.tail(10).length, 0)
})

test('超长 detail 截断', (t) => {
  const dir = tmpDir(t)
  lifecycle.initLifecycle({ dir })
  lifecycle.emit('app.started', { version: 'x'.repeat(10000) })
  const lines = lifecycle.tail(10)
  assert.equal(lines.length, 1)
  const e = JSON.parse(lines[0])
  assert.ok(e.detail.version.length <= 128)
})

test('文件上限：超过 256KB 丢最旧行', (t) => {
  const dir = tmpDir(t)
  lifecycle.initLifecycle({ dir })
  for (let i = 0; i < 1500; i++) {
    lifecycle.emit('app.started', { version: 'v', seq: i, pad: 'y'.repeat(500) })
  }
  const size = fs.statSync(path.join(dir, 'lifecycle.jsonl')).size
  assert.ok(size <= 256 * 1024, `size=${size}`)
  const lines = lifecycle.tail(10000)
  // 最旧的 seq=0 应已被裁剪（300 行 × ~570B > 256KB）
  const first = JSON.parse(lines[0])
  assert.ok(first.detail.seq > 0, `first seq=${first.detail.seq}`)
  // 文件是完整 JSON 行（无半行）
  for (const l of lines) { JSON.parse(l) }
})

test('emit 永不抛错（目录不可写时）', (t) => {
  const dir = tmpDir(t)
  const bad = path.join(dir, 'sub')
  fs.writeFileSync(path.join(dir, 'sub'), 'file-blocking-dir')
  lifecycle.initLifecycle({ dir: bad, log: () => {} })
  assert.doesNotThrow(() => lifecycle.emit('app.started', {}))
})
test('手动回退事件在白名单内（health.restore.manual 不被静默丢弃）', (t) => {
  const dir = tmpDir(t)
  lifecycle.initLifecycle({ dir })
  lifecycle.emit('health.restore.manual', { slotId: 'slot-1', backup: 'config.json.broken-x.json' })
  const lines = lifecycle.tail(10)
  assert.equal(lines.length, 1)
  const e = JSON.parse(lines[0])
  assert.equal(e.event, 'health.restore.manual')
  assert.equal(e.detail.slotId, 'slot-1')
})