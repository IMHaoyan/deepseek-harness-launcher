// tests/plugin-quarantine-behavior.test.js — 按插件隔离的真实文件行为（不是源码正则）。
//
// 用临时 Profile + 真实的 fs 跑 main.js 里抽出来的快照/隔离函数，钉住：
//   - 备份失败 fail-closed、写失败整批回滚、saveConfig 失败不留半状态
//   - 一次禁用多个、二次扩大范围仍复用最初快照、一次恢复回到最初状态
//   - 原状态没有补丁层时，恢复要把隔离期间新建的补丁文件删掉
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n?/gu, '\n')

const INITIAL = {
  name: 'profile',
  dependencies: { 'dsh-usage-billing': '1.0.0', 'dsh-image-gen': '1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-usage-billing', 'dsh-image-gen'] } },
}
const PATCH_TEXT = '# user patch\n'

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-quarantine-'))
  const pkg = path.join(dir, 'package.json')
  const patch = path.join(dir, 'cordis.patch.yml')
  const state = {
    disabled: new Set(),
    noToggle: new Set(['dsh-image-gen']),
    failSet: new Set(),
    failClear: new Set(),
    failPatchCopy: false,
    saveConfigResult: true,
    restarts: 0,
    calls: [],
    cleared: [],
  }
  const fsProxy = Object.assign({}, fs)
  fsProxy.copyFileSync = (src, dst, ...rest) => {
    if (state.failPatchCopy && src === patch && String(dst).includes('.bak-dshl-quarantine')) {
      throw new Error('EPERM: patch copy denied')
    }
    return fs.copyFileSync(src, dst, ...rest)
  }
  const ctx = {
    fs: fsProxy,
    DSH_PROFILE_PACKAGE: pkg,
    DSH_PROFILE_PATCH: patch,
    Config: { pluginSafeModeBackup: null, pluginQuarantine: null },
    pluginSwitch: {
      isDisabled: (npm) => state.disabled.has(npm),
      canToggle: (npm) => !state.noToggle.has(npm),
      setEnabled: (npm, on) => {
        state.calls.push([npm, on])
        if (on === false && state.failSet.has(npm)) return { ok: false, error: '补丁层写入失败' }
        if (on) state.disabled.delete(npm)
        else {
          state.disabled.add(npm)
          // 模拟真实 setEnabled 会写补丁文件（原状态没有补丁层时也会新建）
          fs.writeFileSync(patch, PATCH_TEXT + 'disabled:\n  - ' + npm + '\n')
        }
        return { ok: true }
      },
      clearPersistedDisabled: (npm) => {
        if (state.failClear.has(npm)) return { ok: false, error: '市场状态文件不可读' }
        state.cleared.push(npm)
        return { ok: true }
      },
    },
    readProfileManifestSafe: () => {
      try { return JSON.parse(fs.readFileSync(pkg, 'utf8')) } catch { return null }
    },
    profileBundlesOf: (m) => {
      const b = m && m.dsh && m.dsh.profile ? m.dsh.profile.bundles : null
      return Array.isArray(b) ? b.filter((n) => typeof n === 'string' && n) : []
    },
    writeProfileManifestAtomic: (m) => {
      const tmp = pkg + '.tmp-test-' + process.pid
      fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n')
      fs.renameSync(tmp, pkg)
    },
    safeModeKeepsBundle: (n) => String(n).startsWith('@deepseek-ai/'),
    pluginNameForNpm: (npm) => npm,
    saveConfig: () => state.saveConfigResult,
    invalidatePluginInventory: () => {},
    log: () => {},
    restartDshForConsole: async () => { state.restarts += 1; return { ok: true } },
  }
  vm.createContext(ctx)
  const start = main.indexOf('function profileSnapshotPaths')
  const end = main.indexOf('function pluginDisplayName')
  assert.ok(start > 0 && end > start, 'main.js 里找不到隔离函数块')
  vm.runInContext(main.slice(start, end), ctx)

  const reset = ({ patchExists = true, saveConfigResult = true } = {}) => {
    fs.writeFileSync(pkg, JSON.stringify(INITIAL, null, 2) + '\n')
    if (patchExists) fs.writeFileSync(patch, PATCH_TEXT)
    else { try { fs.unlinkSync(patch) } catch { /* noop */ } }
    for (const f of fs.readdirSync(dir)) {
      if (/\.bak-dshl-|\.tmp-dshl-/u.test(f)) fs.unlinkSync(path.join(dir, f))
    }
    state.disabled.clear()
    state.noToggle = new Set(['dsh-image-gen'])
    state.failSet.clear()
    state.failClear.clear()
    state.failPatchCopy = false
    state.saveConfigResult = saveConfigResult
    state.restarts = 0
    state.calls = []
    state.cleared = []
    ctx.Config.pluginSafeModeBackup = null
    ctx.Config.pluginQuarantine = null
  }
  const read = (file) => fs.readFileSync(file, 'utf8')
  const backups = () => fs.readdirSync(dir).filter((f) => /\.bak-dshl-/u.test(f))
  return { dir, pkg, patch, state, ctx, reset, read, backups }
}

test('隔离：无加载项的插件从 bundle 列表移除，有加载项的走补丁层；记录清单与备份', async () => {
  const t = setup()
  t.reset()
  const r = await t.ctx.disableSuspectPlugins(['dsh-usage-billing', 'dsh-image-gen'])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual([...r.disabled].map((d) => d.npm).sort(), ['dsh-image-gen', 'dsh-usage-billing'].sort())
  assert.equal(t.state.restarts, 1, '只重启一次')
  assert.equal(t.state.disabled.has('dsh-usage-billing'), true, '有加载项的走补丁层停用')
  const manifest = JSON.parse(t.read(t.pkg))
  assert.equal(manifest.dsh.profile.bundles.includes('dsh-image-gen'), false, '无加载项的从 bundle 列表移除')
  assert.equal(manifest.dsh.profile.bundles.includes('dsh-usage-billing'), true, '另一项不应被误删')
  assert.equal(t.ctx.Config.pluginQuarantine.disabled.length, 2)
  assert.equal(t.ctx.Config.pluginQuarantine.patchExisted, true)
  assert.equal(t.read(t.ctx.Config.pluginQuarantine.manifest), JSON.stringify(INITIAL, null, 2) + '\n')
  assert.equal(t.read(t.ctx.Config.pluginQuarantine.patch), PATCH_TEXT)
  assert.deepEqual(t.backups().filter((f) => f.includes('rollback')), [], '回滚临时快照要清掉')
})

test('恢复：一次拷回最初快照，清 durable 选择并重启', async () => {
  const t = setup()
  t.reset()
  assert.equal((await t.ctx.disableSuspectPlugins(['dsh-usage-billing', 'dsh-image-gen'])).ok, true)
  const r = await t.ctx.restorePluginQuarantine()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(JSON.parse(t.read(t.pkg)), INITIAL, '清单回到禁用前')
  assert.equal(t.read(t.patch), PATCH_TEXT, '补丁层也回到禁用前')
  assert.deepEqual(t.state.cleared.sort(), ['dsh-image-gen', 'dsh-usage-billing'].sort())
  assert.equal(t.ctx.Config.pluginQuarantine, null)
  assert.equal(t.state.restarts, 2)
})

test('二次扩大隔离：复用最初快照、清单取并集，一次恢复两项都回来', async () => {
  const t = setup()
  t.reset()
  assert.equal((await t.ctx.disableSuspectPlugins(['dsh-usage-billing'])).ok, true)
  const firstBackup = t.ctx.Config.pluginQuarantine.manifest
  const firstPatch = t.ctx.Config.pluginQuarantine.patch
  const r = await t.ctx.disableSuspectPlugins(['dsh-image-gen'])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(t.ctx.Config.pluginQuarantine.manifest, firstBackup, '复用最初快照')
  assert.equal(t.ctx.Config.pluginQuarantine.patch, firstPatch)
  assert.deepEqual([...t.ctx.Config.pluginQuarantine.disabled].sort(), ['dsh-image-gen', 'dsh-usage-billing'].sort(),
    '清单要并集，不能丢掉上一轮')
  assert.equal((await t.ctx.restorePluginQuarantine()).ok, true)
  const manifest = JSON.parse(t.read(t.pkg))
  assert.equal(manifest.dsh.profile.bundles.includes('dsh-image-gen'), true)
  assert.equal(manifest.dsh.profile.bundles.includes('dsh-usage-billing'), true)
})

test('setEnabled 写失败：整批回滚，不产生恢复记录，不重启', async () => {
  const t = setup()
  t.reset()
  t.state.failSet.add('dsh-usage-billing')
  const r = await t.ctx.disableSuspectPlugins(['dsh-usage-billing', 'dsh-image-gen'])
  assert.equal(r.ok, false)
  assert.match(r.error, /已回滚/)
  assert.equal(t.ctx.Config.pluginQuarantine, null)
  assert.deepEqual(JSON.parse(t.read(t.pkg)), INITIAL, 'Profile 必须回到调用前')
  assert.equal(t.read(t.patch), PATCH_TEXT)
  assert.equal(t.state.restarts, 0)
  assert.deepEqual(t.backups(), [], '失败后不应留下无引用的备份')
})

test('saveConfig 失败：回滚 Profile，不留下“已停用却找不到恢复记录”的半状态', async () => {
  const t = setup()
  t.reset({ saveConfigResult: false })
  const r = await t.ctx.disableSuspectPlugins(['dsh-usage-billing', 'dsh-image-gen'])
  assert.equal(r.ok, false)
  assert.match(r.error, /保存恢复记录失败/)
  assert.equal(t.ctx.Config.pluginQuarantine, null)
  assert.deepEqual(JSON.parse(t.read(t.pkg)), INITIAL)
  assert.equal(t.state.restarts, 0)
  assert.deepEqual(t.backups(), [])
})

test('补丁层备份复制失败：fail-closed，Profile 不动', async () => {
  const t = setup()
  t.reset()
  t.state.failPatchCopy = true
  const r = await t.ctx.disableSuspectPlugins(['dsh-usage-billing'])
  assert.equal(r.ok, false)
  assert.match(r.error, /备份当前 Profile 失败/)
  assert.deepEqual(JSON.parse(t.read(t.pkg)), INITIAL)
  assert.equal(t.read(t.patch), PATCH_TEXT)
  assert.equal(t.state.restarts, 0)
  assert.deepEqual(t.backups(), [], '失败时不能留半份备份')
})

test('原状态没有补丁层：恢复时删掉隔离期间新建的补丁文件', async () => {
  const t = setup()
  t.reset({ patchExists: false })
  const r = await t.ctx.disableSuspectPlugins(['dsh-usage-billing'])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(t.ctx.Config.pluginQuarantine.patchExisted, false)
  assert.equal(fs.existsSync(t.patch), true, 'setEnabled 模拟写入了补丁文件')
  const restored = await t.ctx.restorePluginQuarantine()
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.equal(fs.existsSync(t.patch), false, '恢复必须回到“没有补丁层”的原始状态')
  assert.deepEqual(JSON.parse(t.read(t.pkg)), INITIAL)
})

test('恢复时 durable 清理失败：不假装成功，保留记录且不动 Profile', async () => {
  const t = setup()
  t.reset()
  assert.equal((await t.ctx.disableSuspectPlugins(['dsh-usage-billing', 'dsh-image-gen'])).ok, true)
  const before = t.read(t.pkg)
  const q = t.ctx.Config.pluginQuarantine
  t.state.failClear.add('dsh-usage-billing')
  const r = await t.ctx.restorePluginQuarantine()
  assert.equal(r.ok, false)
  assert.match(r.error, /恢复未执行/)
  assert.equal(t.ctx.Config.pluginQuarantine, q, '记录要保留以便重试')
  assert.equal(t.read(t.pkg), before, 'Profile 不能改')
  assert.equal(t.state.restarts, 1, '失败时不再重启')
})

test('安全模式：只保留官方 bundle；记录恢复入口；一次恢复回到原 Profile', async () => {
  const t = setup()
  t.reset()
  const r = await t.ctx.enablePluginSafeMode()
  assert.equal(r.ok, true, JSON.stringify(r))
  const manifest = JSON.parse(t.read(t.pkg))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
  assert.deepEqual([...t.ctx.Config.pluginSafeModeBackup.removed].sort(),
    ['dsh-image-gen', 'dsh-usage-billing'].sort())
  assert.equal(t.ctx.Config.pluginSafeModeBackup.patchExisted, true)
  assert.equal(t.state.restarts, 1)
  const restored = await t.ctx.restorePluginSafeMode()
  assert.equal(restored.ok, true, JSON.stringify(restored))
  assert.deepEqual(JSON.parse(t.read(t.pkg)), INITIAL)
  assert.equal(t.ctx.Config.pluginSafeModeBackup, null)
  assert.equal(t.state.restarts, 2)
})

test('安全模式：保存恢复记录失败时回滚 Profile，不重启', async () => {
  const t = setup()
  t.reset({ saveConfigResult: false })
  const r = await t.ctx.enablePluginSafeMode()
  assert.equal(r.ok, false)
  assert.match(r.error, /保存安全模式恢复记录失败/)
  assert.deepEqual(JSON.parse(t.read(t.pkg)), INITIAL)
  assert.equal(t.ctx.Config.pluginSafeModeBackup, null)
  assert.equal(t.state.restarts, 0)
  assert.deepEqual(t.backups(), [], '回滚成功后不应留下无引用备份')
})

test('已有按插件隔离记录时拒绝进入安全模式，避免两份快照互相覆盖', async () => {
  const t = setup()
  t.reset()
  assert.equal((await t.ctx.disableSuspectPlugins(['dsh-usage-billing'])).ok, true)
  const manifestBefore = t.read(t.pkg)
  const r = await t.ctx.enablePluginSafeMode()
  assert.equal(r.ok, false)
  assert.match(r.error, /请先.*恢复禁用前的 Profile/)
  assert.equal(t.read(t.pkg), manifestBefore, '拒绝时不能改 Profile')
  assert.equal(t.state.restarts, 1, '只有前面隔离的那次重启')
})

test('失效的隔离记录不阻塞安全模式：先清掉死元数据再进入', async () => {
  const t = setup()
  t.reset()
  t.ctx.Config.pluginQuarantine = {
    at: '2026-01-01T00:00:00.000Z',
    manifest: path.join(t.dir, 'missing-backup.json'),
    patch: '',
    patchExisted: false,
    disabled: ['dsh-usage-billing'],
  }
  const r = await t.ctx.enablePluginSafeMode()
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(t.ctx.Config.pluginQuarantine, null, '死记录要清掉')
  assert.ok(t.ctx.Config.pluginSafeModeBackup, '安全模式记录要建立')
})

test('重复进入安全模式不会覆盖最初备份', async () => {
  const t = setup()
  t.reset()
  assert.equal((await t.ctx.enablePluginSafeMode()).ok, true)
  const first = t.ctx.Config.pluginSafeModeBackup
  // 模拟用户在安全模式里又启用了一个第三方插件（Profile 不再是纯安全模式）
  const manifest = JSON.parse(t.read(t.pkg))
  manifest.dsh.profile.bundles.push('dsh-usage-billing')
  fs.writeFileSync(t.pkg, JSON.stringify(manifest, null, 2) + '\n')
  const r = await t.ctx.enablePluginSafeMode()
  assert.equal(r.ok, false)
  assert.match(r.error, /当前已处于安全模式/)
  assert.equal(t.ctx.Config.pluginSafeModeBackup, first, '最初备份不能被覆盖')
})
