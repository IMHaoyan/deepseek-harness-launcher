// tests/updater-selfupdate.test.js — 「点更新 → 退出安装」的回执 + electron-updater 日志接线
//
// 背景：用户报"点更新启动器后闪退"——`quitAndInstall` 会先退出启动器再静默跑安装包，
// 安装包要是没跑起来（杀软/损坏/失败），日志里只有一行 quit and install now，之后为空，
// 用户看到的只是"没了"。回执让下次启动能说清"到底装上了没有"；logger 让 electron-updater
// 的内部报错（默认只写打包后看不见的 console）落进启动器日志。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

// updater.js 顶部的常量/纯函数部分可独立跑（不 require electron）——这里只取纯函数求值。
const updaterSrc = read('updater.js')
const pureFns = updaterSrc.slice(updaterSrc.indexOf('function selfUpdateOutcome'), updaterSrc.indexOf('function recordSelfUpdate'))
const mainSrc = read('main.js')

test('selfUpdateOutcome：回执与当前版本比对（缺 target / 非法回执一律 null）', () => {
  const fn = new Function(pureFns + '; return selfUpdateOutcome')()
  assert.equal(fn(null, '1.0.0'), null)
  assert.equal(fn({}, '1.0.0'), null)
  assert.equal(fn({ target: 42 }, '1.0.0'), null)
  assert.deepEqual(fn({ target: '1.4.10-alpha.2', current: '1.4.10-alpha.1' }, '1.4.10-alpha.2'),
    { target: '1.4.10-alpha.2', applied: true, from: '1.4.10-alpha.1' })
  assert.deepEqual(fn({ target: '1.4.10-alpha.2', current: '1.4.10-alpha.1' }, '1.4.10-alpha.1'),
    { target: '1.4.10-alpha.2', applied: false, from: '1.4.10-alpha.1' })
})

test('退出前落回执、启动时读回执并给出结论', () => {
  assert.match(updaterSrc, /recordSelfUpdate\(state\.latest\)/, 'installNow 必须在上安装包之前写回执')
  const init = updaterSrc.slice(updaterSrc.indexOf('function initUpdater'))
  assert.match(init, /const outcome = readSelfUpdateOutcome\(\)/, '启动时必须读回执')
  assert.match(init, /state\.lastSelfUpdate = outcome/, '回执结论要进状态（供界面/日志）')
  assert.match(init, /上次自更新未生效/, '没装上要说出来，而不是只留一行 quit and install now')
  assert.match(init, /selfupdate-failed-/, '未生效的通知要带可去重的键')
})

test('electron-updater 的 logger 挂到启动器日志（否则它的报错打包后完全看不见）', () => {
  const init = updaterSrc.slice(updaterSrc.indexOf('function initUpdater'))
  assert.match(init, /autoUpdater\.logger = \{/, '必须设置 logger')
  for (const level of ['info', 'warn', 'error']) assert.match(init, new RegExp(level + ':'), '缺少 ' + level)
  assert.match(init, /\[updater\]/, '日志要带前缀，便于在启动器日志里过滤')
})

test('主进程接线：启动前 import 自检跑起来，失败进日志与卡片', () => {
  assert.match(mainSrc, /void runBridgeImportCheck\(\)/, '启动流程要触发一次自检（不拖启动）')
  assert.match(mainSrc, /await bridge\.importCheckPayload\(\)/, '自检要真的调用 bridge 的实现')
  assert.match(mainSrc, /启动前 import 自检失败（重启不会改变，插件不会生效）/, '失败要落日志并说明重启无用')
  assert.match(mainSrc, /pluginActivation\.importCheckIssue\(bridge\.PLUGIN_NAME/, '失败要挂到插件卡片上')
  assert.match(mainSrc, /启动前 import 自检异常（不阻断启动）/, '自检自身出问题也不能阻断启动')
})

test('自检结论不参与启动判定（只做证据，不改变启动结果）', () => {
  const fn = mainSrc.slice(mainSrc.indexOf('async function runBridgeImportCheck'))
  const body = fn.slice(0, fn.indexOf('\n}\n'))
  assert.doesNotMatch(body, /return false|throw /, '自检不得让 startServer 失败')
})
