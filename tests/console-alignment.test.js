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

test('wwwroot 与源码同步（改了 ui-src 必须重新构建）', () => {
  assert.match(builtCss, /--label-col:\s*\d+px;/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(builtCss, /\.label \{[\s\S]{0,120}?width: var\(--label-col\);/, 'wwwroot 里仍是旧规则')
})
