// tests/run-guard.test.js — 活跃运行证据测试（node --test）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { beginRun } = require('../run-guard')

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-guard-'))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ } })
  return dir
}

const rec = (n) => ({ startedAt: new Date().toISOString(), pid: 1000 + n, version: '1.0.0' })

test('首次启动：无证据；干净退出后下次也无证据', (t) => {
  const p = path.join(tmpDir(t), 'active-run.json')
  const g1 = beginRun(p, rec(1))
  assert.equal(g1.previousRun, undefined)
  g1.markClean()
  assert.ok(!fs.existsSync(p))
  const g2 = beginRun(p, rec(2))
  assert.equal(g2.previousRun, undefined)
})

test('非受控退出（未 markClean）：下次能检测到上次运行', (t) => {
  const p = path.join(tmpDir(t), 'active-run.json')
  const g1 = beginRun(p, rec(1))
  assert.equal(g1.previousRun, undefined)
  g1.markClean // 不调用：模拟崩溃
  const g2 = beginRun(p, rec(2))
  assert.ok(g2.previousRun !== undefined)
  assert.equal(g2.previousRun.pid, 1001)
  const g3 = beginRun(p, rec(3))
  assert.ok(g3.previousRun !== undefined)
  assert.equal(g3.previousRun.pid, 1002)
})

test('markClean 只清理自己的 marker：旧进程延迟退出不删新 marker', (t) => {
  const p = path.join(tmpDir(t), 'active-run.json')
  const g1 = beginRun(p, rec(1))
  const g2 = beginRun(p, rec(2))
  g1.markClean() // 旧进程延迟退出
  assert.ok(fs.existsSync(p), '新 marker 必须保留')
  const g3 = beginRun(p, rec(3))
  assert.equal(g3.previousRun.pid, 1002)
  g2.markClean() // 旧进程延迟退出：新 marker 必须保留
  assert.ok(fs.existsSync(p), 'g3 的 marker 必须保留')
  g3.markClean() // 当前运行正常退出
  assert.ok(!fs.existsSync(p))
})

test('重复 markClean 幂等', (t) => {
  const p = path.join(tmpDir(t), 'active-run.json')
  const g1 = beginRun(p, rec(1))
  g1.markClean()
  g1.markClean()
  assert.ok(!fs.existsSync(p))
})

test('不可读/损坏 marker：作为 evidence 报告但启动不失败', (t) => {
  const p = path.join(tmpDir(t), 'active-run.json')
  fs.writeFileSync(p, 'not-json')
  const g1 = beginRun(p, rec(1))
  assert.ok('unreadable' in g1.previousRun)
  // 运行期间 marker 被损坏/替换：markClean 保持 fail-closed，不删除未知 marker
  fs.writeFileSync(p, 'not-json')
  g1.markClean()
  assert.ok(fs.existsSync(p))
})

test('非普通文件（目录）拒绝并失败关闭', (t) => {
  const p = path.join(tmpDir(t), 'active-run.json')
  fs.mkdirSync(p)
  assert.throws(() => beginRun(p, rec(1)))
})

test('marker 内容持久化/读取往返', (t) => {
  const p = path.join(tmpDir(t), 'active-run.json')
  const g1 = beginRun(p, { startedAt: '2026-01-01T00:00:00.000Z', pid: 42, version: '9.9.9' })
  const g2 = beginRun(p, rec(7))
  assert.equal(g2.previousRun.startedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(g2.previousRun.version, '9.9.9')
  g1.markClean()
})
