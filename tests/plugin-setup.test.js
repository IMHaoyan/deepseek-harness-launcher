// 首装选择与统一预装批次：执行 main.js 的真实 block，不加载 Electron。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n?/gu, '\n')
const start = main.indexOf('let recommendedAutoInstalling = false')
const end = main.indexOf('// ---------- 退役插件：', start)
assert.ok(start > 0 && end > start, '真实预装 driver block 必须存在')
const driver = main.slice(start, end)

function harness(options = {}) {
  const Config = { pluginSetupChoice: 'install', pluginSetupSelectedIds: null, pluginMarketAutoTryVersion: '', pluginMarketDeclined: false,
    pluginAutoInstallTriedVersion: '', pluginAutoDeclined: {}, ...options.config }
  const calls = { queries: [], resolved: [], installs: [], events: [], saves: 0, locks: 0, releases: 0, stops: 0, applied: [], starts: 0, broadcasts: 0 }
  const installed = new Set(options.installed || [])
  let version = '1.4.15-alpha.3'
  const ctx = {
    Config, SELF_TEST: false, app: { getVersion: () => version }, pluginInstallAllRunning: false,
    PROFILE_BUSY_ERROR: 'profile busy',
    MANAGED_NPM_PLUGINS: [
      { id: 'a', name: '推荐A', npm: 'pkg-a', autoInstall: true, description: 'A说明' },
      { id: 'manual', name: '手动', npm: 'pkg-manual' },
      { id: 'b', name: '推荐B', npm: 'pkg-b', autoInstall: true, description: 'B说明' },
    ],
    market: {
      PLUGIN_NAME: 'dshmarket', PROFILE_NAME: 'web',
      uninstallByName: async (npm) => { calls.events.push('uninstall:' + npm); throw new Error('重选预装不得卸载任何现有插件') },
      getState: (npm) => { calls.queries.push(npm); return { installed: installed.has(npm) } },
      installByName: async (npm) => {
        calls.installs.push(npm); calls.events.push('install:' + npm)
        if (options.install) return options.install(npm)
        installed.add(npm); return { ok: true, version: '1.0.0' }
      },
      classifyEnvFailure: (error) => ({ error }),
      versionGateFailure: (info) => ({ kind: 'version-gate', gate: info }),
    },
    npmVersionCache: new Map(),
    resolveNpmVersion: async (npm) => { calls.resolved.push(npm); if (options.resolve) await options.resolve(npm); return '1.0.0' },
    pluginGateVerdict: () => ({ state: 'ok' }),
    envReady: () => options.envReady !== false, envReport: { pnpm: { status: 'ok' } },
    server: { running: () => options.serverRunning !== false },
    profileOpBusy: () => !!options.busy,
    profileBusyError: () => ({ ok: false, busy: true, error: 'profile busy' }),
    tryBeginBackgroundProfileOp: () => { calls.locks++; return options.lock === false ? null : () => { calls.releases++ } },
    stopServiceForPluginChange: async () => { calls.stops++; calls.events.push('stop'); return options.stop || { ok: true } },
    applyPluginChange: async (verb, version, spec) => { calls.applied.push({ verb, version, spec }); calls.events.push('apply'); return options.apply !== false },
    handleStart: async () => { calls.starts++; calls.events.push('start'); return options.start !== false },
    saveConfig: () => { calls.saves++; if (options.onSave) options.onSave(Config); return options.save !== false },
    broadcastState: () => { calls.broadcasts++ }, log() {}, notify() {}, consoleIsOpen: () => true,
    clearPluginEnvFailure: () => { if (options.clearThrows) throw new Error('记账异常') },
    notePluginEnvFailure() {}, notePluginReleaseAgeRetry() {}, invalidatePluginInventory() {},
  }
  const names = Object.keys(ctx)
  const api = new Function(...names, driver + '\nreturn { maybeAutoInstallRecommendedPlugins, runAutoInstallPlugins, setPluginSetupChoice, pluginSetupPlugins, normalizePluginSetupSelection, pluginSetup, getPromise: () => autoPluginPromise };')(...names.map((key) => ctx[key]))
  return { api, calls, Config, installed, upgrade: (next) => { version = next } }
}

function assertNoServiceChange(calls) {
  assert.equal(calls.stops, 0)
  assert.deepEqual(calls.installs, [])
  assert.deepEqual(calls.applied, [])
  assert.equal(calls.starts, 0)
  assert.deepEqual(calls.events, [], '不应尝试卸载或其它服务变更')
}

function assertUnattempted(Config) {
  assert.equal(Config.pluginMarketAutoTryVersion, '')
  assert.equal(Config.pluginAutoInstallTriedVersion, '')
}

test('预装清单由市场 + autoInstall 注册表生成，不包括手动项', () => {
  const { api } = harness()
  assert.deepEqual(api.pluginSetupPlugins().map(({ id, npm }) => ({ id, npm })), [
    { id: 'dshmarket', npm: 'dshmarket' }, { id: 'a', npm: 'pkg-a' }, { id: 'b', npm: 'pkg-b' },
  ])
})

test('市场和两个推荐插件同批安装：只停一次、末尾只 apply 一次，两种版本 marker 保留', async () => {
  const { api, calls, Config } = harness()
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.events, ['stop', 'install:dshmarket', 'install:pkg-a', 'install:pkg-b', 'apply'])
  assert.equal(calls.stops, 1)
  assert.equal(calls.applied.length, 1)
  assert.equal(calls.starts, 0)
  assert.equal(calls.releases, 1)
  assert.equal(Config.pluginMarketAutoTryVersion, '1.4.15-alpha.3')
  assert.equal(Config.pluginAutoInstallTriedVersion, '1.4.15-alpha.3')
  assert.deepEqual(api.pluginSetup, { running: false, completed: true, current: '', done: 3, total: 3, error: '' })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.equal(calls.installs.length, 3, '同版本不重复安装')
  assert.equal(calls.stops, 1)
})

test('installed 是已装判据；缺推荐项只补缺失项，市场不重装', async () => {
  const { api, calls } = harness({ installed: ['dshmarket', 'pkg-a'] })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, ['pkg-b'])
  assert.ok(calls.queries.includes('dshmarket'), '必须以市场的 PLUGIN_NAME 查询安装状态')
})

for (const [label, config, expected] of [
  ['市场 marker 已记，仅推荐插件参与', { pluginMarketAutoTryVersion: '1.4.15-alpha.3' }, ['pkg-a', 'pkg-b']],
  ['推荐 marker 已记，仅市场参与', { pluginAutoInstallTriedVersion: '1.4.15-alpha.3' }, ['dshmarket']],
  ['市场与推荐均被用户卸载，不自动补装', { pluginMarketDeclined: true, pluginAutoDeclined: { a: true, b: true } }, []],
]) test(label, async () => {
  const { api, calls } = harness({ config })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, expected)
})

for (const all of [false, true]) test(all ? '全失败：只恢复基础服务，不虚假 apply 安装成功' : '部分失败：剩余插件照常安装，末尾 apply 一次恢复服务', async () => {
  const { api, calls } = harness({ install: async (npm) => {
    if (all || npm === 'pkg-a') throw new Error('npm 安装失败')
    return { ok: true, version: '1.0.0' }
  } })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, ['dshmarket', 'pkg-a', 'pkg-b'])
  assert.equal(calls.stops, 1)
  assert.equal(calls.applied.length, all ? 0 : 1)
  assert.equal(calls.starts, all ? 1 : 0)
  assert.equal(calls.releases, 1)
  assert.equal(api.pluginSetup.running, false)
  assert.match(api.pluginSetup.error, /npm 安装失败/)
  if (!all) assert.doesNotMatch(calls.applied[0].spec.name, /推荐A/, '失败项不能进入已安装通知')
})

test('停服后记账异常仍恢复服务并释放锁', async () => {
  const { api, calls } = harness({ clearThrows: true })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.equal(calls.stops, 1)
  assert.equal(calls.starts, 1)
  assert.equal(calls.applied.length, 0)
  assert.equal(calls.releases, 1)
  assert.match(api.pluginSetup.error, /记账异常/)
})

test('stop 失败不记尝试、不安装、不重启', async () => {
  const { api, calls, Config } = harness({ stop: { ok: false, error: '服务尚未停止' } })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.equal(calls.stops, 1)
  assert.deepEqual(calls.installs, [])
  assert.equal(calls.applied.length, 0)
  assert.equal(calls.starts, 0)
  assertUnattempted(Config)
  assert.equal(calls.releases, 1)
  assert.match(api.pluginSetup.error, /服务尚未停止/)
})

for (const choice of ['pending', 'skip']) test(choice + ' 不查状态/版本、不安装、不重启，升级仍保持选择', async () => {
  const { api, calls, Config, upgrade } = harness({ config: { pluginSetupChoice: choice } })
  await api.maybeAutoInstallRecommendedPlugins()
  upgrade('1.4.16')
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.queries, [])
  assert.deepEqual(calls.resolved, [])
  assert.equal(calls.locks, 0)
  assertNoServiceChange(calls)
  assertUnattempted(Config)
  assert.equal(Config.pluginSetupChoice, choice)
})

test('两个触发入口共享进行中的 promise，不重复查询和安装', async () => {
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const { api, calls } = harness({ resolve: () => barrier })
  const first = api.maybeAutoInstallRecommendedPlugins()
  const shared = api.getPromise()
  const second = api.maybeAutoInstallRecommendedPlugins()
  assert.equal(api.getPromise(), shared, '并发调用不得替换内部批次 promise')
  assert.equal(calls.locks, 1)
  assert.deepEqual(calls.resolved, ['dshmarket', 'pkg-a', 'pkg-b'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls.installs, ['dshmarket', 'pkg-a', 'pkg-b'])
  assert.equal(calls.stops, 1)
  assert.equal(calls.applied.length, 1)
  assert.equal(api.getPromise(), null)
})

test('取锁失败不记尝试、不查询版本、不改服务', async () => {
  const { api, calls, Config } = harness({ lock: false })
  await api.maybeAutoInstallRecommendedPlugins()
  assertUnattempted(Config)
  assertNoServiceChange(calls)
  assert.deepEqual(calls.resolved, [])
  assert.equal(calls.releases, 0)
})

for (const choice of ['install', 'skip']) test('首装 ' + choice + ' saveConfig 失败回滚，不自动启动', async () => {
  const { api, calls, Config } = harness({ save: false, serverRunning: false, config: { pluginSetupChoice: 'pending' } })
  const result = api.setPluginSetupChoice(choice)
  await Promise.resolve()
  assert.equal(result.ok, false)
  assert.match(result.error, /无法保存/)
  assert.equal(Config.pluginSetupChoice, 'pending')
  assert.equal(calls.saves, 1)
  assert.equal(api.pluginSetup.running, false)
  assertNoServiceChange(calls)
})

test('有效 choice 成功保存；环境未就绪时不自动启动', () => {
  const { api, calls, Config } = harness({ envReady: false, config: { pluginSetupChoice: 'pending' } })
  assert.deepEqual(api.setPluginSetupChoice('install'), { ok: true, choice: 'install', selectedIds: ['dshmarket', 'a', 'b'] })
  assert.equal(Config.pluginSetupChoice, 'install')
  assert.equal(calls.saves, 1)
  assertNoServiceChange(calls)
})

test('首装选择 install 排队态即时可见，完成批次后解除 running', async () => {
  const { api, calls, Config } = harness({ config: { pluginSetupChoice: 'pending' } })
  assert.deepEqual(api.setPluginSetupChoice('install'), { ok: true, choice: 'install', selectedIds: ['dshmarket', 'a', 'b'] })
  assert.equal(api.pluginSetup.running, true)
  await api.maybeAutoInstallRecommendedPlugins()
  await Promise.resolve()
  assert.equal(Config.pluginSetupChoice, 'install')
  assert.deepEqual(calls.installs, ['dshmarket', 'pkg-a', 'pkg-b'])
  assert.equal(api.pluginSetup.running, false)
  assert.equal(api.pluginSetup.completed, true)
})

test('首装启动排队期间不能第二次修改选择', async () => {
  const { api, calls, Config } = harness({ serverRunning: false, config: { pluginSetupChoice: 'pending' } })
  assert.equal(api.setPluginSetupChoice('install').ok, true)
  assert.equal(api.setPluginSetupChoice('skip').busy, true)
  assert.equal(Config.pluginSetupChoice, 'install')
  assert.equal(calls.saves, 1, '队列空档不允许第二次保存选择')
  await Promise.resolve()
  await api.maybeAutoInstallRecommendedPlugins()
})

test('已全部安装的零目标批次有明确 completed 证据，不停服且 tick 不重复保存', async () => {
  const { api, calls } = harness({ installed: ['dshmarket', 'pkg-a', 'pkg-b'] })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.equal(api.pluginSetup.completed, true)
  assert.equal(api.pluginSetup.total, 0)
  assertNoServiceChange(calls)
  const saves = calls.saves
  await api.maybeAutoInstallRecommendedPlugins()
  assert.equal(calls.saves, saves)
})

test('非法 choice 必须拒绝且不得保存配置或启动', () => {
  const { api, calls, Config } = harness({ config: { pluginSetupChoice: 'pending' } })
  for (const choice of ['pending', '', undefined, null, {}, 'INSTALL']) {
    assert.equal(api.setPluginSetupChoice(choice).ok, false)
  }
  assert.equal(Config.pluginSetupChoice, 'pending')
  assert.equal(calls.saves, 0)
  assertNoServiceChange(calls)
})

test('profile 锁忙时拒绝修改 choice', () => {
  const { api, calls, Config } = harness({ busy: true, config: { pluginSetupChoice: 'pending' } })
  assert.equal(api.setPluginSetupChoice('install').busy, true)
  assert.equal(Config.pluginSetupChoice, 'pending')
  assert.equal(calls.saves, 0)
})

test('新用户默认 pending，旧配置缺字段迁移 install，显式 choice 与两种旧 marker 保留', () => {
  const configStart = main.indexOf('const Config = {')
  const configEnd = main.indexOf('\n', configStart)
  const initial = new Function('SELF_TEST', 'envDetect', main.slice(configStart, configEnd) + '\nreturn Config')(false, { DEFAULT_NODE_MAJOR: 24 })
  assert.equal(initial.pluginSetupChoice, 'pending')
  const migrationStart = main.indexOf("  if (typeof cfg.pluginMarketAutoTryVersion === 'string')")
  const migrationEnd = main.indexOf('  // 退役插件', migrationStart)
  assert.ok(migrationStart > 0 && migrationEnd > migrationStart)
  const migrateSource = new Function('Config', 'cfg', 'normalizePluginSetupSelection', main.slice(migrationStart, migrationEnd))
  const normalize = harness().api.normalizePluginSetupSelection
  const migrate = (Config, cfg) => migrateSource(Config, cfg, normalize)
  assert.equal(initial.pluginSetupSelectedIds, null, '新用户候选清单默认全选')
  for (const [input, expected] of [[{}, 'install'], [{ pluginSetupChoice: 'pending' }, 'pending'], [{ pluginSetupChoice: 'install' }, 'install'], [{ pluginSetupChoice: 'skip' }, 'skip'], [{ pluginSetupChoice: 'corrupt' }, 'pending']]) {
    const Config = { ...initial }
    migrate(Config, { ...input, pluginMarketAutoTryVersion: 'old-market', pluginAutoInstallTriedVersion: 'old-recommended', pluginMarketDeclined: true })
    assert.equal(Config.pluginSetupChoice, expected)
    assert.equal(Config.pluginMarketAutoTryVersion, 'old-market')
    assert.equal(Config.pluginAutoInstallTriedVersion, 'old-recommended')
    assert.equal(Config.pluginMarketDeclined, true)
    assert.equal(Config.pluginSetupSelectedIds, null, '旧配置缺少选择字段保留默认全选')
  }
  for (const [selection, expected] of [
    [null, null], [[], []], [['b', 'dshmarket', 'b'], ['dshmarket', 'b']],
    ['a', []], [{ a: true }, []], [false, []], [['a', 'unknown'], []],
    [['manual'], []], [['a', 1], []],
  ]) {
    const Config = { ...initial }
    migrate(Config, { pluginSetupChoice: 'install', pluginSetupSelectedIds: selection })
    assert.deepEqual(Config.pluginSetupSelectedIds, expected, 'selection 迁移必须校验真实 allowlist 并对损坏配置 fail-closed')
  }
})

test('首装 IPC 转交 choice 和 selectedIds，state 下发真实选择与安装进度', () => {
  assert.match(main, /case 'pluginsSetSetupChoice': return JSON\.stringify\(setPluginSetupChoice\(value && value\.choice, value && value\.selectedIds\)\)/)
  assert.match(main, /pluginSetup: \{ \.\.\.pluginSetup, choice: Config\.pluginSetupChoice, selectedIds: Config\.pluginSetupSelectedIds \}/)
})

for (const [ids, expected] of [
  [['a'], ['pkg-a']],
  [['dshmarket', 'b'], ['dshmarket', 'pkg-b']],
  [['dshmarket'], ['dshmarket']],
]) test('subset ' + ids.join(',') + ' 只安装选中项，升级后不偷偷补装未选项', async () => {
  const { api, calls, Config, upgrade } = harness({ config: { pluginSetupSelectedIds: ids } })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, expected)
  assert.deepEqual(calls.resolved, expected)
  assert.equal(calls.stops, 1)
  assert.equal(calls.applied.length, 1)
  upgrade('1.4.16')
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, expected, '新版本也不得补装未选项')
  assert.deepEqual(Config.pluginSetupSelectedIds, ids)
})

test('显式空选择 fail-closed，不查询任何插件、不安装或改变服务', async () => {
  const { api, calls } = harness({ config: { pluginSetupSelectedIds: [] } })
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.queries, [])
  assert.deepEqual(calls.resolved, [])
  assertNoServiceChange(calls)
})

test('install subset 保存、重复 id 去重，输入数组不被修改', () => {
  const { api, calls, Config } = harness({ envReady: false, config: { pluginSetupChoice: 'pending' } })
  const ids = ['b', 'dshmarket', 'b']
  assert.equal(api.setPluginSetupChoice('install', ids).ok, true)
  assert.equal(Config.pluginSetupChoice, 'install')
  assert.deepEqual(Config.pluginSetupSelectedIds, ['dshmarket', 'b'], '按权威预装清单排序并去重')
  assert.deepEqual(ids, ['b', 'dshmarket', 'b'])
  assert.equal(calls.saves, 1)
  assertNoServiceChange(calls)
})

test('兼容旧 install 调用：省略 selectedIds 保存当前权威清单全选', () => {
  const { api, Config } = harness({ envReady: false, config: { pluginSetupSelectedIds: ['a'] } })
  assert.equal(api.setPluginSetupChoice('install').ok, true)
  assert.deepEqual(Config.pluginSetupSelectedIds, ['dshmarket', 'a', 'b'])
})

test('skip 强制保存 []，不保留旧全选或调用方传入选择', () => {
  const { api, Config } = harness({ envReady: false })
  assert.equal(api.setPluginSetupChoice('skip', ['dshmarket', 'a']).ok, true)
  assert.equal(Config.pluginSetupChoice, 'skip')
  assert.deepEqual(Config.pluginSetupSelectedIds, [])
})

for (const [label, ids] of [
  ['空数组', []], ['未知 id', ['unknown']], ['混入未知 id', ['a', 'unknown']],
  ['手动插件', ['manual']], ['npm 名代替 id', ['pkg-a']], ['数字项', ['a', 1]],
  ['null', null], ['字符串', 'a'], ['对象', { a: true }], ['布尔', false],
]) test('install 拒绝非法 selectedIds：' + label + '，无配置写入或启动', () => {
  const { api, calls, Config } = harness({ config: { pluginSetupChoice: 'pending', pluginSetupSelectedIds: ['b'] } })
  const before = Config.pluginSetupSelectedIds
  assert.equal(api.setPluginSetupChoice('install', ids).ok, false)
  assert.equal(Config.pluginSetupChoice, 'pending')
  assert.equal(Config.pluginSetupSelectedIds, before)
  assert.equal(calls.saves, 0)
  assertNoServiceChange(calls)
})

for (const choice of ['install', 'skip']) test(choice + ' 保存失败同时回滚 choice 与 selection', () => {
  const { api, calls, Config } = harness({ save: false, config: { pluginSetupChoice: 'pending', pluginSetupSelectedIds: ['b'] } })
  const before = Config.pluginSetupSelectedIds
  assert.equal(api.setPluginSetupChoice(choice, ['a']).ok, false)
  assert.equal(Config.pluginSetupChoice, 'pending')
  assert.equal(Config.pluginSetupSelectedIds, before, '回滚必须恢复旧 selection 引用')
  assert.equal(calls.saves, 1)
  assertNoServiceChange(calls)
})

test('同版本已记尝试后重选：两个选中项含 existing，只安装 missing，unchecked 已装不卸载', async () => {
  const { api, calls, Config, installed } = harness({ installed: ['dshmarket', 'pkg-a'], config: {
    pluginSetupSelectedIds: ['a'], pluginMarketAutoTryVersion: '1.4.15-alpha.3', pluginAutoInstallTriedVersion: '1.4.15-alpha.3',
  } })
  assert.equal(api.setPluginSetupChoice('install', ['a', 'b']).ok, true)
  await api.maybeAutoInstallRecommendedPlugins()
  await Promise.resolve()
  assert.deepEqual(calls.installs, ['pkg-b'])
  assert.deepEqual(calls.events, ['stop', 'install:pkg-b', 'apply'])
  assert.equal(calls.stops, 1)
  assert.equal(calls.applied.length, 1)
  assert.equal(calls.starts, 0)
  assert.deepEqual([...installed], ['dshmarket', 'pkg-a', 'pkg-b'], '取消市场勾选不是卸载市场')
  assert.deepEqual(Config.pluginSetupSelectedIds, ['a', 'b'])
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, ['pkg-b'], '同版本重选批次结束后不得再装一次')
})

test('显式重选市场可重试：推荐 existing 不重装，市场 missing 装一次', async () => {
  const { api, calls, installed } = harness({ installed: ['pkg-a', 'pkg-b'], config: {
    pluginMarketAutoTryVersion: '1.4.15-alpha.3', pluginAutoInstallTriedVersion: '1.4.15-alpha.3',
  } })
  assert.equal(api.setPluginSetupChoice('install', ['dshmarket', 'a']).ok, true)
  await api.maybeAutoInstallRecommendedPlugins()
  await Promise.resolve()
  assert.deepEqual(calls.installs, ['dshmarket'])
  assert.equal(calls.applied.length, 1)
  assert.equal(calls.stops, 1)
  assert.ok(installed.has('pkg-b'), '未选 existing 推荐插件不得卸载')
})

test('install 保存前清两种尝试 marker，只清选中的 declined，保留未选卸载记忆', () => {
  let observed
  const { api, calls, Config } = harness({ envReady: false, onSave: (config) => { observed = {
    choice: config.pluginSetupChoice, selected: [...config.pluginSetupSelectedIds],
    marketTry: config.pluginMarketAutoTryVersion, recommendedTry: config.pluginAutoInstallTriedVersion,
    marketDeclined: config.pluginMarketDeclined, declined: { ...config.pluginAutoDeclined },
  } }, config: {
    pluginMarketAutoTryVersion: 'old-market', pluginAutoInstallTriedVersion: 'old-recommended',
    pluginMarketDeclined: true, pluginAutoDeclined: { a: true, b: true, manual: true },
  } })
  assert.equal(api.setPluginSetupChoice('install', ['dshmarket', 'a']).ok, true)
  assert.deepEqual(observed, { choice: 'install', selected: ['dshmarket', 'a'], marketTry: '', recommendedTry: '',
    marketDeclined: false, declined: { b: true, manual: true } })
  assert.deepEqual(Config.pluginAutoDeclined, { b: true, manual: true })
  assert.equal(calls.saves, 1)
  assertNoServiceChange(calls)
})

test('显式 install 可恢复曾手动卸载的 selected 推荐插件，未选市场仍 declined', async () => {
  const { api, calls, Config } = harness({ config: {
    pluginMarketDeclined: true, pluginAutoDeclined: { a: true, b: true },
    pluginMarketAutoTryVersion: '1.4.15-alpha.3', pluginAutoInstallTriedVersion: '1.4.15-alpha.3',
  } })
  assert.equal(api.setPluginSetupChoice('install', ['a']).ok, true)
  await api.maybeAutoInstallRecommendedPlugins()
  await Promise.resolve()
  assert.deepEqual(calls.installs, ['pkg-a'])
  assert.deepEqual(Config.pluginAutoDeclined, { b: true })
  assert.equal(Config.pluginMarketDeclined, true)
  assert.equal(calls.applied.length, 1)
})

test('显式 install 可恢复曾手动卸载的市场，未选推荐卸载记忆保留', async () => {
  const { api, calls, Config } = harness({ config: {
    pluginMarketDeclined: true, pluginAutoDeclined: { a: true, b: true },
    pluginMarketAutoTryVersion: '1.4.15-alpha.3', pluginAutoInstallTriedVersion: '1.4.15-alpha.3',
  } })
  assert.equal(api.setPluginSetupChoice('install', ['dshmarket']).ok, true)
  await api.maybeAutoInstallRecommendedPlugins()
  await Promise.resolve()
  assert.deepEqual(calls.installs, ['dshmarket'])
  assert.equal(Config.pluginMarketDeclined, false)
  assert.deepEqual(Config.pluginAutoDeclined, { a: true, b: true })
})

test('skip 保留现有 installed、两种尝试 marker 和所有 declined，不卸载或重启', async () => {
  const { api, calls, Config, installed } = harness({ installed: ['dshmarket', 'pkg-a', 'pkg-b'], config: {
    pluginMarketAutoTryVersion: 'old-market', pluginAutoInstallTriedVersion: 'old-recommended',
    pluginMarketDeclined: true, pluginAutoDeclined: { a: true, b: true },
  } })
  const declined = Config.pluginAutoDeclined
  assert.equal(api.setPluginSetupChoice('skip', ['dshmarket', 'a']).ok, true)
  await api.maybeAutoInstallRecommendedPlugins()
  await Promise.resolve()
  assert.deepEqual(Config.pluginSetupSelectedIds, [])
  assert.equal(Config.pluginMarketAutoTryVersion, 'old-market')
  assert.equal(Config.pluginAutoInstallTriedVersion, 'old-recommended')
  assert.equal(Config.pluginMarketDeclined, true)
  assert.equal(Config.pluginAutoDeclined, declined)
  assert.deepEqual(Config.pluginAutoDeclined, { a: true, b: true })
  assert.deepEqual([...installed], ['dshmarket', 'pkg-a', 'pkg-b'])
  assertNoServiceChange(calls)
})

for (const choice of ['install', 'skip']) test('重选 ' + choice + ' 保存失败回滚全部 marker/declined/choice/selection，原引用与值不变', () => {
  const { api, calls, Config, installed } = harness({ save: false, installed: ['pkg-b'], config: {
    pluginSetupChoice: 'skip', pluginSetupSelectedIds: ['b'],
    pluginMarketAutoTryVersion: 'old-market', pluginAutoInstallTriedVersion: 'old-recommended',
    pluginMarketDeclined: true, pluginAutoDeclined: { a: true, b: true, manual: true },
  } })
  const selected = Config.pluginSetupSelectedIds
  const declined = Config.pluginAutoDeclined
  const values = JSON.parse(JSON.stringify(Config))
  assert.equal(api.setPluginSetupChoice(choice, ['dshmarket', 'a']).ok, false)
  assert.deepEqual(Config, values)
  assert.equal(Config.pluginSetupSelectedIds, selected, 'selection 原引用恢复')
  assert.equal(Config.pluginAutoDeclined, declined, 'declined 原引用恢复且原对象内容未被改写')
  assert.deepEqual(declined, { a: true, b: true, manual: true })
  assert.deepEqual([...installed], ['pkg-b'])
  assert.equal(calls.saves, 1)
  assertNoServiceChange(calls)
})

for (const previous of ['install', 'skip']) test('管理页既有 ' + previous + ' 改为 skip：服务停止时只保存，不自动启动', async () => {
  const { api, calls, Config } = harness({ serverRunning: false, config: { pluginSetupChoice: previous } })
  assert.deepEqual(api.setPluginSetupChoice('skip'), { ok: true, choice: 'skip', selectedIds: [] })
  await Promise.resolve()
  assert.equal(Config.pluginSetupChoice, 'skip')
  assert.deepEqual(Config.pluginSetupSelectedIds, [])
  assert.equal(calls.saves, 1)
  assert.equal(api.pluginSetup.running, false)
  assertNoServiceChange(calls)
})

test('首装 pending 跳过仍启动基础服务一次，不安装或停服', async () => {
  const { api, calls, Config } = harness({ serverRunning: false, config: { pluginSetupChoice: 'pending' } })
  assert.equal(api.setPluginSetupChoice('skip').ok, true)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(Config.pluginSetupChoice, 'skip')
  assert.equal(calls.starts, 1)
  assert.equal(calls.stops, 0)
  assert.deepEqual(calls.installs, [])
  assert.deepEqual(calls.applied, [])
  assert.equal(api.pluginSetup.running, false)
})
