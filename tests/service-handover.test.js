// tests/service-handover.test.js — DSH 自重启识别的纯决策函数（node --test）
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const handover = require('../service-handover')

// 2026-09-09 事故的真实启动签名：后继进程的命令行与我们 spawn 的逐字一致
const SCRIPT = 'C:\\Users\\gonghaoyan\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const SIG = { script: SCRIPT, args: ['web', '--host', '127.0.0.1', '--port', '4399', '--no-open'] }
const INCIDENT_CMDLINE = '"C:\\Program Files\\nodejs\\node.exe" ' + SCRIPT + ' web --host 127.0.0.1 --port 4399 --no-open'

test('splitCmdline：引号内含空格算一个 token', () => {
  assert.deepEqual(handover.splitCmdline('"C:\\Program Files\\nodejs\\node.exe" a.js --port 1'),
    ['C:\\Program Files\\nodejs\\node.exe', 'a.js', '--port', '1'])
})

test('splitCmdline：多余空白与空串', () => {
  assert.deepEqual(handover.splitCmdline('   a\t b  '), ['a', 'b'])
  assert.deepEqual(handover.splitCmdline(''), [])
})

test('matchLaunchSig：事故命令行必须匹配（这是认领的唯一依据）', () => {
  assert.equal(handover.matchLaunchSig(INCIDENT_CMDLINE, SIG).ok, true)
})

test('matchLaunchSig：路径分隔符与大小写差异不影响匹配', () => {
  const slashed = INCIDENT_CMDLINE.replace(/\\/g, '/')
  assert.equal(handover.matchLaunchSig(slashed, SIG).ok, true)
  assert.equal(handover.matchLaunchSig(slashed.toUpperCase(), { ...SIG, script: SCRIPT.toUpperCase() }).ok, true)
})

test('matchLaunchSig：node 前置参数与裸 node 都容忍（只认脚本之后的参数）', () => {
  assert.equal(handover.matchLaunchSig('node ' + SCRIPT + ' web --host 127.0.0.1 --port 4399 --no-open', SIG).ok, true)
  assert.equal(handover.matchLaunchSig(
    '"C:\\Program Files\\nodejs\\node.exe" --no-warnings ' + SCRIPT + ' web --host 127.0.0.1 --port 4399 --no-open', SIG
  ).ok, true)
})

test('matchLaunchSig：端口不同就不是本轮后继（不能跨世代认领）', () => {
  const r = handover.matchLaunchSig(
    'node ' + SCRIPT + ' web --host 127.0.0.1 --port 3080 --no-open', SIG)
  assert.equal(r.ok, false)
  assert.equal(r.why, 'flag-mismatch')
})

test('matchLaunchSig：少一个开关同样不匹配（--no-open 缺失说明是用户手起的另一套）', () => {
  assert.equal(handover.matchLaunchSig('node ' + SCRIPT + ' web --host 127.0.0.1 --port 4399', SIG).ok, false)
})

test('matchLaunchSig：脚本路径不同 → script-mismatch', () => {
  const r = handover.matchLaunchSig('node C:\\other\\bin.js web --host 127.0.0.1 --port 4399 --no-open', SIG)
  assert.equal(r.why, 'script-mismatch')
})

test('matchLaunchSig：命令行取不到时判为不可判定，绝不误认领', () => {
  for (const v of ['', '   ', undefined, null]) {
    const r = handover.matchLaunchSig(v, SIG)
    assert.equal(r.ok, false)
    assert.equal(r.why, 'cmdline-unknown')
  }
})

test('classifyHandover：端口持有者就是匹配进程 → 自重启', () => {
  assert.equal(handover.classifyHandover({ listenerPid: 72044, matchedPid: 72044, elapsedMs: 900, settleMs: 3000, maxMs: 8000 }),
    'self-restart')
})

test('classifyHandover：持有端口但命令行不匹配/读不到 → 外部实例（走接管或拒绝，不认领）', () => {
  const base = { listenerPid: 555, matchedPid: 0, elapsedMs: 500, settleMs: 3000, maxMs: 8000 }
  assert.equal(handover.classifyHandover(base), 'external')
  assert.equal(handover.classifyHandover({ ...base, matchedPid: 999 }), 'external')
})

test('classifyHandover：端口空档期先等；无匹配候选短等，有候选长等到 bind', () => {
  assert.equal(handover.classifyHandover({ listenerPid: 0, matchedPid: 0, elapsedMs: 1000, settleMs: 3000, maxMs: 8000 }), 'pending')
  assert.equal(handover.classifyHandover({ listenerPid: 0, matchedPid: 72044, elapsedMs: 5000, settleMs: 3000, maxMs: 8000 }), 'pending')
  assert.equal(handover.classifyHandover({ listenerPid: 0, matchedPid: 72044, elapsedMs: 8500, settleMs: 3000, maxMs: 8000 }), 'crash')
  assert.equal(handover.classifyHandover({ listenerPid: 0, matchedPid: 0, elapsedMs: 3100, settleMs: 3000, maxMs: 8000 }), 'crash')
})

test('classifyReadiness：只有监听者等于我们的 child 才算就绪', () => {
  assert.equal(handover.classifyReadiness({ listenerPid: 86680, childPid: 86680, sigMatched: false }), 'ready')
})

test('classifyReadiness：事故 01:14:16 的输入（别人在服务）不得判成就绪', () => {
  assert.equal(handover.classifyReadiness({ listenerPid: 72044, childPid: 107768, sigMatched: true }), 'claim')
  assert.equal(handover.classifyReadiness({ listenerPid: 72044, childPid: 107768, sigMatched: false }), 'not-ours')
})

test('classifyReadiness：netstat 查不到时保守放行但标记未核验（否则正常启动会被误杀）', () => {
  assert.equal(handover.classifyReadiness({ listenerPid: 0, childPid: 107768, sigMatched: false }), 'ready-unverified')
})

test('planCooldownRetry：冷却未到必须给出等待时长（看护不能静默停摆）', () => {
  const now = 1000000
  assert.deepEqual(handover.planCooldownRetry({ now, lastRestartAt: now - 3000, cooldownMs: 10000 }), { waitMs: 7000 })
  assert.equal(handover.planCooldownRetry({ now, lastRestartAt: now - 10000, cooldownMs: 10000 }), null)
  assert.equal(handover.planCooldownRetry({ now, lastRestartAt: 0, cooldownMs: 10000 }), null)
})

test('shouldDeclareGone：连续负样本够一个确认窗口才算消失', () => {
  assert.equal(handover.shouldDeclareGone({ downStreak: 2, tickMs: 2000, confirmMs: 6000 }), false)
  assert.equal(handover.shouldDeclareGone({ downStreak: 3, tickMs: 2000, confirmMs: 6000 }), true)
})

test('parseDshWebLine：只认本机当前端口的带 token 地址', () => {
  const ok = handover.parseDshWebLine('dsh web: http://127.0.0.1:4399/?token=abc_123', { host: '127.0.0.1', port: 4399 })
  assert.equal(ok, 'http://127.0.0.1:4399/?token=abc_123')
  assert.equal(handover.parseDshWebLine('dsh web: http://127.0.0.1:4399/', { host: '127.0.0.1', port: 4399 }), null)
  assert.equal(handover.parseDshWebLine('dsh web: http://127.0.0.1:3080/?token=abc', { host: '127.0.0.1', port: 4399 }), null)
  assert.equal(handover.parseDshWebLine('dsh web: http://192.168.1.5:4399/?token=abc', { host: '127.0.0.1', port: 4399 }), null)
  assert.equal(handover.parseDshWebLine('some other noise', { host: '127.0.0.1', port: 4399 }), null)
})

test('parseDshWebLine：localhost 与默认端口写法都要认', () => {
  assert.equal(handover.parseDshWebLine('dsh web: http://localhost:4399/?token=x', { host: '127.0.0.1', port: 4399 }),
    'http://localhost:4399/?token=x')
  assert.equal(handover.parseDshWebLine('dsh web: http://127.0.0.1/?token=x', { host: '127.0.0.1', port: 80 }),
    'http://127.0.0.1/?token=x')
})

test('classifyOccupant：端口空了 → 交给启动器自己拉起', () => {
  assert.equal(handover.classifyOccupant({ hasListener: false }), 'retry-start')
  assert.equal(handover.classifyOccupant({}), 'retry-start')
})

test('classifyOccupant：命令行签名命中优先于指纹（后继刚 bind、还没开始应答）', () => {
  assert.equal(handover.classifyOccupant({
    hasListener: true, sigMatched: true, probeOk: false, probeReason: 'timeout', waitedMs: 600, budgetMs: 8000,
  }), 'adopt')
})

test('classifyOccupant：指纹命中（已在运行的 DSH 外部实例）也接管', () => {
  assert.equal(handover.classifyOccupant({
    hasListener: true, sigMatched: false, probeOk: true, probeReason: 'fingerprint', waitedMs: 300, budgetMs: 8000,
  }), 'adopt')
})

test('classifyOccupant：明确回了非 DSH 内容 → 立刻判冲突，不白等预算', () => {
  assert.equal(handover.classifyOccupant({
    hasListener: true, sigMatched: false, probeOk: false, probeReason: 'fingerprint', waitedMs: 100, budgetMs: 8000,
  }), 'conflict')
})

test('classifyOccupant：端口有人但没应答 → 等到预算用完才判冲突（这就是误报的修法）', () => {
  const base = { hasListener: true, sigMatched: false, probeOk: false, probeReason: 'timeout' }
  assert.equal(handover.classifyOccupant(Object.assign({}, base, { waitedMs: 1000, budgetMs: 8000 })), 'wait')
  assert.equal(handover.classifyOccupant(Object.assign({}, base, { waitedMs: 7999, budgetMs: 8000 })), 'wait')
  assert.equal(handover.classifyOccupant(Object.assign({}, base, { waitedMs: 8000, budgetMs: 8000 })), 'conflict')
  assert.equal(handover.classifyOccupant(Object.assign({}, base, { probeReason: 'connect', waitedMs: 9000, budgetMs: 8000 })), 'conflict')
})
