// tests/plugin-page-wiring.test.js — 插件页静态接线护栏：导航、数据驱动渲染、旧入口迁移。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const html = read('ui-src/index.html')
const app = read('ui-src/app.js')
const main = read('main.js')
const css = read('ui-src/console.css')
const pluginRepo = require('../plugin-repo')

test('左侧新增插件导航，插件页容器与搜索/筛选入口齐全', () => {
  assert.match(html, /id="navPlugins"[^>]*data-page="plugins"/, '应有插件一级导航')
  assert.match(html, /id="pagePlugins"/, '应有独立插件页面')
  assert.match(html, /id="pluginCards"/, '应有插件卡片容器')
  assert.match(html, /id="pluginSearch"/, '应支持搜索')
  assert.match(html, /data-plugin-filter="all"/, '应支持按安装状态筛选')
  assert.match(html, /id="btnPluginsInstallAll"/, '顶部应有一键安装按钮')
  assert.match(html, /一键安装所有预装插件/, '顶部按钮应写明「一键安装所有预装插件」')
  assert.match(html, /id="btnPluginsUpdate"/, '顶部应有一键更新按钮')
  assert.match(html, /id="btnPluginsUpdate"[^>]*>一键更新</, '一键更新按钮文案')
  assert.match(html, /id="btnPluginsRefresh"/, '工具栏应有刷新按钮')
  assert.match(html, /class="plugin-toolbar-actions"/, '应有操作按钮组')
  assert.match(html, /id="navPlugins"[^>]*title="预装插件"/, '导航应叫「预装插件」')
  assert.match(html, /<span>预装插件<\/span>/, '导航文字应为「预装插件」')
  assert.match(html, /<span class="page-title">预装插件<\/span>/, '页面标题应为「预装插件」')
})

test('预装插件页：定位说明 + 绿色「DSHL预装」/ 蓝色「官方推荐」两枚标签', () => {
  assert.match(html, /class="plugin-page-intro"/, '页面应有定位说明条')
  assert.match(html, /不是插件管理器/, '说明里要写清本页不是插件管理器')
  assert.match(html, /DSH 窗口内的「插件市场」/, '说明里要指路 DSH 内置插件市场')
  assert.doesNotMatch(html, /btnOpenDshMarket/, '说明条不再放跳转按钮（已按用户要求去掉）')
  assert.doesNotMatch(main, /openDshPluginMarket/, '不应保留页面驱动的市场跳转实现')
  assert.doesNotMatch(app, /btnOpenDshMarket/, '渲染层不应再有跳转按钮接线')
  assert.match(main, /label: o\.autoInstall \? 'DSHL预装' : String\(o\.offLabel/, 'DSHL 预装这枚标签应叫「DSHL预装」')
  assert.match(main, /key: 'official', label: '官方推荐', tone: 'official'/, '官方推荐是第二枚标签')
  assert.match(main, /bridgePayloadReady \? '已关闭自动安装' : 'payload 不可用'/, '手机连接（远程连接）也是预装集合成员')
  assert.match(app, /plugin-badge-preinstall/, 'DSHL预装标签应渲染绿色胶囊')
  assert.match(app, /plugin-badge-official/, '官方推荐标签要渲染另一种胶囊')
  assert.match(css, /\.plugin-badge-preinstall \{\n  flex: none;/, '标签应是标题行右端的胶囊（不再跟在包名后面）')
  assert.match(css, /\.plugin-badge-preinstall \{[^}]*font-size: 15px;/, '标签字号应比标题（14.5px）大一号')
  assert.match(css, /\.plugin-badge-official \{[^}]*font-size: 15px;/, '官方推荐与预装标签同尺寸，只换色调')
  assert.match(css, /\.plugin-badge-preinstall\.muted/, '非正常预装的状态说明应有中性灰样式')
  // 卡片紧凑版契约：自适应列宽 + 说明最多两行 + 小一档的按钮 + 标签挂在标题行
  assert.match(css, /repeat\(auto-fill, minmax\(320px, 1fr\)\)/, '卡片网格应按最小 320px 自适应列宽')
  assert.match(css, /-webkit-line-clamp: 2/, '插件说明最多两行（长描述不撑高卡片）')
  assert.match(css, /\.plugin-action-btn \{ height: 30px;/, '操作按钮比全局 .btn 小一档')
  assert.match(app, /head\.appendChild\(wrap\)/, '标签组应挂在标题行右端')
  // 备注编辑已按用户要求整体移除，避免留下点不到的入口
  assert.doesNotMatch(app, /plugin-note-toggle/, '渲染层不应再有备注入口')
  assert.doesNotMatch(app, /pluginSetNote/, '渲染层不应再调用备注保存命令')
  assert.doesNotMatch(css, /plugin-note/, '样式表不应残留备注样式')
})

test('插件卡片由 state.plugins 数据驱动', () => {
  assert.match(main, /function buildPluginCatalog\(marketState, bridgeState, notes\)/, '主进程应构建插件注册表状态')
  assert.match(main, /plugins: buildPluginCatalog\(marketState, bridgeState, Config\.pluginNotes\)/, 'stateJson 应下发 plugins')
  assert.match(main, /case 'pluginsGetState'/, '应有插件状态刷新命令')
  assert.match(main, /case 'pluginAction'/, '应有通用插件动作命令')
  assert.match(app, /function renderPlugins\(plugins, force\)/, '控制台应有通用插件渲染器')
  assert.match(app, /cmd\('pluginAction', \{ id, action \}\)/, '卡片动作应走通用 pluginAction')
  // 带开关的卡片没有状态胶囊，忙态文案只能落在进度行上：泛泛的"正在处理…"说不清在做什么
  assert.match(app, /wait\.textContent = \(p\.status && p\.status\.label\) \|\| '正在处理…'/, '忙态进度行应显示具体动作文案')
})

test('插件卡片：状态/开关 + 一键安装契约', () => {
  assert.match(main, /async function installAllManagedPlugins\(\)/, '主进程应有一键安装逻辑')
  assert.match(main, /case 'pluginsInstallAll'/, '应有一键安装命令')
  assert.match(main, /pluginInstallAll: \{/, 'state 应下发一键安装进度')
  assert.match(main, /key: 'bridge-next', label: '手机连接'/, '一键安装应覆盖手机连接')
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
  assert.match(app, /function renderInstallAll\(info, list\)/, '控制台应渲染一键安装进度')
})

test('插件动作全程有反馈：点击即说明在做什么，结束必须给结果（成功/失败都要说）', () => {
  // 失败重渲染顺序：老代码先 renderPlugins 再往旧卡片写 ✕ —— 写进的是游离节点，用户什么也看不到
  const clickStart = app.indexOf("$('pluginCards').addEventListener('click'")
  const clickEnd = app.indexOf("$('pluginCards').addEventListener('change'", clickStart)
  assert.ok(clickStart > 0 && clickEnd > clickStart, '找不到插件动作点击处理器')
  const handler = app.slice(clickStart, clickEnd)
  assert.match(handler, /setPluginCardFeedback\(btn, `正在\$\{verb\}「\$\{name\}」…/, '点击后卡片要写明正在做什么')
  assert.match(handler, /约 10~60 秒/, '耗时要与说明页 plugin 档同口径（10~60 秒）')
  assert.match(handler, /showConsoleToast\(r\.restartPending/, '成功必须给 toast（重启挂起时说清怎么生效）')
  assert.match(handler, /showConsoleToast\(`✕ \$\{verb\}「\$\{name\}」失败/, '失败也要有 toast（卡片可能已被重渲染换掉）')
  assert.match(handler, /r\.restartPending\s*\n?\s*\? `已\$\{verb\}「\$\{name\}」；点顶部「立即重启生效」后生效`/, '挂起生效的措辞要指路')
  assert.match(handler, /服务已重启生效`\)/, '已生效的措辞要说明服务已重启')
  const iRefresh = handler.indexOf("cmd('pluginsGetState')")
  const iToast = handler.indexOf('showConsoleToast')
  assert.ok(iToast > 0 && iRefresh > iToast, '状态刷新必须放在 toast 之后：先让用户看到结果，再重渲染卡片')
  // 主进程侧：忙态从动作开始记到 finally（含重启），并推给控制台
  assert.match(main, /const pluginActionBusy = new Map\(\)/, '主进程应按插件记账动作忙态')
  assert.match(main, /pluginActionBusy\.set\(id, action\)\n\s+broadcastState\(\)/, '动作开始就要标记忙态并推送')
  assert.match(main, /finally \{\n\s+pluginActionBusy\.delete\(id\)/, '动作结束（含服务重启）必须释放忙态')
  assert.match(main, /pluginActionBusy\.get\(d\.id\)/, 'npm 插件卡片要合并动作忙态')
  // 忙态文案与 market/bridge 的旧口径同一套词
  for (const label of ['安装中…', '卸载中…', '重新安装中…', '更新中…']) {
    assert.ok(main.includes(`'${label}'`), '忙态文案缺 ' + label)
  }
})

test('版本查询失败：同包同原因只留一条日志，恢复后复发再记（注入桩执行真实流程）', async () => {
  const start = main.indexOf('async function resolveNpmVersion(name) {')
  assert.ok(start > 0, '找不到 resolveNpmVersion')
  const end = main.indexOf('\n}\n', start) + 3
  const fnSrc = main.slice(start, end)

  const lines = []
  let mode = 'age' // age = 报「非精确版本」；net = 报网络错；ok = 成功
  const ctx = {
    npmVersionCache: new Map(),
    NPM_VERSION_TTL_MS: 10 * 60 * 1000,
    npmVersionErrors: new Map(),
    log: (m) => lines.push(m),
    market: {
      verifyNpmPackage: async (name) => {
        if (mode === 'ok') return { name, version: '0.1.0-rc.9' }
        if (mode === 'age') throw new Error('npm 未提供精确的版本号')
        throw new Error('无法从 npm 官方源验证包（HTTP 429）')
      },
    },
  }
  const names = Object.keys(ctx)
  const resolve = new Function(...names, fnSrc + '\nreturn resolveNpmVersion')(...names.map((k) => ctx[k]))

  assert.equal(await resolve('dsh-mcp-lens'), '')
  assert.equal(await resolve('dsh-mcp-lens'), '', '同样的失败：第二次不该再刷一条')
  assert.equal(lines.length, 1, '同包同原因只留一条日志（实际 ' + lines.length + ' 条）')
  assert.match(lines[0], /dsh-mcp-lens：npm 未提供精确的版本号/)

  mode = 'net'
  assert.equal(await resolve('dsh-mcp-lens'), '')
  assert.equal(lines.length, 2, '原因变了要重新留证')

  mode = 'ok'
  assert.equal(await resolve('dsh-mcp-lens'), '0.1.0-rc.9', '缓存未命中时会重新查；查成功应返回版本号')
  assert.equal(lines.length, 2, '成功不写日志')
  assert.equal(ctx.npmVersionErrors.size, 0, '成功后清账：下次再失败要重新记一条')

  mode = 'age'
  ctx.npmVersionCache.clear()
  assert.equal(await resolve('dsh-mcp-lens'), '')
  assert.equal(lines.length, 3, '恢复后复发应重新留证')
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
  let releaseProfileOp = () => {}
  const ctx = {
    pluginInstallAllRunning: false,
    pluginInstallAllTarget: 0,
    pluginInstallAllDone: 0,
    pluginInstallAllCurrent: '',
    pluginInstallAllError: '',
    broadcastState() {},
    notify() {},
    log() {},
    // profile 写锁：拿到返回 release，拿不到返回 null（批量流程必须占用它，见 main.js 的说明）
    tryBeginProfileOp: () => releaseProfileOp,
    profileBusyError: () => ({ ok: false, error: '另一个插件操作正在进行，请等它结束后再试', busy: true }),
    stopServiceForPluginChange: async () => { stopped++; return { ok: true } },
    MANAGED_NPM_PLUGINS: [
      { id: 'a', name: '插件A', npm: 'pkg-a' },
      { id: 'b', name: '插件B', npm: 'pkg-b' },
    ],
    market: { getState: () => ({ installed: false }) },
    bridge: { getState: () => ({ installed: false }) },
    runNpmPluginAction: async (d, action, opts) => { deferCalls.push({ id: d.id, action, defer: !!(opts && opts.defer) }); return { ok: true, version: "1.0.0" } },
    installManagedMarket: async (opts) => { deferCalls.push({ id: "dshmarket", action: "install", defer: !!(opts && opts.defer) }); return { ok: true, version: "1.0.0" } },
    setRemoteConnectManaged: async (enabled, opts) => { deferCalls.push({ id: "bridge-next", action: "install", defer: !!(opts && opts.defer) }); return { ok: true } },
    applyPluginChange: async (verb) => { applied.push(verb); return true },
    deferPluginChange: () => {},
    clearPluginEnvFailure: () => {},
    notePluginEnvFailure: () => {},
    notePluginReleaseAgeRetry: () => {},
  }
  const names = Object.keys(ctx)
  const fn = new Function(...names, fnSrc + '\nreturn installAllManagedPlugins')
  const result = await fn(...names.map((k) => ctx[k]))()

  assert.equal(stopped, 1, '整个批量流程只应停一次服务')
  assert.equal(deferCalls.length, 4, '两个推荐插件 + 插件市场 + 手机连接都应参与')
  assert.ok(deferCalls.some((c) => c.id === 'bridge-next' && c.defer), '手机连接也要带 defer 一起装')
  assert.ok(deferCalls.every((c) => c.defer), '每个插件都必须带 defer（否则会装一个重启一次）')
  assert.deepEqual(applied, [], '批量流程不得调用 applyPluginChange（那是重启入口）')
  assert.equal(result.installed, 4)
  assert.equal(result.pendingRestart, true, '结果应标记「待重启生效」')

  // 锁被占用：一个都不许装（并发改写同一份依赖树正是 profile 损坏的来源）
  releaseProfileOp = null
  deferCalls.length = 0
  const blocked = await fn(...names.map((k) => ctx[k]))()
  assert.equal(blocked.ok, false, '拿不到 profile 写锁时必须拒绝')
  assert.equal(deferCalls.length, 0, '拿不到锁时不得改任何插件的 profile')
})

test('批量安装：停服务失败时中止，绝不在别人占着依赖树时改写它', async () => {
  const start = main.indexOf('async function installAllManagedPlugins() {')
  const end = main.indexOf('\n}', main.indexOf('return { ok: true, installed, skipped, pendingRestart', start)) + 2
  const fnSrc = main.slice(start, end)

  const deferCalls = []
  const ctx = {
    pluginInstallAllRunning: false,
    pluginInstallAllTarget: 0,
    pluginInstallAllDone: 0,
    pluginInstallAllCurrent: '',
    pluginInstallAllError: '',
    broadcastState() {},
    notify() {},
    log() {},
    tryBeginProfileOp: () => (() => {}),
    profileBusyError: () => ({ ok: false, error: 'busy' }),
    stopServiceForPluginChange: async () => ({ ok: false, error: '服务正在停止中，请稍候重试', busy: true }),
    MANAGED_NPM_PLUGINS: [{ id: 'a', name: '插件A', npm: 'pkg-a' }],
    market: { getState: () => ({ installed: false }) },
    bridge: { getState: () => ({ installed: false }) },
    runNpmPluginAction: async () => { deferCalls.push('a'); return { ok: true } },
    installManagedMarket: async () => { deferCalls.push('m'); return { ok: true } },
    setRemoteConnectManaged: async () => { deferCalls.push('b'); return { ok: true } },
    applyPluginChange: async () => true,
    deferPluginChange: () => {},
    clearPluginEnvFailure: () => {},
    notePluginEnvFailure: () => {},
    notePluginReleaseAgeRetry: () => {},
  }
  const names = Object.keys(ctx)
  const fn = new Function(...names, fnSrc + '\nreturn installAllManagedPlugins')
  const result = await fn(...names.map((k) => ctx[k]))()

  assert.equal(result.ok, false)
  assert.match(result.error, /正在停止/u)
  assert.deepEqual(deferCalls, [], '停不下来就一个都别装')
})

test('推荐插件注册表：八个 npm 插件 + 通用动作/更新检查', () => {
  assert.match(main, /const MANAGED_NPM_PLUGINS = \[/, '主进程应有推荐插件注册表')
  for (const npm of [
    'dsh-better-sidebar',
    '@michengai/dsh-codex-ui',
    '@kenz1117/dsh-ui-usage-billing',
    'dsh-chat-import',
    '@michengai/dsh-skills-manager',
    'dsh-sidebar-qa',
    'dsh-rewind-plugin',
    'dsh-context',
  ]) {
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

test('推荐插件注册表：真注册表 → 真卡片目录 + 真默认代装筛选（不是抄一份实现）', async () => {
  // 1. 取真实注册表字面量（纯数据，无外部引用）
  const regStart = main.indexOf('const MANAGED_NPM_PLUGINS = [')
  const regEnd = main.indexOf('\n]\n', regStart) + 3
  assert.ok(regStart > 0 && regEnd > regStart, '找不到 MANAGED_NPM_PLUGINS 字面量')
  const registry = new Function(main.slice(regStart, regEnd) + '; return MANAGED_NPM_PLUGINS')()

  // 插件市场的仓库声明在注册表外（它有自己的安装/卸载流程）：取真值，避免测试里再抄一份 URL
  const marketRepoMatch = /const PLUGIN_MARKET_REPO = '([^']+)'/u.exec(main)
  assert.ok(marketRepoMatch, '找不到 PLUGIN_MARKET_REPO')
  const marketRepo = marketRepoMatch[1]

  // 2. 注册表自身的形状契约：id / order 唯一，卡片字段齐全
  assert.equal(registry.length, 8, '推荐插件（npm 分发）应为 8 个（会话归档 / MCP Lens 已摘出）')
  assert.equal(new Set(registry.map((d) => d.id)).size, registry.length, '插件 id 必须唯一')
  assert.equal(new Set(registry.map((d) => d.order)).size, registry.length, '卡片顺序 order 必须唯一')
  for (const d of registry) {
    for (const field of ['id', 'order', 'npm', 'name', 'subtitle', 'description', 'icon', 'category']) {
      assert.ok(String(d[field] === undefined ? '' : d[field]).trim() !== '', `${d.id} 缺少字段 ${field}`)
    }
    assert.match(d.npm, /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u, `${d.id} 的 npm 包名不合法：${d.npm}`)
    // 标题要跳到 GitHub 发布页：每条推荐插件都得声明仓库，且存的就是归一化形式
    // （不合法/缺失都会被解析成空串，标题就不再可点 —— 这里把它钉成契约，别让卡片悄悄少一个入口）
    assert.ok(d.repo, `${d.id} 缺少 repo（标题会不可点）`)
    assert.equal(pluginRepo.normalizeRepo(d.repo), d.repo, `${d.id} 的 repo 应是归一化的 GitHub 仓库地址：${d.repo}`)
  }

  // 3. 真 buildPluginCatalog + 真 pluginCardActions：每个注册项都必须渲染成一张卡片
  const sliceFn = (signature, TailMarker) => {
    const start = main.indexOf(signature)
    assert.ok(start > 0, '找不到 ' + signature)
    const end = main.indexOf(TailMarker, start) + TailMarker.length
    return main.slice(start, end)
  }
  const src = [
    sliceFn('function cleanInstalledVersion(spec) {', '\n}\n'),
    sliceFn('function pluginBusyLabel(action) {', '\n}\n'),
    sliceFn('function pluginCardActions(opts) {', '\n}\n'),
    sliceFn('function pluginRepoOf(id) {', '\n}\n'),
    sliceFn('function pluginTagsOf(opts) {', '\n}\n'),
    sliceFn('function buildPluginCatalog(marketState, bridgeState, notes) {', '\n}\n'),
  ].join('\n')
  const installed = new Set(registry.map((d) => d.npm))
  const ctx = {
    MANAGED_NPM_PLUGINS: registry,
    PLUGIN_MARKET_REPO: marketRepo,
    pluginRepo,
    Config: { pluginMarketDeclined: false, pluginNotes: {}, remoteConnect: { enabled: true, declined: false } },
    pluginActionBusy: new Map(),
    market: {
      PLUGIN_NAME: 'dshmarket',
      getState: (npm) => ({
        installed: installed.has(npm),
        installedPackageVersion: '1.0.0',
        version: '^1.0.0',
        busy: '',
        error: '',
        lastChange: '',
      }),
    },
    pluginSwitch: { isDisabled: () => false, canToggle: () => true },
    npmVersionCache: new Map(),
    semver: { valid: () => true, lt: () => false },
    pluginAutoDeclined: () => false,
    // 「插件没生效」的证据注入点：默认没有（见下面第二个用例）
    bridge: require('../bridge'),
    pluginActivation: require('../plugin-activation'),
    activationIssueOf: (name) => (typeof activationStub === 'function' ? activationStub(name) : undefined),
  }
  let activationStub = null
  const names = Object.keys(ctx)
  const build = new Function(...names, src + '\nreturn buildPluginCatalog')(...names.map((k) => ctx[k]))
  const marketArg = { installed: true, busy: '', error: '', version: '1.46.1', lastChange: '' }
  const bridgeArg = { installed: true, busy: '', error: '', payloadReady: true, installedPackageVersion: '0.1.0', payloadVersion: '0.1.0', lastChange: '' }
  const catalog = build(marketArg, bridgeArg, {})

  assert.equal(catalog.length, registry.length + 2, '插件页应渲染「插件市场 + 手机连接 + 全部推荐插件」')
  for (const d of registry) {
    const card = catalog.find((c) => c.id === d.id)
    assert.ok(card, '注册表里的 ' + d.id + ' 没有渲染成卡片')
    assert.equal(card.name, d.name, d.id + ' 卡片标题应与注册表一致')
    assert.equal(card.repo, d.repo, d.id + ' 卡片要带上注册表声明的仓库（标题据此可点）')
    assert.ok(card.status && card.status.label, d.id + ' 卡片缺少状态文案')
    assert.ok(card.actions.length >= 1, d.id + ' 卡片缺少操作按钮')
    assert.ok(card.icon && card.category && card.description, d.id + ' 卡片缺少图标/分类/说明')
  }
  assert.equal(catalog.find((c) => c.id === 'dshmarket').repo, marketRepo, '插件市场卡片要带上它的仓库')
  assert.equal(catalog.find((c) => c.id === 'bridge-next').repo, '', '没有仓库的卡片给空串：标题保持不可点')
  // 排序契约：预装（插件市场 / 手机连接 / 注册表声明 autoInstall 的那批）排前面，手动安装的排后面，
  // 各组内按注册表 order —— 用户一眼看到的就是「默认会给我装什么」。
  assert.deepEqual(catalog.map((c) => c.id), [
    'dshmarket',
    'bridge-next',
    'usage-billing',
    'skills-manager',
    'rewind',
    'better-sidebar',
    'codex-ui',
    'chat-import',
    'sidebar-qa',
    'context',
  ], '卡片顺序应为「预装在前、手动在后」，各组内按 order')
  assert.deepEqual(catalog.filter((c) => !c.preset).map((c) => c.id), [
    'better-sidebar', 'codex-ui', 'chat-import', 'sidebar-qa', 'context',
  ], 'preset=false 的应恰好是手动安装的那批')
  assert.equal(catalog.findIndex((c) => !c.preset), catalog.filter((c) => c.preset).length,
    '预装卡片必须全部连续排在前面（不与手动项交错）')
  for (const d of registry) {
    const card = catalog.find((c) => c.id === d.id)
    assert.equal(card.preset, !!d.autoInstall, d.id + ' 的 preset 应等于注册表声明的 autoInstall（不看运行时状态）')
  }
  assert.equal(catalog.find((c) => c.id === 'dshmarket').preset, true, '插件市场默认开启')
  assert.equal(catalog.find((c) => c.id === 'bridge-next').preset, true, '手机连接随启动器分发')

  // 3b. 动作忙态：必须让卡片显示"处理中"并收回按钮 —— 这段忙态要一直盖到服务重启结束，
  //     否则卸载/安装的最后 ~10 秒（pnpm 已结束、服务还没回来）卡片看着像什么都没发生。
  ctx.pluginActionBusy.set('better-sidebar', 'uninstall')
  const busyCatalog = build(
    { installed: true, busy: '', error: '', version: '1.46.1', lastChange: '' },
    { installed: true, busy: '', error: '', payloadReady: true, installedPackageVersion: '0.1.0', payloadVersion: '0.1.0', lastChange: '' },
    {},
  )
  const busyCard = busyCatalog.find((c) => c.id === 'better-sidebar')
  assert.equal(busyCard.busy, 'uninstall', '忙态应写进卡片状态（渲染层据此禁用）')
  assert.equal(busyCard.status.label, '卸载中…', '忙态文案应说清在做哪个动作')
  assert.equal(busyCard.status.tone, 'busy', '忙态胶囊应是 busy 色调')
  assert.deepEqual(busyCard.actions, [], '忙态下不许再给按钮（此刻再点会撞 profile 锁）')

  // 3c. 「未生效」必须盖过"已开启/已安装"这类清单态：DSH 对 bundle 被跳过 / 行没激活
  //     只写 stderr、服务照常就绪，于是插件市场一直说"重启后生效"、重启永远不改变它。
  ctx.pluginActionBusy.clear()
  const target = registry[0]
  activationStub = (name) => (name === target.npm
    ? { kind: 'inactive', packageName: name, entryId: 'some-entry', detail: 'failed to import', services: [] }
    : undefined)
  const issueCatalog = build(marketArg, bridgeArg, {})
  const issueCard = issueCatalog.find((c) => c.id === target.id)
  assert.equal(issueCard.status.label, '未生效', '清单态说"已安装"、运行态没起来时必须说未生效')
  assert.equal(issueCard.status.tone, 'warn')
  assert.equal(issueCard.activation, '启动时未激活：failed to import', '卡片要带上原因文案')
  assert.match(issueCard.status.title, /重启不会改变/, 'tooltip 要说清为什么重启没用')
  assert.equal(issueCatalog.find((c) => c.id === 'bridge-next').activation, '', '没有证据的插件不该被判成未生效')
  activationStub = null
  ctx.pluginActionBusy.delete('better-sidebar')
  assert.deepEqual(
    build({ installed: true, busy: '', error: '', version: '1.46.1', lastChange: '' }, { installed: true, busy: '', error: '', payloadReady: true, installedPackageVersion: '0.1.0', payloadVersion: '0.1.0', lastChange: '' }, {})
      .find((c) => c.id === 'better-sidebar').actions.map((a) => a.action),
    ['reinstall', 'uninstall'],
    '忙态释放后按钮要回来',
  )

  // 3d. 排序契约：**已安装的一律排前面**（与右上角「N 个已安装」同一个口径），
  //     未安装的沉底、不许插在已安装的中间；同一组内仍是「预装 → 手动」+ 注册表 order。
  assert.match(main, /\.sort\(\(a, z\) => \(a\.installed === z\.installed/, '排序主键必须是 installed')
  assert.match(main, /a\.preset === z\.preset \? a\.order - z\.order : \(a\.preset \? -1 : 1\)/, '次键仍是「预装 → 手动」+ order')
  assert.match(app, /const installedCount = list\.filter\(\(p\) => p\.installed\)\.length/,
    '右上角计数与置顶分组必须同一个口径，否则「N 个已安装」会和排在上面的卡片数对不上')

  const notInstalled = ['@michengai/dsh-codex-ui', 'dsh-chat-import', 'dsh-sidebar-qa']
  for (const npm of notInstalled) installed.delete(npm)
  const mixed = build(marketArg, bridgeArg, {})
  assert.deepEqual(mixed.map((c) => c.id), [
    'dshmarket',
    'bridge-next',
    'usage-billing',
    'skills-manager',
    'rewind',
    'better-sidebar',
    'context', // 手动安装但已装上 → 排在未安装的三张之前（这就是「已安装优先」要的效果）
    'codex-ui',
    'chat-import',
    'sidebar-qa',
  ], '已安装的在前；已安装组内「预装 → 手动」，未安装组内同样')
  const installedCount = mixed.filter((c) => c.installed).length
  assert.equal(installedCount, 7, '这组夹具里应有 7 个已安装')
  assert.equal(mixed.findIndex((c) => !c.installed), installedCount,
    '已安装卡片必须全部连续排在未安装之前（不与未安装项交错）')

  // 3e. 归属标签：一枚插件可以挂多枚（key 是筛选依据，label 只给人看）
  const tagKeys = (id) => catalog.find((c) => c.id === id).tags.map((t) => t.key)
  assert.deepEqual(tagKeys('dshmarket'), ['preinstall', 'official'], '插件市场：DSHL预装 + 官方推荐 两枚都有')
  assert.deepEqual(tagKeys('bridge-next'), ['preinstall'], '手机连接：只有 DSHL预装')
  assert.deepEqual(tagKeys('usage-billing'), ['preinstall'])
  assert.deepEqual(tagKeys('better-sidebar'), ['official'], '增强侧边栏是手动安装项，只挂官方推荐')
  assert.deepEqual(tagKeys('context'), ['official'], '上下文洞察同上')
  for (const id of ['codex-ui', 'chat-import', 'sidebar-qa']) {
    assert.deepEqual(tagKeys(id), [], id + '：两枚标签都不带（落进「其他」）')
  }
  for (const card of catalog) {
    for (const t of card.tags) assert.ok(t.key && t.label && t.tone, card.id + ' 的标签缺少 key/label/tone')
  }
  // 关掉自动安装之后：label 换成中性状态说明，但 key 还在 —— 不会被「DSHL预装」筛没
  const tagsOf = new Function(...names, src + '\nreturn pluginTagsOf')(...names.map((k) => ctx[k]))
  assert.deepEqual(tagsOf({ preset: true, autoInstall: true }), [{ key: 'preinstall', label: 'DSHL预装', tone: 'preinstall' }])
  assert.deepEqual(tagsOf({ preset: true, autoInstall: false }), [{ key: 'preinstall', label: '已关闭自动安装', tone: 'muted' }])
  assert.deepEqual(tagsOf({ preset: true, autoInstall: false, offLabel: 'payload 不可用' })[0].label, 'payload 不可用',
    '关掉自动安装时用调用方给的状态文案')
  assert.deepEqual(tagsOf({ preset: true, official: true, autoInstall: true }).map((t) => t.label),
    ['DSHL预装', '官方推荐'], '两枚标签的顺序：先预装、后官方推荐')
  assert.deepEqual(tagsOf({ preset: false, official: false }), [], '既不是预装也没被官方推荐 → 没有标签')

  // 4. 真 pendingAutoInstallPlugins：默认代装集合 = 注册表里 autoInstall 的那批，且只挑缺失的
  const autoIds = registry.filter((d) => d.autoInstall).map((d) => d.id)
  assert.deepEqual(autoIds, [
    'usage-billing',
    'skills-manager',
    'rewind',
  ], '默认代装集合应保持稳定（会话归档 / MCP Lens 摘出注册表后只剩这 3 个）')
  for (const d of registry.filter((x) => x.autoInstall)) {
    const card = catalog.find((c) => c.id === d.id)
    assert.deepEqual(card.tags.map((t) => t.label), ['DSHL预装'], d.id + ' 卡片应标「DSHL预装」')
    assert.match(card.status.label, /已启用|已安装/, d.id + ' 已装时状态应为已启用/已安装')
  }

  const pendSrc = sliceFn('function pendingAutoInstallPlugins() {', '\n}\n')
  // 缺失集合里故意混入手动安装项（划线提问 / Codex 风格界面）：它们不得进入代装队列
  const missing = new Set(['dsh-sidebar-qa', '@michengai/dsh-codex-ui', 'dsh-rewind-plugin'])
  const pendCtx = {
    MANAGED_NPM_PLUGINS: registry,
    pluginAutoDeclined: () => false,
    market: { getState: (npm) => ({ installed: !missing.has(npm) }) },
  }
  const pendNames = Object.keys(pendCtx)
  const pending = new Function(...pendNames, pendSrc + '\nreturn pendingAutoInstallPlugins')(...pendNames.map((k) => pendCtx[k]))
  assert.deepEqual(pending().map((d) => d.npm), ['dsh-rewind-plugin'], '只补 autoInstall 里缺失的（手动项缺了也不动），顺序按注册表 order')

  const declinedCtx = { ...pendCtx, pluginAutoDeclined: (id) => id === 'rewind' }
  const declinedPending = new Function(...pendNames, pendSrc + '\nreturn pendingAutoInstallPlugins')(...pendNames.map((k) => declinedCtx[k]))
  assert.deepEqual(declinedPending().map((d) => d.id), [], '手动卸载过的插件不应再自动补装')
})

test('点插件标题 → 系统默认浏览器打开它的 GitHub 发布页（渲染层只发 id，地址在主进程拼）', () => {
  assert.match(main, /function pluginRepoOf\(id\) \{/, '主进程应有唯一的仓库解析入口')
  assert.match(main, /case 'openPluginRepo': \{/, '应有打开发布页的命令')
  assert.match(main, /const url = pluginRepo\.releasesUrl\(pluginRepoOf\(value && value\.id\)\)/, '命令必须按插件 id 解析地址')
  assert.match(main, /shell\.openExternal\(url\)/, '解析出的地址走系统默认浏览器')
  assert.match(main, /if \(!url\) return JSON\.stringify\(\{ ok: false, error: '该插件没有声明 GitHub 仓库' \}\)/, '没有仓库时明确拒绝，不静默打开别的地址')
  assert.ok(!require('../trust').LOADING_PAGE_COMMANDS.has('openPluginRepo'),
    '这条命令不能进说明页白名单：DSH 页面（或它跳转到的站点）拿不到这份信任')

  assert.match(app, /const repo = String\(p\.repo \|\| ''\)/, '渲染层按卡片字段决定标题是否可点')
  assert.match(app, /document\.createElement\(repo \? 'button' : 'span'\)/, '有仓库才是按钮，没有就是纯文本')
  assert.match(app, /name\.dataset\.pluginOpen = p\.id/, '可点标题只挂插件 id')
  assert.match(app, /e\.target\.closest\('button\[data-plugin-open\]'\)/, '点击走卡片容器的既有委托')
  assert.match(app, /cmd\('openPluginRepo', \{ id: open\.dataset\.pluginOpen \}\)/, '点击只把 id 交给主进程')
  assert.doesNotMatch(app, /openPluginRepo', \{[^}]*url/u, '渲染层不得把 URL 交给主进程（那等于开放任意跳转）')
  assert.match(app, /name\.title = '在浏览器打开 GitHub 发布页：'/, '可点标题要说明点了去哪儿')
  assert.match(css, /button\.plugin-name \{[\s\S]{0,120}?border: 0;/, '按钮要清掉 UA 外观，否则标题会变成带边框的按钮')
  assert.match(css, /button\.plugin-name:hover/, '可点标题要有 hover 反馈')
})

test('筛选按钮：六档单选（全部 / DSHL预装 / Deepseek 官方推荐 / 其他 / 已安装 / 未安装），默认全部', () => {
  for (const f of ['all', 'preinstall', 'official', 'other', 'installed', 'available']) {
    assert.match(html, new RegExp('data-plugin-filter="' + f + '"'), '筛选按钮缺少 ' + f)
  }
  assert.match(html, /class="chip checked" data-plugin-filter="all">全部</, '默认（未点击前）选中的是「全部」')
  assert.match(html, /data-plugin-filter="preinstall">DSHL预装</, '预装筛选按钮文案应为「DSHL预装」')
  assert.match(html, /data-plugin-filter="official">Deepseek 官方推荐</, '官方推荐筛选按钮文案')
  assert.match(html, /data-plugin-filter="other">其他</, '「其他」按钮文案')
  assert.ok(html.indexOf('id="pluginFilters"') < html.indexOf('id="pluginSearch"'), '筛选按钮组要排在搜索框之前')
  // 工具栏两行布局：第一行「筛选（左）+ 操作按钮（贴右）」，搜索框独占第二行
  assert.ok(html.indexOf('class="plugin-toolbar-actions"') < html.indexOf('id="pluginSearch"'),
    '操作按钮要排在搜索框之前，换行后搜索框才落在下一行')
  assert.match(css, /\.plugin-toolbar \.plugin-search \{\n  [^}]*flex: 1 1 100%;/,
    '搜索框要独占一行（flex-basis 100%），否则宽窗口下又会挤回第一行')
  assert.match(css, /\.plugin-toolbar-actions \{[\s\S]{0,140}?margin-left: auto;/,
    '操作按钮在同一行贴右对齐')
  assert.match(css, /\.plugin-filter-sep \{/, '标签维与安装状态维之间要有分隔，免得读成一串同义选项')

  // 跑真 pluginMatches：六档筛选语义逐条核对
  const start = app.indexOf('function pluginMatches(p, filter, query) {')
  assert.ok(start > 0, '找不到 pluginMatches')
  const matches = new Function(app.slice(start, app.indexOf('\n}\n', start) + 3) + '\nreturn pluginMatches')()
  const P = (over) => Object.assign({ name: 'pkg', subtitle: '', description: '', id: 'pkg', category: '' }, over)
  const both = P({ installed: true, tags: [{ key: 'preinstall' }, { key: 'official' }] })
  const officialOnly = P({ installed: false, tags: [{ key: 'official' }] })
  const presetOff = P({ installed: false, tags: [{ key: 'preinstall', tone: 'muted' }] })
  const bare = P({ installed: false, tags: [] })
  assert.equal(matches(both, 'all', ''), true, '「全部」不过滤')
  assert.equal(matches(both, 'preinstall', ''), true)
  assert.equal(matches(both, 'official', ''), true, '一枚插件能同时命中两档标签筛选')
  assert.equal(matches(both, 'other', ''), false, '带标签的不进「其他」')
  assert.equal(matches(officialOnly, 'preinstall', ''), false, '官方推荐 ≠ DSHL预装')
  assert.equal(matches(presetOff, 'preinstall', ''), true, '关掉自动安装的仍算 DSHL 预装成员')
  assert.equal(matches(bare, 'other', ''), true, '「其他」= 两枚标签都不带')
  assert.equal(matches(officialOnly, 'installed', ''), false, '安装状态档照旧')
  assert.equal(matches(officialOnly, 'available', ''), true)
  assert.equal(matches(officialOnly, 'official', 'zzz'), false, '筛选与搜索是叠加的')
  assert.equal(matches(officialOnly, 'official', 'pkg'), true, '搜索命中就显示')
  // query 的小写化在调用方做（pluginMatches 收的就是已小写的串）——把这条契约也钉住
  assert.match(app, /\.value \? \$?\('?pluginSearch'?\)?\.value : ''\)\.trim\(\)\.toLowerCase\(\)|const query = \([\s\S]{0,80}?\.toLowerCase\(\);/,
    '搜索词应在调用方统一小写后再交给 pluginMatches')
})

test('一键更新：目标只取「可更新」的卡片（与卡片同一份判定），不可更新的不碰', () => {
  const start = main.indexOf('function outdatedManagedPluginTargets() {')
  assert.ok(start > 0, '找不到 outdatedManagedPluginTargets')
  const src = main.slice(start, main.indexOf('\n}\n', start) + 3)
  const calls = []
  const ctx = {
    MANAGED_NPM_PLUGINS: [
      { id: 'rewind', name: '对话回退', npm: 'dsh-rewind-plugin' },
      { id: 'context', name: '上下文洞察', npm: 'dsh-context' },
      { id: 'chat-import', name: '会话导入', npm: 'dsh-chat-import' },
    ],
    // 真卡片目录的形状：市场那一张永远是 outdated:false，它有自己的「重新安装」
    buildPluginCatalog: () => [
      { id: 'dshmarket', outdated: false },
      { id: 'bridge-next', outdated: true },
      { id: 'rewind', outdated: true },
      { id: 'context', outdated: true },
      { id: 'chat-import', outdated: false },
    ],
    market: { getState: () => ({}), PROFILE_NAME: 'web' },
    bridge: { getState: () => ({}) },
    Config: { pluginNotes: {} },
    runNpmPluginAction: (d, action, opts) => { calls.push({ id: d.id, action, defer: !!(opts && opts.defer) }); return Promise.resolve({ ok: true }) },
    reinstallRemoteConnectManaged: (opts) => { calls.push({ id: 'bridge-next', action: 'update', defer: !!(opts && opts.defer) }); return Promise.resolve({ ok: true }) },
  }
  const names = Object.keys(ctx)
  const fn = new Function(...names, src + '\nreturn outdatedManagedPluginTargets')(...names.map((k) => ctx[k]))
  const targets = fn()
  assert.deepEqual(targets.map((t) => t.key), ['bridge-next', 'rewind', 'context'], '只取可更新的，按卡片顺序')
  assert.deepEqual(targets.map((t) => t.label), ['手机连接', '对话回退', '上下文洞察'], '目标要带人类可读的名字（进度要显示）')
  return Promise.all(targets.map((t) => t.run())).then(() => {
    assert.deepEqual(calls.map((c) => c.id), ['bridge-next', 'rewind', 'context'], '每个目标都真的被执行')
    assert.ok(calls.every((c) => c.defer), '更新必须带 defer：否则会更新一个重启一次')
    assert.deepEqual(calls.filter((c) => c.id !== 'bridge-next').map((c) => c.action), ['update', 'update'], 'npm 插件走 update 动作')
  })
})

test('一键更新：只停一次服务、全程 defer、全部更新完只重启一次（注入桩执行真实流程）', async () => {
  const start = main.indexOf('async function updateAllManagedPlugins() {')
  assert.ok(start > 0, '找不到 updateAllManagedPlugins')
  const end = main.indexOf('\n}\n', main.indexOf('return { ok: restarted, updated, restarted', start)) + 3
  const src = main.slice(start, end)

  let targets = []
  let releaseProfileOp = () => {}
  let stopped = 0
  let restarts = 0
  const notifies = []
  const ctx = {
    pluginInstallAllRunning: false,
    pluginBatchKind: '',
    pluginInstallAllTarget: 0,
    pluginInstallAllDone: 0,
    pluginInstallAllCurrent: '',
    pluginInstallAllError: '',
    broadcastState() {},
    log() {},
    notify(_title, msg) { notifies.push(msg) },
    tryBeginProfileOp: () => releaseProfileOp,
    profileBusyError: () => ({ ok: false, error: '另一个插件操作正在进行', busy: true }),
    stopServiceForPluginChange: async () => { stopped++; return { ok: true } },
    checkManagedPluginUpdates: async () => {},
    outdatedManagedPluginTargets: () => targets,
    market: { classifyEnvFailure: () => null },
    clearPluginEnvFailure() {},
    notePluginEnvFailure() {},
    notePluginReleaseAgeRetry() {},
    applyPendingPluginChanges: async () => { restarts++; return { ok: true } },
  }
  const names = Object.keys(ctx)
  const fn = new Function(...names, src + '\nreturn updateAllManagedPlugins')(...names.map((k) => ctx[k]))

  // ① 两个可更新：停一次、更新两个、重启一次
  const ran = []
  targets = [
    { key: 'rewind', label: '对话回退', run: async () => { ran.push('rewind'); return { ok: true } } },
    { key: 'context', label: '上下文洞察', run: async () => { ran.push('context'); return { ok: true } } },
  ]
  const r = await fn()
  assert.deepEqual(ran, ['rewind', 'context'], '两个可更新的都要更新到')
  assert.equal(stopped, 1, '整个批量流程只应停一次服务')
  assert.equal(restarts, 1, '全部更新完只重启一次 —— 这是这个按钮的核心语义')
  assert.equal(r.ok, true)
  assert.equal(r.updated, 2)
  assert.equal(r.restarted, true)
  assert.equal(ctx.pluginInstallAllRunning, false, '跑完必须释放批量锁')
  assert.equal(ctx.pluginBatchKind, '', '跑完必须清掉批次标记')
  assert.match(notifies.join('|'), /已更新 2 个插件/, '结果要说一声')

  // ② 没有可更新的：不停服、不重启（点了没反应是最难解释的失败，所以要有明确回执）
  targets = []
  stopped = 0; restarts = 0; notifies.length = 0
  const idle = await fn()
  assert.equal(idle.ok, true)
  assert.equal(idle.updated, 0)
  assert.equal(idle.message, '所有插件都已是最新')
  assert.equal(stopped, 0, '没有可更新的就不该停服务')
  assert.equal(restarts, 0, '没有可更新的就不该重启')

  // ③ 一个成功一个失败：成功的也要生效 → 仍然重启一次，并把失败项报出来
  targets = [
    { key: 'rewind', label: '对话回退', run: async () => ({ ok: true }) },
    { key: 'context', label: '上下文洞察', run: async () => { throw new Error('npm 源限流') } },
  ]
  stopped = 0; restarts = 0
  const partial = await fn()
  assert.equal(restarts, 1, '有成功项就必须重启（否则成功的那次更新也不生效）')
  assert.equal(partial.ok, false)
  assert.equal(partial.updated, 1)
  assert.equal(partial.failed, 1)
  assert.match(partial.error, /上下文洞察：npm 源限流/, '失败原因要带插件名')

  // ④ 拿不到 profile 写锁：一个都不许动
  releaseProfileOp = null
  targets = [{ key: 'rewind', label: '对话回退', run: async () => { ran.push('never'); return { ok: true } } }]
  stopped = 0; restarts = 0
  const blocked = await fn()
  assert.equal(blocked.ok, false)
  assert.equal(stopped, 0, '拿不到锁不得停服务')
  assert.equal(restarts, 0, '拿不到锁不得重启')
  assert.ok(!ran.includes('never'), '拿不到锁时不得改任何插件的 profile')

  // ⑤ 接线：按钮 → 命令 → 流程，且确认框要说清「全部更新完自动重启一次」
  assert.match(main, /case 'pluginsUpdateAll': \{/, '应有 pluginsUpdateAll 命令')
  assert.match(main, /void updateAllManagedPlugins\(\)/, '命令要真的启动更新流程')
  assert.match(app, /\$\('btnPluginsUpdate'\)\.addEventListener\('click'/, '按钮要接点击')
  assert.match(app, /cmd\('pluginsUpdateAll'\)/, '点击要发 pluginsUpdateAll')
  assert.match(app, /全部更新完自动重启一次 DSH 生效/, '确认框要写明最后会重启一次')
  assert.match(app, /kind === 'update'/, '进度要按批次类型显示在正确的按钮上')
  assert.match(app, /desc\.title = p\.description/, '说明被截断时要有悬停全文')
})

test('旧设置页/恢复页插件入口已迁出，避免双份维护', () => {
  assert.doesNotMatch(html, /id="pluginMarketState"/, '设置页不应再保留插件市场行')
  assert.doesNotMatch(html, /id="btnRemoteConnect"/, '设置页不应再保留远程连接行')
  assert.doesNotMatch(html, /id="btnRecoveryMarket"/, '恢复页不应再保留插件修复行')
})
test('默认代装：用量与计费 / 技能管理 / 对话回退随启动器自动装，界面类与上下文洞察保持手动；会话归档与 MCP Lens 已摘出注册表', () => {
  assert.match(main, /pluginAutoInstallTriedVersion: '', pluginRetiredCleanupVersion: '', pluginAutoDeclined: \{\}/, '配置应有自动安装与退役清理记账字段')
  assert.match(main, /function pluginAutoDeclined\(id\)/, '应有「用户卸载过」记忆查询')
  assert.match(main, /function notePluginAutoDeclined\(id, declined\)/, '应有「用户卸载过」记账写入')
  assert.match(main, /async function maybeAutoInstallRecommendedPlugins\(\)/, '应有推荐插件默认代装流程')
  assert.match(main, /function pendingAutoInstallPlugins\(\)/, '应有「缺哪些就装哪些」的筛选')

  assert.doesNotMatch(main, /npm: 'dsh-better-sidebar',\n    name: '增强侧边栏',\n    autoInstall: true,/, '增强侧边栏改为手动安装')
  assert.match(main, /npm: '@kenz1117\/dsh-ui-usage-billing',\n    name: '用量与计费',\n    autoInstall: true,/, '用量与计费应默认代装')
  assert.match(main, /npm: '@michengai\/dsh-skills-manager',\n    name: '技能管理',\n    autoInstall: true,/, '技能管理应默认代装')
  // 会话归档 / MCP Lens：从注册表摘掉（页面不再有卡片），残留实例交给 RETIRED_NPM_PLUGINS 自动卸载
  const regOnly = main.slice(main.indexOf('const MANAGED_NPM_PLUGINS = ['), main.indexOf('\n]\n', main.indexOf('const MANAGED_NPM_PLUGINS = [')) + 3)
  assert.doesNotMatch(regOnly, /dsh-archive-manager/, '会话归档不应再留在推荐插件注册表里')
  assert.doesNotMatch(regOnly, /dsh-mcp-lens/, 'MCP Lens 不应再留在推荐插件注册表里')
  assert.doesNotMatch(main, /npm: 'dsh-sidebar-qa',\n    name: '划线提问',\n    autoInstall: true,/, '划线提问改为手动安装（依赖增强侧边栏）')
  assert.match(main, /npm: 'dsh-rewind-plugin',\n    name: '对话回退',\n    autoInstall: true,/, '对话回退应默认代装')
  assert.doesNotMatch(main, /npm: 'dsh-mcp-lens',\n    name: 'MCP Lens',\n    autoInstall: true,/, 'MCP Lens 改为手动安装（上游 npm 只有预发布版，稳定版校验会拒绝）')
  assert.doesNotMatch(main, /npm: 'dsh-chat-import',\n    name: '会话导入',\n    autoInstall: true,/, '会话导入保持手动安装')
  assert.doesNotMatch(main, /npm: '@michengai\/dsh-codex-ui',\n    name: 'Codex 风格界面',\n    autoInstall: true,/, 'Codex 风格界面默认不安装（只进插件页）')
  assert.doesNotMatch(main, /npm: 'dsh-context',\n    name: '上下文洞察',\n    autoInstall: true,/, '上下文洞察保持手动安装')

  const triggers = main.match(/void maybeAutoInstallRecommendedPlugins\(\)/g) || []
  assert.ok(triggers.length >= 3, '应在启动 / 环境装好 / 服务就绪等触发点补装（实际 ' + triggers.length + ' 处）')
  assert.match(main, /if \(envReady\(\) && server\.running\(\)\) void maybeAutoInstallRecommendedPlugins\(\)/, 'onTick 服务就绪时应补装')

  assert.match(main, /notePluginAutoDeclined\(descriptor\.id, false\)/, '手动装回应清除「不再自动安装」')
  assert.match(main, /notePluginAutoDeclined\(descriptor\.id, true\)/, '手动卸载应记下「不再自动安装」')
  assert.match(main, /const autoOn = !!\(d\.autoInstall && !pluginAutoDeclined\(d\.id\)\)/, '卡片状态应反映自动安装语义')
  assert.match(app, /p\.tags/, '插件卡片应渲染归属标签')
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
    stopServiceForPluginChange: async () => { calls.stops++; return { ok: true } },
    // 后台自动流程：拿不到 profile 写锁就整次跳过、且不记账
    tryBeginBackgroundProfileOp: () => (() => {}),
    applyPluginChange: async (verb, version, spec) => { calls.applied.push(spec && spec.name); return true },
    notify: () => { calls.notified++ },
    log: () => {},
    saveConfig: () => {},
    notePluginEnvFailure: () => {},
    notePluginReleaseAgeRetry: () => {},
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
test('退役插件：注册表摘掉的同时，老用户机器上残留的实例会被自动卸载（注入桩执行真实流程）', async () => {
  // 1) 注册表里不许再有这两个包（页面上的卡片来自注册表，摘掉即不再展示、不再代装）
  const regStart = main.indexOf('const MANAGED_NPM_PLUGINS = [')
  const regText = main.slice(regStart, main.indexOf('\n]\n', regStart) + 3)
  assert.doesNotMatch(regText, /dsh-archive-manager|dsh-mcp-lens/, '两个退役包都不应再出现在预装插件注册表里')

  // 2) 退役清单必须点名这两个包（老用户的 profile 里已经装过它们，摘卡片不等于卸载）
  const start = main.indexOf('// ---------- 退役插件：')
  assert.ok(start > 0, '找不到退役插件清理块')
  const retiredStart = main.indexOf('const RETIRED_NPM_PLUGINS = [', start)
  const retiredEnd = main.indexOf('\n]\n', retiredStart) + 3
  assert.ok(retiredStart > start && retiredEnd > retiredStart, '找不到 RETIRED_NPM_PLUGINS 字面量')
  const retired = new Function(main.slice(retiredStart, retiredEnd) + '; return RETIRED_NPM_PLUGINS')()
  assert.deepEqual(retired.map((d) => d.npm), ['@michengai/dsh-archive-manager', 'dsh-mcp-lens'], '退役清单应包含会话归档与 MCP Lens')
  for (const d of retired) assert.ok(d.id && d.name, '退役项要带 id/name（日志与提示要说人话）')

  // 3) 触发点与默认代装同一批：启动 / 环境装好 / 服务就绪（onTick）
  const triggers = main.match(/void maybeRemoveRetiredPlugins\(\)/g) || []
  assert.ok(triggers.length >= 4, '应在启动 / 环境装好 / 服务就绪等触发点补卸（实际 ' + triggers.length + ' 处）')
  assert.match(main, /if \(envReady\(\) && server\.running\(\)\) void maybeRemoveRetiredPlugins\(\)/, 'onTick 服务就绪时应补卸退役插件')

  // 4) 跑真流程：只卸残留的、卸完只重启一次、成功记账并清掉死键
  const end = main.indexOf('\n}\n', main.indexOf('async function maybeRemoveRetiredPlugins()', start)) + 2
  assert.ok(end > start, '找不到 maybeRemoveRetiredPlugins 结尾')
  const fnSrc = main.slice(start, end)
  const calls = { uninstalls: [], applied: [] }
  const installed = new Set(['@michengai/dsh-archive-manager', 'dsh-mcp-lens', 'dsh-chat-import'])
  const Config = { pluginRetiredCleanupVersion: '', pluginAutoDeclined: { 'mcp-lens': true }, pluginNotes: { 'mcp-lens': '旧备注' } }
  const ctx = {
    SELF_TEST: false,
    Config,
    app: { getVersion: () => '1.4.6' },
    marketAutoInstalling: false,
    bridgeAutoInstalling: false,
    recommendedAutoInstalling: false,
    pluginInstallAllRunning: false,
    market: {
      PROFILE_NAME: 'web',
      getState: (npm) => ({ installed: installed.has(npm) }),
      uninstallByName: async (npm) => { calls.uninstalls.push(npm); installed.delete(npm); return { ok: true } },
    },
    pluginSwitch: { rowIdsForPackage: () => [], carrierDisableIds: () => [], removeRows: () => ({ ok: true }) },
    envReady: () => true,
    envReport: { pnpm: { status: 'ok' } },
    server: { running: () => true },
    sleep: async () => {},
    stopServiceForPluginChange: async () => ({ ok: true }),
    tryBeginBackgroundProfileOp: () => (() => {}),
    applyPluginChange: async (verb, version, spec) => { calls.applied.push(spec && spec.name); return true },
    log: () => {},
    saveConfig: () => {},
    broadcastState: () => {},
  }
  const names = Object.keys(ctx)
  const api = new Function(...names, fnSrc + '\nreturn { maybeRemoveRetiredPlugins, pendingRetiredPlugins }')(...names.map((k) => ctx[k]))

  assert.deepEqual(api.pendingRetiredPlugins().map((d) => d.npm), ['@michengai/dsh-archive-manager', 'dsh-mcp-lens'], '两个包都在时应都进清理队列')
  await api.maybeRemoveRetiredPlugins()
  assert.deepEqual(calls.uninstalls, ['@michengai/dsh-archive-manager', 'dsh-mcp-lens'], '应把残留的两个都卸掉（无关插件不碰）')
  assert.equal(calls.applied.length, 1, '卸完只重启一次服务')
  assert.equal(Config.pluginRetiredCleanupVersion, '1.4.6', '清理成功应记账')
  assert.equal('mcp-lens' in Config.pluginAutoDeclined, false, '退役插件的「不再自动安装」死键应清掉')
  assert.equal('mcp-lens' in Config.pluginNotes, false, '退役插件的卡片备注死键应清掉')

  await api.maybeRemoveRetiredPlugins()
  assert.equal(calls.applied.length, 1, '同一版本内不应重复清理')

  // 5) 干净机器（没有残留）：只记账，不停服务、不重启
  const cleanConfig = { pluginRetiredCleanupVersion: '', pluginAutoDeclined: {}, pluginNotes: {} }
  const cleanCtx = Object.assign({}, ctx, {
    Config: cleanConfig,
    market: { PROFILE_NAME: 'web', getState: () => ({ installed: false }), uninstallByName: async () => { throw new Error('干净机器不该卸载') } },
    stopServiceForPluginChange: async () => { throw new Error('干净机器不该停服务') },
    applyPluginChange: async () => { throw new Error('干净机器不该重启服务') },
  })
  const cleanApi = new Function(...names, fnSrc + '\nreturn { maybeRemoveRetiredPlugins }')(...names.map((k) => cleanCtx[k]))
  await cleanApi.maybeRemoveRetiredPlugins()
  assert.equal(cleanConfig.pluginRetiredCleanupVersion, '1.4.6', '没有残留也应记账（省掉之后每 tick 读 profile）')
})
