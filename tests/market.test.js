// tests/market.test.js — npm 分发插件安装器纯函数测试：
//   profile 状态判定（任意包名）+ npm manifest 校验 + 按包名记账的瞬时状态
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const market = require('../market')

const NAME = market.PLUGIN_NAME

function manifestWith(deps, bundles) {
  return {
    name: 'dsh-profile-web',
    dependencies: deps,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...(bundles || [])] } },
  }
}

test('pluginStateOf：dependencies + bundles 都在 → 已安装且启用', () => {
  const s = market.pluginStateOf(manifestWith({ [NAME]: '^1.45.0' }, [NAME]))
  assert.deepEqual(s, { installed: true, version: '^1.45.0', bundle: true })
})

test('pluginStateOf：只在 dependencies、不在 bundles → 不算装好', () => {
  const s = market.pluginStateOf(manifestWith({ [NAME]: '1.45.0' }, []))
  assert.equal(s.installed, true)
  assert.equal(s.bundle, false)
})

test('pluginStateOf：只在 bundles、没有依赖 → 未安装', () => {
  const s = market.pluginStateOf(manifestWith({}, [NAME]))
  assert.equal(s.installed, false)
  assert.equal(s.bundle, true)
})

test('pluginStateOf：空/畸形 manifest 不抛错', () => {
  assert.deepEqual(market.pluginStateOf(undefined), { installed: false, version: '', bundle: false })
  assert.deepEqual(market.pluginStateOf({}), { installed: false, version: '', bundle: false })
  assert.deepEqual(market.pluginStateOf({ dependencies: null, dsh: { profile: { bundles: 'x' } } }), { installed: false, version: '', bundle: false })
})

test('verifyNpmManifestShape：合法 manifest 返回精确版本', () => {
  const r = market.verifyNpmManifestShape({ name: NAME, version: '1.45.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, NAME)
  assert.deepEqual(r, { name: NAME, version: '1.45.0' })
})

test('verifyNpmManifestShape：包名不符/非精确版本/无 bundle 声明 → 拒绝', () => {
  const base = { name: NAME, version: '1.45.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  assert.throws(() => market.verifyNpmManifestShape({ ...base, name: 'other-pkg' }, NAME), /包身份/)
  assert.throws(() => market.verifyNpmManifestShape({ ...base, version: '^1.45.0' }, NAME), /精确/)
  assert.throws(() => market.verifyNpmManifestShape({ ...base, dsh: {} }, NAME), /DSH bundle/)
  assert.throws(() => market.verifyNpmManifestShape({ ...base, dsh: { bundle: { patch: '../evil.js' } } }, NAME), /DSH bundle/)
  assert.throws(() => market.verifyNpmManifestShape(null, NAME), /invalid/)
})

test('installed()：HOME 未初始化时不抛错，返回未安装', () => {
  const s = market.installed()
  assert.equal(typeof s, 'object')
  assert.equal(s.installed, false)
})

test('getState()：字段形状稳定（面板依赖这些字段）', () => {
  const s = market.getState()
  for (const k of ['installed', 'version', 'bundle', 'busy', 'error', 'lastChange', 'plugin']) {
    assert.ok(k in s, '缺少字段 ' + k)
  }
  assert.equal(s.plugin, NAME)
})

test('pluginStateOf：能判定任意包名（推荐插件复用同一套 profile 判定）', () => {
  const other = 'dsh-better-sidebar'
  const s = market.pluginStateOf(manifestWith({ [other]: '^0.19.1' }, [other]), other)
  assert.deepEqual(s, { installed: true, version: '^0.19.1', bundle: true })
  assert.equal(market.pluginStateOf(manifestWith({}, []), other).installed, false)
})

test('安装器暴露按包名操作的入口（控制台插件页依赖）', () => {
  for (const fn of ['installByName', 'uninstallByName', 'getState', 'verifyNpmPackage']) {
    assert.equal(typeof market[fn], 'function', '缺少入口 ' + fn)
  }
})

test('installByName：空包名直接拒绝；按包名各自记账', async () => {
  const r = await market.installByName('')
  assert.equal(r.ok, false)
  assert.match(r.error, /不能为空/)
  const other = market.getState('dsh-chat-import')
  assert.equal(other.plugin, 'dsh-chat-import')
  assert.equal(other.installed, false)
  assert.equal(other.busy, '')
})

test('pnpm 视图：add/remove 都注入一次新版本观察期放行参数（对齐 dshmarket）', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'market.js'), 'utf8')
  assert.match(src, /const RELEASE_AGE_OVERRIDE = '--config\.minimumReleaseAge=0'/, '放行参数应集中声明并说明原因')
  assert.match(src, /withReleaseAgeOverride\(args\)/, 'runCli 必须统一注入放行参数')
  assert.deepEqual(market.withReleaseAgeOverride(['add', 'pkg@1.0.0', '-w']), ['add', '--config.minimumReleaseAge=0', 'pkg@1.0.0', '-w'])
  assert.deepEqual(market.withReleaseAgeOverride(['remove', 'pkg', '-w']), ['remove', '--config.minimumReleaseAge=0', 'pkg', '-w'])
  assert.deepEqual(market.withReleaseAgeOverride(['list']), ['list'])
})