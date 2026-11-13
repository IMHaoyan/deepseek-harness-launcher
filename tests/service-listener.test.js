// tests/service-listener.test.js — 监听 PID 取证（netstat → Get-NetTCPConnection 兜底）的纯函数与 IO 编排
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const listener = require('../service-listener')

const netstatRow = (local, pid, state = 'LISTENING', proto = 'TCP') =>
  `  ${proto}    ${local}         0.0.0.0:0              ${state}       ${pid}`

function fakeExec({ stdout = '', err = null, onCall } = {}) {
  return (file, args, opts, cb) => {
    if (onCall) onCall(file, args, opts)
    setImmediate(() => cb(err, stdout, ''))
  }
}

function fakePwsh(handler) {
  return async (script, opts) => handler(script, opts)
}

test('splitHostPort：IPv4 / IPv6 / 通配地址都能拆出 host 与端口', () => {
  assert.deepEqual(listener.splitHostPort('127.0.0.1:5099'), { hostPart: '127.0.0.1', port: 5099 })
  assert.deepEqual(listener.splitHostPort('[::1]:5099'), { hostPart: '::1', port: 5099 })
  assert.deepEqual(listener.splitHostPort('[::]:5099'), { hostPart: '::', port: 5099 })
  assert.equal(listener.splitHostPort('nonsense'), null)
  assert.equal(listener.splitHostPort(''), null)
})

test('parseNetstatListeners：IPv4 监听行 → found', () => {
  const r = listener.parseNetstatListeners(netstatRow('127.0.0.1:5099', 26636), 5099, '127.0.0.1')
  assert.equal(r.status, 'found')
  assert.equal(r.pid, 26636)
  assert.equal(r.via, 'netstat')
  assert.equal(r.ambiguous, false)
})

test('parseNetstatListeners：IPv6 监听行同样识别（不再依赖 -p TCP）', () => {
  const out = netstatRow('[::1]:5099', 73940, 'LISTENING', 'TCPv6')
  const r = listener.parseNetstatListeners(out, 5099, '127.0.0.1')
  assert.equal(r.status, 'found')
  assert.equal(r.pid, 73940)
})

test('parseNetstatListeners：PID=0 行不能提前 return，后面的有效行仍要收', () => {
  const out = [netstatRow('127.0.0.1:5099', 0), netstatRow('127.0.0.1:5099', 4242)].join('\r\n')
  const r = listener.parseNetstatListeners(out, 5099, '127.0.0.1')
  assert.equal(r.status, 'found')
  assert.equal(r.pid, 4242)
})

test('parseNetstatListeners：同端口多监听行时优先精确 host，其次通配', () => {
  const out = [
    netstatRow('0.0.0.0:5099', 100),
    netstatRow('127.0.0.1:5099', 200),
  ].join('\n')
  const r = listener.parseNetstatListeners(out, 5099, '127.0.0.1')
  assert.equal(r.pid, 200)
  // 同优先级两个不同 PID = 歧义（返回第一个但标记出来）
  const dual = listener.parseNetstatListeners([
    netstatRow('127.0.0.1:5099', 300),
    netstatRow('127.0.0.1:5099', 400),
  ].join('\n'), 5099, '127.0.0.1')
  assert.equal(dual.status, 'found')
  assert.equal(dual.ambiguous, true)
})

test('parseNetstatListeners：没有该端口/没有 LISTENING 行 → absent（不是 unknown）', () => {
  assert.equal(listener.parseNetstatListeners('', 5099, '127.0.0.1').status, 'absent')
  assert.equal(listener.parseNetstatListeners(netstatRow('127.0.0.1:5100', 1), 5099, '127.0.0.1').status, 'absent')
  assert.equal(listener.parseNetstatListeners(netstatRow('127.0.0.1:5099', 1, 'ESTABLISHED'), 5099, '127.0.0.1').status, 'absent')
})

test('parseNetTcpRows：pid;address 输出按 host 择优', () => {
  const r = listener.parseNetTcpRows('100;0.0.0.0\r\n200;127.0.0.1\r\n', '127.0.0.1')
  assert.equal(r.status, 'found')
  assert.equal(r.pid, 200)
  assert.equal(r.via, 'net-tcp')
  assert.equal(listener.parseNetTcpRows('', '127.0.0.1').status, 'absent')
})

test('fallbackScript：不依赖 State、用 RemotePort=0、并显式 exit 0', () => {
  const s = listener.fallbackScript(5099)
  assert.match(s, /Get-NetTCPConnection -LocalPort 5099/u)
  assert.match(s, /RemotePort -eq 0/u)
  assert.match(s, /exit 0/u)
  assert.doesNotMatch(s, /-State /u)
})

test('resolver：netstat 命中时绝不跑 PowerShell 兜底', async () => {
  let pwshCalls = 0
  const r = listener.createListenerResolver({
    isWin: true,
    execFileImpl: fakeExec({ stdout: netstatRow('127.0.0.1:5099', 26636) }),
    runPwshImpl: fakePwsh(() => { pwshCalls++; return { ok: true, stdout: '', stderr: '' } }),
  })
  const got = await r.resolve(5099, { probePortOpen: async () => true })
  assert.equal(got.status, 'found')
  assert.equal(got.pid, 26636)
  assert.equal(pwshCalls, 0)
})

test('resolver：端口没人应答时不跑兜底（absent 保持 absent）', async () => {
  let pwshCalls = 0
  const r = listener.createListenerResolver({
    isWin: true,
    execFileImpl: fakeExec({ stdout: '' }),
    runPwshImpl: fakePwsh(() => { pwshCalls++; return { ok: true, stdout: '26636;127.0.0.1', stderr: '' } }),
  })
  const got = await r.resolve(5099, { probePortOpen: async () => false })
  assert.equal(got.status, 'absent')
  assert.equal(pwshCalls, 0)
})

test('resolver：netstat 无行但端口有人应答 → 兜底找到 PID（报告机器场景）', async () => {
  let pwshCalls = 0
  const r = listener.createListenerResolver({
    isWin: true,
    execFileImpl: fakeExec({ stdout: '' }),
    runPwshImpl: fakePwsh(() => { pwshCalls++; return { ok: true, stdout: '26636;127.0.0.1', stderr: '' } }),
  })
  const got = await r.resolve(5099, { probePortOpen: async () => true })
  assert.equal(got.status, 'found')
  assert.equal(got.pid, 26636)
  assert.equal(got.via, 'net-tcp')
  assert.equal(pwshCalls, 1)
})

test('resolver：两条通道都失败 → unknown，绝不能落成 absent', async () => {
  const r = listener.createListenerResolver({
    isWin: true,
    execFileImpl: fakeExec({ err: Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) }),
    runPwshImpl: fakePwsh(() => ({ ok: false, code: 1, stdout: '', stderr: 'Access denied' })),
  })
  const got = await r.resolve(5099, { probePortOpen: async () => true })
  assert.equal(got.status, 'unknown')
  assert.equal(got.diag.primary.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  assert.match(got.diag.stderr || '', /Access denied/u)
})

test('resolver：兜底返回空（端口有人应答却查不到 PID）同样算 unknown', async () => {
  const r = listener.createListenerResolver({
    isWin: true,
    execFileImpl: fakeExec({ stdout: '' }),
    runPwshImpl: fakePwsh(() => ({ ok: true, stdout: '', stderr: '' })),
  })
  const got = await r.resolve(5099, { probePortOpen: async () => true })
  assert.equal(got.status, 'unknown')
})

test('resolver：兜底结果缓存 ~cacheMs，避免在轮询里反复起 PowerShell', async () => {
  let pwshCalls = 0
  let t = 1_000_000
  const r = listener.createListenerResolver({
    isWin: true,
    execFileImpl: fakeExec({ stdout: '' }),
    runPwshImpl: fakePwsh(() => { pwshCalls++; return { ok: true, stdout: '26636;127.0.0.1', stderr: '' } }),
    now: () => t,
    cacheMs: 1200,
  })
  await r.resolve(5099, { probePortOpen: async () => true })
  t += 300
  const cached = await r.resolve(5099, { probePortOpen: async () => true })
  assert.equal(cached.cached, true)
  assert.equal(pwshCalls, 1)
  t += 2000
  await r.resolve(5099, { probePortOpen: async () => true })
  assert.equal(pwshCalls, 2)
})

test('resolver：POSIX 的 lsof 退出码 1 = absent；ENOENT = unknown', async () => {
  const absent = listener.createListenerResolver({
    isWin: false,
    host: '127.0.0.1',
    execFileImpl: fakeExec({ err: Object.assign(new Error('no match'), { code: 1 }) }),
    runPwshImpl: fakePwsh(() => ({ ok: true, stdout: '' })),
  })
  assert.equal((await absent.resolve(5099)).status, 'absent')
  const missing = listener.createListenerResolver({
    isWin: false,
    host: '127.0.0.1',
    execFileImpl: fakeExec({ err: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    runPwshImpl: fakePwsh(() => ({ ok: true, stdout: '' })),
  })
  assert.equal((await missing.resolve(5099)).status, 'unknown')
})

test('createListenerResolver：缺少注入的 IO 直接报错（别在运行时才炸）', () => {
  assert.throws(() => listener.createListenerResolver({ isWin: true }), /execFileImpl/u)
})
