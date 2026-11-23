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
  assert.match(main, /inspectWebBootFailure\(text\)/, 'did-finish-load 时要把页面文本送进解析')
  assert.match(main, /setTimeout\(inspect, 2000\)/, 'SPA 延迟挂载时补读一次')
  assert.match(main, /kind: 'ui-page'/, '解析不出条目也要留一条合成证据，至少能进安全模式')
  assert.match(main, /document\.querySelector\('textarea,\[contenteditable=true\],input\[type=text\]'\)/,
    '只在没有聊天输入框的失败页采信，避免聊天正文里的报错文本误触发')
  assert.match(main, /function addActivationIssues\(found\)/, 'stderr 与页面两个来源共用同一份去重/推送/自动打开逻辑')
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

test('真实界面加载后解除过期的“界面未就绪”：页面证据是最终裁决', () => {
  assert.match(main, /function markUiPageHealthy\(\)/, '要有“页面已健康”的显式标记')
  assert.match(main, /st && st\.healthy\) markUiPageHealthy\(\)/, '检测到可见聊天输入框时调用')
  assert.match(main, /server\.uiPageHealthy = false/, '新世代/失败页都要重置或置否')
  assert.match(main, /degraded: critical\.length > 0 && server\.uiPageHealthy !== true/,
    '页面健康时 pluginUi.degraded 必须为 false，卡片不能挂着')
})
