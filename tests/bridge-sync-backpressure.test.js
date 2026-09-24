// tests/bridge-sync-backpressure.test.js — 背压溢出不得作废整条流、消费循环不得被单条坏数据打死（node --test）
// 症状：网页端能连上、能发消息（本地 DSH 收到）却收不到回复 —— 溢出 fail() → 重订阅 → 窗口内增量丢失。
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const tgzPath = join(root, 'assets', 'bridge-next', 'bridge-next.tgz')
const meta = JSON.parse(readFileSync(join(root, 'assets', 'bridge-next', 'version.json'), 'utf8'))
const read = (rel) => execFileSync('tar', ['-xOf', tgzPath, `package/${rel}`], { encoding: 'utf8' })
const js = read('lib/index.js')
const py = read('lib/bundled-connector/connector/runtimes/dsh/bridge/sync.py')

test('A：溢出时丢 refresh/最旧条目并继续，不再 fail() 整条流', () => {
  assert.ok(js.includes('sync.buffer_dropped'), '缺少丢弃记录（补丁未打或被回退）')
  assert.ok(!js.includes('DSH event buffer full'), '仍在 fail() 整条流 —— 溢出窗口的增量会丢，网页端收不到回复')
  assert.ok(js.includes('item?.type !== "refresh"'), '要先丢可自愈的 refresh 类')
  assert.match(js, /while \(this\.queue\.length > 0 && \(this\.queue\.length >= MAX_BUFFER \|\| this\.queuedBytes > 67108864\)\)/, '要按两条上限一起丢到满足为止')
  assert.ok(js.includes('this.queuedBytes -= jsonBytes(dropped)'), '丢弃要同步扣减字节记账')
})

test('B：两条上限都已抬高（条数 5e4 / 队列字节 64 MiB）', () => {
  assert.ok(js.includes('const MAX_BUFFER = 5e4;'), '条数上限未抬')
  assert.ok(js.includes('this.queuedBytes > 67108864'), '队列字节上限未抬到 64 MiB')
  assert.ok(!js.includes('this.queuedBytes > 16777216'), '队列旧的 16 MiB 上限仍在（补丁没替换干净）')
  // 注意：index.js 里另有一处 16777216 是 socket.writableLength 的上限，与队列无关，别一起卡
})

test('C：同步中断以 error 落盘并带原因（warning 会被丢弃，查不到根因）', () => {
  assert.ok(py.includes('logger.error("DSH event sync interrupted'), '中断日志必须是 error 才会被 connector/log 持久化')
  assert.ok(py.includes('type(error).__name__, error'), '要带上异常原因')
  assert.ok(!py.includes('logger.warning("DSH event sync interrupted'), '仍是 warning')
})

test('D：未知操作 kind 只记 warning，不再 raise 打死消费循环', () => {
  assert.ok(!py.includes('raise ValueError(f"Unsupported bridge operation'), '仍在 raise —— 一种新投影类型就能打死整条同步')
  assert.ok(py.includes('Ignoring unsupported bridge operation'), '缺少 warning 兜底')
})

test('补丁后 payload 版本已抬升（启动器才会重装）', () => {
  const n = Number(meta.version.replace(/^.*-dev\./u, ''))
  assert.ok(Number.isFinite(n) && n >= 6, `版本仍是 ${meta.version}：不抬版本启动器不会重装`)
})
