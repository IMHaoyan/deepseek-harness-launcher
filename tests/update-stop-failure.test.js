'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')

// 完整加载真实 updater 模块，但所有 Electron/文件写入/安装均为桩。
function launcher(beforeInstall, installer) {
  const autoUpdater = new EventEmitter()
  const scheduled = [], receipts = [], installs = [], notices = [], quits = []
  const app = { isPackaged: true, getVersion: () => '1.0.0', getPath: () => 'unused', quit: () => quits.push('quit') }
  autoUpdater.checkForUpdates = async () => {}
  autoUpdater.quitAndInstall = (...args) => { installs.push(args); if (installer) installer(autoUpdater) }
  const context = {
    module: { exports: {} }, setImmediate: (fn) => { scheduled.push(fn) },
    require: (id) => {
      if (id === 'electron') return { app }
      if (id === 'electron-updater') return { autoUpdater }
      if (id === 'fs') return { readFileSync: () => { throw new Error('no receipt') }, unlinkSync: () => {}, writeFileSync: (...args) => receipts.push(args) }
      return require(id)
    },
  }
  vm.runInNewContext(read('updater.js'), context)
  const api = context.module.exports
  api.initUpdater({ beforeInstall, selfUpdatePath: 'mock-receipt', onNotify: (...args) => notices.push(args) })
  autoUpdater.emit('update-downloaded', { version: '1.1.0' })
  return { api, autoUpdater, app, quits, receipts, installs, notices, flush: () => { scheduled.splice(0).forEach((fn) => fn()) } }
}
for (const answer of [false, undefined, 'true']) {
  test(`启动器更新收尾返回 ${String(answer)} 不得安装/落回执，已下载目标保留`, async () => {
    const h = launcher(async () => answer)
    assert.equal(await h.api.installNow(), false)
    h.flush()
    assert.equal(h.installs.length, 0)
    assert.equal(h.receipts.length, 0)
    assert.equal(JSON.parse(h.api.getState()).status, 'downloaded')
    assert.match(JSON.parse(h.api.getState()).error, /更新已暂停/)
  })
}
test('收尾抛错也不能安装；修好后可重试且无需重新下载', async () => {
  let failed = true
  const h = launcher(async () => { if (failed) throw new Error('access denied'); return true })
  assert.equal(await h.api.installNow(), false)
  assert.match(JSON.parse(h.api.getState()).error, /access denied/)
  failed = false
  assert.equal(await h.api.installNow(), true)
  h.flush()
  assert.equal(h.installs.length, 1)
  assert.equal(h.receipts.length, 1)
})
test('缺少收尾钩子不能安装，退出自动安装默认关闭', async () => {
  const h = launcher(undefined)
  assert.equal(h.autoUpdater.autoInstallOnAppQuit, false)
  assert.equal(await h.api.installOnExit(), false)
  h.flush()
  assert.equal(h.installs.length, 0)
})
test('重复点击合并一次；安装器触发的退出不再次安装', async () => {
  let resume, stops = 0
  const h = launcher(() => { stops++; return new Promise((resolve) => { resume = resolve }) })
  const a = h.api.installNow(), b = h.api.installNow()
  assert.equal(a, b)
  resume(true)
  assert.equal(await a, true)
  h.flush()
  assert.equal(await h.api.installOnExit(), false)
  assert.equal(h.installs.length, 1)
  assert.equal(stops, 1)
})
test('收尾中更新目标变化，不安装旧目标', async () => {
  let resume
  const h = launcher(() => new Promise((resolve) => { resume = resolve }))
  const result = h.api.installNow()
  h.api.onChannelChanged()
  resume(true)
  assert.equal(await result, false)
  h.flush()
  assert.equal(h.installs.length, 0)
})

for (const failure of ['throw', 'error-event', 'no-handoff']) {
  test(`普通退出发起安装 ${failure} 仍真正退出；手动安装失败保留界面`, async () => {
    const installer = (updater) => {
      if (failure === 'throw') throw new Error('installer denied')
      if (failure === 'error-event') updater.emit('error', new Error('installer denied'))
    }
    const h = launcher(async () => true, installer)
    const main = read('main.js')
    const body = main.slice(main.indexOf('let exitPromise = null'), main.indexOf('// ---------- 自检（对齐 C# selftest'))
    const ctx = {
      reallyExit: false, stopFlash: () => {}, saveWebWindowState: () => {},
      stopServerFast: async () => true, saveConfig: () => {}, runGuardHandle: null,
      lifecycle: { emit: () => {} }, tray: { destroy: () => {} }, app: h.app,
      updater: h.api, log: () => {}, redact: (s) => s,
    }
    vm.runInNewContext(body + ';globalThis.request=requestExit', ctx)
    await ctx.request('tray')
    h.flush()
    assert.equal(h.quits.length, 1, '不能卡在半退出状态')
    const manual = launcher(async () => true, installer)
    await manual.api.installNow()
    manual.flush()
    assert.equal(manual.quits.length, 0, '用户点安装失败应留在界面，不能强制退出')
  })
}

// 执行真实 updateNow，但停服失败后任何磁盘/安装/页面操作都记录为违规。
const source = read('dsh-update.js')
const updateFunction = source.slice(source.indexOf('async function updateNow('), source.indexOf('module.exports ='))
function dsh(kind, stopService, snapshot = { running: true }, extra = {}) {
  const writes = [], changes = []
  const state = { status: 'available', latest: '0.2.0', latestChannel: 'latest' }
  const ctx = Object.assign({
    state, updating: false, rollbackUsed: false, log: () => {},
    // 预装探测的"坏目标"结论（模块级状态）：置空后走的是正常的停服失败路径
    stageBlock: null,
    warming: null,
    staging: null,
    path: require('node:path'),
    notify: () => {},
    // 目标版本 Node 预检：本组用例只关心停服失败路径，显式放行
    Config: { nodeMajor: 26 },
    readStagedEngines: () => '',
    fetchTargetEngines: async () => '',
    targetNodeBlockOf: () => null,
    rememberTargetRequirement: () => {},
    clearTargetRequirement: () => {},
    setUpdatePhase: () => {},
    envDetect: { detectEnv: async () => ({ node: { version: '26.13.1' }, plan: { kind, dshVersion: '0.1.0' } }) },
    setState: (patch) => Object.assign(state, patch),
    decideUpdateTarget: () => ({ action: 'install' }), channelOf: () => 'latest', userSwitchedChannel: '',
    // 用真实判定函数：否则回滚/收尾分支在 extract 出来的函数体里是未定义标识符，静默落进 catch
    decideRollback: require('../dsh-update').decideRollback,
    decideUpdateOutcome: require('../dsh-update').decideUpdateOutcome,
    readPageCredential: () => ({ hasToken: true }),
    emitLifecycle: () => {}, getServerState: () => snapshot, stopService,
    writeUpdateState: (value) => writes.push(value),
    loadWebTabs: () => changes.push('page'),
    envInstall: { startInstall: () => changes.push('install'), resolveGlobalRoot: () => { changes.push('resolve'); throw new Error('must not proceed') } },
    markProgress: () => changes.push('progress'),
  }, extra)
  const fn = new Function(...Object.keys(ctx), updateFunction + ';return updateNow')(...Object.values(ctx))
  return { fn, writes, changes, state }
}
for (const kind of ['managed', 'global', 'npx']) {
  for (const outcome of ['false', 'throw', 'undefined']) {
    test(`${kind} 更新停服 ${outcome}：不安装、不切目录、不写事务、不假重启`, async () => {
      const h = dsh(kind, async () => { if (outcome === 'throw') throw new Error('stop denied'); return outcome === 'false' ? false : undefined })
      await h.fn()
      assert.equal(h.state.status, 'error')
      assert.deepEqual(h.writes, [])
      assert.deepEqual(h.changes, [])
    })
  }
}
test('正在停止/交接但 running=false 仍必须通过停服检查', async () => {
  for (const status of [{ running: false, stopping: true }, { running: false, settling: true }, { running: false, starting: true }]) {
    const h = dsh('global', async () => false, status)
    await h.fn()
    assert.equal(h.state.status, 'error')
    assert.deepEqual(h.writes, [])
  }
})

// 2026-11-22：0.2.3-alpha.1 的安装树自身跑不起来。预装探测给出结论后，点击更新必须
// **一个副作用都不产生**（不停服、不安装、不写事务）—— 完整安装只会把同一棵坏树顶上。
test('目标版本已被探测为不可运行：点更新直接拒绝，不停服/不安装/不写事务', async () => {
  let stopped = 0
  const h = dsh('global', async () => { stopped++; return true }, { running: true }, {
    stageBlock: { version: '0.2.0', detail: "The requested module 'x' does not provide an export named 'Y'" },
  })
  await h.fn()
  assert.equal(stopped, 0, '不该先停服再发现装不了')
  assert.deepEqual(h.writes, [], '不该写更新事务')
  assert.deepEqual(h.changes, [], '不该切页面/安装')
  assert.equal(h.state.status, 'error')
  assert.match(h.state.error, /禁用或卸载插件都无效/u, h.state.error)
  assert.match(h.state.error, /0\.1\.0 未改动/u, '必须告诉用户当前版本完好：' + h.state.error)
})

// 2026-11-22 家里机器现场：Node 24.14.1、目标 alpha.2 要求 ^24.22.3 || >=26.13.1。
// 目标版本对 Node 的要求必须在停服前判定：否则会"装上 → 起不来 → 回滚"，且回滚后环境页
// 只看旧 DSH，永远不出现 Node 升级入口。
test('目标版本要求更高 Node：停服前直接拒绝，不安装/不写事务，并记住要求', async () => {
  let stopped = 0
  const remembered = [], events = []
  const h = dsh('global', async () => { stopped++; return true }, { running: true }, {
    Config: { nodeMajor: 26 },
    envDetect: { detectEnv: async () => ({ node: { version: '24.14.1' }, plan: { kind: 'global', dshVersion: '0.1.0' } }) },
    readStagedEngines: () => '^24.22.3 || >=26.13.1',
    fetchTargetEngines: async () => '',
    targetNodeBlockOf: require('../dsh-update').targetNodeBlockOf,
    rememberTargetRequirement: (version, range) => remembered.push({ version, range }),
    emitLifecycle: (name, payload) => events.push({ name, payload }),
  })
  await h.fn()
  assert.equal(stopped, 0, '不该先停服')
  assert.deepEqual(h.writes, [], '不该写更新事务')
  assert.deepEqual(h.changes, [], '不该安装')
  assert.equal(h.state.status, 'error')
  assert.equal(h.state.nodeBlocked, true, '界面据此把按钮换成「先升级 Node.js」')
  assert.match(h.state.error, /Node\.js 26 LTS/u, h.state.error)
  assert.match(h.state.error, /当前 v0\.1\.0 未改动/u, h.state.error)
  assert.match(h.state.error, /其他方式管理/u, '没有可执行的升级入口时，不能把用户导向"没有入口"的运行环境页')
  assert.deepEqual(remembered, [{ version: '0.2.0', range: '^24.22.3 || >=26.13.1' }],
    '要把目标要求记下来，环境页才会出现 Node 升级入口')
  assert.equal(events[0].payload.reason, 'target-node')
})

test('目标版本要求更高 Node 且环境页有升级入口：文案直接指向运行环境页', async () => {
  const h = dsh('global', async () => true, { running: true }, {
    Config: { nodeMajor: 26 },
    envDetect: {
      detectEnv: async () => ({
        node: { version: '24.14.1' },
        plan: { kind: 'global', dshVersion: '0.1.0' },
        nodeUpgrade: { mode: 'msi', from: '24.14.1', targetMajor: 26 },
      }),
    },
    readStagedEngines: () => '^24.22.3 || >=26.13.1',
    targetNodeBlockOf: require('../dsh-update').targetNodeBlockOf,
  })
  await h.fn()
  assert.match(h.state.error, /运行环境/u, '有入口时给最短路径：' + h.state.error)
  assert.doesNotMatch(h.state.error, /其他方式管理/u)
})

// 更新前服务本来就没在跑时，也不能把一棵探测失败的树当成成功：startOk 必须无条件为 false。
test('更新前服务未运行 + 完整安装探测出坏树：仍必须回滚，不得宣告成功', async () => {
  const events = []
  const h = dsh('global', async () => { events.push('stop'); return true }, { running: false }, {
    Config: {}, saveConfig: () => {},
    envDetect: { detectEnv: async () => ({ plan: { kind: 'global', dshVersion: '0.1.0', nodeCmd: 'mock' } }) },
    envInstall: { resolveGlobalRoot: async () => 'mock', startInstall: () => events.push('install') },
    swapStagedInto: async () => ({ ok: false, reason: 'no-staged-tree' }),
    runGlobalUpdate: async (_node, _root, version) => { events.push('install:' + version); return { ok: true } },
    probeDshVersion: async () => ({ version: '', output: "SyntaxError: The requested module 'x' does not provide an export named 'Y'" }),
    probeIndicatesBrokenTree: (output) => /does not provide an export named/u.test(String(output)),
    probeFailureDetail: () => "does not provide an export named 'Y'",
    startService: async () => { events.push('start'); return true },
    reloadWebTabs: () => events.push('reload'),
    refreshEnv: async () => {},
  })
  await h.fn()
  assert.deepEqual(events, ['install:0.2.0', 'stop', 'install:0.1.0'], '应回装旧版，且不拉起坏树：' + events.join(','))
  assert.equal(h.state.status, 'error', '不得因为"更新前没在跑"就宣告成功')
  assert.match(h.state.error, /无法启动|回滚/u, h.state.error)
})

// 竞态：用户在后台预装完成前就点了更新（stageBlock 还没产生）。
// 此时走完整安装之前的切换阶段才发现坏树 —— 必须停在这里，不许把完整安装跑完。
test('竞态：预装结论尚未产生时点击，切换阶段发现坏树 → 不跑完整安装，拉回旧服务', async () => {
  const events = []
  const h = dsh('global', async () => { events.push('stop'); return true }, { running: true }, {
    // 模拟"后台预装还在进行中"：必须先等它收场，再停服/决定路径
    warming: { then(resolve) { events.push('warm'); resolve() } },
    envInstall: { resolveGlobalRoot: async () => 'mock', startInstall: () => events.push('install') },
    swapStagedInto: async () => ({ ok: false, reason: 'staged-tree-broken', detail: "The requested module 'x' does not provide an export named 'Y'" }),
    startService: async () => { events.push('start'); return true },
    reloadWebTabs: () => events.push('reload'),
    refreshEnv: async () => {},
  })
  await h.fn()
  assert.deepEqual(events, ['warm', 'stop', 'start', 'reload'], '先等在途预装收场，再停服；停服后只做"把旧版拉回来"，不装新包：' + events.join(','))
  assert.equal(h.writes[0].phase, 'start', '事务在切换前落盘（用于中断恢复）')
  assert.equal(h.writes[h.writes.length - 1].phase, 'failed', '明确失败要落终态，避免下次启动重装')
  assert.equal(h.state.status, 'error')
  assert.match(h.state.error, /禁用或卸载插件都无效/u, h.state.error)
})
// 2026-11-28 现场：dsh-cua-windows --shared-server 被孤儿化到 explorer，停服务带不走；
// 旧树里的 exe/dll 被它映射着 → 改名 EBUSY。清理不掉时必须停在改名之前，并说清是谁占着。
test('安装目录被孤儿进程占用：停服后清理失败 → 拒绝改名/安装，报出占用者', async () => {
  const events = []
  const h = dsh('global', async () => { events.push('stop'); return true }, { running: true }, {
    envInstall: { resolveGlobalRoot: async () => 'mock', startInstall: () => events.push('install') },
    clearInstallDirHolders: async () => ({ ok: false, killed: [], remaining: [{ pid: 9516, name: 'dsh-cua-windows.exe' }] }),
    busyHoldersText: require('../dsh-update').busyHoldersText,
    swapStagedInto: async () => { events.push('swap'); return { ok: true } },
    runGlobalUpdate: async () => { events.push('npm'); return { ok: true } },
    startService: async () => { events.push('start'); return true },
    reloadWebTabs: () => events.push('reload'),
    refreshEnv: async () => {},
  })
  await h.fn()
  assert.equal(h.state.status, 'error')
  assert.match(h.state.error, /PID 9516/u, h.state.error)
  assert.match(h.state.error, /已取消升级/u, h.state.error)
  assert.deepEqual(events, ['stop', 'start', 'reload'], '不许改名/跑 npm，但要把旧服务拉回来：' + events.join(','))
  assert.equal(h.writes[0].phase, 'start', '事务在动手前落盘，恢复逻辑有依据')
})

test('改名切换撞上占用：不再退 npm 重装，直接 fail-closed 并拉回旧服务', async () => {
  const events = []
  const h = dsh('global', async () => { events.push('stop'); return true }, { running: true }, {
    envInstall: { resolveGlobalRoot: async () => 'mock', startInstall: () => events.push('install') },
    clearInstallDirHolders: async () => ({ ok: true, killed: [{ pid: 9516 }], remaining: [] }),
    swapStagedInto: async () => ({ ok: false, reason: 'install-dir-busy: EBUSY: resource busy or locked, rename ...' }),
    runGlobalUpdate: async () => { events.push('npm'); return { ok: true } },
    startService: async () => { events.push('start'); return true },
    reloadWebTabs: () => events.push('reload'),
    refreshEnv: async () => {},
  })
  await h.fn()
  assert.equal(h.state.status, 'error')
  assert.match(h.state.error, /仍被占用/u, h.state.error)
  assert.deepEqual(events, ['stop', 'start', 'reload'], '不许白跑 npm：' + events.join(','))
})

test('清理成功后才轮到改名：顺序 stop → clear → swap', async () => {
  const events = []
  const h = dsh('global', async () => { events.push('stop'); return true }, { running: true }, {
    envInstall: { resolveGlobalRoot: async () => 'mock', startInstall: () => events.push('install') },
    clearInstallDirHolders: async () => { events.push('clear'); return { ok: true, killed: [{ pid: 9516 }], remaining: [] } },
    swapStagedInto: async () => { events.push('swap'); return { ok: false, reason: 'staged-tree-broken', detail: 'x' } },
    startService: async () => { events.push('start'); return true },
    reloadWebTabs: () => events.push('reload'),
    refreshEnv: async () => {},
  })
  await h.fn()
  assert.deepEqual(events.slice(0, 3), ['stop', 'clear', 'swap'])
})

