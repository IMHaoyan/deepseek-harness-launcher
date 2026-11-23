// tests/plugin-safe-mode.test.js — 插件冲突「安全模式」的护栏。
//
// 背景：2026-11-23 用户另一台机器 —— 用量与计费插件打断 DSH 的 UI 服务链，
// 服务 HTTP ready，但页面是 Failed to load plugins；逐个禁用十几个插件排查代价太高。
// 这里钉住：安全模式只保留官方 bundle（+ 桌面登录辅助）、写入前备份、可整体恢复；
// 同时确认不再归 DSHL 管理的电脑操作插件不会出现在插件页/未生效提示/兼容预判里。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')
const app = read('ui-src/app.js')
const html = read('ui-src/index.html')
const browserHtml = read('ui-src/browser.html')
const browserJs = read('ui-src/browser.js')

function sliceBetween(src, startMarker, endMarker, label) {
  const at = src.indexOf(startMarker)
  assert.ok(at >= 0, `源码里找不到：${label || startMarker}`)
  const end = src.indexOf(endMarker, at + startMarker.length)
  assert.ok(end > at, `源码里找不到 ${label || startMarker} 的结束边界`)
  return src.slice(at, end)
}

test('safeModeKeepsBundle：只保留官方 @deepseek-ai/* 与桌面登录辅助', () => {
  const block = sliceBetween(main, 'const SAFE_MODE_KEEP_PREFIX', 'function readProfileManifestSafe', 'safe mode keep helpers')
  const ctx = {}
  vm.runInNewContext(block + '\n;globalThis.keep = safeModeKeepsBundle', ctx)
  assert.equal(ctx.keep('@deepseek-ai/dsh-base'), true)
  assert.equal(ctx.keep('@deepseek-ai/dsh-web-app'), true)
  assert.equal(ctx.keep('dshl-desktop-signin'), true)
  assert.equal(ctx.keep('@kenz1117/dsh-ui-usage-billing'), false)
  assert.equal(ctx.keep('dsh-better-sidebar'), false)
  assert.equal(ctx.keep('dsh-computer-use-win'), false)
})

test('电脑操作不再归 DSHL 管理，但用户装了它仍应在插件页可见', () => {
  const regOnly = main.slice(main.indexOf('const MANAGED_NPM_PLUGINS = ['), main.indexOf('\n]\n', main.indexOf('const MANAGED_NPM_PLUGINS = [')) + 3)
  assert.doesNotMatch(regOnly, /dsh-computer-use-win/, '注册表里不应再有电脑操作卡片')
  assert.match(main, /IGNORED_NPM_PLUGINS = new Set\(\['dsh-computer-use-win'\]\)/, '要有明确的忽略清单')
  assert.match(main, /if \(!\(opts && opts\.includeIgnored\) && IGNORED_NPM_PLUGINS\.has\(name\)\) return undefined/,
    '未生效证据默认过滤忽略清单（不拉高主页面警示）')
  assert.doesNotMatch(main, /Array\.from\(IGNORED_NPM_PLUGINS\)/, '不能把忽略包塞进 inventory 的 known 集合（否则装了就看不见）')
  const inv = sliceBetween(main, 'function pluginInventoryCards()', 'function invalidatePluginInventory', 'pluginInventoryCards')
  assert.match(inv, /const known = new Set\(MANAGED_NPM_PLUGINS\.map\(\(d\) => d\.npm\)\.concat\(\[market\.PLUGIN_NAME\]\)\)/,
    'Profile 其他插件清单只排除受管注册表与市场，不排除忽略清单')
  assert.match(inv, /activationIssueOf\(npm, \{ includeIgnored: true \}\)/,
    '已安装时卡片要显示它真实的未生效状态，不能把失败说成已启用')
  assert.match(inv, /isIgnored: \(npm\) => IGNORED_NPM_PLUGINS\.has\(String\(npm \|\| ''\)\)/,
    '要告诉清单卡片它属于忽略清单，主页面才能跳过它的全局警示')
  assert.match(app, /p\.activation && !p\.ignored/, '主页面不把忽略清单里的包算进“未生效”提示')
  assert.match(main, /filter\(\(x\) => !IGNORED_NPM_PLUGINS\.has\(String\(\(x && x\.name\) \|\| ''\)\)\)/,
    '升级兼容预判也不应再点名它')
})

test('安全模式：先备份 package.json / cordis.patch.yml，再写 bundle 列表；可整体恢复', () => {
  const enable = sliceBetween(main, 'async function enablePluginSafeMode()', 'async function restorePluginSafeMode()', 'enablePluginSafeMode')
  assert.match(enable, /snapshotProfileFiles\(backup\)/, '必须先备份当前 Profile（patch 存在但复制失败要 fail-closed）')
  assert.match(enable, /next\.dsh\.profile\.bundles = bundles\.filter\(\(n\) => safeModeKeepsBundle\(n\)\)/,
    '安全模式只保留官方 bundle + 桌面登录辅助')
  assert.match(enable, /writeProfileManifestAtomic\(next\)/, '清单要原子落盘')
  assert.match(enable, /const record = \{/, '备份落点要结构化成记录')
  assert.match(enable, /Config\.pluginSafeModeBackup = record/, '先持久化恢复凭证再改 Profile')
  assert.match(enable, /if \(!saveConfig\(\)\)/, '恢复记录没落盘就不能继续')
  assert.match(enable, /await restartDshForConsole\(\)/, '改完 Profile 必须重启服务才生效')
  assert.match(enable, /Config\.pluginQuarantine/, '有按插件隔离记录时不允许再叠一层安全模式快照')

  const restore = sliceBetween(main, 'async function restorePluginSafeMode()', 'function takeProfileRollback', 'restorePluginSafeMode')
  assert.match(restore, /restoreProfileFiles\(\{ manifest: bak\.manifest/, '恢复要按快照整体拷回')
  assert.match(restore, /Config\.pluginSafeModeBackup = null/, '恢复后清掉备份记录')
  assert.match(restore, /await restartDshForConsole\(\)/, '恢复后重启服务')
  assert.match(main, /case 'pluginSafeMode': return JSON\.stringify\(await withProfileOp\(/, '安全模式写入口要走 profile 写锁')
  assert.match(main, /case 'pluginSafeModeRestore': return JSON\.stringify\(await withProfileOp\(/, '恢复入口也要走 profile 写锁')
})

test('状态与界面：pluginUi 只读事实 + 恢复页安全模式卡片 + 主页面警示卡升级', () => {
  const state = sliceBetween(main, 'function pluginUiState()', '/** 安全模式：保留官方 bundle', 'pluginUiState')
  assert.match(state, /degraded: critical\.length > 0 && server\.uiPageHealthy !== true/,
    '真实页面已加载时，过期的 required 证据不能继续挂恢复卡')
  assert.match(state, /criticalCount: critical\.length/, '要告诉界面有多少条是 UI 关键证据')
  assert.match(state, /requiredCount,/, '要告诉界面有多少条是 DSH 标了 required 的')
  assert.match(state, /critical: pluginActivation\.isUiCriticalIssue\(it\)/, '逐条标记是否 UI 关键')
  assert.match(state, /thirdParty,/, '要告诉界面哪些第三方 bundle 会被临时停用')
  assert.match(state, /canSafeMode: thirdParty\.length > 0/, '没有第三方插件时不能给安全模式按钮')
  assert.match(state, /pluginActivation\.attributeCulprits\(issues, candidates\)/, '冲突元凶要归因到具体包')
  assert.match(state, /staticShortcutSuspects\(candidates, candidateNames\)/,
    '运行时没有证据时，用插件声明的默认快捷键比对兜底')
  assert.match(state, /suspicionSource = 'shortcut-defaults'/, '要告诉界面这条结论来自默认快捷键比对')
  assert.match(app, /根据已安装插件声明的默认快捷键比对/, '静态归因必须说明依据，不能冒充报错原文')
  assert.match(state, /\.filter\(\(npm\) => !IGNORED_NPM_PLUGINS\.has\(npm\)\)/, '忽略清单里的插件不参与自动停用')
  assert.match(state, /declaredThirdParty/, '归因候选要覆盖 dependencies（市场停用的插件仍在依赖里）')
  assert.match(state, /profileTargetNamesCached/, '还要覆盖 cordis.patch.yml 里的 insert 行（市场安装的形态）')
  assert.match(state, /suspects,/, '状态里要带精确的待禁用清单')
  assert.match(state, /canBatchDisable: suspects\.some\(\(s\) => s\.actionable\)/, '只有还能停用的元凶才给按钮')
  assert.match(state, /const quarantined = new Set\(\[/, '已隔离的包也要参与归因候选')
  assert.match(state, /disabled: disabledOf\(npm\)/, '候选要带“当前是否已停用”')
  assert.match(state, /actionable: !disabled &&/, '已停用的元凶不能重复给禁用按钮')
  assert.match(state, /quarantine: q \? \{/, '隔离记录要下发，恢复页才能列清楚停了谁')
  assert.match(main, /pluginUi: pluginUiState\(\),/, '状态快照要下发 pluginUi')

  for (const id of ['pluginRecoveryCard', 'pluginRecoveryTitle', 'btnPluginSafeMode', 'btnPluginSafeModeRestore', 'btnPluginDisableSuspects', 'btnPluginQuarantineRestore', 'btnPluginOpenList', 'btnPluginRecoveryJump', 'btnPluginsQuarantineRestore']) {
    assert.match(html, new RegExp('id="' + id + '"'), `index.html 缺 ${id}`)
  }
  assert.match(app, /const show = pluginRecoveryVisible\(ui\)/,
    '按插件隔离成功后（页面已健康）不再占版面；只有未就绪与安全模式才显示恢复卡')
  assert.match(app, /btnPluginsQuarantineRestore'\)\.addEventListener\('click', restoreQuarantineProfile\)/,
    '卡片隐藏后，插件页工具栏必须保留恢复入口')
  assert.match(main, /show: !!pu\.degraded/, '标题栏的「插件恢复」按钮只跟未就绪状态走，恢复完就消失')
  assert.match(html, /id="diagSlotsDetails"/, '健康检查点默认收起，不再抢冲突处理的版面')
  assert.match(app, /classList\.toggle\('recovery-alert', !!ui\.degraded\)/, '只有未就绪才给红框强调')
  assert.match(app, /recoverySlotCount/, '收起时也要显示剩余检查点数量')
  assert.match(html, /id="recoverySlotsLatest"/, '最新检查点要常驻可见，不能全部收起')
  assert.match(app, /fillSlots\(\$\('recoverySlotsLatest'\)/, '第一条进常驻区，其余进折叠区')
  assert.match(app, /还有 \$\{rest\.length\} 条/, '折叠标题要说明还有多少条')
  const css = read('ui-src/console.css')
  assert.match(css, /--console-nav-w: 280px/, '侧栏宽度保持原样')
  assert.match(css, /\.console-nav-item \{[\s\S]{0,220}min-height: 54px/, '导航行高度放大到 1.5 倍（36 → 54）')
  assert.match(app, /setRecoveryBusy\(true\)/, '禁用并重启期间要锁住恢复动作')
  assert.match(app, /for \(const id of RECOVERY_ACTION_IDS\)[\s\S]{0,120}el\.disabled = busy/,
    '禁用期间旁边的按钮一起置灰')
  assert.match(app, /recoveryBusy[\s\S]{0,220}btnDisable\.textContent = '正在禁用并重启…'/,
    '重渲染后也要保持进行中文案')
  assert.match(read('ui-src/browser.css'), /bar-btn\.plugin-recovery\.warn[\s\S]{0,160}background: var\(--danger\)/,
    '标题栏「处理插件冲突」红底白字')
  assert.match(browserJs, /⚠️ 处理插件冲突/, '标题栏按钮文字前带 ⚠️')
  assert.match(app, /pu\.degraded \? '处理插件冲突' : '查看插件恢复状态'/,
    '主页面常驻按钮要随状态换文案')
  assert.match(app, /const showJump = pluginRecoveryVisible\(pu\)/,
    '按插件隔离成功且界面健康后，主页面不再常驻「插件恢复」入口')
  assert.match(app, /btnPluginRecoveryJump'\)\.addEventListener\('click', \(\) => showPage\('recovery'\)\)/,
    '主页面按钮要一步跳到恢复卡')
  const render = sliceBetween(app, 'function renderPluginRecovery(p)', 'function renderRecovery(state)', 'renderPluginRecovery')
  assert.match(render, /安全模式已启用/, '安全模式生效后要能解释当前状态')
  assert.match(render, /恢复到安全模式前的完整 Profile/, '要给整体恢复的出路')
  assert.match(render, /已临时禁用/, '按插件隔离后要显示当前实际禁用了什么')
  assert.match(render, /将只禁用以上/, '执行前就要说明只会禁用哪些插件')
  assert.match(render, /疑似冲突插件/, '归因是报错推断，界面必须说“疑似”而不是武断定罪')
  assert.match(render, /pluginSuspectLine/, '详情要逐条列出插件名与冲突原因')
  assert.match(render, /ui\.thirdPartyEnabled/, '排查范围只能列真正处于启用状态的第三方插件（停用的不算）')
  assert.match(render, /报错原文没有点名具体插件/, '不能把「没归因」说成「没有可疑插件」')
  assert.match(render, /actionableSuspects/, '批量按钮只能操作还能停用的 suspect')
  assert.match(app, /pluginSuspectLine[\s\S]{0,300}已临时禁用/, '已停用的元凶要标明，而不是从卡片上消失')
  assert.match(app, /renderPluginRecovery\(state\.pluginUi\)/, '状态推送时要渲染这张卡')
  assert.match(app, /pluginDegraded \? '处理插件冲突'/, '主页面警示卡要升级为「处理插件冲突」')
  assert.match(app, /cmd\('pluginSafeMode'\)/, '安全模式按钮要真的调用主进程')
  assert.match(app, /cmd\('pluginSafeModeRestore'\)/, '恢复按钮要真的调用主进程')
})

test('按插件隔离：批量文案、确认框、执行结果都必须点名具体插件', () => {
  const label = sliceBetween(app, 'function pluginBatchDisableLabel', 'function pluginSuspectLine', 'pluginBatchDisableLabel')
  assert.match(label, /names\.length === 1/, '1 个元凶直呼其名')
  assert.match(label, /names\.length === 2/, '2 个元凶两个都列出')
  assert.match(label, /这 \$\{names\.length\} 个冲突插件/, '3+ 用数量 + 详情列全')
  assert.match(app, /cmd\('pluginDisableSuspects', \{ npms: suspects\.map\(\(s\) => s\.npm\) \}\)/,
    '按钮要把精确的包名列表交给主进程')
  assert.match(app, /'将只禁用以下疑似冲突插件：\\n'/, '确认框要逐条列出将禁用的插件')
  assert.match(app, /已有隔离记录，本次会扩大隔离范围/, '二次隔离要说明恢复仍回到最初状态')
  assert.match(app, /已禁用 \$\{done\.join\('、'\)\}/, '执行后要用主进程回执的真实清单，而不是只回显请求')
  assert.match(app, /cmd\('pluginQuarantineRestore'\)/, '恢复按钮要真的调用主进程')
  assert.match(app, /window\._pluginUi = ui/, '点击处理要拿到当前卡片状态')
})

test('按插件隔离：只允许第三方 bundle、先备份、一次重启、可整体恢复', () => {
  const disable = sliceBetween(main, 'async function disableSuspectPlugins', 'async function restorePluginQuarantine', 'disableSuspectPlugins')
  assert.match(disable, /thirdParty\.includes\(n\)/, 'fail-closed：只接受当前 Profile 的第三方 bundle')
  assert.match(disable, /snapshotProfileFiles\(backup\)/, '写前备份 package.json 与存在的补丁层')
  assert.match(disable, /pluginSwitch\.setEnabled\(npm, false\)/, '逐个子集停用，不动其他插件')
  assert.match(disable, /if \(!target\.toggle\)/, '只有“没有可切换加载项”才允许退化为从 bundle 列表移除')
  assert.match(disable, /removedFromBundles\.push\(npm\)/, '补丁层没有加载项时退化为从 bundle 列表移除')
  assert.match(disable, /writeProfileManifestAtomic\(next\)/, '清单要原子落盘')
  assert.match(disable, /Config\.pluginQuarantine = \{/, '精确禁用清单要持久化，恢复页才列得出来')
  assert.match(disable, /const reuse = !!\(prior && prior\.manifest && fs\.existsSync\(prior\.manifest\)\)/,
    '二次隔离要复用最初的快照，一次恢复回到第一次隔离前')
  assert.match(disable, /\.\.\.\(\(reuse && Array\.isArray\(prior\.disabled\)\) \? prior\.disabled : \[\]\)/,
    '禁用清单要取并集，不能把之前隔离的插件从卡片上抹掉')
  assert.match(disable, /if \(!saveConfig\(\)\)/, '恢复记录没落盘就不能继续')
  assert.match(disable, /const abort = \(error, failed\) =>/, '任何写失败都要整批回滚，不能留下半状态')
  assert.match(disable, /await restartDshForConsole\(\)/, '所有改动后只重启一次')
  assert.match(main, /case 'pluginDisableSuspects': return JSON\.stringify\(await withProfileOp\(/, '写入口要走 profile 写锁')

  const restore = sliceBetween(main, 'async function restorePluginQuarantine', 'function pluginDisplayName', 'restorePluginQuarantine')
  assert.match(restore, /restoreProfileFiles\(\{ manifest: q\.manifest/, '恢复要按快照整体拷回')
  assert.match(restore, /clearPersistedDisabledFor\(q\.disabled\)/, '要先清 durable 的停用选择')
  assert.match(restore, /if \(warnings\.length\)/, 'durable 清理失败时不能假装恢复成功')
  assert.match(restore, /Config\.pluginQuarantine = null/, '恢复后清掉记录')
  assert.match(restore, /await restartDshForConsole\(\)/, '恢复后重启服务')
  assert.match(main, /case 'pluginQuarantineRestore': return JSON\.stringify\(await withProfileOp\(/, '恢复入口也要走 profile 写锁')
})

test('Profile 快照恢复：原状态没有补丁层时要把新建的补丁文件删掉', () => {
  const fn = sliceBetween(main, 'function restoreProfileFiles(snap)', 'function dropProfileSnapshot', 'restoreProfileFiles')
  assert.match(fn, /snap\.patchExisted === true/, '有补丁层但备份缺失要报错，不能跳过')
  assert.match(fn, /补丁层备份已不存在/, '必须 fail-closed')
  assert.match(fn, /snap\.patchExisted === false/, '原状态没有补丁层')
  assert.match(fn, /fs\.unlinkSync\(DSH_PROFILE_PATCH\)/, '要把隔离期间新建的补丁文件删掉')
})

test('DSH 独立窗口：插件冲突时顶栏出现恢复按钮，直达恢复页', () => {
  assert.match(browserHtml, /id="btnPluginRecovery"/, '独立窗口顶栏要有恢复按钮')
  assert.match(browserJs, /state\.pluginRecovery/, '按钮显隐由主进程状态驱动')
  assert.match(browserJs, /send\('pluginRecovery'\)/, '按钮要真的调用主进程')
  assert.match(main, /pluginRecovery: \(\(\) => \{/, '状态推送要带 pluginRecovery')
  assert.match(main, /case 'browser:pluginRecovery': if \(!SELF_TEST\) showConsolePage\('recovery'\)/,
    '独立窗口按钮直接打开恢复页')
})

test('pluginUiState：运行时没有证据时用默认快捷键兜底，且声明顺序不能踩 TDZ', () => {
  const activation = require('../plugin-activation')
  const manifest = {
    dependencies: { '@kenz1117/dsh-ui-usage-billing': '^1.8.9' },
    dsh: { profile: { bundles: ['@kenz1117/dsh-ui-usage-billing'] } },
  }
  const server = {
    activationIssues: [{
      kind: 'ui-page',
      packageName: '@deepseek-ai/dsh-client-ui-sidebar',
      entryId: '',
      detail: 'pending (waiting for service: uiWorkspace)',
      required: true,
    }],
    uiPageHealthy: false,
    activationAutoOpened: false,
  }
  const ctx = {
    server,
    Config: { pluginQuarantine: null, pluginSafeModeBackup: null },
    IGNORED_NPM_PLUGINS: new Set(),
    pluginActivation: activation,
    pluginSwitch: { isDisabled: () => false, canToggle: () => true },
    readProfileManifestSafe: () => manifest,
    profileBundlesOf: () => ['@kenz1117/dsh-ui-usage-billing'],
    profileDeclaredNpms: () => ['@kenz1117/dsh-ui-usage-billing'],
    profileTargetNamesCached: () => [],
    safeModeKeepsBundle: (n) => n.startsWith('@deepseek-ai/'),
    pluginNameForNpm: (n) => (n === '@kenz1117/dsh-ui-usage-billing' ? '用量与计费' : n),
    staticShortcutSuspects: () => [{
      npm: '@kenz1117/dsh-ui-usage-billing',
      name: '用量与计费',
      reasons: ['声明了与 session.toggleRead（@deepseek-ai/dsh-client-ui-workspace）相同的默认快捷键 desktop:macos'],
      canToggle: true,
      inBundles: true,
      disabled: false,
      actionable: true,
      static: true,
    }],
  }
  vm.createContext(ctx)
  const src = main.slice(main.indexOf('function pluginUiState('), main.indexOf('/** 安全模式：保留官方 bundle'))
  vm.runInContext(src, ctx)
  const state = ctx.pluginUiState()
  assert.equal(state.degraded, true)
  assert.equal(state.suspicionSource, 'shortcut-defaults')
  assert.deepEqual([...state.suspects].map((s) => s.npm), ['@kenz1117/dsh-ui-usage-billing'])
  assert.equal(state.suspects[0].name, '用量与计费')
  assert.equal(state.canBatchDisable, true, '静态归因同样可以一键禁用')
})

test('恢复入口可见性：只有未就绪/安全模式占版面，隔离成功不常驻', () => {
  const ctx = {}
  vm.createContext(ctx)
  const fn = app.slice(app.indexOf('function pluginRecoveryVisible('), app.indexOf('function renderPluginRecovery('))
  vm.runInContext(fn, ctx)
  assert.equal(ctx.pluginRecoveryVisible({ degraded: true }), true, '界面未就绪要显示')
  assert.equal(ctx.pluginRecoveryVisible({ safeMode: {} }), true, '安全模式是进行中的状态，保留恢复入口')
  assert.equal(ctx.pluginRecoveryVisible({ quarantine: { disabled: [{ npm: 'x', disabled: true }] } }), false,
    '按插件隔离成功、界面健康后，恢复卡/跳转/标题栏都不该再出现')
  assert.equal(ctx.pluginRecoveryVisible({}), false)
})
