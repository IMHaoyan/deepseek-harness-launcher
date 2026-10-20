// tests/login-popup-external.test.js — DSH「登录账号」必须自动用系统浏览器打开授权链接
//
// 背景（用户直接反馈）：在 DSH 里点「登录账号」时没有自动打开浏览器，只能手动复制链接。
// DSH 的登录流程是两步式（dsh-client-ui-settings-account 的 BrowserLogin）：
//   ① 点击当刻 window.open('about:blank') 先预开一个标签页（挡弹窗拦截）；
//   ② 拿到 Host 返回的 authorizeUrl 后 popup.location.replace(authorizeUrl)。
// DSHL 原实现对外部链接一律 `{ action: 'deny' }`，第 ① 步拿不到 popup，登录 UI 退回「复制链接」。
// 契约：
//   · about:blank 预开页要放行，但窗口必须隐藏（不能弹 Electron 窗口）；
//   · 它第一次导航到 http(s) 时 → preventDefault + shell.openExternal + 销毁隐藏窗口；
//   · 直接 window.open(http URL) 仍走系统浏览器（原有行为不能回归）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')

/** webCreateTab 里 `wc` 创建之后、视图背景色设置之前：窗口打开策略都写在这里。 */
function openPolicyBlock() {
  const fnStart = main.indexOf('function webCreateTab(')
  assert.ok(fnStart > 0, 'main.js 里应有 webCreateTab')
  const start = main.indexOf('const wc = view.webContents', fnStart)
  assert.ok(start > fnStart, '找不到 webCreateTab 里的 wc 创建位置')
  const end = main.indexOf('try { view.setBackgroundColor', start)
  assert.ok(end > start, '找不到 webCreateTab 的窗口策略结束位置')
  return main.slice(start, end)
}

test('about:blank 预开页放行但隐藏；未知协议仍然 deny', () => {
  const block = openPolicyBlock()
  assert.ok(block.includes('setWindowOpenHandler'), '应有 setWindowOpenHandler')
  assert.ok(block.includes("if (url === '' || url === 'about:blank')"), 'about:blank / 空 URL 要单独识别（DSH 登录预开页）')
  assert.ok(block.includes("action: 'allow'"), '预开页要放行，否则 DSH 登录拿不到 popup')
  assert.ok(block.includes('overrideBrowserWindowOptions'), '放行时要覆盖窗口选项')
  assert.ok(block.includes('show: false'), '预开页窗口必须不可见，不能弹 Electron 窗口')
  assert.ok(block.includes('skipTaskbar: true'), '隐藏预开页不应出现在任务栏')
  assert.ok(block.includes("return { action: 'deny' }"), '其它未知协议仍要拒绝')
})

test('预开页第一次真实导航：拦截 → 系统浏览器 → 销毁隐藏窗口', () => {
  const block = openPolicyBlock()
  assert.ok(block.includes("wc.on('did-create-window'"), '要接住 about:blank 预开出来的子窗口')
  assert.ok(block.includes('child.hide()'), '子窗口要立刻隐藏')
  assert.ok(block.includes('will-navigate'), '要拦截子窗口的主动导航')
  assert.ok(block.includes('will-redirect'), '服务端重定向也要拦截')
  const at = block.indexOf('const handOffToBrowser =')
  assert.ok(at > 0, '应有 handOffToBrowser 处理器')
  const handler = block.slice(at, block.indexOf('\n  })', at))
  assert.ok(handler.includes('event.preventDefault()'), '必须先取消 Electron 内部导航')
  assert.ok(handler.includes('shell.openExternal(targetUrl)'), '授权链接要交给系统默认浏览器')
  assert.ok(handler.includes('child.destroy()'), '交出去之后要销毁隐藏窗口，不能留着空白窗')
  assert.ok(/https\?:/u.test(handler), '只对 http(s) 链接做外部打开')
})

test('回归：直接 window.open(http URL) 仍走系统浏览器', () => {
  const block = openPolicyBlock()
  const start = block.indexOf('setWindowOpenHandler')
  const end = block.indexOf("wc.on('did-create-window'", start)
  assert.ok(start > 0 && end > start, '找不到 setWindowOpenHandler 边界')
  const open = block.slice(start, end)
  assert.ok(open.includes('shell.openExternal(url)'), '直接打开 http(s) 的能力不能丢')
  assert.ok(open.includes('about:blank'), '登录预开页分支要留在同一个处理器里')
})
