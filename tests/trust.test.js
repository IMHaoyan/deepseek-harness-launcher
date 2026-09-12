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
  for (const name of ['browser:fixPane', 'browser:blockSwitch', 'browser:authRestart', 'browser:consoleToggle']) {
    assert.equal(trust.decideCommand(tab(AUTH_PAGE), LOADING_URL, name), 'allow', `说明页应放行 ${name}`)
  }
  // loadingUrl() 生成的一律是 `…loading.html?reason=…`；裸地址与 hash 也算说明页
  assert.equal(trust.decideCommand(tab(LOADING_URL), LOADING_URL, 'browser:fixPane'), 'allow')
  assert.equal(trust.decideCommand(tab(LOADING_URL + '#x'), LOADING_URL, 'browser:fixPane'), 'allow')
})

test('DSH 页面拿不到 browser:* 的信任（这是本文件存在的理由）', () => {
  for (const url of [DSH_PAGE, OTHER_SITE, 'http://127.0.0.1:3080/?token=abc']) {
    for (const name of ['browser:fixPane', 'browser:blockSwitch', 'browser:authRestart']) {
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

test('判定表本身：说明页白名单恰好四条，不多不少', () => {
  assert.deepEqual([...trust.LOADING_PAGE_COMMANDS].sort(), ['browser:authRestart', 'browser:blockSwitch', 'browser:consoleToggle', 'browser:fixPane'])
})

test('isLoadingPageUrl：参数非法/空值不抛错且判否', () => {
  for (const [u, base] of [[null, LOADING_URL], [LOADING_URL, null], ['', LOADING_URL], [LOADING_URL, ''], [undefined, undefined], [123, LOADING_URL]]) {
    assert.equal(trust.isLoadingPageUrl(u, base), false)
  }
})
