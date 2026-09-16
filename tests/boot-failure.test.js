// tests/boot-failure.test.js — 失败原因提取与确定性判定（node --test）
// 语料全部取自本机真实 server.err.log 的原文，避免"自己编一个刚好能过的输入"。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const bf = require('../boot-failure')

// —— 真实语料（server.err.log 原文） ——

const PLUGIN_TREE = [
  'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry better-sidebar (dsh-better-sidebar): The requested module \'@deepseek-ai/dsh-session\' does not provide an export named \'SessionLogOffset\'',
  '    at resolveBundleDir (file:///C:/Users/x/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:831:8)',
  '    at async runCli (file:///C:/Users/x/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js:146:4)',
].join('\n')

const BUNDLE_MISSING = [
  'Error: dsh: cannot resolve profile bundle "dsh-sidebar-qa" from the dsh installation or C:\\Users\\x\\.dsh\\profiles\\web; run \'dsh plugin --profile web install\' if its dependency is not installed',
  '    at resolveBundleDir (file:///C:/x/dsh-app-boot/lib/index.js:831:8)',
].join('\n')

const SETTINGS_BAD_INDENT = [
  'Error: simplegit',
  'Error: settings-file: invalid document at C:\\Users\\x\\.dsh\\settings.yaml: BAD_INDENT at line 20, column 1',
  '    at file:///C:/x/dsh-settings-file/lib/index.js:1:1',
].join('\n')

const MODULE_MISSING = [
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-typert-protocol' imported from C:\\Users\\x\\.dsh\\dshl\\bridge-payloads\\0.1.0-dev.1\\bridge-next.tgz\\lib\\index.js",
].join('\n')

const EACCES = [
  'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): listen EACCES: permission denied 127.0.0.1:3080',
  'Error: listen EACCES: permission denied 127.0.0.1:3080',
].join('\n')

// —— firstErrorLine ——

test('firstErrorLine：插件树失败取到插件那一行（这是用户最需要看到的一句）', () => {
  const line = bf.firstErrorLine(PLUGIN_TREE)
  assert.match(line, /does not provide an export named/u)
  assert.ok(line.length <= bf.LINE_MAX)
  assert.ok(!line.includes('    at '), '堆栈行不能被当成根因')
})

test('firstErrorLine：ANSI 与控制字符被剥掉', () => {
  const line = bf.firstErrorLine('\u001B[31mError: listen EACCES: permission denied 127.0.0.1:3080\u001B[0m')
  assert.equal(line, 'Error: listen EACCES: permission denied 127.0.0.1:3080')
})

test('firstErrorLine：空输入返回空串，不抛错', () => {
  assert.equal(bf.firstErrorLine(''), '')
  assert.equal(bf.firstErrorLine(undefined), '')
  assert.equal(bf.firstErrorLine(null), '')
})

test('firstErrorLine：没有任何错误行时返回空串（不编造）', () => {
  assert.equal(bf.firstErrorLine('[usage-billing] aggregated 112 sessions\nok'), '')
})

test('firstErrorLine：超长单行按上限截断', () => {
  const line = bf.firstErrorLine('Error: ' + 'x'.repeat(1000))
  assert.equal(line.length, bf.LINE_MAX)
})

// —— classifyBootFailure ——

test('classify：插件与新 DSH 不兼容 → plugin-tree，且点名是哪个包', () => {
  const c = bf.classifyBootFailure(PLUGIN_TREE)
  assert.equal(c.kind, 'plugin-tree')
  assert.equal(c.target, 'dsh-better-sidebar')
  assert.equal(c.eligible, true)
  assert.match(c.reason, /dsh-better-sidebar/u)
})

test('classify：bundle 声明与 node_modules 不一致 → bundle-missing + 包名', () => {
  const c = bf.classifyBootFailure(BUNDLE_MISSING)
  assert.equal(c.kind, 'bundle-missing')
  assert.equal(c.target, 'dsh-sidebar-qa')
  assert.equal(c.eligible, true)
  assert.match(c.reason, /dsh-sidebar-qa/u)
})

test('classify：settings.yaml 缩进坏了 → settings-invalid + 文件路径', () => {
  const c = bf.classifyBootFailure(SETTINGS_BAD_INDENT)
  assert.equal(c.kind, 'settings-invalid')
  assert.match(c.target, /settings\.yaml$/u)
  assert.equal(c.eligible, true)
  assert.match(c.reason, /BAD_INDENT/u)
})

test('classify：插件依赖缺失 → module-missing + 包名', () => {
  const c = bf.classifyBootFailure(MODULE_MISSING)
  assert.equal(c.kind, 'module-missing')
  assert.equal(c.target, '@deepseek-ai/dsh-typert-protocol')
  assert.equal(c.eligible, true)
})

test('classify：端口问题 → bind，且不参与确定性判定（已有独立的处理路径）', () => {
  const c = bf.classifyBootFailure(EACCES)
  assert.equal(c.kind, 'bind')
  assert.equal(c.eligible, false)
  assert.match(c.reason, /EACCES/u)
})

test('classify：无法识别 → unknown 且 eligible=false（fail open，宁可多试一次）', () => {
  const c = bf.classifyBootFailure('Error: 某种谁也没见过的新故障')
  assert.equal(c.kind, 'unknown')
  assert.equal(c.eligible, false)
  assert.match(c.line, /谁也没见过/u)
})

test('classify：完全无输出时不编造原因', () => {
  const c = bf.classifyBootFailure('')
  assert.equal(c.kind, 'unknown')
  assert.equal(c.line, '')
  assert.equal(c.signature, '')
  assert.match(c.reason, /没有输出/u)
})

test('classify：stack trace 在前、根因在后也能命中（真实日志就是这个顺序）', () => {
  const text = ['    at foo (file:///a.js:1:1)', '    at bar (file:///b.js:2:2)', BUNDLE_MISSING].join('\n')
  assert.equal(bf.classifyBootFailure(text).kind, 'bundle-missing')
})

// —— 签名归一化 ——

test('signatureOf：行号/端口/PID 的差异不影响同一性（BAD_INDENT line 11 vs line 20）', () => {
  const a = bf.signatureOf('Error: settings-file: invalid document at C:\\x\\.dsh\\settings.yaml: BAD_INDENT at line 11, column 1')
  const b = bf.signatureOf('Error: settings-file: invalid document at C:\\x\\.dsh\\settings.yaml: BAD_INDENT at line 20, column 1')
  assert.equal(a, b)
})

test('signatureOf：包名不同必须区分（不能把两个插件的故障算成同一个）', () => {
  const a = bf.signatureOf('cannot resolve profile bundle "dsh-sidebar-qa"')
  const b = bf.signatureOf('cannot resolve profile bundle "dsh-better-sidebar"')
  assert.notEqual(a, b)
})

test('signatureOf：随机 UUID 被抹平（临时目录名不该影响同一性）', () => {
  const a = bf.signatureOf('open C:\\tmp\\a1b2c3d4-1111-2222-3333-444455556666\\x.json failed')
  const b = bf.signatureOf('open C:\\tmp\\ffffffff-aaaa-bbbb-cccc-dddddddddddd\\x.json failed')
  assert.equal(a, b)
})

// —— 连续次数与确定性判定 ——

test('nextFailureStreak：同签名累加，换签名从 1 重来', () => {
  let s = bf.nextFailureStreak(null, 'sig-a')
  assert.deepEqual(s, { signature: 'sig-a', count: 1 })
  s = bf.nextFailureStreak(s, 'sig-a')
  assert.equal(s.count, 2)
  s = bf.nextFailureStreak(s, 'sig-b')
  assert.deepEqual(s, { signature: 'sig-b', count: 1 })
})

test('nextFailureStreak：空签名清零（无证据就不算连续失败）', () => {
  const s = bf.nextFailureStreak({ signature: 'sig-a', count: 3 }, '')
  assert.deepEqual(s, { signature: '', count: 0 })
  assert.equal(bf.isDeterministic({ eligible: true, count: 0 }), false)
})

test('isDeterministic：同一种可判定失败第二次即成立；不可判定的种类永不成立', () => {
  assert.equal(bf.isDeterministic({ eligible: true, count: 1 }), false)
  assert.equal(bf.isDeterministic({ eligible: true, count: 2 }), true)
  assert.equal(bf.isDeterministic({ eligible: false, count: 9 }), false)
  assert.equal(bf.isDeterministic(null), false)
  assert.equal(bf.isDeterministic(undefined), false)
})

test('端到端：三次同类插件树失败在第 2 次就被判定为确定性（不必烧完 5 次额度）', () => {
  let streak = null
  const seen = []
  for (let i = 0; i < 3; i++) {
    const c = bf.classifyBootFailure(PLUGIN_TREE)
    streak = bf.nextFailureStreak(streak, c.signature)
    seen.push(bf.isDeterministic({ eligible: c.eligible, count: streak.count }))
  }
  assert.deepEqual(seen, [false, true, true])
})

test('端到端：端口类失败连续 3 次也不触发确定性判定', () => {
  let streak = null
  let deterministic = false
  for (let i = 0; i < 3; i++) {
    const c = bf.classifyBootFailure(EACCES)
    streak = bf.nextFailureStreak(streak, c.signature)
    deterministic = bf.isDeterministic({ eligible: c.eligible, count: streak.count })
  }
  assert.equal(deterministic, false)
})
