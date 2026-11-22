// tests/web-initial-ready-reload.test.js — 启动时窗口先于服务恢复的鉴权页回归护栏。
//
// 2026-11-22 实测（自更新 alpha.2 → alpha.3 后）：服务尚未就绪时窗口先恢复了旧地址，
// 页面停在 DSH 的「连接到此 Host / 申请配对」页；它内容非空，refreshWebUiOnReady(false)
// 不认为是空白/加载页，因此不会被补拉 —— 用户必须手动点「刷新」才能进入正常界面。
// 这里钉住：本次启动的**第一次** launch token 捕获必须强制重载所有标签到带凭据的 UI 地址；
// 后续的自重启仍按原来的保守策略（只修空白/加载页）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n?/g, '\n')

function sliceBetween(src, startMarker, endMarker, label) {
  const at = src.indexOf(startMarker)
  assert.ok(at >= 0, `源码里找不到：${label || startMarker}`)
  const end = src.indexOf(endMarker, at + startMarker.length)
  assert.ok(end > at, `源码里找不到 ${label || startMarker} 的结束边界`)
  return src.slice(at, end)
}

test('启动后首次拿到 launch token：强制重载标签页（否则会停在 Host 配对/鉴权页）', () => {
  const block = sliceBetween(main,
    'if (!href) continue\n      server.launchUrl = href',
    'child.stdout.on',
    'launch token 捕获块')
  assert.match(block, /const firstReady = !webInitialReadyReloaded/, '要区分"本次启动的第一次就绪"')
  assert.match(block, /webInitialReadyReloaded = true/, '首次之后要落标记，不能每次重启服务都强制打断页面')
  assert.match(block, /refreshWebUiOnReady\(firstReady\)/, '首次就绪必须 force 重载；后续仍用 false 的保守策略')
  assert.match(block, /server\.running\(\)/, '只在服务确实运行时重载')
})

test('refreshWebUiOnReady：force=true 时无条件重载所有标签', () => {
  const body = sliceBetween(main, 'async function refreshWebUiOnReady', 'function webLoadTabs', 'refreshWebUiOnReady')
  assert.match(body, /if \(force \|\| \(wc\.getURL\(\) \|\| ''\)\.includes\('loading\.html'\) \|\| await isPageBlank\(wc\)\)/,
    'force 必须绕过"非空白页不重载"的保守判断')
  assert.match(body, /wc\.loadURL\(uiUrl\(\)\)/, '重载目标必须是带凭据的 UI 地址')
})
