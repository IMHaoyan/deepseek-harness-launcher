// tests/bridge.test.js — 远程连接（DSH Bridge Next）纯函数测试：
// profile 状态判定 + manifest 身份校验 + payload（tgz）解析 + 随包 payload 完整性
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
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

test('satisfied：payload 升版但 tgz 同名时按已物化版本判定（否则老构建常驻）', () => {
  const cur = bridge.pluginStateOf(manifestWith({ [NAME]: 'file:C:/old/bridge-next.tgz' }, [NAME]))
  const want = { version: '0.1.0-dev.1', spec: 'file:C:/new/bridge-next.tgz' }
  assert.equal(bridge.satisfied(cur, want, '0.1.0-dev.1'), true)
  assert.equal(bridge.satisfied(cur, want, '0.1.0-dev.0'), false)
  assert.equal(bridge.satisfied(cur, want, ''), false)
  assert.equal(bridge.needsInstall(cur, want, '0.1.0-dev.0'), true)
  assert.equal(bridge.needsInstall(cur, want, '0.1.0-dev.1'), false)
  // 不声明版本（历史调用方式）时保持旧的「同名即满足」语义
  assert.equal(bridge.satisfied(cur, { spec: 'file:C:/new/bridge-next.tgz' }, ''), true)
})

test('withReleaseAgeOverride：只在 add/remove 注入一次 pnpm 观察期放行参数', () => {
  assert.deepEqual(bridge.withReleaseAgeOverride(['add', 'pkg@1.0.0', '-w']), ['add', '--config.minimumReleaseAge=0', 'pkg@1.0.0', '-w'])
  assert.deepEqual(bridge.withReleaseAgeOverride(['remove', 'pkg', '-w']), ['remove', '--config.minimumReleaseAge=0', 'pkg', '-w'])
  const already = ['add', '--config.minimumReleaseAge=0', 'pkg@1.0.0']
  assert.deepEqual(bridge.withReleaseAgeOverride(already), already)
  assert.deepEqual(bridge.withReleaseAgeOverride(['install', '--frozen-lockfile']), ['install', '--frozen-lockfile'])
  assert.deepEqual(bridge.withReleaseAgeOverride(null), [])
})

test('bridge：与 market 同一套「先按策略默认跑、命中判定才放行重试」契约', async () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8').replace(/\r\n?/gu, '\n')
  assert.match(src, /async function runCliOnce\(args\)/, '必须有一个「不注入放行参数」的基础执行器')
  assert.match(src, /if \(!releaseAgeViolation\(e && e\.output\)\) throw e/, '只有命中 24h 观察期判定才重试')
  assert.equal(bridge.releaseAgeViolation('lockfile failed supply-chain policy check'), true)
  assert.equal(bridge.releaseAgeViolation('ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED: 1 resolution-policy violation was produced'), true, 'pnpm 11.8 的 remove 硬失败也必须命中重试')
  assert.equal(bridge.releaseAgeViolation('ERR_PNPM_EPERM: operation not permitted'), false)
  assert.deepEqual(
    bridge.parseReleaseAgeEntries('  dshmarket@1.47.0 was published at 2026-09-15T04:59:30.465Z, within the minimumReleaseAge cutoff (x)'),
    [{ name: 'dshmarket@1.47.0', publishedAt: '2026-09-15T04:59:30.465Z' }],
  )

  const start = src.indexOf('async function runCli(args) {')
  const end = src.indexOf('\n}\n', start) + 3
  assert.ok(start > 0 && end > start, '找不到 runCli')
  const calls = []
  const ctx = {
    log: () => {},
    withReleaseAgeOverride: bridge.withReleaseAgeOverride,
    releaseAgeViolation: bridge.releaseAgeViolation,
    parseReleaseAgeEntries: bridge.parseReleaseAgeEntries,
    runCliOnce: async (args) => {
      calls.push(args.slice())
      if (calls.length === 1) {
        const e = new Error('dsh plugin 退出码 1：…bypassed the policy locally')
        e.output = 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION: 1 lockfile entries failed verification'
        throw e
      }
      return { code: 0, output: '' }
    },
  }
  const names = Object.keys(ctx)
  const run = new Function(...names, src.slice(start, end) + '\nreturn runCli')(...names.map((k) => ctx[k]))
  await run(['add', 'link:C:/payload/bridge-next.tgz', '-w'])
  assert.deepEqual(calls, [
    ['add', 'link:C:/payload/bridge-next.tgz', '-w'],
    ['add', '--config.minimumReleaseAge=0', 'link:C:/payload/bridge-next.tgz', '-w'],
  ], '默认路径不得注入放行参数，只有被整体拒绝后才放行重试')
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

test('readMaterializedPackageState：bundle patch 缺失不算可用，补回后才 ready', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bridge-'))
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep
  t.after(() => {
    if (path.resolve(home).startsWith(tmpRoot)) fs.rmSync(home, { recursive: true, force: true })
  })
  const profile = path.join(home, 'profiles', 'web')
  const packageDir = path.join(profile, 'node_modules', ...NAME.split('/'))
  fs.mkdirSync(packageDir, { recursive: true })
  bridge.initBridge({ home, payloadRoot: PAYLOAD_DIR, log: () => {} })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(manifestWith({ [NAME]: bridge.expectedSpec() }, [NAME])))
  // payload 升版时本夹具必须跟着走：satisfied() 用物化版本区分「老构建 / 新 payload」，
  // 硬编码版本号会在每次升版时把 specMatchesPayload 误判成 false。
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: NAME,
    version: bridge.payloadVersion(),
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  try {
    assert.deepEqual(bridge.readMaterializedPackageState(), { version: bridge.payloadVersion(), patchReady: false })
    const before = bridge.getState()
    assert.equal(before.installed, true)
    assert.equal(before.materializedPatchReady, false)
    assert.equal(before.specMatchesPayload, true)
    assert.equal(before.outdated, true)

    fs.writeFileSync(path.join(packageDir, 'cordis.patch.yml'), '- insert: []\n')
    const after = bridge.getState()
    assert.equal(after.materializedPatchReady, true)
    assert.equal(after.specMatchesPayload, true)
    assert.equal(after.outdated, false)
  } finally {
    bridge.initBridge({})
  }
})

test('materializePayload：tgz 解到 link: 缓存目录，末段保持 bridge-next.tgz', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bridge-'))
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep
  t.after(() => {
    if (path.resolve(home).startsWith(tmpRoot)) fs.rmSync(home, { recursive: true, force: true })
  })
  bridge.initBridge({ home, payloadRoot: PAYLOAD_DIR, log: () => {} })
  try {
    const dir = bridge.materializePayload()
    const again = bridge.materializePayload()
    assert.equal(dir, again)
    assert.equal(path.basename(dir), 'bridge-next.tgz')
    assert.equal(fs.existsSync(path.join(dir, 'package.json')), true)
    assert.equal(fs.existsSync(path.join(dir, 'cordis.patch.yml')), true)
    assert.equal(bridge.expectedSpec(), 'link:' + dir.replace(/\\/gu, '/'))
    assert.equal(bridge.sameSpec(bridge.expectedSpec(), 'link:' + dir.replace(/\\/gu, '/')), true)
  } finally {
    bridge.initBridge({})
  }
})

test('ensureRuntimeDeps：悬空 junction 会重连到稳定的 profiles fallback', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bridge-'))
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep
  t.after(() => {
    if (path.resolve(home).startsWith(tmpRoot)) fs.rmSync(home, { recursive: true, force: true })
  })
  const stable = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
  fs.mkdirSync(stable, { recursive: true })
  fs.writeFileSync(path.join(stable, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', version: '0.0.0' }))
  bridge.initBridge({ home, payloadRoot: PAYLOAD_DIR, log: () => {} })
  try {
    const dir = bridge.materializePayload()
    const link = path.join(path.dirname(dir), 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
    fs.unlinkSync(link)
    const gone = path.join(home, 'gone-target')
    fs.mkdirSync(gone)
    fs.symlinkSync(gone, link, process.platform === 'win32' ? 'junction' : 'dir')
    fs.rmSync(gone, { recursive: true, force: true })
    assert.equal(fs.existsSync(path.join(link, 'package.json')), false, '先制造悬空 junction')

    bridge.materializePayload()
    assert.equal(fs.existsSync(path.join(link, 'package.json')), true)
    assert.equal(fs.realpathSync(link), fs.realpathSync(stable))
  } finally {
    bridge.initBridge({})
  }
})

test('satisfied：link 缓存目录与旧 file: tgz 基名兼容，旧 DSHL 不会把 link 改回 file', () => {
  const cur = { installed: true, bundle: true, spec: 'link:C:/cache/bridge-next.tgz' }
  const want = { version: '0.1.0-dev.1', spec: 'file:C:/app/resources/bridge-next/bridge-next.tgz' }
  assert.equal(bridge.satisfied(cur, want, '0.1.0-dev.1'), true)
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
