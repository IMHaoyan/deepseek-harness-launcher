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