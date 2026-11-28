'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { probePid, terminateProcess, waitPortClosed } = require('../service-termination')

function harness({ alive = true, send } = {}) {
  let time = 0, state = alive
  const calls = []
  return {
    calls,
    options: {
      now: () => time, sleep: async (ms) => { time += ms }, gracefulMs: 200, verifyMs: 200,
      probe: async () => state,
      send: async (force) => { calls.push(force); return send ? send(force, (v) => { state = v }) : { ok: true } },
    },
  }
}

test('PID 探测仅 ESRCH 是退出证据，权限错误是未知', () => {
  assert.equal(probePid(42, () => {}), true)
  assert.equal(probePid(42, () => { throw Object.assign(new Error(), { code: 'ESRCH' }) }), false)
  assert.equal(probePid(42, () => { throw Object.assign(new Error(), { code: 'EPERM' }) }), null)
  assert.equal(probePid(0, () => { throw new Error('不得调用') }), null)
})
test('已退出不再发命令；不对非法 PID 发命令', async () => {
  const h = harness({ alive: false })
  assert.equal((await terminateProcess(42, h.options)).alreadyGone, true)
  assert.deepEqual(h.calls, [])
  await assert.rejects(terminateProcess(-1, h.options), /ID/)
})
test('非强杀后真的退出才成功', async () => {
  const h = harness({ send: (_force, set) => { set(false); return { ok: true } } })
  assert.equal((await terminateProcess(42, h.options)).forced, false)
  assert.deepEqual(h.calls, [false])
})
test('先请求关闭再强杀，并在强杀后确认退出', async () => {
  const h = harness({ send: (force, set) => { if (force) set(false); return { ok: true } } })
  assert.equal((await terminateProcess(42, h.options)).forced, true)
  assert.deepEqual(h.calls, [false, true])
})
test('命令成功但进程仍活着，必须失败', async () => {
  const h = harness()
  await assert.rejects(terminateProcess(42, h.options), /进程仍在运行/)
})
test('命令失败且仍存活，保留错误原因，不报告停止', async () => {
  const h = harness({ send: () => ({ ok: false, error: 'access denied' }) })
  await assert.rejects(terminateProcess(42, h.options), /access denied/)
})
test('终止/探测异常以及未知状态不能成为成功', async () => {
  const h = harness({ alive: null, send: () => { throw new Error('mock timeout') } })
  await assert.rejects(terminateProcess(42, h.options), /无法读取进程状态.*mock timeout/)
})
test('命令报错但独立采样确认已退出（竞争）可成功', async () => {
  const h = harness({ send: (_force, set) => { set(false); return { ok: false, error: 'already gone' } } })
  assert.equal((await terminateProcess(42, h.options)).stopped, true)
})
test('快速退出仍等待确认，不尝试优雅关闭', async () => {
  const h = harness({ send: (_force, set) => { set(false); return { ok: true } } })
  await terminateProcess(42, { ...h.options, force: true })
  assert.deepEqual(h.calls, [true])
})
test('waitPortClosed：端口立即关闭即成功（0 宽限也不sleep）', async () => {
  let calls = 0
  assert.equal(await waitPortClosed(async () => { calls++; return false }), true)
  assert.equal(calls, 1)
})
test('waitPortClosed：短暂残留后关闭要判成功（进程已退不等于监听立刻消失）', async () => {
  let time = 0, calls = 0
  const ok = await waitPortClosed(async () => { calls++; return calls <= 2 }, {
    timeoutMs: 1000, stepMs: 100, now: () => time, sleep: async (ms) => { time += ms },
  })
  assert.equal(ok, true)
  assert.equal(calls, 3)
})
test('waitPortClosed：始终不关闭则有界失败（fail-closed）', async () => {
  let time = 0, calls = 0
  const ok = await waitPortClosed(async () => { calls++; return true }, {
    timeoutMs: 250, stepMs: 100, now: () => time, sleep: async (ms) => { time += ms },
  })
  assert.equal(ok, false)
  assert.ok(calls <= 4, '轮询次数必须有界，不能无限等')
})
test('waitPortClosed：探测抛错按“仍有应答”处理', async () => {
  let time = 0
  const ok = await waitPortClosed(async () => { throw new Error('boom') }, {
    timeoutMs: 200, stepMs: 100, now: () => time, sleep: async (ms) => { time += ms },
  })
  assert.equal(ok, false)
})

