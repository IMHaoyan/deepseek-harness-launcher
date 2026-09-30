'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8')

test('控制台默认可选，只禁选操作控件，不禁用输入框正文', () => {
  const css = read('ui-src/styles.css')
  const body = /(?:^|\n)body \{([\s\S]*?)\n\}/u.exec(css)
  assert.match(body[1], /user-select: text;/)
  assert.match(body[1], /-webkit-user-select: text;/)
  assert.doesNotMatch(body[1], /user-select: none;/)
  const start = css.indexOf('/* 仅操作控件禁选')
  const controls = css.slice(start, css.indexOf('/* ---------- 头部', start))
  assert.match(controls, /button, button \*/)
  assert.match(controls, /user-select: none;/)
  assert.doesNotMatch(controls, /(?:^|\n)\s*(?:input|textarea)\s*[,\{]/)
  assert.doesNotMatch(read('ui-src/console.css'), /user-select:\s*none;/)
})

test('拖选地址/版本不触发打开网页；普通单击仍生效，不受别处选区影响', () => {
  const source = read('ui-src/app.js')
  const start = source.indexOf('function selectedTextTouches(')
  const code = source.slice(start, source.indexOf('// 启动/停止：', start))
  const callbacks = {}, nodes = {}, commands = []
  let target = null
  const window = { getSelection: () => target ? {
    isCollapsed: false, toString: () => 'selected text', rangeCount: 1,
    getRangeAt: () => ({ intersectsNode: (node) => node === target }),
  } : { isCollapsed: true } }
  new Function('window', '$', 'cmd', code)(window, (id) => {
    return nodes[id] ||= { addEventListener: (_event, callback) => { callbacks[id] = callback } }
  }, (name) => commands.push(name))
  window._currentUrl = 'http://example.invalid/'
  for (const [id, command] of [['urlText', 'openUrlExternal'], ['launcherVersion', 'openLauncherRelease'], ['dshVersion', 'openDshRelease']]) {
    target = nodes[id]
    callbacks[id]({ currentTarget: nodes[id] })
    assert.equal(commands.length, 0)
    target = null
    callbacks[id]({ currentTarget: nodes[id] })
    assert.equal(commands.pop(), command)
    target = {} // 别处的选区不能让链接永久无法单击
    callbacks[id]({ currentTarget: nodes[id] })
    assert.equal(commands.pop(), command)
  }
})

test('界面源码与构建产物同步', () => {
  for (const file of ['styles.css', 'console.css', 'app.js']) {
    assert.equal(read('ui-src/' + file), read('wwwroot/' + file), file + ' 未同步构建')
  }
})
