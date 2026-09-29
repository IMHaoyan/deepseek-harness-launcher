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
