'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { terminateProcess, waitForCompletion } = require('../service-termination')
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const exitCode = source.slice(source.indexOf('let exitPromise = null'), source.indexOf('// ---------- 自检（对齐 C# selftest'))
function exitHarness(stop, install = async () => false) {
  const events = []
  const ctx = {
    reallyExit: false, stopFlash: () => {}, saveWebWindowState: () => {},
    stopServerFast: async () => { events.push('stop'); return stop() },
    saveConfig: () => {}, runGuardHandle: { markClean: () => events.push('clean') },
    lifecycle: { emit: (_name, detail) => events.push(detail.serviceStopped ? 'stopped' : 'unconfirmed') },
    tray: null, app: { quit: () => events.push('quit') },
    updater: { installOnExit: async () => { events.push('install'); return install() } },
    log: () => {}, redact: (text) => text,
  }
  vm.createContext(ctx)
  vm.runInContext(exitCode + ';globalThis.request=requestExit', ctx)
  return { events, ctx, request: ctx.request }
}
test('所有主动退出先停服务，随后清 marker，再退出；重复请求合并', async () => {
  let resolve
  const h = exitHarness(() => new Promise((r) => { resolve = r }))
  const a = h.request('tray'), b = h.request('quit')
  assert.equal(a, b)
  assert.deepEqual(h.events, ['stop'])
  assert.equal(h.ctx.reallyExit, true)
  resolve(true)
  await a
  assert.deepEqual(h.events, ['stop', 'clean', 'stopped', 'install', 'quit'])
})
test('普通退出清理失败也退出，但绝不安装，不假报停服', async () => {
  const h = exitHarness(() => { throw new Error('mock termination failure') })
  await h.request()
  assert.deepEqual(h.events, ['stop', 'clean', 'unconfirmed', 'quit'])
})
test('信号退出不触发更新安装', async () => {
  for (const signal of ['sigint', 'sigterm']) {
    const h = exitHarness(async () => true)
    await h.request(signal)
    assert.deepEqual(h.events, ['stop', 'clean', 'stopped', 'quit'])
  }
})
test('已成功交接给安装器时不抢先再次 app.quit', async () => {
  const h = exitHarness(async () => true, async () => true)
  await h.request()
  assert.deepEqual(h.events, ['stop', 'clean', 'stopped', 'install'])
})

function stopHarness({ fail = false, external = false, busy = false } = {}) {
  const calls = []
  const child = external ? null : { pid: 42, exitCode: null, signalCode: null }
  const server = {
    child, claimedPid: 0, claimedAlive: false, adoptedPid: external ? 88 : 0,
    adoptedAlive: external, gen: 0, settling: false, stopping: false,
    owned() { return !!this.child }, claimed() { return this.claimedAlive }, managed() { return this.owned() || this.claimed() },
  }
  const ctx = {
    server, process: { env: {} }, log: () => {}, redact: (s) => s,
    beginServiceStop: () => !busy, endServiceStop: () => {}, cancelRestartRetry: () => {}, broadcastState: () => {},
    stopPidVerified: async (pid) => { calls.push(pid); if (fail) throw new Error('still alive') },
    clearClaimed: () => { server.claimedPid = 0; server.claimedAlive = false }, lastServiceError: '', waitForCompletion,
  }
  vm.createContext(ctx)
  const begin = source.indexOf('let serviceStopPromise = null')
  const end = source.indexOf('// 认领的自重启后继拿不到新凭据', begin)
  vm.runInContext(source.slice(begin, end) + ';globalThis.stop=stopServer;', ctx)
  return { calls, child, server, ctx, stop: ctx.stop }
}
test('停止验证失败保留自有 PID，重置停止标志且向上传播错误', async () => {
  const h = stopHarness({ fail: true })
  await assert.rejects(h.stop(), /still alive/)
  assert.equal(h.server.child, h.child)
  assert.equal(h.server.stopping, false)
  assert.match(h.ctx.lastServiceError, /still alive/)
})
test('退出/更新启动器的 managedOnly 不终止外部接管服务；显式停止仍可停止它', async () => {
  const h = stopHarness({ external: true })
  assert.equal(await h.stop({ managedOnly: true, force: true }), true)
  assert.equal(h.server.adoptedPid, 88)
  assert.deepEqual(h.calls, [])
  assert.equal(await h.stop(), true)
  assert.deepEqual(h.calls, [88])
  assert.equal(h.server.adoptedPid, 0)
})
test('忙状态返回 false，不报告成功或清 PID', async () => {
  const h = stopHarness({ busy: true })
  assert.equal(await h.stop(), false)
  assert.equal(h.server.child, h.child)
  assert.deepEqual(h.calls, [])
})
test('停止过程中旧 child 退出并产生同签名后继，必须再次停止后继才成功', async () => {
  const h = stopHarness()
  h.server.launchSig = { script: 'mock', args: [] }
  let listener = 0
  h.ctx.findListenPid = async () => listener
  h.ctx.matchSuccessorPid = async (pid) => pid === 43 ? 43 : 0
  h.ctx.stopPidVerified = async (pid) => {
    h.calls.push(pid)
    if (pid === 42) { h.server.child = null; listener = 43 }
    else if (pid === 43) listener = 0
  }
  assert.equal(await h.stop(), true)
  assert.deepEqual(h.calls, [42, 43])
  assert.equal(h.server.claimedPid, 0)
})
test('在途启动准备必须取消且等它结束，不能停服成功后晚到 spawn', async () => {
  const h = stopHarness()
  h.server.child = null
  h.server.startPromise = null
  let release, spawned = 0, prepared
  const preparing = new Promise((resolve) => { prepared = resolve })
  const ctx = {
    server: h.server, reallyExit: false, serviceStopping: () => false,
    markLoadingProgress: () => {}, portOpen: async () => false,
    envReport: { plan: { dshBin: 'mock-bin', nodeCmd: 'mock-node' } },
    fs: { existsSync: () => true },
    bridge: { ensureRuntimeDeps: () => new Promise((resolve) => { release = resolve; prepared() }), getState: () => ({ installed: false }) },
    spawn: () => { spawned++; throw new Error('不能启动') }, log: () => {},
  }
  const body = source.slice(source.indexOf('async function startServerInner('), source.indexOf('function killPid('))
  vm.runInNewContext(body + ';globalThis.start=startServerInner', ctx)
  h.server.startPromise = ctx.start()
  await preparing
  let completed = false
  const stopping = h.stop({ managedOnly: true, force: true }).then((result) => { completed = true; return result })
  await Promise.resolve()
  assert.equal(completed, false)
  release()
  assert.equal(await stopping, true)
  assert.equal(await h.server.startPromise, false)
  assert.equal(spawned, 0)
})
test('更新期禁止普通启动，只有 DSH 更新协调器允许自己的校验启动', async () => {
  let calls = 0
  const ctx = {
    reallyExit: false, exitCleanupComplete: false, server: { startPromise: null },
    updater: { isInstalling: () => false }, dshUpdater: { getState: () => ({ status: 'updating' }) },
    startServerInner: async () => { calls++; return true },
  }
  const body = source.slice(source.indexOf('function startServer('), source.indexOf('async function startServerInner('))
  vm.runInNewContext(body + ';globalThis.start=startServer', ctx)
  assert.equal(await ctx.start(), false)
  assert.equal(calls, 0)
  assert.equal(await ctx.start(0, true), true)
  ctx.updater.isInstalling = () => true
  assert.equal(await ctx.start(0, true), false)
})
test('无句柄 PID 在首次关闭后被重用，不得再强杀新的同号进程', async () => {
  const calls = []
  let reads = 0
  const ctx = {
    probePid: () => true,
    readProcessIdentity: async () => ({ startedAt: ++reads >= 4 ? 'new' : 'original', cmdline: 'known' }),
    server: { claimedPid: 42, adoptedPid: 0, launchSig: {} }, handover: { matchLaunchSig: () => ({ ok: true }) },
    killPid: async (_pid, force) => { calls.push(force); return { ok: true } }, terminateProcess,
  }
  const begin = source.indexOf('async function stopPidVerified(')
  vm.runInNewContext(source.slice(begin, source.indexOf('// ---------- DSH 自重启的识别', begin)) + ';globalThis.stop=stopPidVerified', ctx)
  assert.equal((await ctx.stop(42, null)).stopped, true)
  assert.deepEqual(calls, [false])
})
test('无法读取身份或后继命令行不匹配时不得发终止命令', async () => {
  for (const identity of [null, { startedAt: '1', cmdline: 'other' }]) {
    let calls = 0
    const ctx = {
      probePid: () => true, readProcessIdentity: async () => identity,
      server: { claimedPid: 42, adoptedPid: 0, launchSig: {} }, handover: { matchLaunchSig: () => ({ ok: false }) },
      killPid: async () => { calls++; return { ok: true } }, terminateProcess,
    }
    const begin = source.indexOf('async function stopPidVerified(')
    vm.runInNewContext(source.slice(begin, source.indexOf('// ---------- DSH 自重启的识别', begin)) + ';globalThis.stop=stopPidVerified', ctx)
    await assert.rejects(ctx.stop(42, null), /身份/)
    assert.equal(calls, 0)
  }
})

test('SIGINT/SIGTERM 与 before-quit 接入统一收尾，before-quit 等待而非异步假退出', () => {
  const handlers = {}, requests = []
  const ctx = {
    IS_WIN: false, SELF_TEST: false, ownsLauncherInstance: true, exitCleanupComplete: false, systemSessionEnding: false,
    app: { on: (name, callback) => { handlers[name] = callback } },
    process: { on: (name, callback) => { handlers[name] = callback } },
    requestExit: (reason) => requests.push(reason), runGuardHandle: null,
  }
  vm.runInNewContext(source.slice(source.indexOf('// ---------- 应用生命周期 ----------'), source.indexOf("process.on('uncaughtException'")), ctx)
  handlers.SIGINT(); handlers.SIGTERM()
  let prevented = 0
  handlers['before-quit']({ preventDefault: () => prevented++ })
  assert.deepEqual(requests, ['sigint', 'sigterm', 'quit'])
  assert.equal(prevented, 1)
  ctx.exitCleanupComplete = true
  handlers['before-quit']({ preventDefault: () => prevented++ })
  assert.equal(prevented, 1)
})
