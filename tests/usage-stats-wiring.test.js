// tests/usage-stats-wiring.test.js — 统计开关/上报接线护栏（防"开关在、上报没接上"或反之）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')
const html = read('ui-src/index.html')
const appJs = read('ui-src/app.js')
const pkg = JSON.parse(read('package.json'))

test('usage-stats.js 必须在打包文件清单里', () => {
  assert.ok(pkg.build.files.includes('usage-stats.js'), '漏了它，打包后 require 会失败')
})

test('默认关闭，接收地址不写进页面状态', () => {
  assert.match(main, /usageStats: false, usageStatsUrl: '', usageStatsAt: 0/u)
  assert.match(main, /Config\.usageStatsUrl = USAGE_STATS_URL/u)
  assert.match(main, /if \(typeof cfg\.usageStats === 'boolean'\) Config\.usageStats = cfg\.usageStats/u)
  assert.match(main, /case 'setUsageStats':/u)
  assert.match(main, /endpointConfigured: !!Config\.usageStatsUrl/u)
  assert.doesNotMatch(main, /usageStatsUrl: Config\.usageStatsUrl/u, '接收地址不应下发给渲染层')
})

test('上报不阻塞启动：延时、单飞、失败冷却，且 SELF_TEST 不发送', () => {
  assert.match(main, /USAGE_STATS_FIRST_DELAY_MS = 15000/u)
  assert.match(main, /USAGE_STATS_RETRY_MS = 30 \* 60 \* 1000/u)
  assert.match(main, /if \(SELF_TEST \|\| !Config\.usageStats \|\| !Config\.usageStatsUrl\) return/u)
  assert.match(main, /if \(usageStatsInFlight\) return/u)
  assert.match(main, /usageStats\.shouldReport\(\{ enabled: true, lastAt: Config\.usageStatsAt/u)
  assert.match(main, /maybeSendUsageStats\(\)/u)
})

test('不可用期间不露出统计入口', () => {
  assert.doesNotMatch(html, /id="btnUsageStats"/u)
  assert.doesNotMatch(appJs, /btnUsageStats/u)
})
