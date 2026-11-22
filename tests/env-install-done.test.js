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

function harness({ dsh, checkOnce } = {}) {
  const events = []
  const logs = []
  const ctx = {
    log: (m) => logs.push(String(m)),
    refreshEnv: async () => { events.push('refresh') },
    envReady: () => true,
    envReport: { pnpm: { status: 'ok' } },
    handleStart: async () => { events.push('start') },
    maybeAutoInstallRecommendedPlugins: async () => {},
    maybeRemoveRetiredPlugins: () => {},
    server: { running: () => true },
    Config: { pluginSetupChoice: 'auto' },
    pluginSetup: { error: null },
    sleep: async () => {},
    openWebUi: () => {},
    startWhenReady: false,
    dshUpdater: {
      getState: () => dsh || { status: 'idle' },
      checkOnce: (...args) => {
        events.push('check')
        return checkOnce ? checkOnce(...args) : Promise.resolve()
      },
      updateNow: () => { events.push('updateNow'); return Promise.resolve() },
    },
  }
  vm.runInNewContext(mainSrc.slice(fnStart, fnEnd) + '\n;globalThis.afterEnvInstallDone = afterEnvInstallDone', ctx)
  return { run: (snap) => ctx.afterEnvInstallDone(snap), events, logs }
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
