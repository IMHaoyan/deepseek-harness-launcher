// tests/bridge-migration.test.js — 旧版「随包 payload」→ npm 版本的一次性迁移
//
// dshl 不再随包分发手机连接。老用户 profile 里的依赖还是
// `link:<...>/bridge-payloads/.../bridge-next.tgz`，启动服务前必须换成 npm 版本；
// 失败不能标记（下次启动重试），成功才记账并清掉旧缓存。这里锁住判定与迁移语义。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n?/gu, '\n')

function extractAsync(name) {
  const start = mainSrc.indexOf('async function ' + name + '(')
  assert.ok(start > 0, 'main.js 里找不到 ' + name)
  const end = mainSrc.indexOf('\n}\n', start)
  assert.ok(end > start, name + ' 找不到函数结尾')
  return mainSrc.slice(start, end + 2)
}

function extractSync(name) {
  const start = mainSrc.indexOf('function ' + name + '(')
  assert.ok(start > 0, 'main.js 里找不到 ' + name)
  const end = mainSrc.indexOf('\n}\n', start)
  assert.ok(end > start, name + ' 找不到函数结尾')
  return mainSrc.slice(start, end + 2)
}

const isBridgePayloadSpec = new Function(extractSync('isBridgePayloadSpec') + '\nreturn isBridgePayloadSpec')()
const MIGRATION_ID = 'bridge-payload-to-npm-1'
const BRIDGE = '@agents-anywhere/dsh-bridge-next'

function loadMigration({ marked = '', selfTest = false, state = {}, installResult = { ok: true, version: '2.0.2' } } = {}) {
  const logs = []
  const calls = { install: 0, save: 0, rm: 0 }
  const Config = { bridgePayloadMigrated: marked }
  const market = {
    getState: () => state,
    installByName: async () => { calls.install += 1; return installResult },
  }
  const src = extractSync('isBridgePayloadSpec') + '\n' + extractAsync('maybeMigrateBridgePayloadInstall') + '\nreturn maybeMigrateBridgePayloadInstall'
  const fn = new Function(
    'SELF_TEST', 'Config', 'BRIDGE_PAYLOAD_MIGRATION', 'BRIDGE_PLUGIN', 'market', 'log', 'saveConfig', 'fs', 'path', 'HOME',
    src,
  )(
    selfTest, Config, MIGRATION_ID, BRIDGE, market,
    (line) => logs.push(String(line)),
    () => { calls.save += 1 },
    { rmSync: () => { calls.rm += 1 } },
    path,
    '/tmp/dshl-migration-home',
  )
  return { fn, Config, logs, calls }
}

test('isBridgePayloadSpec：只认旧版 payload 的 link:/file: 规格', () => {
  for (const spec of [
    'link:C:/Users/me/.dsh/dshl/bridge-payloads/2.0.0-dev.11-abc/bridge-next.tgz',
    'file:C:\\Users\\me\\.dsh\\dshl\\bridge-payloads\\x\\bridge-next.tgz',
    'file:C:/cache/bridge-next.tgz',
  ]) assert.equal(isBridgePayloadSpec(spec), true, spec)

  for (const spec of ['^2.0.2', '2.0.2', 'link:C:/other/plugin', 'github:foo/bar', '']) {
    assert.equal(isBridgePayloadSpec(spec), false, spec)
  }
})

test('已记账 / 自检模式：不读 profile、不改配置', async () => {
  for (const options of [{ marked: MIGRATION_ID }, { selfTest: true }]) {
    const run = loadMigration(options)
    assert.equal(await run.fn(), false)
    assert.equal(run.calls.install, 0)
    assert.equal(run.calls.save, 0)
  }
})

test('没装插件 / 已是 npm 规格：只记账，不执行安装', async () => {
  for (const state of [{ installed: false }, { installed: true, spec: '^2.0.2' }]) {
    const run = loadMigration({ state })
    assert.equal(await run.fn(), false)
    assert.equal(run.calls.install, 0)
    assert.equal(run.Config.bridgePayloadMigrated, MIGRATION_ID)
    assert.equal(run.calls.save, 1)
  }
})

test('旧 payload 安装：迁移到 npm 版本，成功才记账并清缓存', async () => {
  const run = loadMigration({ state: { installed: true, spec: 'link:C:/Users/me/.dsh/dshl/bridge-payloads/a/bridge-next.tgz' } })
  assert.equal(await run.fn(), true)
  assert.equal(run.calls.install, 1)
  assert.equal(run.Config.bridgePayloadMigrated, MIGRATION_ID)
  assert.equal(run.calls.save, 1)
  assert.equal(run.calls.rm, 1, '旧 payload 缓存应清掉')
  assert.ok(run.logs.some((line) => line.includes('已迁移到 npm 版本')), run.logs.join(' | '))
})

test('迁移失败：不记账（下次启动重试），只留日志', async () => {
  const run = loadMigration({
    state: { installed: true, spec: 'link:C:/Users/me/.dsh/dshl/bridge-payloads/a/bridge-next.tgz' },
    installResult: { ok: false, error: '网络不可达' },
  })
  assert.equal(await run.fn(), false)
  assert.equal(run.Config.bridgePayloadMigrated, '', '失败不能记账，否则永远不再重试')
  assert.equal(run.calls.save, 0)
  assert.equal(run.calls.rm, 0)
  assert.ok(run.logs.some((line) => line.includes('迁移到 npm 版本失败')), run.logs.join(' | '))
})

test('接线：启动服务前先迁移，再打运行时补丁', () => {
  const migrateAt = mainSrc.indexOf('await maybeMigrateBridgePayloadInstall()')
  const patchAt = mainSrc.indexOf('bridgePatch.apply({ profileDir: DSH_PROFILE_DIR, log })')
  assert.ok(migrateAt > 0 && patchAt > 0, 'startServerInner 必须调用迁移与补丁')
  assert.ok(migrateAt < patchAt, '迁移必须在补丁之前（否则补丁打不到新装的 npm 版本）')
})
