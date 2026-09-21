// tests/crash-note.test.js — 崩溃提示分级（node --test）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crashNote = require('../crash-note')

const T0 = '2026-09-11T10:00:00.000Z'

test('nextStreak：首次记录为 1，窗口内累加，窗口外重新计数', () => {
  assert.equal(crashNote.nextStreak({}, T0), 1)
  assert.equal(crashNote.nextStreak({ streak: 1, lastAt: T0 }, '2026-09-11T12:00:00.000Z'), 2)
  assert.equal(crashNote.nextStreak({ streak: 2, lastAt: T0 }, '2026-09-12T09:59:00.000Z'), 3)
  // 超过 24 小时 → 重新从 1 开始
  assert.equal(crashNote.nextStreak({ streak: 3, lastAt: T0 }, '2026-09-12T11:00:00.000Z'), 1)
  // 时间倒流（时钟异常/旧记录）→ 不累加
  assert.equal(crashNote.nextStreak({ streak: 3, lastAt: T0 }, '2026-09-11T09:00:00.000Z'), 1)
})

test('nextStreak：脏数据一律按 1，且不超过上限', () => {
  assert.equal(crashNote.nextStreak({ streak: 'x', lastAt: 5 }, T0), 1)
  assert.equal(crashNote.nextStreak({ streak: 3, lastAt: T0 }, ''), 1)
  assert.equal(crashNote.nextStreak({ streak: 99, lastAt: T0 }, '2026-09-11T11:00:00.000Z'), 99)
})

test('severityFor：无崩溃证据 → none；单次无影响 → info', () => {
  assert.equal(crashNote.severityFor({ hasPreviousRun: false, streak: 5 }), 'none')
  assert.equal(crashNote.severityFor({ hasPreviousRun: true, streak: 1 }), 'info')
  assert.equal(crashNote.severityFor({ hasPreviousRun: true, streak: 0 }), 'info')
})

test('severityFor：反复出现升级，影响叠加直接 alert', () => {
  assert.equal(crashNote.severityFor({ hasPreviousRun: true, streak: 2 }), 'notice')
  assert.equal(crashNote.severityFor({ hasPreviousRun: true, streak: 3 }), 'alert')
  assert.equal(crashNote.severityFor({ hasPreviousRun: true, streak: 1, hasImpact: true }), 'alert')
})

test('shouldNotify：单次异常退出不弹通知（这就是"不要每次都打扰"的落点）', () => {
  assert.equal(crashNote.shouldNotify('none'), false)
  assert.equal(crashNote.shouldNotify('info'), false)
  assert.equal(crashNote.shouldNotify('notice'), true)
  assert.equal(crashNote.shouldNotify('alert'), true)
})

test('endedBySystemRestart：机器在运行开始之后才开机 → 判为随系统结束（少报不误报）', () => {
  const now = Date.parse('2026-09-20T03:00:00.000Z')
  // 运行 01:00Z 开始，机器 02:30Z 才启动（uptime=1800s）→ 是关机/重启带走的
  assert.equal(crashNote.endedBySystemRestart({ startedAt: '2026-09-20T01:00:00.000Z', now, uptimeSeconds: 1800 }), true)
  // 机器 00:00Z 启动（uptime=10800s），运行 01:00Z 才开始 → 不是系统重启，崩溃判定保持
  assert.equal(crashNote.endedBySystemRestart({ startedAt: '2026-09-20T01:00:00.000Z', now, uptimeSeconds: 10800 }), false)
  // 边界：开机时刻正好等于运行开始时刻 → 必须严格晚于才算，否则维持原判定
  assert.equal(crashNote.endedBySystemRestart({ startedAt: '2026-09-20T02:00:00.000Z', now, uptimeSeconds: 3600 }), false)
  // 证据不全一律不抑制（保持原有崩溃判定）
  assert.equal(crashNote.endedBySystemRestart({ startedAt: '', now, uptimeSeconds: 1800 }), false)
  assert.equal(crashNote.endedBySystemRestart({ startedAt: '不是时间', now, uptimeSeconds: 1800 }), false)
  assert.equal(crashNote.endedBySystemRestart({ startedAt: '2026-09-20T01:00:00.000Z', now, uptimeSeconds: Number.NaN }), false)
  assert.equal(crashNote.endedBySystemRestart({ startedAt: '2026-09-20T01:00:00.000Z', now, uptimeSeconds: -1 }), false)
  assert.equal(crashNote.endedBySystemRestart({}), false)
  assert.equal(crashNote.endedBySystemRestart(null), false)
})