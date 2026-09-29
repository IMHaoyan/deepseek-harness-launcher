// tests/plugin-activation-wiring.test.js — 「未生效」信号必须真的接到界面上
//
// 解析逻辑有单测（plugin-activation.test.js），但这类"静默失效"的修复价值全在接线：
// 证据不进状态、卡片不显示，就等于没做。这里只钉接线点与文案契约，不重复测解析。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const uiSrc = fs.readFileSync(path.join(root, 'ui-src', 'app.js'), 'utf8')
const wwwroot = fs.readFileSync(path.join(root, 'wwwroot', 'app.js'), 'utf8')

test('主进程：stderr 逐行增量解析，且随世代清空', () => {
  assert.match(main, /const pluginActivation = require\('\.\/plugin-activation'\)/, '要 require 解析模块')
  assert.match(main, /noteActivationEvidence\(line\)/, 'stderr 每行都要喂给解析器')
  assert.match(main, /server\.activationIssues = \[\]/, '新世代要清掉上一轮的证据')
  assert.match(main, /server\.activationWindow = \[\]/, '滑动窗口也要随世代清空')
  assert.match(main, /const ACTIVATION_WINDOW_LINES = \d+/, '窗口大小要有名字（warning 头 + 条目行一起看）')
})

test('主进程：就绪时把「重启不会改变」写进日志，并立刻推送状态', () => {
  assert.match(main, /插件未生效（重启不会改变）/, '就绪日志要把结论说完')
  assert.match(main, /broadcastState\(\) \/\/ 插件卡片要立刻显示"未生效"/)
})

test('插件卡片：「未生效」覆盖清单态，且三类卡片都带 activation 文案', () => {
  assert.match(main, /const unresolvedStatus = \(packageName, status\) =>/, '状态要有统一入口')
  assert.match(main, /label: '未生效', tone: 'warn'/, '未生效要有独立状态胶囊')
  assert.match(main, /const marketStatus = unresolvedStatus\(market\.PLUGIN_NAME,/, '插件市场卡片')
  assert.match(main, /const bridgeStatus = unresolvedStatus\(bridge\.PLUGIN_NAME,/, '手机连接卡片')
  assert.match(main, /const status = unresolvedStatus\(d\.npm,/, 'npm 推荐插件卡片')
  const hits = main.match(/activation: activationText\(/g) || []
  assert.equal(hits.length, 3, '三类卡片都要带上 activation 文案（市场 / 手机连接 / npm）')
})

test('界面：⚠ 单独一行显示未生效，胶囊 tooltip 给出原因原文', () => {
  for (const [label, src] of [['ui-src', uiSrc], ['wwwroot', wwwroot]]) {
    assert.match(src, /p\.activation \? '⚠ ' \+ p\.activation/, `${label} 要显示未生效原因`)
    assert.match(src, /if \(p\.status && p\.status\.title\) statePill\.title = p\.status\.title;/, `${label} 胶囊要带 tooltip`)
  }
})

test('wwwroot 与 ui-src 同步（打包产物不能是旧界面）', () => {
  assert.equal(wwwroot, uiSrc, 'ui-src/app.js 与 wwwroot/app.js 不一致，先跑 npm run build:assets')
})

test('打包清单包含新模块（否则装出来的 exe 缺文件）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('plugin-activation.js'), 'electron-builder files 要含 plugin-activation.js')
})
