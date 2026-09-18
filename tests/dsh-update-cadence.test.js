// tests/dsh-update-cadence.test.js — DSH 更新检查的节奏（启动后一次 + 按渠道周期的 tick）。
//
// 契约（为什么要有这一层测试）：
//   1) 周期数字只有一个来源：dsh-update.js 的 checkTickMs()（alpha 1 小时 / latest 6 小时）。
//      main.js 的 armDshCheckTimer 只负责按它武装/重新武装定时器，自己不再写死小时数。
//   2) dsh-update.js 里的 CHECK_MIN_GAP_MS 只是"最小间隔地板"，防的是启动器被反复重启
//      （dev 热重启 / 崩溃后重启 / 用户来回重启托盘）时每次启动都联网。
//   3) 地板必须**显著小于最短的那个 tick**（alpha 的 1 小时）：tick 从进程启动开始计时、首次检查在 +15s，
//      地板一旦接近或等于 tick，就会把每个 tick 都挡在门外 —— 检查频率会悄悄减半，
//      而且因为被挡掉的那次原本不写日志，这种退化在日志里完全看不出来。
//   4) 换渠道必须重新武装定时器：否则切到 alpha 后要等下次启动才享受到 1 小时节奏。
//   5) 时间戳记的是"上次尝试"（写在 fetchLatest 判空之前），这样离线时反复重启启动器
//      不会每次都去等两个源各 90 秒；有人把这次写入挪到判空之后就会拆掉这层保护。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const dshUpdater = require('../dsh-update')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const dshUpdate = read('dsh-update.js')
const main = read('main.js')

const HOUR = 60 * 60 * 1000

function minGapMs() {
  const m = /const CHECK_MIN_GAP_MS = ([0-9\s*]+)/u.exec(dshUpdate)
  assert.ok(m, 'dsh-update.js 应定义 CHECK_MIN_GAP_MS（检查的最小间隔地板）')
  const ms = new Function('return ' + m[1])()
  assert.equal(typeof ms, 'number')
  return ms
}

// 周期数字是纯函数，直接跑行为，不再从 main.js 里抠正则
function tickMsFor(channel) {
  dshUpdater.initDshUpdater({ Config: { dshChannel: channel } })
  return dshUpdater.checkTickMs()
}

test('节奏数字的唯一来源是 checkTickMs：alpha 每小时、latest 每 6 小时', () => {
  assert.equal(tickMsFor('alpha'), HOUR, 'alpha 渠道应每小时检查一次')
  assert.equal(tickMsFor('latest'), 6 * HOUR, 'latest 渠道维持 6 小时')
  assert.equal(tickMsFor(''), 6 * HOUR, '渠道为脏值时应回落到 latest，不能是 undefined（setInterval 会疯转）')
})

test('main.js 只按 checkTickMs 武装定时器，不再写死小时数', () => {
  assert.match(main, /setTimeout\(\(\) => \{ void dshUpdater\.checkOnce\('startup'\) \}, 15000\)/, '启动后要自动检查一次')
  assert.match(
    main,
    /setInterval\(\(\) => \{ void dshUpdater\.checkOnce\('timer'\) \}, dshUpdater\.checkTickMs\(\)\)/,
    '定时器周期必须取自 dshUpdater.checkTickMs()',
  )
  assert.doesNotMatch(main, /checkOnce\('timer'\) \}, [0-9]/, 'main.js 里不应再有写死的 tick 毫秒数')
})

test('换渠道要重新武装定时器', () => {
  const setter = main.indexOf("case 'setDshChannel'")
  assert.ok(setter > 0, '找不到 setDshChannel 分支')
  const nextCase = main.indexOf("case 'setLauncherChannel'", setter)
  assert.ok(nextCase > setter, '找不到 setDshChannel 之后的兄弟分支')
  const arm = main.indexOf('armDshCheckTimer()', setter)
  assert.ok(arm > setter && arm < nextCase, 'setDshChannel 分支里必须重新武装定时器：否则切到 alpha 要等下次启动')
})

test('地板必须显著小于最短 tick，否则 tick 会被自己的地板吃掉', () => {
  const gap = minGapMs()
  const tick = Math.min(tickMsFor('alpha'), tickMsFor('latest'))
  assert.ok(gap > 0, '地板应为正数')
  // tick 从进程启动计时、首查在 +15s，所以 tick 那次的间隔是 tick-15s；给 1 分钟余量兜住计时抖动
  assert.ok(gap + 60 * 1000 <= tick, `地板 ${gap / 60000} 分钟相对最短 tick ${tick / HOUR} 小时太大，会把 tick 挡掉`)
})

test('地板只是防抖：不能再变回粗节流，老的 24h 常量不得残留', () => {
  const gap = minGapMs()
  assert.ok(gap <= HOUR, `地板 ${gap / 60000} 分钟过大：它只该防"启动器反复重启"，节奏交给按渠道的 tick`)
  assert.doesNotMatch(dshUpdate, /CHECK_INTERVAL_MS/, '旧的 24h 节流常量应已移除（语义已改成最小间隔地板）')
})

test('时间戳记"上次尝试"：取版本失败也落盘，离线重启不会反复等超时', () => {
  const from = dshUpdate.indexOf('await fetchLatest(plan.nodeCmd)')
  const stamp = dshUpdate.indexOf('Config.dshUpdateCheckedAt = now', from)
  const nullBranch = dshUpdate.indexOf('if (!latest) {', from)
  assert.ok(from > 0, '找不到取最新版的调用')
  assert.ok(stamp > from, '取版本之后应记录检查时间（地板据此生效）')
  assert.ok(nullBranch > stamp, '时间戳必须写在"取版本失败"分支之前：否则失败就不落地板保护')
})

test('地板内跳过要留日志，且手动检查（force）不受地板限制', () => {
  assert.match(dshUpdate, /if \(!force && sinceLastCheck < CHECK_MIN_GAP_MS\) \{/, '地板判断应带 force 开关')
  assert.match(dshUpdate, /检查跳过`\)/, '被地板挡掉的那次必须写日志：否则"没查"与"查了没事"无从区分')
})

// ---------- 行为验证（跑真实 checkOnce，不联网） ----------

function initProbe(logs, detectEnv) {
  const Config = { dshUpdateCheckedAt: Date.now(), dshChannel: 'latest' }
  dshUpdater.initDshUpdater({
    Config,
    saveConfig: () => {},
    log: (m) => logs.push(String(m)),
    envInstall: { getJob: () => ({ job: null }) },
    envDetect: { detectEnv },
  })
  return Config
}

test('地板内：自动检查直接跳过，绝不去探测环境/联网', async () => {
  const logs = []
  initProbe(logs, async () => { throw new Error('地板内不该探测环境') })
  await dshUpdater.checkOnce('timer')
  assert.ok(logs.some((l) => l.includes('检查跳过')), '跳过要留痕：' + logs.join(' | '))
  assert.ok(!logs.some((l) => l.includes('不该探测环境')), '被地板挡下时不应走到环境探测：' + logs.join(' | '))
})

test('地板外（手动 force）：照常探测并按结果给状态', async () => {
  const logs = []
  initProbe(logs, async () => null) // 环境未就绪
  await dshUpdater.checkOnce('manual', true)
  assert.ok(logs.some((l) => l.includes('environment not ready')), '手动检查应穿过地板：' + logs.join(' | '))
  assert.equal(dshUpdater.getState().status, 'error', '手动检查失败要如实报错，不能静默')
})
