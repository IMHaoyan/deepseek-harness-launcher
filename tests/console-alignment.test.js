// tests/console-alignment.test.js — 控制台「通用」页的对齐契约
//
// 背景：2026-09-21 截图反馈"选项标题与开关距离太远、整体没对齐"。根因是设置行被写成
// 控件贴右缘（.settings-groups .row { justify-content: space-between }）+ 长标签行把 label 撑满，
// 于是一行之内中缝可达数百 px、每行控件左缘各不相同（实测卡内偏移出现 7 个不同值）。
// 契约：标签列宽固定（--label-col）、控件紧随其后（行间距 12px）、状态卡复用同一列。
// 几何实测（真实 Electron 渲染 1728×1152，120% 缩放）：所有行控件卡内偏移 = 157、间距 = 14（=12×1.2）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const css = read('ui-src/styles.css')
const builtCss = read('wwwroot/styles.css')

test('标签列宽集中声明为 --label-col，且 .label 与状态卡共用它', () => {
  assert.match(css, /--label-col:\s*\d+px;/, '标签列宽必须是单一常量（改一处即可全页生效）')
  assert.match(css, /\.label \{[\s\S]{0,120}?width: var\(--label-col\);/, '.label 必须用 --label-col')
  assert.match(css, /#statusCard \.label \{\s*\n\s*width: var\(--label-col\);/, '状态卡必须复用同一列，否则上下两块卡片文字起始竖线不一致')
})

test('设置行：控件紧跟标签列，不再贴右缘', () => {
  assert.match(css, /\.settings-groups \.row \{\s*\n\s*justify-content: flex-start;/, '设置行不得再用 space-between（那会把标题与开关的中缝拉到几百 px）')
  assert.doesNotMatch(css, /\.settings-groups \.row \{\s*\n\s*justify-content: space-between;/, 'space-between 已废弃')
  // 长标签行与普通行同列：不能再 flex: 1 撑满（撑满会把控件推到右缘）
  const longLabel = /\.settings-groups \.row\.long-label \.label \{([\s\S]{0,200}?)\}/u.exec(css)
  assert.ok(longLabel, '长标签行规则应存在（保留省略号兜底）')
  assert.match(longLabel[1], /width: var\(--label-col\);/, '长标签行也必须用同一列宽')
  assert.match(longLabel[1], /flex: none;/, '长标签行不得再 flex: 1 撑满')
  // 折叠行（stack）的控件左缘用同一个列宽常量算出
  assert.match(css, /\.row\.stack \.chips \{\s*\n\s*margin-left: calc\(var\(--label-col\) \+ 12px\);/, '折叠行的控件左缘必须与普通行同列')
})

test('缩放行与 chips 行同一个行间距（不再额外留白、也不推到右端）', () => {
  const zoom = /\.zoom-control \{([\s\S]{0,200}?)\}/u.exec(css)
  assert.ok(zoom, '缩放行规则应存在')
  assert.doesNotMatch(zoom[1], /margin-left:\s*16px/, '不得再额外加 16px（与 chips 行的间距会不一致）')
  assert.doesNotMatch(zoom[1], /justify-content:\s*flex-end/, '不得再把控件推到右端')
})

test('上下两行共用同一个两栏定义（卡片竖缝不能错开）', () => {
  const consoleCss = read('ui-src/console.css')
  const builtConsole = read('wwwroot/console.css')
  assert.match(css, /--general-cols:\s*repeat\(2, minmax\(0, 1fr\)\);/, '两栏分割必须是单一常量')
  assert.match(consoleCss, /#pageGeneral \{[\s\S]{0,220}?grid-template-columns: var\(--general-cols\);/, '顶部两栏必须用 --general-cols')
  assert.match(consoleCss, /#consoleContent \.settings-groups \{ display: grid; grid-template-columns: var\(--general-cols\);/, '下半两栏必须同源')
  assert.doesNotMatch(consoleCss, /1\.35fr/, '旧的 1.35fr/0.85fr 不对称分割已废弃（它让上半两行竖缝差出 ~150px）')
  assert.match(builtConsole, /var\(--general-cols\)/, 'wwwroot 未同步：请执行 npm run build:assets')
})

test('日志与反馈：宽屏两栏底部对齐（日志区不再比右侧长一截）', () => {
  const consoleCss = read('ui-src/console.css')
  const builtConsole = read('wwwroot/console.css')
  // 背景（用户截图反馈）：日志区高度 = 100vh - 510px，窗口越高它越长；右列反馈卡是内容高度，
  // 于是两栏底部差出几十到几百 px。契约：两栏 stretch 到同一行高，页面高度随内容，日志 <pre>
  // 吃卡片剩余高度（flex:1 1 0），不再写死视口高度。
  const wide = /@media \(min-width: 1220px\) \{([\s\S]*?)\n\}/u.exec(consoleCss)
  assert.ok(wide, '应有宽屏双列媒体查询')
  const pageBlock = /#pageLog \{([\s\S]*?)\n  \}/u.exec(wide[1])
  assert.ok(pageBlock, '媒体查询里应有 #pageLog 的网格定义')
  assert.match(pageBlock[1], /align-items: stretch;/, '两栏必须 stretch 才能底部对齐')
  assert.match(pageBlock[1], /height: auto;/, '必须覆盖 styles.css 的 height:100%，页面高度随内容')
  const preOverride = /#pageLog > \.logs-card > pre \{([\s\S]{0,220}?)\}/u.exec(consoleCss)
  assert.ok(preOverride, '应有宽屏日志区高度覆盖规则（选择器避开唯一的 .logs-card pre 声明）')
  assert.match(preOverride[1], /height: auto;/, '日志区不再用「视口高度 - 固定值」')
  assert.match(preOverride[1], /flex: 1 1 0;/, '日志区由卡片剩余空间决定高度')
  assert.match(preOverride[1], /min-height: 0;/, '允许收缩，避免把两栏顶成左长右短')
  assert.match(builtConsole, /align-items: stretch;/, 'wwwroot 未同步：请执行 npm run build:assets')
})

test('wwwroot 与源码同步（改了 ui-src 必须重新构建）', () => {
  assert.match(builtCss, /--label-col:\s*\d+px;/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(builtCss, /\.label \{[\s\S]{0,120}?width: var\(--label-col\);/, 'wwwroot 里仍是旧规则')
})
