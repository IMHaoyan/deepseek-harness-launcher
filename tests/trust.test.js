// trust.test.js — IPC 命令桥的信任边界（安全关键：DSH 页面必须拿不到 browser:* 的信任）
const { test } = require('node:test')
const assert = require('node:assert/strict')

const trust = require('../trust')

const LOADING_URL = 'file:///C:/app/wwwroot/loading.html'
const AUTH_PAGE = LOADING_URL + '?reason=auth&pane=t1'
const DSH_PAGE = 'http://127.0.0.1:3080/'
const OTHER_SITE = 'https://example.com/'

const consoleSender = { kind: 'console' }
const shell = { kind: 'shell' }
const tab = (url) => ({ kind: 'tab', url })
const none = { kind: 'none' }

test('自己人页面（控制台/窗口壳）任何命令都放行', () => {
  for (const name of ['getState', 'stop', 'start', 'resetDefaults', 'browser:winClose', 'setPort']) {
    assert.equal(trust.decideCommand(consoleSender, LOADING_URL, name), 'allow', `console 应放行 ${name}`)
    assert.equal(trust.decideCommand(shell, LOADING_URL, name), 'allow', `shell 应放行 ${name}`)
  }
})

test('说明页的白名单命令放行（含带 query 的真实地址）', () => {
  for (const name of ['browser:fixPane', 'browser:blockSwitch', 'browser:authRestart', 'browser:repairBoot', 'browser:openConsole']) {
    assert.equal(trust.decideCommand(tab(AUTH_PAGE), LOADING_URL, name), 'allow', `说明页应放行 ${name}`)
  }
  // loadingUrl() 生成的一律是 `…loading.html?reason=…`；裸地址与 hash 也算说明页
  assert.equal(trust.decideCommand(tab(LOADING_URL), LOADING_URL, 'browser:fixPane'), 'allow')
  assert.equal(trust.decideCommand(tab(LOADING_URL + '#x'), LOADING_URL, 'browser:fixPane'), 'allow')
})

test('DSH 页面拿不到 browser:* 的信任（这是本文件存在的理由）', () => {
  for (const url of [DSH_PAGE, OTHER_SITE, 'http://127.0.0.1:3080/?token=abc']) {
    for (const name of ['browser:fixPane', 'browser:blockSwitch', 'browser:authRestart', 'browser:repairBoot', 'browser:openConsole']) {
      assert.equal(trust.decideCommand(tab(url), LOADING_URL, name), 'deny', `${url} 不得放行 ${name}`)
    }
  }
})

test('标签视图里只有说明页白名单放行，其余（改端口/关窗口/停服务）一律拒绝', () => {
  for (const name of [
    'browser:tabNew', 'browser:tabClose', 'browser:splitToggle', 'browser:splitRatio',
    'browser:closePane', 'browser:swapPanes', 'browser:paneToTab', 'browser:winClose',
    'browser:winMax', 'browser:winMin', 'browserInit',
    'stop', 'start', 'setPort', 'setZoom', 'resetDefaults', 'envInstall',
  ]) {
    assert.equal(trust.decideCommand(tab(AUTH_PAGE), LOADING_URL, name), 'deny', `说明页也不得放行 ${name}`)
  }
})

test('同前缀的仿冒地址不算说明页', () => {
  for (const url of [LOADING_URL + 'X', LOADING_URL + '.evil', LOADING_URL + '/../index.html']) {
    assert.equal(trust.isLoadingPageUrl(url, LOADING_URL), false, `${url} 不应被判为说明页`)
    assert.equal(trust.decideCommand(tab(url), LOADING_URL, 'browser:fixPane'), 'deny')
  }
})

test('非我们视图的发送方（含取不到发送方）一律拒绝', () => {
  for (const sender of [none, null, undefined, {}, { kind: 'iframe' }, { kind: 'tab' }]) {
    assert.equal(trust.decideCommand(sender, LOADING_URL, 'browser:fixPane'), 'deny')
    assert.equal(trust.decideCommand(sender, LOADING_URL, 'stop'), 'deny')
  }
})

// 说明页的导航能力被删过一次（2026-09，那颗按钮"说了不做"），2026-10 按用户要求以「管理插件」
// 的形式加回来 —— 它只发一个页面 key（白名单在 recovery-plan.CONSOLE_PAGES），不改任何状态。
// 每次往这里加东西都要过一遍：载荷能不能被页面用来指定目标？它会不会改状态？
test('判定表本身：说明页白名单恰好五条，不多不少', () => {
  assert.deepEqual([...trust.LOADING_PAGE_COMMANDS].sort(),
    ['browser:authRestart', 'browser:blockSwitch', 'browser:fixPane', 'browser:openConsole', 'browser:repairBoot'])
})

test('isLoadingPageUrl：参数非法/空值不抛错且判否', () => {
  for (const [u, base] of [[null, LOADING_URL], [LOADING_URL, null], ['', LOADING_URL], [LOADING_URL, ''], [undefined, undefined], [123, LOADING_URL]]) {
    assert.equal(trust.isLoadingPageUrl(u, base), false)
  }
})

// 桌面壳桥（dshl:desktop-shell:*）只认 DSH 应用页：它能写键位、驱动原生快捷键、关窗口。
test('isDshAppUrl：只认同源 DSH 应用页，同前缀仿冒/说明页/外部站点都拒绝', () => {
  assert.equal(trust.isDshAppUrl('http://127.0.0.1:3080/', DSH_PAGE), true)
  assert.equal(trust.isDshAppUrl('http://127.0.0.1:3080', DSH_PAGE), true)
  assert.equal(trust.isDshAppUrl('http://127.0.0.1:3080/?token=abc', DSH_PAGE), true, '带 token 的首次加载也是应用页')
  assert.equal(trust.isDshAppUrl('http://127.0.0.1:3080/session/x', DSH_PAGE), true)
  assert.equal(trust.isDshAppUrl('http://127.0.0.1:3080.evil/', DSH_PAGE), false, '同前缀仿冒域名必须拒绝')
  assert.equal(trust.isDshAppUrl('http://127.0.0.1:3080.evil', DSH_PAGE), false)
  assert.equal(trust.isDshAppUrl('http://127.0.0.1:3081/', DSH_PAGE), false, '换端口是另一个 origin')
  assert.equal(trust.isDshAppUrl(AUTH_PAGE, DSH_PAGE), false, '说明页不是 DSH 应用页')
  assert.equal(trust.isDshAppUrl(OTHER_SITE, DSH_PAGE), false)
  for (const [u, base] of [[null, DSH_PAGE], [DSH_PAGE, null], ['', DSH_PAGE], [DSH_PAGE, ''], [123, DSH_PAGE]]) {
    assert.equal(trust.isDshAppUrl(u, base), false)
  }
})
