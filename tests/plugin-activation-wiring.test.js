// tests/plugin-activation-wiring.test.js — 「未生效」信号必须真的接到界面上
//
// 解析逻辑有单测（plugin-activation.test.js），但这类"静默失效"的修复价值全在接线：
// 证据不进状态、卡片不显示，就等于没做。这里钉接线点与文案契约；换服务世代时
// "先清证据再推状态"的时序用一个最小 vm 夹具把 claimSuccessor 真跑一遍（正则证明不了顺序）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const uiSrc = fs.readFileSync(path.join(root, 'ui-src', 'app.js'), 'utf8')
const wwwroot = fs.readFileSync(path.join(root, 'wwwroot', 'app.js'), 'utf8')

test('主进程：stderr 逐行增量解析，且随世代清空', () => {
  assert.match(main, /const pluginActivation = require\('\.\/plugin-activation'\)/, '要 require 解析模块')
  assert.match(main, /noteActivationEvidence\(line\)/, 'stderr 每行都要喂给解析器')
  assert.match(main, /server\.activationIssues = \[\]/, '新世代要清掉上一轮的证据')
  assert.match(main, /server\.activationWindow = \[\]/, '滑动窗口也要随世代清空')
  assert.match(main, /const ACTIVATION_WINDOW_LINES = \d+/, '窗口大小要有名字（warning 头 + 条目行一起看）')
  assert.match(main, /server\.activationAutoOpened = false/, '自动打开恢复页要按世代记账')
  assert.match(main, /criticalFailure && !server\.activationAutoOpened && !consoleIsOpen\(\)/,
    'UI 关键插件失败且控制台没开时，自动把恢复页摆到用户面前')
  assert.match(main, /pluginActivation\.isUiCriticalIssue\(it\)/,
    '只有 required / UI 服务 / 快捷键冲突才算界面未就绪')
  assert.match(main, /showConsolePage\('recovery'\)/, '恢复页是插件冲突的唯一写操作入口')
})

test('换了一代服务也要清证据：自重启认领 / 外部接管都不能留着上一轮的 ⚠', () => {
  // 规则只写一处，三条换进程的路径共用：自己 spawn（startServerInner）、认领 DSH 自重启后继、
  // 接管外部实例。后两条不经过 startServerInner —— 漏清的话，在 DSH 内更新插件并重启之后，
  // 插件已经好了，卡片还会一直挂着上一轮的 ⚠（正是这条 bug 的现场）。
  assert.match(main, /function resetActivationEvidence\(\) \{[\s\S]*?server\.activationWindow = \[\]\s*server\.activationIssues = \[\]/,
    '重置必须同时清滑动窗口与证据列表（窗口不清，旧行会被再解析成证据）')
  const claim = main.slice(main.indexOf('function claimSuccessor('), main.indexOf('async function runHandover('))
  assert.match(claim, /resetActivationEvidence\(\)/, '认领 DSH 自重启后继时必须清证据')
  assert.ok(claim.indexOf('resetActivationEvidence()') < claim.indexOf('broadcastState()'),
    '必须先清再推状态，否则控制台会先按旧证据渲染一次')
  const adopt = main.slice(main.indexOf("if (verdict === 'adopt') {"), main.indexOf("if (verdict === 'retry-start')"))
  assert.match(adopt, /resetActivationEvidence\(\)/, '接管外部实例同样换了一代服务，旧证据不能留')
  const spawnPath = main.slice(main.indexOf('async function startServerInner('), main.indexOf('child = spawn(nodeCmd, spawnArgs'))
  assert.match(spawnPath, /resetActivationEvidence\(\)/, '自己 spawn 的新世代也要走同一份重置')
})

/** 把 resetActivationEvidence + claimSuccessor 抠出来跑：正则证明不了"清空发生在推状态之前"。 */
function claimSuccessorHarness() {
  const server = {
    activationWindow: ['dsh: warning: 1 entry did not activate', 'x (pkg): failed to import'],
    activationIssues: [{ kind: 'inactive', packageName: 'pkg', entryId: 'x', detail: 'failed to import', services: [], key: 'k' }],
    claimedPid: 0, claimedAlive: false, tokenPending: false, authPending: false,
    settling: false, settlingServing: false, handover: null, launchUrl: '', tailOpen: false, gen: 7,
  }
  const seen = { atBroadcast: null, emits: 0 }
  const ctx = {
    server, PORT: 3080, healthFault: true,
    cancelRestartRetry: () => {},
    scheduleHealthyCapture: () => {},
    probeClaimedAuth: () => {},
    refreshDesktopShellGate: () => {},
    log: () => {},
    lifecycle: { emit: () => { seen.emits += 1 } },
    broadcastState: () => {
      seen.atBroadcast = { window: server.activationWindow.slice(), issues: server.activationIssues.slice() }
    },
  }
  vm.createContext(ctx)
  const helperStart = main.indexOf('function resetActivationEvidence(')
  const helperEnd = main.indexOf('// 记录一次服务侧失败')
  const claimStart = main.indexOf('function claimSuccessor(')
  const claimEnd = main.indexOf('async function runHandover(')
  assert.ok(helperStart > 0 && helperEnd > helperStart, '找不到 resetActivationEvidence 片段')
  assert.ok(claimStart > 0 && claimEnd > claimStart, '找不到 claimSuccessor 片段')
  vm.runInContext(
    main.slice(helperStart, helperEnd) + '\n' + main.slice(claimStart, claimEnd) + ';globalThis.claim = claimSuccessor;',
    ctx,
  )
  return { server, seen, claim: ctx.claim }
}

test('claimSuccessor：认领自重启后继时清空上一轮证据，且在推送状态前完成', () => {
  const h = claimSuccessorHarness()
  assert.equal(h.claim(4242, 4242, { fromPid: 111, source: 'handover', elapsedMs: 12 }), true)
  // 跨 vm realm 的数组原型不同，deepStrictEqual 会因为原型不同而误报 —— 只比内容/长度
  assert.equal(h.server.activationIssues.length, 0, '新世代不能带着上一轮的 ⚠')
  assert.equal(h.server.activationWindow.length, 0, '滑动窗口也要清（否则旧行会被再解析一遍）')
  assert.equal(h.seen.atBroadcast && h.seen.atBroadcast.issues.length, 0, '推给界面的第一帧就必须是清空后的状态')
  assert.equal(h.seen.atBroadcast && h.seen.atBroadcast.window.length, 0)
  assert.equal(h.seen.emits, 1, '认领仍要发一次 handover 生命周期事件')
})

test('claimSuccessor：PID 不匹配（不是我们的后继）时不认领、也不动证据', () => {
  const h = claimSuccessorHarness()
  assert.equal(h.claim(4242, 9999, { fromPid: 111 }), false)
  assert.equal(h.server.activationIssues.length, 1, '没认领就不能把上一轮的证据清掉')
  assert.equal(h.server.activationWindow.length, 2, '没认领也不该重置窗口')
  assert.equal(h.seen.atBroadcast, null, '没认领不该推状态')
})

test('主进程：就绪时把「重启不会改变」写进日志，并立刻推送状态', () => {
  assert.match(main, /插件未生效（重启不会改变）/, '就绪日志要把结论说完')
  assert.match(main, /broadcastState\(\) \/\/ 插件卡片要立刻显示"未生效"/)
})

test('插件卡片：「未生效」覆盖清单态，且三类卡片都带 activation 文案', () => {
  assert.match(main, /const unresolvedStatus = \(packageName, status\) =>/, '状态要有统一入口')
  assert.match(main, /label: '未生效', tone: 'warn'/, '未生效要有独立状态胶囊')
  assert.match(main, /const marketStatus = unresolvedStatus\(market\.PLUGIN_NAME,/, '插件市场卡片')
  assert.match(main, /const status = unresolvedStatus\(d\.npm,/, 'npm 推荐插件卡片')
  const hits = main.match(/activation: activationText\(/g) || []
  assert.equal(hits.length, 2, '两类卡片都要带上 activation 文案（市场 / npm）')
})

test('界面：⚠ 单独一行显示未生效，胶囊 tooltip 给出原因原文', () => {
  for (const [label, src] of [['ui-src', uiSrc], ['wwwroot', wwwroot]]) {
    assert.match(src, /p\.activation \? '⚠ ' \+ p\.activation/, `${label} 要显示未生效原因`)
    assert.match(src, /if \(p\.status && p\.status\.title\) statePill\.title = p\.status\.title;/, `${label} 胶囊要带 tooltip`)
  }
})

test('wwwroot 与 ui-src 同步（打包产物不能是旧界面）', () => {
  assert.equal(wwwroot, uiSrc, 'ui-src/app.js 与 wwwroot/app.js 不一致，先跑 npm run build:assets')
})

test('打包清单包含新模块（否则装出来的 exe 缺文件）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('plugin-activation.js'), 'electron-builder files 要含 plugin-activation.js')
})

test('失败页兜底：stderr 没给 required 失败时，从页面原文补证据', () => {
  assert.match(main, /function inspectWebBootFailure\(text\)/, '要有页面原文解析入口')
  assert.match(main, /Failed to load plugins|did not activate/, '只对失败页做检查')
  assert.match(main, /inspectWebBootFailure\(text\)/, '页面取证结果要送进解析')
  assert.match(main, /const st = await inspectWebUiPage\(wc, seq\)/, 'did-finish-load 后要把页面取证接进流程')
  assert.match(main, /if \(st !== 'pending'\) return/, '拿到失败/健康结论就停止轮询')
  assert.match(main, /Date\.now\(\) - startedAt > 90000/, '慢机器上失败页可能晚于 did-finish-load，必须有界轮询')
  assert.match(main, /kind: 'ui-page'/, '解析不出条目也要留一条合成证据，至少能进安全模式')
  assert.match(main, /document\.querySelector\('textarea,\[contenteditable=true\],input\[type=text\]'\)/,
    '只在没有聊天输入框的失败页采信，避免聊天正文里的报错文本误触发')
  assert.match(main, /function addActivationIssues\(found, opts\)/, 'stderr 与页面/控制台来源共用同一份去重/推送/自动打开逻辑')
})

test('失败页原文 → 19 条证据 / required 2 / 自动打开恢复页，且重复读页不重复记', () => {
  const activation = require('../plugin-activation')
  const server = { activationIssues: [], activationAutoOpened: false }
  const state = { broadcasts: 0, pages: [] }
  const ctx = {
    server,
    pluginActivation: activation,
    IGNORED_NPM_PLUGINS: new Set(['dsh-computer-use-win']),
    log: () => {},
    broadcastState: () => { state.broadcasts += 1 },
    consoleIsOpen: () => false,
    showConsolePage: (page) => { state.pages.push(page) },
  }
  vm.createContext(ctx)
  const add = main.slice(main.indexOf('function addActivationIssues('), main.indexOf('function noteActivationEvidence('))
  const inspect = main.slice(main.indexOf('function inspectWebBootFailure('), main.indexOf('function activationIssueOf('))
  assert.ok(add.includes('function addActivationIssues'), '找不到 addActivationIssues')
  assert.ok(inspect.includes('function inspectWebBootFailure'), '找不到 inspectWebBootFailure')
  vm.runInContext(add + '\n' + inspect, ctx)

  const text = [
    'HARNESS',
    'Failed to load plugins',
    'web boot: 2 required entries did not activate',
    '@deepseek-ai/dsh-client-ui-sidebar (required): pending (waiting for service: uiWorkspace)',
    '@deepseek-ai/dsh-client-ui-conversation: pending (waiting for service: uiWorkspace)',
    '@deepseek-ai/dsh-message-quotes: pending (waiting for service: uiConversation)',
    '@deepseek-ai/dsh-client-ui-chat (required): pending (waiting for services: uiWorkspace, uiConversation)',
    '@deepseek-ai/dsh-client-ui-workspace: failed: Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)',
    '@deepseek-ai/dsh-client-ui-workflow-run: pending (waiting for services: uiConversation, uiWorkspace)',
    '@deepseek-ai/dsh-client-ui-skill: pending (waiting for service: uiConversation)',
    '@deepseek-ai/dsh-client-ui-subagent: pending (waiting for service: uiWorkspace)',
    '@deepseek-ai/dsh-client-ui-reference: pending (waiting for service: uiConversation)',
    '@deepseek-ai/dsh-client-ui-secret-mask: pending (waiting for service: uiConversation)',
    '@deepseek-ai/dsh-client-ui-schedule: pending (waiting for services: conversation, uiConversation, uiWorkspace)',
    '@deepseek-ai/dsh-client-ui-goal: pending (waiting for service: uiConversation)',
    '@deepseek-ai/dsh-client-ui-entry-customization: pending (waiting for service: uiWorkspace)',
    '@deepseek-ai/dsh-client-ui-plan: pending (waiting for service: uiConversation)',
    '@deepseek-ai/dsh-client-ui-user-questions: pending (waiting for service: uiConversation)',
    '@deepseek-ai/dsh-client-ui-trajectory: pending (waiting for service: uiConversation)',
    '@deepseek-ai/dsh-client-ui-deliverables: pending (waiting for service: uiConversation)',
    'dsh-mcp-connector: pending (waiting for service: conversation)',
    '@deepseek-ai/dsh-client-ui-directory-picker-native: pending (waiting for service: uiWorkspace)',
  ].join('\n')

  assert.equal(ctx.inspectWebBootFailure(text), true)
  assert.equal(server.activationIssues.length, 19)
  assert.equal(server.activationIssues.filter((i) => i.required === true).length, 2)
  assert.deepEqual(state.pages, ['recovery'], 'UI 关键失败要自动打开恢复页')
  assert.equal(state.broadcasts, 1)

  assert.equal(ctx.inspectWebBootFailure(text), false, '重复读同一页不新增证据')
  assert.equal(server.activationIssues.length, 19)
  assert.deepEqual(state.pages, ['recovery'], '自动打开只做一次')
})

test('页面解析提前停住时，单独扫冲突原文仍能归因到 usage-billing', () => {
  const activation = require('../plugin-activation')
  const server = { activationIssues: [], activationAutoOpened: false }
  const ctx = {
    server,
    pluginActivation: activation,
    IGNORED_NPM_PLUGINS: new Set(['dsh-computer-use-win']),
    log: () => {},
    broadcastState: () => {},
    consoleIsOpen: () => true,
    showConsolePage: () => {},
  }
  vm.createContext(ctx)
  const add = main.slice(main.indexOf('function addActivationIssues('), main.indexOf('function noteActivationEvidence('))
  const inspect = main.slice(main.indexOf('function inspectWebBootFailure('), main.indexOf('function activationIssueOf('))
  vm.runInContext(add + '\n' + inspect, ctx)

  const text = [
    'HARNESS',
    'Failed to load plugins',
    'web boot: 1 required entry did not activate',
    '@deepseek-ai/dsh-client-ui-sidebar (required): pending (waiting for service: uiWorkspace)',
    '',
    '@deepseek-ai/dsh-client-ui-workspace: failed: Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)',
  ].join('\n')
  assert.equal(ctx.inspectWebBootFailure(text), true)
  assert.equal(server.activationIssues.length, 2, 'parser 停住后，冲突原文要由兜底补上')
  const suspects = activation.attributeCulprits(server.activationIssues, [
    { npm: '@kenz1117/dsh-ui-usage-billing', name: '用量与计费' },
  ])
  assert.equal(suspects.length, 1)
  assert.equal(suspects[0].npm, '@kenz1117/dsh-ui-usage-billing')
})

test('失败页没有冲突原文时：留合成证据并记录诊断片段，不瞎猜元凶', () => {
  const activation = require('../plugin-activation')
  const server = { activationIssues: [], activationAutoOpened: false, failureSnippetLogged: '' }
  const logs = []
  const ctx = {
    server,
    pluginActivation: activation,
    IGNORED_NPM_PLUGINS: new Set(['dsh-computer-use-win']),
    log: (m) => { logs.push(m) },
    broadcastState: () => {},
    consoleIsOpen: () => true,
    showConsolePage: () => {},
  }
  vm.createContext(ctx)
  const add = main.slice(main.indexOf('function addActivationIssues('), main.indexOf('function noteActivationEvidence('))
  const inspect = main.slice(main.indexOf('function inspectWebBootFailure('), main.indexOf('function activationIssueOf('))
  vm.runInContext(add + '\n' + inspect, ctx)

  const text = [
    'HARNESS',
    'Failed to load plugins',
    'web boot: 1 required entry did not activate',
    '@deepseek-ai/dsh-client-ui-workspace (required): pending (waiting for service: uiWorkspace)',
  ].join('\n')
  assert.equal(ctx.inspectWebBootFailure(text), true, '失败页必须留证据，才进得了安全模式')
  assert.ok(server.activationIssues.length >= 1, '至少保留 required 条目')
  assert.equal(activation.attributeCulprits(server.activationIssues, []).length, 0, '没有原文就不归因')
  assert.ok(server.failureSnippetLogged, '要把页面片段记下来，便于对照用户设备')
  assert.ok(logs.some((m) => m.includes('未找到冲突原文')), '诊断日志要可检索')

  // 同一片段重复读取不重复刷日志
  const before = logs.length
  ctx.inspectWebBootFailure(text)
  assert.equal(logs.filter((m) => m.includes('未找到冲突原文')).length, 1, '同内容只记一次')
  assert.equal(logs.length, before, '重复读取不新增日志')

  // 只有冲突原文、没有“Failed to load plugins”页头时也必须能归因
  const conflictOnly = 'Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)'
  assert.equal(ctx.inspectWebBootFailure(conflictOnly), true, '冲突原文本身就是失败证据')
  const suspects = activation.attributeCulprits(server.activationIssues, [
    { npm: '@kenz1117/dsh-ui-usage-billing', name: '用量与计费' },
  ])
  assert.equal(suspects.length, 1, '冲突行要归因到用量与计费')
})

test('真实界面加载后解除过期的“界面未就绪”：页面证据是最终裁决', () => {
  assert.match(main, /function markUiPageHealthy\(\)/, '要有“页面已健康”的显式标记')
  assert.match(main, /function classifyUiPageSnapshot\(snap\)/, '页面判定要抽成可回归的纯函数')
  assert.match(main, /if \(composer\) return 'healthy'/, '检测到可见聊天输入框时判为健康')
  assert.match(main, /markUiPageHealthy\(\)/, '健康路径要调用 markUiPageHealthy')

  // 失败页取证必须走 frame 树，而不是只看主文档 + 同源 iframe：
  // 冲突行可能落在跨源 / 嵌套 frame 或开放 shadow root 里。
  assert.match(main, /async function collectPageSnapshot\(wc\)/, '要有按 frame 树取证的采集函数')
  assert.match(main, /walk\(wc\.mainFrame\)/, '从 mainFrame 开始遍历')
  assert.match(main, /f\.frames/, '递归遍历子 frame')
  assert.match(main, /f\.executeJavaScript/, '每个 frame 单独执行只读取证脚本')
  assert.match(main, /shadowRoot/, '开放 shadow root 的文本也要纳入')
  assert.match(main, /new URL\(url\)\.origin === expectedOrigin/, '只信 DSH 同源 frame，第三方嵌入内容不能当启动证据')
  assert.match(main, /f, i\) => i === 0 \|\| trusted\(f\)/, '主 frame 永远保留，其余按来源过滤')

  assert.match(main, /const st = await inspectWebUiPage\(wc, seq\)/, 'did-finish-load 后要触发 frame 树取证')
  assert.match(main, /seq !== pageInspectSeq/, '旧导航的延迟取证必须作废，不能污染新页面')
  assert.match(main, /server\.activationIssues !== issuesRef/, '期间换服务世代时，旧页面证据作废')
  assert.match(main, /verdict === 'healthy'\) markUiPageHealthy\(\)/,
    '纯函数判健康时才解除“界面未就绪”，聊天里讨论报错不算失败')
  assert.match(main, /setTimeout\(\(\) => \{ void tick\(\) \}, 3000\)/, '未定案时按 3 秒间隔继续取证')
  assert.match(main, /server\.uiPageHealthy = false/, '新世代/失败页都要重置或置否')
  assert.match(main, /degraded: critical\.length > 0 && server\.uiPageHealthy !== true/,
    '页面健康时 pluginUi.degraded 必须为 false，卡片不能挂着')
})

test('浏览器控制台证据：可选插件失败也能点名 usage-billing，但不擅自弹恢复页', () => {
  const activation = require('../plugin-activation')
  const server = { activationIssues: [], activationWindow: [], activationAutoOpened: false, uiPageHealthy: false }
  const state = { pages: [], broadcasts: 0 }
  const ctx = {
    server,
    pluginActivation: activation,
    IGNORED_NPM_PLUGINS: new Set(['dsh-computer-use-win']),
    ACTIVATION_WINDOW_LINES: 64,
    log: () => {},
    broadcastState: () => { state.broadcasts += 1 },
    consoleIsOpen: () => false,
    showConsolePage: (page) => { state.pages.push(page) },
  }
  vm.createContext(ctx)
  const add = main.slice(main.indexOf('function addActivationIssues('), main.indexOf('function noteActivationEvidence('))
  const note = main.slice(main.indexOf('function noteActivationEvidence('), main.indexOf('function markUiPageHealthy('))
  vm.runInContext(add + '\n' + note, ctx)

  // DSH 对「可选插件没激活」只 console.warn；失败页只渲染 required 条目，
  // 冲突行往往只在这里出现 —— 这是 dshl 能点名用量与计费的最后一条证据链。
  const warn = [
    'web boot: warning: 1 entry did not activate',
    '@kenz1117/dsh-ui-usage-billing: failed: Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)',
  ].join('\n')
  ctx.noteConsoleEvidence(warn)
  assert.equal(server.activationIssues.length, 1, '控制台证据要进统一去重表')
  const suspects = activation.attributeCulprits(server.activationIssues, [
    { npm: '@kenz1117/dsh-ui-usage-billing', name: '用量与计费' },
  ])
  assert.equal(suspects.length, 1, '冲突行要归因到用量与计费')
  assert.equal(state.pages.length, 0, '控制台证据不自动打开恢复页（界面可能完全正常）')
  assert.ok(state.broadcasts > 0, '证据变化要立刻推给界面')

  // 真实形态：插件把 register 异常吞掉，用 console.info 打印（本机实测日志原文）。
  // 冲突行前面没有 warning 头，也不是条目格式 —— 必须单独抠冲突原文。
  const swallowed = '[usage-billing] swallowed: shortcut-register-failed Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)'
  ctx.noteConsoleEvidence(swallowed)
  const swallowedSuspects = activation.attributeCulprits(server.activationIssues, [
    { npm: '@kenz1117/dsh-ui-usage-billing', name: '用量与计费' },
  ])
  assert.equal(swallowedSuspects.length, 1, 'console.info 里吞掉的冲突也要能点名用量与计费')

  // 页面失败证据走默认路径时仍然自动开页：两边的差别只在 opts.autoOpen
  const pageEvidence = [
    'HARNESS',
    'Failed to load plugins',
    'web boot: 1 required entry did not activate',
    '@deepseek-ai/dsh-client-ui-workspace (required): failed: Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)',
  ].join('\n')
  ctx.noteActivationEvidence(pageEvidence)
  assert.deepEqual(state.pages, ['recovery'], '真正的失败页证据照旧自动打开恢复页')

  assert.match(main, /wc\.on\('console-message'/, '独立窗口/标签页都要接浏览器控制台')
  assert.match(main, /noteConsoleEvidence\(text\)/, '控制台证据统一进 activationIssues，但不自动开页')
  assert.match(main, /recordConsoleTrail\(level, text\)/, 'info 级消息也要进控制台尾部（插件会把异常吞进 console.info）')
  assert.match(main, /u\.origin === new URL\(WEB_URL\)\.origin/, '只信 DSH 同源控制台消息')
})

test('页面判定纯函数：失败页/真实界面/加载中三种边界，以及“只 loading 不归因”', () => {
  const activation = require('../plugin-activation')
  const ctx = {}
  vm.createContext(ctx)
  const fn = main.slice(main.indexOf('function classifyUiPageSnapshot('), main.indexOf('async function inspectWebUiPage('))
  vm.runInContext(fn, ctx)
  const classify = (text, composer) => ctx.classifyUiPageSnapshot({ text, composer })

  const failedPage = [
    'HARNESS',
    'Failed to load plugins',
    'web boot: 1 required entry did not activate',
    '@deepseek-ai/dsh-client-ui-workspace (required): failed: Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)',
  ].join('\n')
  assert.equal(classify(failedPage, false), 'failed', 'HARNESS 失败页必须判失败')
  assert.equal(classify('', false), 'pending', '空页面不能下结论')
  assert.equal(classify('HARNESS\nLoading plugins…', false), 'pending', '加载中保持 pending，继续轮询')
  assert.equal(classify(failedPage, true), 'healthy', '有可见聊天输入框 = 真实界面，正文讨论报错不算失败')
  assert.equal(classify('web boot: 2 entries did not activate\nfoo: failed', false), 'failed',
    '没有 HARNESS 页头但有失败签名、且无输入框，同样判失败')

  // 只有 loading / pending 原因时，不能把任何第三方插件说成元凶
  const pendingOnly = [
    'HARNESS',
    'Failed to load plugins',
    'web boot: 1 required entry did not activate',
    '@deepseek-ai/dsh-client-ui-workspace (required): pending (waiting for service: uiWorkspace)',
  ].join('\n')
  const issues = activation.parseActivationIssues(pendingOnly)
  assert.ok(issues.length >= 1, 'pending 本身仍是 required 失败证据')
  const suspects = activation.attributeCulprits(issues, [
    { npm: '@kenz1117/dsh-ui-usage-billing', name: '用量与计费' },
  ])
  assert.equal(suspects.length, 0, '没有冲突原文就不能点名插件')
})

test('归因候选覆盖 Profile dependencies：市场停用（不在 bundles）的元凶仍能点名', () => {
  const ctx = {}
  vm.createContext(ctx)
  const fn = main.slice(main.indexOf('function profileBundlesOf('), main.indexOf('function writeProfileManifestAtomic('))
  vm.runInContext(fn, ctx)
  const manifest = {
    dependencies: { '@kenz1117/dsh-ui-usage-billing': '^1.8.9', '@deepseek-ai/dsh': '0.2.3-alpha.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh', 'dshmarket'] } },
  }
  const declared = ctx.profileDeclaredNpms(manifest)
  assert.ok(declared.includes('@kenz1117/dsh-ui-usage-billing'),
    'bundles 里没有、但 dependencies 里还在的插件必须参与归因候选')
  assert.ok(declared.includes('dshmarket'), 'bundles 仍然保留')
  assert.equal(new Set(declared).size, declared.length, '并集要去重')
  assert.deepEqual([...ctx.profileDeclaredNpms(null)], [], 'manifest 缺失时返回空数组')

  // 空/非法 dependencies 不能让状态计算抛错
  assert.deepEqual([...ctx.profileDeclaredNpms({ dependencies: null, dsh: null })], [])
})

test('控制台来源判定：本机 localhost/127.0.0.1 任意端口都采信，外部来源不采信', () => {
  const ctx = { WEB_URL: 'http://127.0.0.1:5100', URL }
  vm.createContext(ctx)
  const fn = main.slice(main.indexOf('function consoleSourceTrusted('), main.indexOf('function recordConsoleTrail('))
  vm.runInContext(fn, ctx)
  assert.equal(ctx.consoleSourceTrusted('http://127.0.0.1:5100/assets/index.js'), true)
  assert.equal(ctx.consoleSourceTrusted('http://localhost:5100/assets/index.js'), true, 'DSH 可能用 localhost 和 127.0.0.1 混着加载')
  assert.equal(ctx.consoleSourceTrusted(''), true, '无来源（内联脚本）允许')
  assert.equal(ctx.consoleSourceTrusted('about:blank'), true)
  assert.equal(ctx.consoleSourceTrusted('https://example.com/x.js'), false, '外部嵌入内容不能当启动证据')
  assert.equal(ctx.consoleSourceTrusted('devtools://devtools/bundled/x.js'), false)
  assert.match(main, /pushConsoleTrail\(\{ level, text: `\(来源被忽略 \$\{src\}\) \$\{text\}` \}\)/,
    '被来源判定挡下的消息要留在控制台尾部，便于区分“没有证据”和“证据被误杀”')
  assert.match(main, /插件失败页：控制台尾部=/, '失败页没有冲突原文时，要把控制台尾部记进日志')
})
