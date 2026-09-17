// tests/health-gate-wiring.test.js — 健康门（maybeCaptureHealthy）接线护栏。
//
// 为什么单独有这条：v1.4.5-alpha.2（c721558）把 `let healthCaptured = false` 并进了上一行的行尾注释，
// 于是 maybeCaptureHealthy() 每次调用都在第一行抛 ReferenceError —— 健康快照自 2026-09-16 20:47 起
// 再没捕获过，dshl.log 里攒了 51 条 app.uncaught，而静态护栏全绿（这段代码从没被真正跑过）。
// 这里把声明 + 真函数体抽出来真跑一遍：声明再被吞、提前 return、单飞标记失效都会立刻红。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n?/gu, '\n')

test('healthCaptured 的声明必须是真正的代码行（被行尾注释吞掉就是这样坏的）', () => {
  const line = main.split('\n').find((l) => l.includes('healthCaptured')) || ''
  assert.match(main, /\nlet healthCaptured = false/, 'healthCaptured 必须有独立声明行')
  assert.ok(!/\/\/[^\n]*let healthCaptured/u.test(line), '声明不许落在行尾注释里：' + line.trim())
})

/** 抽出"声明行 + maybeCaptureHealthy 真函数体"，注入依赖跑一遍。 */
function loadGate(overrides = {}, { declAsComment = false } = {}) {
  const declAt = main.indexOf('let healthCaptured')
  assert.ok(declAt > 0, '找不到 healthCaptured 声明')
  const declLine = main.slice(declAt, main.indexOf('\n', declAt))
  const start = main.indexOf('function maybeCaptureHealthy(')
  const end = main.indexOf('\n}\n', start) + 2
  assert.ok(start > 0 && end > start, '找不到 maybeCaptureHealthy')
  const decl = declAsComment ? '// ' + declLine : declLine
  const src = decl + '\n' + main.slice(start, end) + '\nreturn { maybeCaptureHealthy, captured: () => healthCaptured }'

  const calls = { capture: [], invalidated: 0, events: [] }
  const ctx = {
    SELF_TEST: false,
    server: { running: () => true, managed: () => true },
    health: { captureHealthy: (o) => { calls.capture.push(o); return { status: 'captured', slotId: 'slot-9' } } },
    app: { getVersion: () => '1.4.6' },
    envReport: { dsh: { kind: 'global' }, plan: { dshVersion: '0.1.6-alpha.2' }, node: { version: '24.16.0' } },
    PORT: 3081,
    invalidateRecoverySlots: () => { calls.invalidated++ },
    lifecycle: { emit: (name, detail) => calls.events.push({ name, detail }) },
    log: () => {},
    ...overrides,
  }
  const names = Object.keys(ctx)
  const api = new Function(...names, src)(...names.map((k) => ctx[k]))
  return { api, calls }
}

test('服务就绪时捕获一次健康快照：不抛错、写单飞标记、作废恢复槽缓存', () => {
  const { api, calls } = loadGate()
  assert.doesNotThrow(() => api.maybeCaptureHealthy('page-loaded'))
  assert.deepEqual(calls.capture, [{
    dshlVersion: '1.4.6',
    dshKind: 'global',
    dshVersion: '0.1.6-alpha.2',
    nodeVersion: '24.16.0',
    port: 3081,
    reason: 'page-loaded',
  }], 'captureHealthy 的入参要带齐版本/来源/端口')
  assert.equal(api.captured(), true, '捕获后必须写单飞标记')
  assert.equal(calls.invalidated, 1, '捕获后要作废恢复槽缓存（否则恢复页读到旧列表）')
  assert.deepEqual(calls.events, [{ name: 'health.capture', detail: { slotId: 'slot-9', reason: 'page-loaded' } }])

  api.maybeCaptureHealthy('survived-120s')
  assert.equal(calls.capture.length, 1, '单飞：同一次运行只捕获一次')
})

test('服务不是自己拉起的 / 自检模式：不捕获，也不抛错', () => {
  const adopted = loadGate({ server: { running: () => true, managed: () => false } })
  adopted.api.maybeCaptureHealthy('page-loaded')
  assert.equal(adopted.calls.capture.length, 0, '接管的实例无从证明健康，不该捕获')

  const stopped = loadGate({ server: { running: () => false, managed: () => true } })
  stopped.api.maybeCaptureHealthy('page-loaded')
  assert.equal(stopped.calls.capture.length, 0, '服务没在跑就不该捕获')

  const selfTest = loadGate({ SELF_TEST: true })
  selfTest.api.maybeCaptureHealthy('page-loaded')
  assert.equal(selfTest.calls.capture.length, 0, '自检模式不写真实快照（这也是它抓不到本 bug 的原因）')
})

test('负样本：声明被注释吞掉时抛 ReferenceError（复刻 9/16 线上那次回归）', () => {
  const broken = loadGate({}, { declAsComment: true })
  assert.throws(() => broken.api.maybeCaptureHealthy('page-loaded'), /healthCaptured is not defined/,
    '声明被吞必须表现为 ReferenceError —— 这正是 dshl.log 里 51 条 app.uncaught 的样子')
  assert.equal(broken.calls.capture.length, 0, '抛错时快照自然也没写')
})
