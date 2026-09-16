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

// ---------- 启动期"当前环节"（等待端口那 10 秒里显示服务进程在干什么） ----------

test('pickPhaseLine：只认插件日志行（[名字] …），并取最新的一条', () => {
  const chunk = [
    '[usage-billing] skip unreadable session session-aaa',
    'some unprefixed chatter',
    '[archive-manager] 归档索引已就绪',
    '',
  ].join('\n')
  assert.equal(startProgress.pickPhaseLine(chunk), '[archive-manager] 归档索引已就绪')
  assert.equal(startProgress.pickPhaseLine('[usage-billing] aggregated 112 sessions'), '[usage-billing] aggregated 112 sessions')
  // 单行输入与多行 chunk 都要能用；空输入不炸
  assert.equal(startProgress.pickPhaseLine(''), '')
  assert.equal(startProgress.pickPhaseLine(null), '')
  assert.equal(startProgress.pickPhaseLine('   \n  \n'), '')
})

test('pickPhaseLine：不带 [名字] 前缀的行一律不显示（宁可没有，也不误报）', () => {
  // DSH 的 stderr 里混着多行错误转储与堆栈：把 location / at Proxy.foo 当"当前环节"就是误报
  assert.equal(startProgress.pickPhaseLine('location: {'), '')
  assert.equal(startProgress.pickPhaseLine('    at Proxy.generationFailure (file:///x.js:2622:73)'), '')
  assert.equal(startProgress.pickPhaseLine('  kind: \'jsonl\','), '')
  assert.equal(startProgress.pickPhaseLine('aggregated 112 sessions'), '')
})

test('pickPhaseLine：带 token 的启动地址永不进界面', () => {
  assert.equal(startProgress.pickPhaseLine('dsh web: http://127.0.0.1:3081/?token=cGbWHyUrBPPSE20YKg2iTsWKcQNHM7XwstcSIozrjK8'), '')
  // 即便被插件前缀包着，带 token= 也一律拒绝
  assert.equal(startProgress.pickPhaseLine('[bridge] url http://x/?token=abcdefghijklmnop'), '')
})

test('pickPhaseLine：ANSI/控制字符被剥掉，长行截断，敏感串打码', () => {
  const ansi = startProgress.pickPhaseLine('\u001b[32m[usage-billing]\u001b[0m 扫描完成\u0007')
  assert.equal(ansi, '[usage-billing] 扫描完成')
  const long = startProgress.pickPhaseLine('[x] ' + 'a'.repeat(400))
  assert.ok(long.length <= startProgress.PHASE_MAX, '长行必须截断')
  assert.ok(long.endsWith('…'), '截断要有省略号')
  const masked = startProgress.pickPhaseLine('[llm] key sk-abcdefghijklmnopqrstuvwxyz012345 无效')
  assert.ok(!/sk-abcdefghijklmnopqrstuvwxyz012345/.test(masked), 'key 必须被打码')
})

test('pickPhaseLine：多行输出的首行不留悬空标点（真实日志里就是这样收尾的）', () => {
  assert.equal(
    startProgress.pickPhaseLine('[usage-billing] aggregated 112 sessions, skipped 2 unreadable: ['),
    '[usage-billing] aggregated 112 sessions, skipped 2 unreadable',
  )
  assert.equal(startProgress.pickPhaseLine('[x] 正在装载：'), '[x] 正在装载')
  // 整行只剩前缀+标点 → 没有可展示的内容
  assert.equal(startProgress.pickPhaseLine('[x]: ['), '')
})

test('兜底文案存在且说明了"没有输出"，不许编造内部阶段', () => {
  assert.match(startProgress.PHASE_FALLBACK, /暂无输出/)
  assert.ok(!/装载|组装|初始化/.test(startProgress.PHASE_FALLBACK), '兜底文案不能猜内部阶段')
})

test('createPhaseReader：跨 chunk 的半行不算环节，拼齐了才算', () => {
  const r = startProgress.createPhaseReader()
  assert.equal(r.push('[usage-bil'), '', '半行不能当环节展示')
  assert.equal(r.push('ling] aggregated 112 sessions\n'), '[usage-billing] aggregated 112 sessions')
  // 同一块里多行 → 取最后一条合规行
  assert.equal(r.push('[a] 一\n[b] 二\n'), '[b] 二')
  // 只有半行（没有换行）→ 什么都不出，等下一块
  assert.equal(r.push('[c] 还没写完'), '')
  // 非字符串/空输入不炸
  assert.equal(r.push(null), '')
  assert.equal(r.push(''), '')
  // 收尾：残行永远不展示
  assert.equal(r.push('[d] 结束'), '')
})
