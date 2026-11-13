// tests/handover-evidence-wiring.test.js — 交接窗口/候选证据/崩溃取证的接线护栏
//
// 对应 2026-11 排查：本机两次真实误判（交接 20.6s/20.4s 后被判崩溃，5~6s 后又能认领成功），
// 根因是 HANDOVER_MAX_MS=20s 短于真实 DSH 冷启动；同时 findListenPid 的 execFile 失败被静默吞成 0。
// 这些断言防的是"改回去"：窗口缩回 20s、候选不再带创建时间、崩溃现场没有取证日志。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')

test('交接窗口必须覆盖实测晚绑定：HANDOVER_MAX_MS >= 45000', () => {
  const m = main.match(/const HANDOVER_MAX_MS = (\d+)/u)
  assert.ok(m, 'main.js 里必须仍有 HANDOVER_MAX_MS 常量')
  assert.ok(Number(m[1]) >= 45000, `HANDOVER_MAX_MS 不能缩回 20s（当前 ${m[1]}）`)
})

test('后继候选必须带创建时间，并能与本世代 spawn 时刻比较', () => {
  assert.match(main, /CreationDate\.ToUniversalTime\(\)\.Ticks/u, 'CIM 扫描必须带回进程创建时间')
  assert.match(main, /server\.genStartedAt = Date\.now\(\)/u, 'spawn 时必须记录本世代起点')
  assert.match(main, /dotNetTicksToEpochMs/u, '创建时间必须经纯函数换算（可单测）')
})

test('runHandover 必须区分候选存活/本世代，并把取证带进崩溃记录', () => {
  assert.match(main, /matchedAlive/u, '交接裁决必须传入候选存活状态')
  assert.match(main, /matchedCurrentGen/u, '交接裁决必须传入候选是否本世代')
  assert.match(main, /交接取证：/u, '崩溃时必须把 listener/matched/portOpen 等证据写进日志')
  assert.match(main, /verdict: 'crash'[\s\S]{0,200}?evidence/u, 'crash 的交接记录必须带 evidence 字段')
})

test('占有者裁决：查不到 PID 但有端口应答不得当空闲；probeDsh 不再被 PID 门控', () => {
  assert.match(main, /portOpen: lastOpen/u, 'handlePortOccupied 必须把 portOpen 传给 classifyOccupant')
  assert.match(main, /probeOk: probe\.ok && pid > 0/u, '指纹命中但 PID 未知不能据此接管')
  assert.match(main, /\(pid > 0 \|\| lastOpen\) \? await probeDsh\(\)/u, 'pid=0 但端口有人应答时仍要探 HTTP 指纹')
  assert.match(main, /serviceStopping\(\) \|\| reallyExit \|\| server\.gen !== gen/u, 'while(true) 必须有停止/世代兜底，不能空转')
})

test('监听取证三态必须进入交接裁决：未知占用不得判崩溃/换端口', () => {
  assert.match(main, /const lr = await findListener\(\)/u, 'runHandover 必须取三态结果')
  assert.match(main, /listenerStatus,/u, '三态必须传给 classifyHandover')
  assert.match(main, /portOpen: serving,/u, '端口是否有人应答必须传给 classifyHandover')
  assert.match(main, /verdict === 'occupied-unverified'/u, '未核实占用必须有独立分支')
  assert.match(main, /listener-unverified/u, '未核实占用必须留下生命周期证据')
  assert.match(main, /server\.suggestedPort = 0/u, '未核实占用不得自动建议换端口')
})

test('停止后的端口复核：claimed 停止后与 sweep 结束都要检查端口仍被占用', () => {
  assert.match(main, /停止后端口 \$\{PORT\} 仍有应答（原 PID/u, 'claimed 停止后必须复核端口释放')
  assert.match(main, /停止后端口 \$\{PORT\} 仍被 PID/u, '停止 sweep 后必须拒绝残留监听者')
})

test('监听 PID 取证失败必须留证（不能静默吞成 0）', () => {
  assert.match(main, /require\('\.\/service-listener'\)/u, '监听取证必须走可注入 IO 的 service-listener 模块')
  assert.match(main, /listenerProbe\.createListenerResolver/u, 'main.js 必须创建监听解析器')
  assert.match(main, /listenerResolver\.resolve\(PORT/u, 'findListenPid 必须通过解析器取三态结果')
  assert.match(main, /监听者无法核实|兜底识别/u, 'unknown/兜底命中必须留下可读日志')
  assert.match(main, /function logThrottled/u, '取证日志必须节流，避免轮询刷屏')
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.build.files.includes('service-listener.js'), 'service-listener.js 必须在 build.files 里，否则打包后 require 失败')
})
