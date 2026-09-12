// tests/loading-texts.test.js — 状态说明页文案表必须覆盖主进程用到的所有 reason（node --test）
//
// 漏一个键就会 fallback 到 TEXTS.start：页面显示「正在启动 DeepSeek Harness 服务…」，
// 与真实动作不符（插件市场变更 / 健康回退都踩过这个坑），而且按钮语义也跟着错。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const loadingSrc = fs.readFileSync(path.join(root, 'ui-src', 'loading.js'), 'utf8')
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

function textsKeys() {
  const body = loadingSrc.slice(loadingSrc.indexOf('const TEXTS = {'), loadingSrc.indexOf('const triedAuth'))
  return new Set([...body.matchAll(/^  ([A-Za-z][A-Za-z0-9]*): \{$/gm)].map((m) => m[1]))
}

// 主进程真正会传给说明页的 reason：webLoadTabs('x') / loadWebTabs('x') / loadingReason: 'x'
// + reasonForPhase() 按服务阶段推导出来的那几个
function usedReasons() {
  const used = new Set()
  for (const file of ['main.js', 'dsh-update.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    // 两个调用名不同：main.js 是 webLoadTabs('x')，dsh-update.js 是 loadWebTabs('x')
    for (const m of src.matchAll(/webLoadTabs\('([^']+)'\)|loadWebTabs\('([^']+)'\)/g)) used.add(m[1] || m[2])
    for (const m of src.matchAll(/loadingReason: '([^']+)'/g)) used.add(m[1])
  }
  const tail = mainSrc.slice(mainSrc.indexOf('function reasonForPhase('))
  const body = tail.slice(0, tail.indexOf('\n}'))
  for (const m of body.matchAll(/return '([A-Za-z]+)'/g)) used.add(m[1])
  return used
}

test('说明页文案表覆盖所有用到的 reason（不许 fallback 成"正在启动"）', () => {
  const keys = textsKeys()
  const missing = [...usedReasons()].filter((r) => !keys.has(r)).sort()
  assert.deepEqual(missing, [], '缺少说明页文案：' + missing.join(', '))
})

test('进行中状态延迟放出兜底按钮；需要用户介入的状态立刻显示', () => {
  const busySrc = loadingSrc.slice(loadingSrc.indexOf('const BUSY_REVEAL_MS'), loadingSrc.indexOf('const revealMs'))
  const busy = new Set([...busySrc.matchAll(/([A-Za-z][A-Za-z0-9]*): \d+/g)].map((m) => m[1]))
  const keys = textsKeys()
  for (const r of busy) assert.ok(keys.has(r), 'BUSY_REVEAL_MS 里的 ' + r + ' 不在文案表里')
  for (const r of ['start', 'restart', 'restartManual', 'update', 'plugin', 'recovery']) {
    assert.ok(busy.has(r), r + ' 属于"进行中"，兜底按钮应当延迟出现')
  }
  for (const r of ['offline', 'blocked', 'failed', 'auth']) {
    assert.ok(!busy.has(r), r + ' 需要用户介入，按钮必须立刻可见')
  }
})
