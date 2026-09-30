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
const updateFunction = source.slice(source.indexOf('async function updateNow()'), source.indexOf('module.exports ='))
function dsh(kind, stopService, snapshot = { running: true }) {
  const writes = [], changes = []
  const state = { status: 'available', latest: '0.2.0', latestChannel: 'latest' }
  const ctx = {
    state, updating: false, rollbackUsed: false, log: () => {},
    envDetect: { detectEnv: async () => ({ plan: { kind, dshVersion: '0.1.0' } }) },
    setState: (patch) => Object.assign(state, patch),
    decideUpdateTarget: () => ({ action: 'install' }), channelOf: () => 'latest', userSwitchedChannel: '',
    emitLifecycle: () => {}, getServerState: () => snapshot, stopService,
    writeUpdateState: (value) => writes.push(value),
    loadWebTabs: () => changes.push('page'),
    envInstall: { startInstall: () => changes.push('install'), resolveGlobalRoot: () => { changes.push('resolve'); throw new Error('must not proceed') } },
    markProgress: () => changes.push('progress'),
  }
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
