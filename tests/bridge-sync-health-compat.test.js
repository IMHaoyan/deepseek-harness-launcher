// tests/bridge-sync-health-compat.test.js — 「同步已就绪」必须真的被上报（node --test）
// 背景：同步数据面正常（sync.batch == sync.ack），但 desktop 记录停在 starting（health 只有 consume() 开头那次），
// 客户端 client.js:381/386 把 detected === 'error' 判成异常 → 卡片「启动中 + 异常」。
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const tgzPath = join(root, 'assets', 'bridge-next', 'bridge-next.tgz')
const meta = JSON.parse(readFileSync(join(root, 'assets', 'bridge-next', 'version.json'), 'utf8'))
const py = execFileSync('tar', ['-xOf', tgzPath, 'package/lib/bundled-connector/connector/runtimes/dsh/bridge/sync.py'], { encoding: 'utf8' })
const lines = py.split('\n')
const indentOf = (line) => /^\s*/u.exec(line)[0].length

test('P1：首个批次 ack 成功后上报 running（不再只靠 inventory 通知）', () => {
  const ackAt = lines.findIndex((line) => line.includes('runtime.sync.ack'))
  assert.ok(ackAt >= 0, '找不到 ack 调用')
  const after = lines.slice(ackAt + 1, ackAt + 10)
  assert.ok(after.some((line) => line.includes('health_reported = True')), 'ack 之后要置位一次性标记')
  assert.ok(after.some((line) => line.includes('runtime_health_update("running")')), 'ack 之后要上报 running')
  const flagAt = lines.findIndex((line) => line.trim().startsWith('health_reported = False'))
  assert.ok(flagAt >= 0, '缺少 health_reported 初始化')
  assert.ok(flagAt < ackAt, '标记必须在消费循环之前初始化')
  // 缩进契约：if 与 ack 同级，其体内两条各深一层（Python 语法正确性由补丁脚本的 ast.parse 兜底）
  // 注意只在插入区域里找：文件更靠前处还有一处原有的 runtime_health_update("running")（inventory 通知那条）
  const guard = after.find((line) => line.includes('if not health_reported:'))
  const setFlag = after.find((line) => line.includes('health_reported = True'))
  const publish = after.find((line) => line.includes('runtime_health_update("running")'))
  assert.ok(guard && setFlag && publish, 'ack 之后的插入块不完整')
  assert.equal(indentOf(guard), indentOf(lines[ackAt]), 'if 必须与 ack 语句同级')
  assert.equal(indentOf(setFlag), indentOf(publish), '置位与上报必须同级（同一 if 体内）')
  assert.ok(indentOf(setFlag) > indentOf(guard), 'if 体内必须比 if 更深')
})

test('P2：未知 runtime 通知记 warning 后忽略，不再 raise 打死消费循环', () => {
  assert.ok(!py.includes('raise ValueError(f"Unsupported runtime notification'), '仍在 raise —— 一种新通知类型就能打死整条同步')
  assert.ok(py.includes('Ignoring unsupported runtime notification'), '缺少 warning 兜底')
})

test('补丁后 payload 版本已抬升（启动器才会重装）', () => {
  const n = Number(meta.version.replace(/^.*-dev\./u, ''))
  assert.ok(Number.isFinite(n) && n >= 5, `版本仍是 ${meta.version}：不抬版本启动器不会重装（satisfied() 只比 spec 基名）`)
})
