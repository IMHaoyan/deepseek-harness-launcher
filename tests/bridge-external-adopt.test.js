// tests/bridge-external-adopt.test.js — 「外部安装不归启动器托管」的护栏
//
// 背景（2026-10-27 事故）：用户自己从 npm 装了 2.0.2，启动器的启动自愈把"规格不匹配"当成
// "安装内容不完整"直接重装成随包 payload，等于覆盖用户选择；重装还把依赖镜像剪悬空
// （Cannot find module 'qrcode'）。现在的边界只有一条：发现**外部安装**时关掉启动器托管、
// 不碰 profile；payload 安装（启动器自己的）照常走自愈。
// 这里锁四件事：① 只有外部规格才触发；② payload 安装不触发、也不记账；
// ③ 触发后记账，不反复改配置；④ 启动顺序上"先做外部安装检查、再做 payload 自愈"。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const bridge = require('../bridge')

const root = path.resolve(__dirname, '..')
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n?/gu, '\n')

function extractFunction(name) {
  const start = mainSrc.indexOf('async function ' + name + '(')
  assert.ok(start > 0, 'main.js 里找不到 ' + name)
  const end = mainSrc.indexOf('\n}\n', start)
  assert.ok(end > start, name + ' 找不到函数结尾')
  return mainSrc.slice(start, end + 2)
}

test('payloadInstallSpec / externalInstallSpec：启动器 payload 与外部安装的边界', () => {
  const payloads = [
    'link:C:/Users/me/.dsh/dshl/bridge-payloads/2.0.0-dev.11-abc/bridge-next.tgz',
    'file:C:\\Users\\me\\.dsh\\dshl\\bridge-payloads\\x\\bridge-next.tgz',
    'file:C:/cache/bridge-next.tgz',
  ]
  for (const spec of payloads) {
    assert.equal(bridge.payloadInstallSpec(spec), true, spec)
    assert.equal(bridge.externalInstallSpec(spec), false, spec)
  }

  const external = [
    '^2.0.2',
    '2.0.2',
    'link:C:/Users/me/.dsh/dshl/desktop-signin/1.0.0',
    'github:wzn16/dsh-auto-archive',
    'https://example.com/x.tgz',
  ]
  for (const spec of external) {
    assert.equal(bridge.payloadInstallSpec(spec), false, spec)
    assert.equal(bridge.externalInstallSpec(spec), true, spec)
  }
  assert.equal(bridge.externalInstallSpec(''), false, '空规格不算外部安装')
})

function loadAdopt({ marked = '', selfTest = false, snap = {}, remoteConnect = { enabled: true, declined: false } } = {}) {
  const logs = []
  const calls = { save: 0, broadcast: 0 }
  const Config = { bridgeExternalAdopt: marked, remoteConnect }
  const bridgeStub = {
    getState: () => snap,
    payloadInstallSpec: bridge.payloadInstallSpec,
    externalInstallSpec: bridge.externalInstallSpec,
  }
  const src = extractFunction('maybeAdoptExternalBridgeInstall') + '\nreturn maybeAdoptExternalBridgeInstall'
  const fn = new Function('SELF_TEST', 'Config', 'BRIDGE_EXTERNAL_ADOPT', 'bridge', 'log', 'saveConfig', 'broadcastState', src)(
    selfTest,
    Config,
    'bridge-external-1',
    bridgeStub,
    (line) => logs.push(String(line)),
    () => { calls.save += 1 },
    () => { calls.broadcast += 1 },
  )
  return { fn, Config, logs, calls }
}

test('已记账 / 自检模式：不读 profile、不改配置', async () => {
  for (const options of [{ marked: 'bridge-external-1' }, { selfTest: true }]) {
    const run = loadAdopt(options)
    assert.equal(await run.fn(), false)
    assert.equal(run.calls.save, 0, JSON.stringify(options))
    assert.deepEqual(run.logs, [])
  }
})

test('没装插件：记账后不再重复检查，不动托管开关', async () => {
  const run = loadAdopt({ snap: { installed: false } })
  assert.equal(await run.fn(), false)
  assert.equal(run.Config.bridgeExternalAdopt, 'bridge-external-1')
  assert.equal(run.Config.remoteConnect.enabled, true)
  assert.equal(run.calls.save, 1)
})

test('启动器 payload 安装：不触发、不记账（继续走正常自愈）', async () => {
  const run = loadAdopt({
    snap: { installed: true, spec: 'link:C:/Users/me/.dsh/dshl/bridge-payloads/2.0.0-dev.11-x/bridge-next.tgz' },
  })
  assert.equal(await run.fn(), false)
  assert.equal(run.Config.bridgeExternalAdopt, '', 'payload 情况不记账：以后可能变成外部安装')
  assert.equal(run.Config.remoteConnect.enabled, true, 'payload 归启动器托管，开关不动')
  assert.equal(run.calls.save, 0)
  assert.deepEqual(run.logs, [])
})

test('外部安装且托管开启：关掉托管 + 记账，避免启动自愈把它换回 payload', async () => {
  const run = loadAdopt({ snap: { installed: true, spec: '^2.0.2' } })
  assert.equal(await run.fn(), true)
  assert.equal(run.Config.remoteConnect.enabled, false)
  assert.equal(run.Config.remoteConnect.declined, true)
  assert.equal(run.Config.bridgeExternalAdopt, 'bridge-external-1')
  assert.equal(run.calls.save, 1)
  assert.equal(run.calls.broadcast, 1, '开关变了要让界面刷新')
  assert.ok(run.logs.some((line) => line.includes('已关闭启动器托管')), run.logs.join(' | '))
})

test('外部安装但托管已关闭：只记账 + 解释日志，不改配置', async () => {
  const run = loadAdopt({
    snap: { installed: true, spec: '^2.0.2' },
    remoteConnect: { enabled: false, declined: true },
  })
  assert.equal(await run.fn(), false, '配置没变就不算"调整了托管开关"')
  assert.equal(run.Config.remoteConnect.declined, true)
  assert.equal(run.Config.bridgeExternalAdopt, 'bridge-external-1')
  assert.equal(run.calls.save, 1)
  assert.equal(run.calls.broadcast, 0)
  assert.ok(run.logs.some((line) => line.includes('启动器不替换它')), run.logs.join(' | '))
})

test('接线：启动时先检查外部安装、再做 payload 自愈（顺序反了会被自愈覆盖）', () => {
  const adoptAt = mainSrc.indexOf('await maybeAdoptExternalBridgeInstall()')
  const maintainAt = mainSrc.indexOf('await ensureBridgeStartupMaintenance()')
  assert.ok(adoptAt > 0 && maintainAt > 0, 'startServerInner 必须调用这两个函数')
  assert.ok(adoptAt < maintainAt, '外部安装检查必须在 payload 自愈之前执行')
})
