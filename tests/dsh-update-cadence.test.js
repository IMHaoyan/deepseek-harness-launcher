// tests/dsh-update-cadence.test.js — DSH 更新检查的节奏（启动后一次 + 每 6 小时 tick）。
//
// 契约（为什么要有这一层测试）：
//   1) 节奏的唯一定义处是 main.js 的定时器；dsh-update.js 里那个常量只是"最小间隔地板"，
//      防的是启动器被反复重启（dev 热重启 / 崩溃后重启 / 用户来回重启托盘）时每次启动都联网。
//   2) 地板必须**显著小于** tick：tick 从进程启动开始计时、首次检查在 +15s，
//      地板一旦接近或等于 tick，就会把每个 tick 都挡在门外 —— 检查频率会悄悄退化成 12 小时一次，
//      而且因为被挡掉的那次原本不写日志，这种退化在日志里完全看不出来。
//   3) 地板只该是"防抖"量级：如果它又被调回十几小时，等于把 6 小时的节奏名存实亡。
//   4) 时间戳记的是"上次尝试"（写在 fetchLatest 判空之前），这样离线时反复重启启动器
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

function tickMs() {
  const m = /void dshUpdater\.checkOnce\('timer'\) \}, ([0-9\s*]+)\)/u.exec(main)
  assert.ok(m, 'main.js 应有一个周期性的 dshUpdater.checkOnce(\'timer\') 定时器（检查节奏的源头）')
  const ms = new Function('return ' + m[1])()
  assert.equal(typeof ms, 'number')
  return ms
}

test('节奏由 main.js 定义：启动后 15 秒一次 + 每 6 小时一次', () => {
  assert.match(main, /setTimeout\(\(\) => \{ void dshUpdater\.checkOnce\('startup'\) \}, 15000\)/, '启动后要自动检查一次')
  assert.equal(tickMs(), 6 * HOUR, '周期检查应为 6 小时（改这里必须同步 README 的更新说明）')
})

test('地板必须显著小于 tick：否则每个 tick 都会被自己的地板吃掉（退化成 12 小时一次）', () => {
  const gap = minGapMs()
  const tick = tickMs()
  assert.ok(gap > 0, '地板应为正数')
  // tick 从进程启动计时、首查在 +15s，所以 tick 那次的间隔是 tick-15s；给 1 分钟余量兜住计时抖动
  assert.ok(gap + 60 * 1000 <= tick, `地板 ${gap / 60000} 分钟相对 ${tick / HOUR} 小时 tick 太大，会把 tick 挡掉`)
})

test('地板只是防抖：不能再变回粗节流，老的 24h 常量不得残留', () => {
  const gap = minGapMs()
  assert.ok(gap <= HOUR, `地板 ${gap / 60000} 分钟过大：它只该防"启动器反复重启"，节奏交给 6 小时 tick`)
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
