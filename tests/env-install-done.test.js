// tests/env-install-done.test.js — 安装完成收尾的可执行护栏。
//
// 2026-11-22：用户在 Node 24.14.1 的机器上点 DSH 更新被"目标版本要求更高 Node"拦下，
// 升级 Node 成功后版本行却仍停在「需先升级 Node.js」——收尾逻辑没有复检旧结论。
// 这里真实执行 main.js 的 afterEnvInstallDone（桩掉环境探测/启动/更新器），钉住：
//   ① 必须先 refreshEnv（看到新 Node）再判断是否复检；
//   ② 只有"本次确实装了 node"且 DSH 状态是 nodeBlocked 错误时才复检；
//   ③ 复检失败只记日志、不产生未处理 rejection；④ 收尾绝不自动触发 DSH 更新。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n?/g, '\n')
const fnStart = mainSrc.indexOf('async function afterEnvInstallDone')
const fnEnd = mainSrc.indexOf('function initEnvRuntime()')
assert.ok(fnStart > 0 && fnEnd > fnStart, 'main.js 里找不到 afterEnvInstallDone')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function harness({ dsh, checkOnce, pending = false, resume = true, runningAfterUpdate = true } = {}) {
  const events = []
  const logs = []
  let running = true
  const ctx = {
    log: (m) => logs.push(String(m)),
    refreshEnv: async () => { events.push('refresh') },
    envReady: () => true,
    envReport: { pnpm: { status: 'ok' } },
    handleStart: async () => { events.push('start'); running = true },
    maybeAutoInstallRecommendedPlugins: async () => {},
    maybeRemoveRetiredPlugins: () => {},
    server: { running: () => running },
    Config: { pluginSetupChoice: 'auto' },
    pluginSetup: { error: null },
    sleep: async () => {},
    openWebUi: () => {},
    startWhenReady: false,
    pendingDshUpdateAfterNode: pending,
    pendingDshUpdateResume: resume,
    consoleIsOpen: () => true,
    showConsolePage: (page) => { events.push('page:' + page) },
    dshUpdater: {
      getState: () => dsh || { status: 'idle' },
      checkOnce: (...args) => {
        events.push('check')
        return checkOnce ? checkOnce(...args) : Promise.resolve()
      },
      updateNow: (opts) => {
        events.push('updateNow')
        events.push('updateOpts:' + JSON.stringify(opts || {}))
        running = runningAfterUpdate
        return Promise.resolve()
      },
    },
  }
  vm.runInNewContext(mainSrc.slice(fnStart, fnEnd) + '\n;globalThis.afterEnvInstallDone = afterEnvInstallDone', ctx)
  return { run: (snap) => ctx.afterEnvInstallDone(snap), events, logs, ctx }
}

test('装了 node 且被 Node 拦下：先刷新环境，再复检一次（不自动更新 DSH）', async () => {
  const h = harness({ dsh: { status: 'error', nodeBlocked: true } })
  await h.run({ job: { items: ['node'], silent: false } })
  assert.deepEqual(h.events.slice(0, 2), ['refresh', 'check'], '顺序必须是先刷新再复检：' + h.events.join(','))
  assert.ok(h.events.indexOf('start') > h.events.indexOf('check'), '复检不应挡住服务启动：' + h.events.join(','))
  assert.equal(h.events.includes('updateNow'), false, '收尾绝不能自动发起 DSH 更新')
})

test('本次没装 node / 不是 nodeBlocked 错误：一律不复检', async () => {
  for (const [snap, dsh] of [
    [{ job: { items: ['dsh'] } }, { status: 'error', nodeBlocked: true }],
    [{ job: { items: ['node'] } }, { status: 'available', nodeBlocked: false }],
    [{ job: { items: ['node'] } }, { status: 'error', nodeBlocked: false }],
    [{ job: null }, { status: 'error', nodeBlocked: true }],
  ]) {
    const h = harness({ dsh })
    await h.run(snap)
    assert.equal(h.events.includes('check'), false,
      `不该复检：items=${JSON.stringify(snap.job && snap.job.items)} status=${dsh.status} nodeBlocked=${dsh.nodeBlocked}`)
  }
})

test('复检 rejection 被接住：只记日志，不产生未处理 rejection，也不影响后续启动', async () => {
  const h = harness({
    dsh: { status: 'error', nodeBlocked: true },
    checkOnce: () => Promise.reject(new Error('offline')),
  })
  await h.run({ job: { items: ['node'], silent: false } })
  await sleep(10) // 让 catch 回调跑完
  assert.ok(h.logs.some((l) => l.includes('复检失败') && l.includes('offline')), '要留可读日志：' + h.logs.join(' | '))
  assert.ok(h.events.includes('start'), '复检是尽力而为，不能挡住服务启动：' + h.events.join(','))
})

test('静默安装：只刷新/复检，不自动启动服务', async () => {
  const h = harness({ dsh: { status: 'error', nodeBlocked: true } })
  await h.run({ job: { items: ['node'], silent: true } })
  assert.deepEqual(h.events, ['refresh', 'check'], '静默任务不能拉起服务：' + h.events.join(','))
})

// ---------- 串行流程：点一次「升级 Node 并更新 DSH」后，Node 成功即自动继续 DSH 更新 ----------
test('串行流程：Node 成功后直接继续 DSH 更新，不先启动服务、不先复检', async () => {
  const h = harness({ dsh: { status: 'error', nodeBlocked: true }, pending: true })
  await h.run({ job: { items: ['node'], silent: false } })
  assert.equal(h.events[0], 'refresh', '必须先重探环境')
  assert.ok(h.events.includes('updateNow'), 'Node 成功后应自动继续 DSH 更新：' + h.events.join(','))
  assert.ok(h.events.indexOf('page:main') < h.events.indexOf('updateNow'), '先切回「通用」再开始更新：' + h.events.join(','))
  assert.equal(h.events.includes('check'), false, '串行流程不做会挡住更新的复检')
  assert.equal(h.events.includes('start'), false, '不能先启动一次服务再停掉')
  assert.ok(h.events.includes('page:main'), '切回「通用」展示 DSH 更新进度')
  assert.equal(h.events.includes('updateOpts:{"assumeWasRunning":true}'), true, '按"原本在运行"收尾')
  assert.equal(h.ctx.pendingDshUpdateAfterNode, false, '串行标记只能消费一次')
})

test('串行流程：已没有可更新的 DSH 时，退回正常启动服务', async () => {
  const h = harness({ dsh: { status: 'up-to-date' }, pending: true })
  await h.run({ job: { items: ['node'], silent: false } })
  assert.equal(h.events.includes('updateNow'), false, '没有更新时不能触发更新')
  assert.ok(h.events.includes('start'), '服务必须被拉起来：' + h.events.join(','))
  assert.equal(h.ctx.pendingDshUpdateAfterNode, false, '标记仍要被消费')
})

test('串行流程：DSH 更新后服务未起来时，收尾负责兜底启动', async () => {
  const h = harness({ dsh: { status: 'available' }, pending: true, runningAfterUpdate: false })
  await h.run({ job: { items: ['node'], silent: false } })
  assert.deepEqual(h.events.filter((e) => e === 'updateNow' || e === 'start'), ['updateNow', 'start'],
    '更新后服务没起来时必须兜底启动：' + h.events.join(','))
})

test('串行流程：更新前服务本来就没运行，Node 装完也不擅自拉起', async () => {
  const h = harness({ dsh: { status: 'up-to-date' }, pending: true, resume: false })
  await h.run({ job: { items: ['node'], silent: false } })
  assert.equal(h.events.includes('updateNow'), false, '没有可更新版本时不触发更新')
  assert.equal(h.events.includes('start'), false, '服务原本停着，不能顺手拉起：' + h.events.join(','))
  assert.equal(h.ctx.pendingDshUpdateResume, false, 'resume 标记也要被消费')
})
