// tests/plugin-activation.test.js — 「插件没生效」证据的解析契约
//
// 全部用例都来自 2026-09-29 实测日志原文：新机器 dsh 0.1.7-rc.2 上
// @agents-anywhere/dsh-bridge-next 启动时 `failed to import`，服务照常就绪，
// 插件市场一直说「已安装，重启后生效」——重启永远不会改变它。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const activation = require('../plugin-activation')

const BRIDGE = '@agents-anywhere/dsh-bridge-next'

test('warning 头 + 条目行：failed to import 被认成「未激活」', () => {
  const text = [
    'dsh: warning: 1 entry did not activate',
    `agents-anywhere-bridge-next (${BRIDGE}): failed to import`,
  ].join('\n')
  const issues = activation.parseActivationIssues(text)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'inactive')
  assert.equal(issues[0].packageName, BRIDGE)
  assert.equal(issues[0].entryId, 'agents-anywhere-bridge-next')
  assert.equal(issues[0].detail, 'failed to import')
  assert.deepEqual(issues[0].services, [])
  assert.equal(activation.describeActivationIssue(issues[0]), '启动时未激活：failed to import')
})

test('pending：缺服务时把服务名抠出来（重启也不会有人提供）', () => {
  const text = [
    'dsh: warning: 1 entry did not activate',
    `agents-anywhere-bridge-next (${BRIDGE}): pending (waiting for service: sessions)`,
  ].join('\n')
  const issues = activation.parseActivationIssues(text)
  assert.deepEqual(issues[0].services, ['sessions'])
  assert.match(activation.describeActivationIssue(issues[0]), /缺 sessions 服务/)
})

test('pending：多个服务按序全列出', () => {
  const text = [
    'dsh: warning: 1 entry did not activate',
    `x (${BRIDGE}): pending (waiting for services: sessions, sessionQuery, workspaceRegistry)`,
  ].join('\n')
  const issues = activation.parseActivationIssues(text)
  assert.deepEqual(issues[0].services, ['sessions', 'sessionQuery', 'workspaceRegistry'])
  assert.match(activation.describeActivationIssue(issues[0]), /sessions、sessionQuery、workspaceRegistry/)
})

test('skipping profile bundle：peer 兼容闸的整行原因只提炼出「与 dsh x 不兼容」', () => {
  const text = 'dsh: skipping profile bundle "@agents-anywhere/dsh-bridge-next": Error: Plugin '
    + '@agents-anywhere/dsh-bridge-next@0.1.0-dev.2 is incompatible with dsh 0.1.7-rc.1: peerDependencies '
    + '{"@deepseek-ai/dsh-typert-protocol":"0.1.5-rc.1"}. Running it may cause crashes or data loss. '
    + 'To accept this risk explicitly, grant the exact-version exemption …'
  const issues = activation.parseActivationIssues(text)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].kind, 'skipped')
  assert.equal(issues[0].packageName, BRIDGE)
  assert.equal(activation.describeActivationIssue(issues[0]), '启动时被跳过：与 dsh 0.1.7-rc.1 不兼容')
})

test('skipping profile bundle：非兼容原因照原样短句呈现', () => {
  const text = 'dsh: skipping profile bundle "dsh-x": Error: dsh: cannot resolve profile bundle "dsh-x" from the dsh installation or C:\\Users\\a\\.dsh\\profiles\\web; run \'dsh plugin --profile web install\' if its dependency is not installed'
  const issues = activation.parseActivationIssues(text)
  assert.equal(issues[0].kind, 'skipped')
  const described = activation.describeActivationIssue(issues[0])
  assert.match(described, /^启动时被跳过：/)
  assert.ok(described.length <= 140, '长尾要截断，不能整段塞进卡片')
  assert.ok(!described.includes('dsh plugin --profile web install'), '处置建议属于 tooltip，不该挤进单行文案')
})

test('控制台文本（带 [时间] 前缀）同样解析', () => {
  const text = [
    '[2026-09-29T08:54:47.923+08:00] dsh: warning: 1 entry did not activate',
    `[2026-09-29T08:54:47.923+08:00] agents-anywhere-bridge-next (${BRIDGE}): failed to import`,
  ].join('\n')
  const issues = activation.parseActivationIssues(text)
  assert.equal(issues.length, 1)
  assert.equal(issues[0].detail, 'failed to import')
})

test('多轮启动重复出现同一条 → 去重成一条', () => {
  const one = `dsh: warning: 1 entry did not activate\nagents-anywhere-bridge-next (${BRIDGE}): failed to import`
  const issues = activation.parseActivationIssues([one, one, one].join('\n'))
  assert.equal(issues.length, 1)
})

test('两条不同条目的 warning 都能收到（2 entries）', () => {
  const text = [
    'dsh: warning: 2 entries did not activate',
    `a (dsh-a): failed to import`,
    `b (dsh-b): pending (waiting for service: sessions)`,
  ].join('\n')
  const issues = activation.parseActivationIssues(text)
  assert.deepEqual(issues.map((i) => i.packageName), ['dsh-a', 'dsh-b'])
})

test('普通日志不会被误判成激活失败（没有 warning 头的 `x (y): z` 一律忽略）', () => {
  const text = [
    '[2026-09-29T09:27:16.188+09:00] [usage-billing] DeepSeek（deepseek）鉴权失败：请检查 llm-pi-ai 设置中该 provider 的凭据环境变量是否正确/有效。',
    'some-plugin (some-package): something happened',
    '',
    'dsh: ready',
  ].join('\n')
  assert.deepEqual(activation.parseActivationIssues(text), [])
  assert.deepEqual(activation.parseActivationIssues(''), [])
  assert.deepEqual(activation.parseActivationIssues(undefined), [])
})

test('findActivationIssue：按包名取条目，取不到给 undefined', () => {
  const issues = activation.parseActivationIssues(`dsh: warning: 1 entry did not activate\nx (${BRIDGE}): failed to import`)
  assert.equal(activation.findActivationIssue(issues, BRIDGE).detail, 'failed to import')
  assert.equal(activation.findActivationIssue(issues, 'dsh-other'), undefined)
  assert.equal(activation.findActivationIssue(null, BRIDGE), undefined)
})

test('hint 必须把"重启不会改变"说清楚，并带原因原文', () => {
  const issues = activation.parseActivationIssues(`dsh: warning: 1 entry did not activate\nx (${BRIDGE}): failed to import`)
  const hint = activation.activationIssueHint(issues[0])
  assert.match(hint, /failed to import/)
  assert.match(hint, /重启不会改变/)
})

test('启动器自检条目（import-check）：与 DSH 解析来的证据同形，但说明"发生在起服务之前"', () => {
  const issue = activation.importCheckIssue(BRIDGE,
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-session-title' imported from /x/lib/index.js")
  assert.equal(issue.kind, 'import-check')
  assert.equal(issue.packageName, BRIDGE)
  const described = activation.describeActivationIssue(issue)
  assert.match(described, /^启动前自检失败：/)
  assert.match(described, /Cannot find package '@deepseek-ai\/dsh-session-title'/)
  const hint = activation.activationIssueHint(issue)
  assert.match(hint, /起服务之前/)
  assert.match(hint, /重启不会改变/)
  assert.equal(activation.findActivationIssue([issue], BRIDGE), issue)
})

test('importCheckIssue：空 detail 也不产出空冒号文案（fail-closed 兜底）', () => {
  const described = activation.describeActivationIssue(activation.importCheckIssue(BRIDGE, ''))
  assert.match(described, /启动前自检失败：/)
  assert.doesNotMatch(described, /：$/u, '不能只留一个空冒号')
})

// ---------- 冲突元凶归因：从快捷键前缀对回具体第三方包 ----------
const USAGE = '@kenz1117/dsh-ui-usage-billing'
const WORKSPACE = '@deepseek-ai/dsh-client-ui-workspace'
const conflict = (detail) => ({
  kind: 'inactive',
  packageName: WORKSPACE,
  entryId: 'deepseek-workspace',
  detail,
  services: [],
})

test('shortcutPrefixes：只抠 Conflicting shortcut defaults 段里的前缀', () => {
  assert.deepEqual(
    activation.shortcutPrefixes('failed: Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)'),
    ['session', 'usage-billing'],
  )
  assert.deepEqual(activation.shortcutPrefixes('some random a.b error'), [])
})

test('packageAliases：dsh-ui-usage-billing → usage-billing；dsh-rewind-plugin → rewind', () => {
  const usage = activation.packageAliases(USAGE)
  assert.ok(usage.includes('usage-billing'))
  assert.ok(activation.packageAliases('dsh-rewind-plugin').includes('rewind'))
  assert.ok(activation.packageAliases('@agents-anywhere/dsh-bridge-next').includes('bridge'))
})

test('attributeCulprits：一个冲突 → 只归因到唯一匹配的第三方包', () => {
  const issues = [conflict('failed: Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)')]
  const found = activation.attributeCulprits(issues, [
    { npm: USAGE, name: '用量与计费' },
    { npm: 'dsh-better-sidebar', name: '侧边栏' },
  ])
  assert.equal(found.length, 1)
  assert.equal(found[0].npm, USAGE)
  assert.equal(found[0].name, '用量与计费')
  assert.match(found[0].reasons[0], /usage-billing\.open-dashboard/)
})

test('attributeCulprits：多个冲突 → 多个元凶；同一插件两条冲突只出现一次', () => {
  const issues = [
    conflict('Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)'),
    conflict('Error: Conflicting shortcut defaults: usage-billing.open-settings and image-gen.open (desktop:macos)'),
  ]
  const found = activation.attributeCulprits(issues, [
    { npm: USAGE, name: '用量与计费' },
    { npm: 'dsh-image-gen', name: '图像生成' },
  ])
  assert.deepEqual(found.map((f) => f.npm).sort(), [USAGE, 'dsh-image-gen'].sort())
  const usage = found.find((f) => f.npm === USAGE)
  assert.equal(usage.reasons.length, 2)
})

test('attributeCulprits：官方/通用前缀、歧义匹配、无匹配都不归因（退回安全模式）', () => {
  const generic = [conflict('Error: Conflicting shortcut defaults: session.toggleRead and workspace.open (desktop:macos)')]
  assert.deepEqual(activation.attributeCulprits(generic, [{ npm: 'dsh-session', name: '会话' }]), [])

  const ambiguous = [conflict('Error: Conflicting shortcut defaults: session.toggleRead and usage-billing.open-dashboard (desktop:macos)')]
  assert.deepEqual(activation.attributeCulprits(ambiguous, [
    { npm: USAGE, name: '用量与计费' },
    { npm: '@other/dsh-usage-billing', name: '另一个计费' },
  ]), [])

  const none = [conflict('Error: Conflicting shortcut defaults: a.one and b.two (desktop:macos)')]
  assert.deepEqual(activation.attributeCulprits(none, [{ npm: USAGE, name: '用量与计费' }]), [])
})

test('attributeCulprits：报错里直接点名包名时也认', () => {
  const issues = [conflict(`failed: Error: plugin ${USAGE} broke the service chain`)]
  const found = activation.attributeCulprits(issues, [{ npm: USAGE, name: '用量与计费' }])
  assert.equal(found.length, 1)
  assert.equal(found[0].npm, USAGE)
})

test('attributeCulprits：失败条目本身是第三方 bundle、且前缀对得上时也算元凶', () => {
  const issue = {
    kind: 'inactive',
    packageName: USAGE,
    entryId: 'usage-billing',
    detail: 'failed: Error: Conflicting shortcut defaults: usage-billing.open and session.toggleRead (desktop:macos)',
    services: [],
  }
  const found = activation.attributeCulprits([issue], [{ npm: USAGE, name: '用量与计费' }])
  assert.equal(found.length, 1)
  assert.equal(found[0].npm, USAGE)
})

test('mentionsPackage：完整点名才算，子串不算', () => {
  assert.equal(activation.mentionsPackage('failed: dsh-image broke', 'dsh-image'), true)
  assert.equal(activation.mentionsPackage('failed: dsh-image-gen broke', 'dsh-image'), false,
    'dsh-image 不能因为 dsh-image-gen 被误归因')
  assert.equal(activation.mentionsPackage('failed: ' + USAGE + ' broke', USAGE), true)
  assert.equal(activation.mentionsPackage('failed: usage-billing.open broke', 'dsh-ui-usage-billing'), false,
    '短名不完整匹配时不走点名归因（前缀归因另有规则）')
})
