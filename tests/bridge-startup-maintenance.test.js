// tests/bridge-startup-maintenance.test.js — 远程连接启动维护的接线护栏
//
// 2026-10-27 本机事故：
//   1. remoteConnect 早已被用户关闭（enabled=false/declined=true），但启动器启动时仍做了
//      bridge 自愈 + 重装判断，把用户自己从 npm 装的 2.0.2 换成自带的 2.0.0-dev.11；
//   2. ensureRuntimeDeps 先于 install 跑，镜像 junction 指向 install 马上要剪掉的 profile
//      依赖；install 之后 junction 悬空 → payload 入口 `Cannot find module 'qrcode'`
//      → 插件整体不加载，侧边栏入口和设置页入口一起消失。
//
// 这里把两个启动期函数从 main.js 抽出来真跑，锁住三条行为：
//   - 关闭远程连接时不得调用 bridge 自愈/安装（只留一条解释日志）；
//   - 开启时重装成功后必须再刷一次运行依赖；
//   - payload import 自检在关闭时直接跳过（不制造"插件未生效"假警报）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n?/gu, '\n')

/** 抽一个顶层 async 函数（结尾是行首 `}`），供 new Function 注入依赖真跑。 */
function extractAsyncFunction(name) {
  const start = main.indexOf('async function ' + name + '(')
  assert.ok(start > 0, 'main.js 里找不到 ' + name)
  const end = main.indexOf('\n}\n', start)
  assert.ok(end > start, name + ' 找不到函数结尾')
  return main.slice(start, end + 2)
}

const SNAP_HEALTHY = {
  installed: true,
  payloadReady: true,
  materializedPatchReady: true,
  specMatchesPayload: true,
  payloadVersion: '2.0.0-dev.11',
}

function loadMaintenance({ remoteConnect, states, repair = { ok: true, version: '2.0.0-dev.11' } } = {}) {
  const logs = []
  const calls = { runtimeDeps: 0, install: 0 }
  const list = Array.isArray(states) ? states : [states]
  let cursor = 0
  const bridge = {
    getState: () => list[Math.min(cursor++, list.length - 1)],
    ensureRuntimeDeps: async () => { calls.runtimeDeps += 1 },
    install: async () => { calls.install += 1; return repair },
    // payload 规格（link:/file:）之外的安装算"外部版本"：本测试里 SNAP 没有 spec → 按非外部处理
    externalInstallSpec: (spec) => !!spec && !/^(?:link:|file:)/iu.test(String(spec)),
  }
  const src = extractAsyncFunction('ensureBridgeStartupMaintenance') + '\nreturn ensureBridgeStartupMaintenance'
  const fn = new Function('Config', 'log', 'bridge', src)(
    { remoteConnect },
    (message) => logs.push(String(message)),
    bridge,
  )
  return { fn, logs, calls }
}

test('remoteConnect 关闭且 profile 有同名插件：不碰 bridge，只留一条解释日志', async () => {
  const { fn, logs, calls } = loadMaintenance({
    remoteConnect: { enabled: false },
    states: { ...SNAP_HEALTHY, specMatchesPayload: false },
  })
  assert.equal(await fn(), false, '关闭状态下不执行启动维护')
  assert.deepEqual(calls, { runtimeDeps: 0, install: 0 }, '关闭状态下既不能自愈也不能重装（用户可能是自己从 npm 装的）')
  assert.ok(logs.some((line) => line.includes('远程连接已关闭')), '要能解释"为什么没动它"：' + logs.join(' | '))
})

test('remoteConnect 关闭且 profile 没装同名插件：不产生噪音日志', async () => {
  const { fn, logs, calls } = loadMaintenance({
    remoteConnect: { enabled: false },
    states: { installed: false, payloadReady: true },
  })
  assert.equal(await fn(), false)
  assert.deepEqual(calls, { runtimeDeps: 0, install: 0 })
  assert.deepEqual(logs, [])
})

test('remoteConnect 开启且安装健康：自愈一次，不重装', async () => {
  const { fn, calls } = loadMaintenance({ remoteConnect: { enabled: true }, states: SNAP_HEALTHY })
  assert.equal(await fn(), true)
  assert.deepEqual(calls, { runtimeDeps: 1, install: 0 })
})

test('remoteConnect 开启且需要修复：重装成功后必须再刷一次运行依赖', async () => {
  const stale = { ...SNAP_HEALTHY, specMatchesPayload: false }
  const { fn, calls, logs } = loadMaintenance({ remoteConnect: { enabled: true }, states: [stale, stale] })
  assert.equal(await fn(), true)
  assert.equal(calls.install, 1, '规格不匹配时应重装一次')
  assert.equal(calls.runtimeDeps, 2, '装前自愈 + 装后重刷缺一，就会出现"装好了却 Cannot find module"')
  assert.ok(logs.some((line) => line.includes('启动前修复完成')), logs.join(' | '))
})

test('修复失败：不再刷依赖，但错误必须进日志', async () => {
  const stale = { ...SNAP_HEALTHY, specMatchesPayload: false }
  const { fn, calls, logs } = loadMaintenance({
    remoteConnect: { enabled: true },
    states: [stale, stale],
    repair: { ok: false, error: 'ETIMEDOUT' },
  })
  assert.equal(await fn(), true)
  assert.equal(calls.install, 1)
  assert.equal(calls.runtimeDeps, 1, '修复失败时没有可刷的镜像')
  assert.ok(logs.some((line) => line.includes('启动前修复失败') && line.includes('ETIMEDOUT')), logs.join(' | '))
})

function loadImportCheck({ remoteConnect, snap = SNAP_HEALTHY, check = { ok: true } } = {}) {
  const logs = []
  const issues = []
  const calls = { importCheck: 0, broadcast: 0 }
  const bridge = {
    PLUGIN_NAME: '@agents-anywhere/dsh-bridge-next',
    getState: () => snap,
    importCheckPayload: async () => { calls.importCheck += 1; return check },
    // SNAP 没有 spec → 不属于外部版本，自检照常跑
    externalInstallSpec: (spec) => !!spec && !/^(?:link:|file:)/iu.test(String(spec)),
  }
  const src = extractAsyncFunction('runBridgeImportCheck') + '\nreturn runBridgeImportCheck'
  const fn = new Function('Config', 'bridge', 'log', 'redact', 'server', 'pluginActivation', 'broadcastState', src)(
    { remoteConnect },
    bridge,
    (message) => logs.push(String(message)),
    (value) => value,
    { activationIssues: issues },
    { importCheckIssue: (name, detail) => ({ name, detail }) },
    () => { calls.broadcast += 1 },
  )
  return { fn, logs, issues, calls }
}

test('payload import 自检：远程连接关闭时直接跳过（不报假警报）', async () => {
  const { fn, calls, issues } = loadImportCheck({ remoteConnect: { enabled: false } })
  await fn()
  assert.equal(calls.importCheck, 0, '关闭时不该拿启动器 payload 的健康状况去评价 profile 里的插件')
  assert.deepEqual(issues, [])
})

test('payload import 自检：开启时记录通过/失败证据', async () => {
  const okRun = loadImportCheck({ remoteConnect: { enabled: true } })
  await okRun.fn()
  assert.equal(okRun.calls.importCheck, 1)
  assert.equal(okRun.issues.length, 0)

  const badRun = loadImportCheck({
    remoteConnect: { enabled: true },
    check: { ok: false, error: "Cannot find module 'qrcode'" },
  })
  await badRun.fn()
  assert.equal(badRun.issues.length, 1, '失败要落成"插件未生效"证据')
  assert.match(badRun.issues[0].detail, /qrcode/u)
  assert.equal(badRun.calls.broadcast, 1, '卡片要立刻刷新')
})

test('startServerInner 必须调用 ensureBridgeStartupMaintenance（防止维护逻辑被内联回去）', () => {
  assert.match(main, /await ensureBridgeStartupMaintenance\(\)/u)
})
