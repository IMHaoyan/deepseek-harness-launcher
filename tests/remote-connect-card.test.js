// tests/remote-connect-card.test.js — 手机连接卡片的「外部安装」语义
//
// 背景（2026-10-27）：用户自己从 npm 装了 2.0.2，控制台卡片却拿随包 payload 的版本去比，
// 写出「可更新到 v2.0.0-dev.11」+「重新安装」——后者点下去是 force，会把 npm 版本换回随包版本。
// 启动器现在已经不覆盖外部安装（见 bridge-external-adopt），卡片文案/按钮必须同步：
//   - 状态写「外部版本」，不显示"可更新/重新安装"；
//   - 开关不渲染（不是启动器在管）；
//   - 只保留显式动作：「改用随包版本」与「卸载」。
// 这里锁这四条 + 正常（启动器托管）状态映射不回退。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n?/gu, '\n')

function extractFunction(name) {
  const start = mainSrc.indexOf('function ' + name + '(')
  assert.ok(start > 0, 'main.js 里找不到 ' + name)
  const end = mainSrc.indexOf('\n}\n', start)
  assert.ok(end > start, name + ' 找不到函数结尾')
  return mainSrc.slice(start, end + 2)
}

const loadView = () => new Function(
  'pluginBusyLabel',
  extractFunction('remoteConnectCardView') + '\nreturn remoteConnectCardView',
)((action) => '忙态:' + action)

const externalSnap = {
  external: true,
  installed: true,
  installedPackageVersion: '2.0.2',
  payloadVersion: '2.0.0-dev.11',
  payloadReady: true,
  outdated: false,
  busy: '',
  error: '',
}

test('外部安装：状态写「外部版本」，不显示可更新/重新安装，开关不渲染', () => {
  const view = loadView()(externalSnap, false, false, '', () => '忙态')
  assert.equal(view.external, true)
  assert.equal(view.status.label, '外部版本')
  assert.match(view.status.title, /启动器不托管/u)
  assert.equal(view.latestVersion, '', '不能承诺"可更新到随包版本"')
  assert.equal(view.outdated, false)
  assert.equal(view.toggleAction, '', '开关不渲染：不是启动器在管')
  assert.deepEqual(view.actions.map((a) => a.action), ['switch', 'uninstall'])
  assert.deepEqual(view.actions.map((a) => a.label), ['改用随包版本', '卸载'])
  assert.ok(view.actions.every((a) => a.confirmTitle && a.confirmBody), '两个动作都必须二次确认')
})

test('外部安装但启动器托管开关是开的：卡片仍然按「外部版本」显示（不会被接管）', () => {
  const view = loadView()(externalSnap, true, false, '', () => '忙态')
  assert.equal(view.status.label, '外部版本')
  assert.equal(view.toggleAction, '')
  assert.equal(view.latestVersion, '')
})

test('外部安装 + 动作进行中：不给按钮，状态显示忙态文案', () => {
  const view = loadView()(externalSnap, false, true, 'switch', (action) => '忙态:' + action)
  assert.deepEqual(view.actions, [])
  assert.equal(view.status.tone, 'busy')
  assert.equal(view.status.label, '忙态:switch')
})

test('启动器托管：状态映射保持原样（待安装/需要安装/可更新/已开启/已关闭）', () => {
  const view = loadView()
  const base = { external: false, installed: false, payloadReady: true, outdated: false, busy: '', error: '' }
  const label = (snap, enabled) => view(snap, enabled, false, '', () => '忙态').status.label

  assert.equal(label({ ...base, error: '坏了' }, true), '操作失败')
  assert.equal(label({ ...base, payloadReady: false }, true), '待安装')
  assert.equal(label({ ...base, installed: false }, true), '需要安装')
  assert.equal(label({ ...base, installed: true, outdated: true }, true), '可更新')
  assert.equal(label({ ...base, installed: true }, true), '已开启')
  assert.equal(label({ ...base, installed: true }, false), '已关闭')
})
