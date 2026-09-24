// tests/bridge-sync-ack-compat.test.js — 随包 payload 必须带「同步 ack 宽容化」三处补丁（node --test）
// 背景：resubscribe 会换掉唯一 feed 槽，旧流上迟到的 ack 被路由判 INVALID_PARAMS(non-retryable) →
// connector 的 consume() 退出 → 无人 ACK → host 队列涨到 MAX_BUFFER → 卡片进「异常」并循环。
// 三处补丁（tools/patch-bridge-sync-ack-compat.mjs）：路由幂等成功 / Feed.ack 忽略越界 / connector 乱序重新对齐。
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

test('P1：路由对失效流的 ack 幂等成功，不再抛 INVALID_PARAMS', () => {
  assert.ok(js.includes('sync.ack_stale'), '缺少幂等分支的标记（补丁未打或被打回）')
  assert.ok(!js.includes('throw new BridgeError("INVALID_PARAMS", "Unknown event stream.")'), '路由仍在抛 Unknown event stream —— 迟到 ack 会打死 connector 的消费循环')
  const at = js.indexOf('case "runtime.sync.ack":')
  const block = js.slice(at, at + 700)
  assert.ok(block.includes('return { ok: true };'), '幂等分支必须返回成功')
  assert.ok(block.includes('this.feed.ack(params.batchSeq);'), '正常路径仍要真正 ack')
})

test('P2：Feed.ack 越界/重复序号只忽略，不再抛错', () => {
  assert.ok(js.includes('dshl 补丁：迟到或重复的确认'), '缺少 Feed.ack 的宽容化说明')
  assert.ok(!js.includes('throw new BridgeError("INVALID_PARAMS", "Invalid event acknowledgement.")'), 'Feed.ack 仍在抛 Invalid event acknowledgement')
  assert.match(js, /if \(seq < 1 \|\| seq > this\.batchSeq \|\| !Number\.isSafeInteger\(seq\)\) return;/)
})

test('P3：connector 乱序批次重新对齐，不再 raise 退出消费循环', () => {
  assert.ok(py.includes('dshl 补丁：host 换流/重发基线'), '缺少 sync.py 的补丁标记')
  assert.ok(!py.includes('raise ValueError("Out-of-order event batch'), 'connector 仍在 raise 乱序 —— 一次重订阅就整条退出')
  assert.ok(py.includes('expected = batch["batchSeq"]'), '要重新对齐到收到的序号')
  // 逐行解析：乱序分支的第一条非注释语句必须是重新对齐，且缩进比 if 更深（否则语法就不合法）
  const lines = py.split('\n')
  const at = lines.findIndex((line) => line.includes('if batch.get("batchSeq") != expected:'))
  assert.ok(at >= 0, '找不到乱序判定行')
  const indentOf = (line) => /^\s*/u.exec(line)[0].length
  const body = lines.slice(at + 1, at + 5).filter((line) => line.trim() && !line.trim().startsWith('#'))
  assert.equal(body[0]?.trim(), 'expected = batch["batchSeq"]', '乱序分支的第一条语句应是 expected = batch["batchSeq"]')
  assert.ok(indentOf(body[0]) > indentOf(lines[at]), '重新对齐语句的缩进必须比 if 更深，否则 Python 语法错误')
})

test('补丁后 payload 版本已抬升（启动器才会重装）', () => {
  assert.match(meta.version, /-dev\.\d+$/u, 'payload 版本应是 ...-dev.N 形态')
  assert.ok(Number(meta.version.replace(/^.*-dev\./u, '')) >= 4, `版本仍是 ${meta.version}：启动器 satisfied() 只比 spec 基名，不抬版本不会重装`)
})
