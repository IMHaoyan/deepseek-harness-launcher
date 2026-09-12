// tests/plugin-page-wiring.test.js — 插件页静态接线护栏：导航、数据驱动渲染、旧入口迁移。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const html = read('ui-src/index.html')
const app = read('ui-src/app.js')
const main = read('main.js')
const css = read('ui-src/console.css')

test('左侧新增插件导航，插件页容器与搜索/筛选入口齐全', () => {
  assert.match(html, /id="navPlugins"[^>]*data-page="plugins"/, '应有插件一级导航')
  assert.match(html, /id="pagePlugins"/, '应有独立插件页面')
  assert.match(html, /id="pluginCards"/, '应有插件卡片容器')
  assert.match(html, /id="pluginSearch"/, '应支持搜索')
  assert.match(html, /data-plugin-filter="all"/, '应支持按安装状态筛选')
  assert.match(html, /id="btnPluginsInstallAll"/, '顶部应有一键全部安装按钮')
  assert.match(html, /id="btnPluginsRefresh"/, '工具栏应有刷新按钮')
  assert.match(html, /class="plugin-toolbar-actions"/, '操作按钮应与搜索/筛选同排')
  assert.match(html, /id="navPlugins"[^>]*title="预装插件"/, '导航应叫「预装插件」')
  assert.match(html, /<span>预装插件<\/span>/, '导航文字应为「预装插件」')
  assert.match(html, /<span class="page-title">预装插件<\/span>/, '页面标题应为「预装插件」')
})

test('预装插件页：定位说明 + 绿色「预装 (推荐开启)」标签', () => {
  assert.match(html, /class="plugin-page-intro"/, '页面应有定位说明条')
  assert.match(html, /不是插件管理器/, '说明里要写清本页不是插件管理器')
  assert.match(html, /DSH 窗口内的「插件市场」/, '说明里要指路 DSH 内置插件市场')
  assert.doesNotMatch(html, /btnOpenDshMarket/, '说明条不再放跳转按钮（已按用户要求去掉）')
  assert.doesNotMatch(main, /openDshPluginMarket/, '不应保留页面驱动的市场跳转实现')
  assert.doesNotMatch(app, /btnOpenDshMarket/, '渲染层不应再有跳转按钮接线')
  assert.match(main, /'预装 \(推荐开启\)'/, '默认代装标签应为「预装 (推荐开启)」')
  assert.match(main, /bridgePayloadReady \? '预装 \(推荐开启\)' : 'payload 不可用'/, '手机连接（远程连接）也要标预装')
  assert.match(app, /plugin-badge-preinstall/, '预装标签应渲染成绿色样式')
  assert.match(css, /\.plugin-badge-preinstall \{ color: #15803D/, '预装标签应有绿色样式')
  // 卡片紧凑版契约：自适应列宽 + 说明最多两行 + 小一档的按钮 + 备注入口在标题行
  assert.match(css, /repeat\(auto-fill, minmax\(320px, 1fr\)\)/, '卡片网格应按最小 320px 自适应列宽')
  assert.match(css, /-webkit-line-clamp: 2/, '插件说明最多两行（长描述不撑高卡片）')
  assert.match(css, /\.plugin-action-btn \{ height: 30px;/, '操作按钮比全局 .btn 小一档')
  assert.match(app, /head\.appendChild\(noteToggle\)/, '备注入口应在标题行，不再独占一行')
})

test('插件卡片由 state.plugins 数据驱动', () => {
  assert.match(main, /function buildPluginCatalog\(marketState, bridgeState, notes\)/, '主进程应构建插件注册表状态')
  assert.match(main, /plugins: buildPluginCatalog\(marketState, bridgeState, Config\.pluginNotes\)/, 'stateJson 应下发 plugins')
  assert.match(main, /case 'pluginsGetState'/, '应有插件状态刷新命令')
  assert.match(main, /case 'pluginAction'/, '应有通用插件动作命令')
  assert.match(app, /function renderPlugins\(plugins, force\)/, '控制台应有通用插件渲染器')
  assert.match(app, /cmd\('pluginAction', \{ id, action \}\)/, '卡片动作应走通用 pluginAction')
})

test('插件卡片：备注 + 状态/开关 + 一键安装契约', () => {
  assert.match(main, /pluginNotes: \{\}/, '配置应有插件备注容器')
  assert.match(main, /function setManagedPluginNote\(id, text\)/, '主进程应有备注保存逻辑')
  assert.match(main, /async function installAllManagedPlugins\(\)/, '主进程应有一键安装逻辑')
  assert.match(main, /case 'pluginsInstallAll'/, '应有一键安装命令')
  assert.match(main, /case 'pluginSetNote'/, '应有备注保存命令')
  assert.match(main, /pluginInstallAll: \{/, 'state 应下发一键安装进度')
  assert.match(main, /toggleAction: 'toggle'/, '手机连接开关应有真实启停语义')
  assert.match(main, /require\('\.\/plugin-switch'\)/, '主进程应加载 user patch layer 启停模块')
  assert.match(main, /pluginSwitch\.setEnabled\(d\.npm, action === 'enable'\)|pluginSwitch\.setEnabled\(descriptor\.npm, action === 'enable'\)/, 'npm 插件开关应走 user patch layer')
  assert.match(main, /reconcileDisabledPackages\(MANAGED_NPM_PLUGINS/, '启动时应把 DSH market 的禁用状态落到 patch 层')
  assert.match(main, /watchManagedPluginState\(\)/, '应监听 DSH market 状态并刷新控制台')
  assert.match(main, /pluginSwitch\.removeRows\(descriptor\.npm, beforeRows, beforeCarriers\)/, '卸载时应同时清掉 carrier 覆盖行')
  assert.ok(!/deferPluginRefresh\(/.test(main), '启停不应再走「只刷新页面」的旧路径')
  assert.match(main, /r\.restartPending = true/, '开关结果应标记待重启生效')
  assert.ok(!/mode === 'refresh'/.test(main), '不应保留 refresh 挂起模式')
  assert.match(html, /id="consoleToast"/, '控制台应有插件启停反馈 toast')
  assert.match(app, /function showConsoleToast\(text\)/, '控制台应实现 toast 展示')
  assert.match(app, /r\.restartPending/, '开关成功回调应提示需要重启生效')
  assert.match(html, /id=\"pendingRestartHint\"/, '提示条应显示重启文案')
  assert.match(html, /重启后才会生效/, '提示条默认文案应为重启提示')
  assert.ok(!/dataset\.mode = mode/.test(app), '提示条不应再按模式切换')
  assert.match(app, /'立即重启生效'/, '按钮文案统一为立即重启生效')
  assert.match(main, /toggleAction: toggle \? 'toggle' : ''/, '可识别的 npm 插件安装后应显示真实开关')
  assert.match(app, /function renderInstallAll\(info\)/, '控制台应渲染一键安装进度')
  assert.match(app, /data-plugin-note-toggle/, '卡片应支持备注编辑入口')
})

test('按钮形态统一：未安装 1 个、已安装 2 个（走主进程同一份推导）', () => {
  // 直接执行 main.js 里的 pluginCardActions，避免"测试抄一份实现"的假护栏
  const start = main.indexOf('function pluginCardActions(')
  const end = main.indexOf('\n}', start) + 2
  const factory = new Function(main.slice(start, end) + '; return pluginCardActions')
  const build = factory()

  const fresh = build({ installed: false, name: 'x' })
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].action, 'install')

  const done = build({ installed: true, name: 'x', uninstallAction: 'disable' })
  assert.equal(done.length, 2, '已安装必须是「重新安装 + 卸载」两个按钮')
  assert.equal(done[0].action, 'reinstall')
  assert.equal(done[1].action, 'disable')

  const newer = build({ installed: true, outdated: true, latestVersion: '9.9.9', name: 'x' })
  assert.equal(newer.length, 2)
  assert.equal(newer[0].action, 'update')
  assert.match(newer[0].label, /9\.9\.9/)

  assert.deepEqual(build({ busy: true, installed: true, name: 'x' }), [], '操作中不显示按钮')

})

test('插件变更挂起：批量安装不中途重启，顶部提示条一键生效', () => {
  assert.match(html, /id="pendingRestartBar"/, '应有插件变更提示条')
  assert.match(html, /id="btnApplyRestart"/, '提示条应有立即重启按钮')
  assert.match(main, /function deferPluginChange\(verb, name, label\)/, '主进程挂起逻辑统一按重启生效')
  assert.match(main, /async function applyPendingPluginChanges\(\)/, '应有「立即重启生效」入口')
  assert.match(main, /case 'pluginsApplyRestart'/, '应有生效命令')
  assert.match(main, /pluginPendingRestart: \{/, 'state 应下发挂起状态')
  assert.match(main, /deferPluginChange\('install', descriptor\.npm, descriptor\.name\)/, '推荐插件应支持延迟重启')
  assert.match(app, /function renderPendingRestart\(info\)/, '控制台应渲染提示条')
  assert.match(app, /cmd\('pluginsApplyRestart'\)/, '按钮应触发立即重启')
})

test('批量安装：每个插件都带 defer，全程不重启（注入桩执行真实流程）', async () => {
  const start = main.indexOf('async function installAllManagedPlugins() {')
  assert.ok(start > 0, '找不到 installAllManagedPlugins')
  const end = main.indexOf('\n}', main.indexOf('return { ok: true, installed, skipped, pendingRestart', start)) + 2
  assert.ok(end > start, '找不到函数结尾')
  const fnSrc = main.slice(start, end)

  const deferCalls = []
  const applied = []
  let stopped = 0
  const ctx = {
    pluginInstallAllRunning: false,
    pluginInstallAllTarget: 0,
    pluginInstallAllDone: 0,
    pluginInstallAllCurrent: '',
    pluginInstallAllError: '',
    broadcastState() {},
    notify() {},
    log() {},
    stopServiceForPluginChange: async () => { stopped++ },
    MANAGED_NPM_PLUGINS: [
      { id: 'a', name: '插件A', npm: 'pkg-a' },
      { id: 'b', name: '插件B', npm: 'pkg-b' },
    ],
    market: { getState: () => ({ installed: false }) },
    runNpmPluginAction: async (d, action, opts) => { deferCalls.push({ id: d.id, action, defer: !!(opts && opts.defer) }); return { ok: true, version: "1.0.0" } },
    installManagedMarket: async (opts) => { deferCalls.push({ id: "dshmarket", action: "install", defer: !!(opts && opts.defer) }); return { ok: true, version: "1.0.0" } },
    applyPluginChange: async (verb) => { applied.push(verb); return true },
    deferPluginChange: () => {},
  }
  const names = Object.keys(ctx)
  const fn = new Function(...names, fnSrc + '\nreturn installAllManagedPlugins')
  const result = await fn(...names.map((k) => ctx[k]))()

  assert.equal(stopped, 1, '整个批量流程只应停一次服务')
  assert.equal(deferCalls.length, 3, '两个推荐插件 + 插件市场都应参与')
  assert.ok(deferCalls.every((c) => c.defer), '每个插件都必须带 defer（否则会装一个重启一次）')
  assert.deepEqual(applied, [], '批量流程不得调用 applyPluginChange（那是重启入口）')
  assert.equal(result.installed, 3)
  assert.equal(result.pendingRestart, true, '结果应标记「待重启生效」')
})

test('推荐插件注册表：四个 npm 插件 + 通用动作/更新检查', () => {
  assert.match(main, /const MANAGED_NPM_PLUGINS = \[/, '主进程应有推荐插件注册表')
  for (const npm of ['dsh-better-sidebar', '@michengai/dsh-codex-ui', '@kenz1117/dsh-ui-usage-billing', 'dsh-chat-import']) {
    assert.ok(main.includes("'" + npm + "'"), '注册表缺少 ' + npm)
  }
  assert.match(main, /market\.installByName\(descriptor\.npm/, '推荐插件应复用通用 npm 安装器')
  assert.match(main, /market\.uninstallByName\(descriptor\.npm/, '推荐插件应复用通用 npm 卸载器')
  assert.match(main, /action: 'reinstall', label: '重新安装'/, '已安装的卡片应统一提供「重新安装」')
  assert.doesNotMatch(main, /'open-dsh'/, '卡片不再提供「打开 DSH」按钮（统一为 重新安装 + 卸载）')
  assert.match(main, /\.\.\.npmEntries,/, '推荐插件条目应进入 state.plugins 目录')
  assert.match(main, /case 'pluginCheckUpdates'/, '应有 npm 最新版检查命令')
  assert.match(app, /cmd\('pluginCheckUpdates'\)/, '插件页应触发最新版检查')
})

test('旧设置页/恢复页插件入口已迁出，避免双份维护', () => {
  assert.doesNotMatch(html, /id="pluginMarketState"/, '设置页不应再保留插件市场行')
  assert.doesNotMatch(html, /id="btnRemoteConnect"/, '设置页不应再保留远程连接行')
  assert.doesNotMatch(html, /id="btnRecoveryMarket"/, '恢复页不应再保留插件修复行')
})
test('默认代装：增强侧边栏 / 用量与计费随启动器自动装，会话导入仍手动', () => {
  assert.match(main, /pluginAutoInstallTriedVersion: '', pluginAutoDeclined: \{\}/, '配置应有自动安装记账字段')
  assert.match(main, /function pluginAutoDeclined\(id\)/, '应有「用户卸载过」记忆查询')
  assert.match(main, /function notePluginAutoDeclined\(id, declined\)/, '应有「用户卸载过」记账写入')
  assert.match(main, /async function maybeAutoInstallRecommendedPlugins\(\)/, '应有推荐插件默认代装流程')
  assert.match(main, /function pendingAutoInstallPlugins\(\)/, '应有「缺哪些就装哪些」的筛选')

  assert.match(main, /npm: 'dsh-better-sidebar',\n    name: '增强侧边栏',\n    autoInstall: true,/, '增强侧边栏应默认代装')
  assert.match(main, /npm: '@kenz1117\/dsh-ui-usage-billing',\n    name: '用量与计费',\n    autoInstall: true,/, '用量与计费应默认代装')
  assert.doesNotMatch(main, /npm: 'dsh-chat-import',\n    name: '会话导入',\n    autoInstall: true,/, '会话导入保持手动安装')
  assert.doesNotMatch(main, /npm: '@michengai\/dsh-codex-ui',\n    name: 'Codex 风格界面',\n    autoInstall: true,/, 'Codex 风格界面默认不安装（只进插件页）')

  const triggers = main.match(/void maybeAutoInstallRecommendedPlugins\(\)/g) || []
  assert.ok(triggers.length >= 3, '应在启动 / 环境装好 / 服务就绪等触发点补装（实际 ' + triggers.length + ' 处）')
  assert.match(main, /if \(envReady\(\) && server\.running\(\)\) void maybeAutoInstallRecommendedPlugins\(\)/, 'onTick 服务就绪时应补装')

  assert.match(main, /notePluginAutoDeclined\(descriptor\.id, false\)/, '手动装回应清除「不再自动安装」')
  assert.match(main, /notePluginAutoDeclined\(descriptor\.id, true\)/, '手动卸载应记下「不再自动安装」')
  assert.match(main, /autoInstall: !!\(d\.autoInstall && !pluginAutoDeclined\(d\.id\)\)/, '卡片状态应反映自动安装语义')
  assert.match(app, /p\.autoInstallLabel/, '插件卡片应显示自动安装来源')
})

test('默认代装：只装缺失且未被卸载的，一次装完全部只重启一次（注入桩执行真实流程）', async () => {
  const start = main.indexOf('let recommendedAutoInstalling = false')
  assert.ok(start > 0, '找不到默认代装流程')
  const driver = main.indexOf('async function maybeAutoInstallRecommendedPlugins()', start)
  assert.ok(driver > start, '找不到 maybeAutoInstallRecommendedPlugins')
  const end = main.indexOf('\n}\n', main.indexOf('broadcastState()', driver)) + 2
  assert.ok(end > driver, '找不到函数结尾')
  const fnSrc = main.slice(start, end)

  const calls = { installs: [], stops: 0, applied: [], notified: 0 }
  const installed = new Set(['dsh-chat-import']) // 会话导入已装（且非默认代装）
  const Config = { pluginAutoInstallTriedVersion: '', pluginAutoDeclined: { 'usage-billing': true } }
  const ctx = {
    SELF_TEST: false,
    Config,
    app: { getVersion: () => '1.2.1-rc.15' },
    marketAutoInstalling: false,
    bridgeAutoInstalling: false,
    pluginInstallAllRunning: false,
    MANAGED_NPM_PLUGINS: [
      { id: 'better-sidebar', name: '增强侧边栏', npm: 'dsh-better-sidebar', autoInstall: true },
      { id: 'usage-billing', name: '用量与计费', npm: '@kenz1117/dsh-ui-usage-billing', autoInstall: true },
      { id: 'chat-import', name: '会话导入', npm: 'dsh-chat-import' },
    ],
    market: {
      PROFILE_NAME: 'web',
      getState: (npm) => ({ installed: installed.has(npm) }),
      installByName: async (npm) => { calls.installs.push(npm); installed.add(npm); return { ok: true, version: '9.9.9' } },
    },
    envReady: () => true,
    envReport: { pnpm: { status: 'ok' } },
    server: { running: () => true },
    sleep: async () => {},
    stopServiceForPluginChange: async () => { calls.stops++ },
    applyPluginChange: async (verb, version, spec) => { calls.applied.push(spec && spec.name); return true },
    notify: () => { calls.notified++ },
    log: () => {},
    saveConfig: () => {},
    broadcastState: () => {},
  }
  const names = Object.keys(ctx)
  const factory = new Function(...names, fnSrc + '\nreturn { maybeAutoInstallRecommendedPlugins, pendingAutoInstallPlugins, notePluginAutoDeclined }')
  const api = factory(...names.map((k) => ctx[k]))

  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, ['dsh-better-sidebar'], '只应装缺失且未被用户卸载的默认代装插件')
  assert.equal(calls.stops, 1, '只应停一次服务')
  assert.equal(calls.applied.length, 1, '装完只重启一次（不得逐个重启）')
  assert.equal(Config.pluginAutoInstallTriedVersion, '1.2.1-rc.15', '应记下本版本已尝试')
  assert.equal(calls.notified, 0, '成功路径不应发失败通知')

  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, ['dsh-better-sidebar'], '同一启动器版本内不应重复安装')
  assert.equal(calls.stops, 1, '同一启动器版本内不应再次停服务')

  api.notePluginAutoDeclined('better-sidebar', true)
  assert.deepEqual(await api.pendingAutoInstallPlugins(), [], '手动卸载过的插件不应再自动补装')

  api.notePluginAutoDeclined('better-sidebar', false)
  Config.pluginAutoInstallTriedVersion = ''
  installed.delete('dsh-better-sidebar')
  await api.maybeAutoInstallRecommendedPlugins()
  assert.deepEqual(calls.installs, ['dsh-better-sidebar', 'dsh-better-sidebar'], '手动装回后应恢复自动维护')
})
test('挂起变更统一走重启：任何插件变更都只提供「立即重启生效」', async () => {
  const start = main.indexOf('function deferPluginChange(')
  const end = main.indexOf('// 插件市场默认安装', start)
  assert.ok(start > 0 && end > start, '找不到 pending 函数块')
  const fnSrc = main.slice(start, end)
  const Config = { pluginPendingRestart: { count: 0, names: [], mode: 'restart' } }
  const calls = { refresh: 0, restart: 0, broadcasts: 0 }
  const ctx = {
    Config,
    saveConfig() {},
    log() {},
    broadcastState() { calls.broadcasts++ },
    refreshWebUiOnReady: async () => { calls.refresh++ },
    applyPluginChange: async () => { calls.restart++; return true },
    market: { PROFILE_NAME: 'web' },
  }
  const names = Object.keys(ctx)
  const factory = new Function(...names, fnSrc + '\nreturn { deferPluginChange, applyPendingPluginChanges, clearPendingPluginRestart }')
  const api = factory(...names.map((k) => ctx[k]))

  api.deferPluginChange('toggle', '@michengai/dsh-codex-ui', 'Codex 风格界面')
  assert.equal(Config.pluginPendingRestart.mode, 'restart', '插件启停应挂起重启')
  assert.equal(Config.pluginPendingRestart.count, 1, '应记一笔挂起')
  let result = await api.applyPendingPluginChanges()
  assert.equal(result.ok, true)
  assert.equal(calls.restart, 1, '应走服务重启')
  assert.equal(calls.refresh, 0, '不应再走只刷新页面的分支')
  assert.equal(Config.pluginPendingRestart.count, 0, '生效后应清空挂起')

  api.deferPluginChange('toggle', 'dsh-chat-import', '会话导入')
  api.deferPluginChange('install', 'dsh-x', 'X 插件')
  assert.equal(Config.pluginPendingRestart.count, 2, '多次变更应攒在同一条提示里')
  result = await api.applyPendingPluginChanges()
  assert.equal(result.ok, true)
  assert.equal(calls.restart, 2, '批量变更一次重启统一生效')
})