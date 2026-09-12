// tests/bridge.test.js — 远程连接（DSH Bridge Next）纯函数测试：
// profile 状态判定 + manifest 身份校验 + payload（tgz）解析 + 随包 payload 完整性
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const bridge = require('../bridge')

const NAME = bridge.PLUGIN_NAME
const PAYLOAD_DIR = path.join(__dirname, '..', 'assets', 'bridge-next')
const PAYLOAD_META = path.join(PAYLOAD_DIR, 'version.json')
const PAYLOAD_TGZ = path.join(PAYLOAD_DIR, 'bridge-next.tgz')

function manifestWith(deps, bundles) {
  return {
    name: 'dsh-profile-web',
    dependencies: deps,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...(bundles || [])] } },
  }
}

test('pluginStateOf：dependencies + bundles 都在 → 已安装且启用', () => {
  const s = bridge.pluginStateOf(manifestWith({ [NAME]: 'file:C:/cache/bridge-next.tgz' }, [NAME]))
  assert.equal(s.installed, true)
  assert.equal(s.bundle, true)
  assert.equal(s.spec, 'file:C:/cache/bridge-next.tgz')
})

test('pluginStateOf：只在 dependencies、不在 bundles → 不算装好', () => {
  const s = bridge.pluginStateOf(manifestWith({ [NAME]: 'file:C:/x.tgz' }, []))
  assert.equal(s.installed, true)
  assert.equal(s.bundle, false)
})

test('pluginStateOf：空/畸形 manifest 不抛错', () => {
  assert.deepEqual(bridge.pluginStateOf(undefined), { installed: false, version: '', bundle: false, spec: '' })
  assert.deepEqual(bridge.pluginStateOf({}), { installed: false, version: '', bundle: false, spec: '' })
  assert.deepEqual(bridge.pluginStateOf({ dependencies: null, dsh: { profile: { bundles: 'x' } } }), { installed: false, version: '', bundle: false, spec: '' })
})

test('satisfied：同一 payload 文件名（路径前缀不同）算已满足', () => {
  const cur = bridge.pluginStateOf(manifestWith({ [NAME]: 'file:C:/old/bridge-next.tgz' }, [NAME]))
  assert.equal(bridge.satisfied(cur, { spec: 'file:C:/new/bridge-next.tgz' }), true)
  assert.equal(bridge.satisfied(cur, { spec: 'file:C:/new/other.tar.gz' }), false)
})

test('satisfied：非 file/link 规格（npm 版本号 / git）一律不满足，避免误判', () => {
  const cur = bridge.pluginStateOf(manifestWith({ [NAME]: '0.1.0' }, [NAME]))
  assert.equal(bridge.satisfied(cur, { spec: 'file:C:/x/bridge-next.tgz' }), false)
})

test('needsInstall：payload 不可用（want.spec 为空）时永不自动动 profile', () => {
  const cur = bridge.pluginStateOf(manifestWith({}, []))
  assert.equal(bridge.needsInstall(cur, { spec: '' }), false)
  assert.equal(bridge.needsInstall(cur, null), false)
})

test('needsInstall：未装/未启用/指向别处 → 需要安装', () => {
  const notInstalled = bridge.pluginStateOf(manifestWith({}, []))
  const depOnly = bridge.pluginStateOf(manifestWith({ [NAME]: 'file:C:/x/bridge-next.tgz' }, []))
  const ok = bridge.pluginStateOf(manifestWith({ [NAME]: 'file:C:/x/bridge-next.tgz' }, [NAME]))
  const other = bridge.pluginStateOf(manifestWith({ [NAME]: 'file:C:/x/other.tgz' }, [NAME]))
  const want = { spec: 'file:C:/x/bridge-next.tgz' }
  assert.equal(bridge.needsInstall(notInstalled, want), true)
  assert.equal(bridge.needsInstall(depOnly, want), true)
  assert.equal(bridge.needsInstall(other, want), true)
  assert.equal(bridge.needsInstall(ok, want), false)
})

test('verifyPluginManifest：合法 manifest 返回身份', () => {
  const pkg = { name: NAME, version: '0.1.0-dev.0', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }
  assert.deepEqual(bridge.verifyPluginManifest(pkg), { name: NAME, version: '0.1.0-dev.0' })
})

test('verifyPluginManifest：包名/版本段数/patch/client 任一项不符 → 拒绝', () => {
  const base = { name: NAME, version: '0.1.0-dev.0', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }
  assert.throws(() => bridge.verifyPluginManifest({ ...base, name: 'other-pkg' }), /包身份/)
  assert.throws(() => bridge.verifyPluginManifest({ ...base, version: 'dev' }), /版本号/)
  assert.throws(() => bridge.verifyPluginManifest({ ...base, dsh: { client: { platform: 'web' } } }), /bundle/)
  assert.throws(() => bridge.verifyPluginManifest({ ...base, dsh: { bundle: { patch: '../evil.js' }, client: { platform: 'web' } } }), /bundle/)
  assert.throws(() => bridge.verifyPluginManifest({ ...base, dsh: { bundle: { patch: './cordis.patch.yml' } } }), /client/)
  assert.throws(() => bridge.verifyPluginManifest({ ...base, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'node' } } }), /client/)
  assert.throws(() => bridge.verifyPluginManifest(null), /manifest/)
})

test('initBridge：payload 不可用时只记账、不抛错', () => {
  bridge.initBridge({ home: path.join(__dirname, 'tmp-home'), payloadRoot: path.join(__dirname, 'not-exist'), log: () => {} })
  const s = bridge.getState()
  assert.equal(s.payloadReady, false)
  assert.equal(typeof s.payloadError, 'string')
  assert.ok(s.payloadError.length > 0)
  bridge.initBridge({})
})

test('随包 payload：version.json 与 tgz 内的 package.json 身份一致，SHA256 对得上', () => {
  assert.ok(fs.existsSync(PAYLOAD_META), 'assets/bridge-next/version.json 缺失')
  assert.ok(fs.existsSync(PAYLOAD_TGZ), 'assets/bridge-next/bridge-next.tgz 缺失')
  const meta = JSON.parse(fs.readFileSync(PAYLOAD_META, 'utf8'))
  assert.match(meta.sha256, /^[0-9a-f]{64}$/u)
  const actual = crypto.createHash('sha256').update(fs.readFileSync(PAYLOAD_TGZ)).digest('hex')
  assert.equal(actual, meta.sha256, 'payload SHA256 与 version.json 不一致')
  const pkg = bridge.readPackageFromTarball(PAYLOAD_TGZ)
  assert.equal(pkg.name, NAME)
  assert.equal(pkg.version, meta.version)
  assert.equal(meta.package.name, NAME)
  assert.equal(meta.package.version, meta.version)
})

test('initBridge：payload 可用时 state 带出版本与 payloadReady', () => {
  bridge.initBridge({ home: path.join(__dirname, 'tmp-home'), payloadRoot: PAYLOAD_DIR, log: () => {} })
  const s = bridge.getState()
  assert.equal(s.payloadReady, true)
  assert.match(s.payloadVersion, /^\d+\.\d+\.\d+/u)
  assert.equal(s.payloadPackageVersion, s.payloadVersion)
  bridge.initBridge({})
})
