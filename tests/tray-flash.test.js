// tests/tray-flash.test.js — 托盘闪烁的起停语义（注入桩执行真实实现）
//
// 规则：闪烁 = 「未读提醒」。判据是**窗口焦点**，不是"窗口开没开"：
//   - 用户已经在这个窗口上（有焦点）→ 不闪；
//   - 窗口开着但被盖住 / 最小化 / 没开（都没有焦点）→ 闪；
//   - 闪烁中窗口获得焦点（alt-tab / 点任务栏 / 点窗口本身）→ 立刻停。
//
// 回归的是两个真实缺陷：
//   1. 崩溃与"更新已下载"两条触发路径根本不判断焦点，用户正看着窗口也会开始闪；
//   2. 停止只挂在"打开动作"上，窗口本来就开着时只能去点托盘才能让图标停下来。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n?/gu, '\n')

/** 取真实的闪烁实现（含模块级 flashTimer/flashOn），注入假定时器与托盘桩跑真流程。 */
function loadFlash(opts = {}) {
  const start = main.indexOf('let flashTimer = null')
  const tickAt = main.indexOf('function onFlashTick()')
  assert.ok(start > 0 && tickAt > start, '找不到闪烁实现')
  const end = main.indexOf('\n}\n', tickAt) + 3
  const src = main.slice(start, end)
    + '\nreturn { startFlash, stopFlash, onFlashTick, hasTimer: () => flashTimer !== null, tickOn: () => flashOn }'

  const state = {
    timers: new Set(),
    images: [],
    focused: !!opts.focused,
  }
  const ctx = {
    webUiFocused: () => state.focused,
    setTrayImage: (img) => { state.images.push(img) },
    IconNormal: 'NORMAL',
    IconBlank: 'BLANK',
    setInterval: (fn, ms) => { const h = { fn, ms }; state.timers.add(h); return h },
    clearInterval: (h) => { state.timers.delete(h) },
  }
  const names = Object.keys(ctx)
  const api = new Function(...names, src)(...names.map((k) => ctx[k]))
  return { api, state }
}

test('窗口没聚焦（开着但被盖住 / 最小化 / 没开）→ 照常闪', () => {
  const { api, state } = loadFlash({ focused: false })
  api.startFlash()
  assert.equal(state.timers.size, 1, '未聚焦时必须开始提醒')
  assert.equal([...state.timers][0].ms, 600, '节奏保持 600ms')
})

test('窗口已聚焦 → 一个定时器都不起（用户正看着它，提醒没有意义）', () => {
  const { api, state } = loadFlash({ focused: true })
  api.startFlash()
  assert.equal(state.timers.size, 0, '聚焦时不得闪烁')
  assert.equal(api.hasTimer(), false)
})

test('重复 startFlash 不叠加定时器（崩溃 + 更新并发通知时只闪一个）', () => {
  const { api, state } = loadFlash({ focused: false })
  api.startFlash()
  api.startFlash()
  api.startFlash()
  assert.equal(state.timers.size, 1)
})

test('闪烁中途窗口获得焦点 → 立刻停，且图标复位（不能停在空白图标上）', () => {
  const { api, state } = loadFlash({ focused: false })
  api.startFlash()
  api.onFlashTick() // 切到空白图标
  assert.equal(api.tickOn(), true)
  state.focused = true // 用户 alt-tab / 点任务栏回来了
  api.stopFlash()
  assert.equal(state.timers.size, 0, '必须停止闪烁')
  assert.equal(state.images.at(-1), 'NORMAL', '停止时必须把图标复位成正常态')
})

test('onFlashTick 在正常/空白之间交替（QQ/微信式）', () => {
  const { api, state } = loadFlash({ focused: false })
  api.startFlash()
  api.onFlashTick()
  api.onFlashTick()
  api.onFlashTick()
  assert.deepEqual(state.images, ['BLANK', 'NORMAL', 'BLANK'])
})

test('stopFlash 幂等：没在闪时调用无副作用', () => {
  const { api, state } = loadFlash({ focused: false })
  api.stopFlash()
  api.stopFlash()
  assert.equal(state.timers.size, 0)
  assert.deepEqual(state.images, [], '没闪就不该去动图标')
})

test('焦点判断集中在 startFlash 里（新增触发点不会漏判）', () => {
  // 三条触发路径（服务崩溃 / 通知投递 / 更新已下载）都直连 startFlash，
  // 判断必须在它内部 —— 否则就得靠每个调用点自觉，原来就是这么漏掉两条的。
  assert.match(main, /function startFlash\(\) \{\s*\n\s*\/\/[\s\S]{0,400}?if \(webUiFocused\(\)\) return/, 'startFlash 必须先做焦点判断')
  assert.doesNotMatch(main, /onFlash: \(\) => \{ if \(!webUiFocused/, '调用点不该各自再判一遍')
})

test('DSH 窗口与更新窗口的聚焦都算已读', () => {
  assert.match(main, /webWin\.on\('focus', \(\) => stopFlash\(\)\)/, 'DSH 窗口聚焦必须停止闪烁')
  assert.match(main, /onWebContents: \(_wc, win\) => \{ win\.on\('focus', \(\) => stopFlash\(\)\) \}/, '更新窗口聚焦同样算已读')
  // openWebUi 的原语义保留：任何"打开"动作都视为已读
  assert.match(main, /function openWebUi\(opts = \{\}\) \{\s*\n\s*log\('open DeepSeek Harness window'\)\s*\n\s*stopFlash\(\)/, '打开动作仍要停闪烁')
})

test('焦点判据是窗口焦点而非"窗口开没开"', () => {
  assert.match(main, /function webUiFocused\(\) \{\s*\n\s*try \{ return !!\(webWin && !webWin\.isDestroyed\(\) && webWin\.isFocused\(\)\) \}/, '判据必须是 isFocused()')
})
