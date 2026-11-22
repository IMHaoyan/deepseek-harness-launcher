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

// 真实语料（2026-11-22，0.2.3-alpha.1 安装树的 `dsh --version` 原文，路径按既有语料惯例改写为 x）：
// DSH 安装包**自己的内置组件**在加载期就引用了依赖里不存在的导出 —— 与任何用户插件无关。
const CORE_MISMATCH = [
  'file:///C:/Users/x/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:7',
  'import Loader, { EntryGroup, EntryTree, EntryValidationError, ModuleLoader, formatIssues, isJsExpr, relocate, validateOptions } from "@deepseek-ai/cordis-plugin-loader";',
  '                                        ^^^^^^^^^^^^^^^^^^^^',
  "SyntaxError: The requested module '@deepseek-ai/cordis-plugin-loader' does not provide an export named 'EntryValidationError'",
  '    at #asyncInstantiate (node:internal/modules/esm/module_job:327:21)',
].join('\n')

// 同样的 ESM 报错，但导入方是装在 profile 里的用户插件：仍按插件问题处理。
const PROFILE_EXPORT_MISMATCH = [
  'file:///C:/Users/x/.dsh/profiles/web/node_modules/my-third-party-plugin/lib/index.js:3',
  'import { SessionLogOffset } from "@deepseek-ai/dsh-session";',
  "SyntaxError: The requested module '@deepseek-ai/dsh-session' does not provide an export named 'SessionLogOffset'",
  // 公共栈帧里一定会出现安装树路径 —— 判据不能拿它当"导入方"
  '    at async runCli (file:///C:/Users/x/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js:21:9)',
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

// 2026-11-22：0.2.3-alpha.1 的安装包自己坏了（app-boot 引用 loader 未导出的 EntryValidationError）。
// 旧规则只看 "does not provide an export named" 就判 plugin-tree，说明页于是让用户去禁用插件 ——
// 用户照做后错误一字不变。这条测试钉住"内核自身依赖不匹配"与"插件不兼容"必须分开。
test('classify：DSH 安装树自身导出缺失 → dsh-core-mismatch，不说成插件问题', () => {
  const c = bf.classifyBootFailure(CORE_MISMATCH)
  assert.equal(c.kind, 'dsh-core-mismatch')
  assert.equal(c.target, '', '内核问题不该点名某个插件')
  assert.equal(c.eligible, true, '磁盘上的坏安装树是确定性失败，重试无用')
  assert.match(c.reason, /dsh-app-boot/u, '要点名坏在哪个内置组件：' + c.reason)
  assert.match(c.reason, /EntryValidationError/u, '要点名缺的导出：' + c.reason)
  assert.match(c.reason, /禁用或卸载插件无效/u, '必须直接告诉用户禁用插件没用：' + c.reason)
  assert.doesNotMatch(c.reason, /插件与新版本 DSH 不兼容|插件 [^ ]+ 加载失败/u, '不能把锅甩给用户插件：' + c.reason)
  // 证据行仍是用户最需要看的那一句
  assert.match(c.line, /does not provide an export named/u)
})

test('classify：同样的导出缺失但导入方在 profile 里 → 仍按插件问题处理（不误伤）', () => {
  const c = bf.classifyBootFailure(PROFILE_EXPORT_MISMATCH)
  assert.equal(c.kind, 'plugin-tree')
  assert.match(c.reason, /插件引用了当前 DSH 不再提供的导出/u)
})

test('classify：有 loader entry 证据时，即使栈里出现安装树路径也不判内核问题', () => {
  // PLUGIN_TREE 的栈帧同样指向 dsh-app-boot —— 判据必须以 loader entry 这段反证优先
  assert.equal(bf.coreMismatchOf(PLUGIN_TREE), null)
  assert.equal(bf.classifyBootFailure(PLUGIN_TREE).kind, 'plugin-tree')
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

// —— 多插件失败：一次失败里有几个插件坏了 ——
// DSH 把多插件激活失败聚合成 AggregateError 并**逐条打印**（dsh-app-boot/lib/index.js:4260）。
// classifyBootFailure 只返回一个 target 是刻意的（挑最具体的那条），但界面需要知道"还有谁"，
// 否则用户禁用掉第一个、重启、又被第二个拦住，看起来像"修了没用"的循环。
const MULTI_PLUGIN = [
  'Error: dsh: plugin tree failed to load',
  'PluginActivationError: failed to import loader entry sidebar (dsh-ui-kit)',
  'PluginActivationError: failed to import loader entry charts (dsh-charts)',
  'PluginActivationError: failed to import loader entry theme (dsh-theme-pack)',
].join('\n')

test('pluginTargets：收集所有被点名的包，去重保序，不受分类优先级影响', () => {
  assert.deepEqual(bf.pluginTargets(MULTI_PLUGIN), ['dsh-ui-kit', 'dsh-charts', 'dsh-theme-pack'])
  // 同一个包出现两次只算一个
  assert.deepEqual(bf.pluginTargets(MULTI_PLUGIN + '\n' + MULTI_PLUGIN), ['dsh-ui-kit', 'dsh-charts', 'dsh-theme-pack'])
  // 其他两类规则里的包名同样算"被点名"
  assert.deepEqual(bf.pluginTargets('cannot resolve profile bundle "dsh-x"'), ['dsh-x'])
  assert.deepEqual(bf.pluginTargets("Cannot find package 'left-pad'"), ['left-pad'])
})

test('pluginTargets：识别不出就是空数组，且有长度上限（不许把 stderr 抄进界面）', () => {
  assert.deepEqual(bf.pluginTargets('Error: 谁也没见过的新故障'), [])
  assert.deepEqual(bf.pluginTargets(''), [])
  assert.deepEqual(bf.pluginTargets(null), [])
  assert.deepEqual(bf.pluginTargets(undefined), [])
  const many = Array.from({ length: 30 }, (_, i) => `failed to import loader entry e${i} (pkg-${i})`).join('\n')
  assert.equal(bf.pluginTargets(many).length, bf.MAX_TARGETS)
})

test('classifyBootFailure 带上 targets，但 target 仍是那一个（判定口径不变）', () => {
  const c = bf.classifyBootFailure(MULTI_PLUGIN)
  assert.equal(c.kind, 'plugin-tree')
  assert.equal(c.target, 'dsh-ui-kit', 'target 仍是"最具体的那一条"，不许被 targets 影响')
  assert.deepEqual(c.targets, ['dsh-ui-kit', 'dsh-charts', 'dsh-theme-pack'])
  // 单插件失败时 targets 恰好就是那一个，界面据此判断"不用提还有别的"
  assert.deepEqual(bf.classifyBootFailure(PLUGIN_TREE).targets, ['dsh-better-sidebar'])
  // 非插件类失败也带上（可能为空），字段始终存在，消费方不必判 undefined
  assert.deepEqual(bf.classifyBootFailure(EACCES).targets, [])
  assert.ok(Array.isArray(bf.classifyBootFailure('Error: 未知').targets))
})
