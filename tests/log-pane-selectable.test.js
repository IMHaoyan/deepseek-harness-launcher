// tests/log-pane-selectable.test.js — 运行日志必须「可选中 + 自动换行」
//
// 契约来自用户直接提的诉求：控制台「日志与反馈」页的运行日志要能框选复制、
// 长行要自动折行。两条都不能只靠"看起来对"：
//   ① 正文默认可选，日志区仍明确保留可选规则；拖拽窗口由独立标题栏负责；
//   ② <pre> 默认 white-space:pre —— 不覆盖的话长路径/URL/堆栈只会从右边滚出去，
//      右侧既看不见也选不到（这正是本次被报的问题）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')

const consoleCss = read('ui-src/console.css')
const builtConsoleCss = read('wwwroot/console.css')
const stylesCss = read('ui-src/styles.css')
const indexHtml = read('ui-src/index.html')

/** 取一条 CSS 规则块（按选择器字面量匹配，块内返回原文）。 */
function ruleBlock(css, selector) {
  const at = css.indexOf(selector + ' {')
  assert.ok(at > 0, `找不到规则 ${selector}`)
  const end = css.indexOf('}', at)
  return css.slice(at, end)
}

test('运行日志容器只有一处样式声明（重复声明会让改的人以为改上了）', () => {
  const hits = consoleCss.match(/\.logs-card pre\s*\{/gu) || []
  assert.equal(hits.length, 1, `期望 1 处 .logs-card pre 声明，实际 ${hits.length} 处`)
})

test('运行日志的 <pre> 就在「运行日志」卡片里（规则打在 .logs-card pre 上才生效）', () => {
  const card = /<section class="card logs-card">([\s\S]*?)<\/section>/u.exec(indexHtml)
  assert.ok(card, 'index.html 里应有 .logs-card 卡片')
  assert.match(card[1], /<pre id="logFull"><\/pre>/, '运行日志容器应仍是 #logFull 这个 pre')
  assert.match(card[1], /运行日志/, '卡片标题应仍写「运行日志」')
})

test('普通正文默认可选，运行日志仍显式保留选择规则', () => {
  const body = /(?:^|\n)body \{([\s\S]*?)\n\}/u.exec(stylesCss);
  assert.ok(body, '应有 body 规则');
  assert.match(body[1], /user-select:\s*text;/u, '不能全页禁止选中文字');
  assert.match(body[1], /-webkit-user-select:\s*text;/u);
  const pre = ruleBlock(consoleCss, '.logs-card pre')
  assert.match(pre, /user-select:\s*text;/, '运行日志必须可选中')
  assert.match(pre, /-webkit-user-select:\s*text;/, 'Electron/Chromium 下要带 -webkit- 前缀')
})

test('自动换行：长行折行，不再横向滚出去', () => {
  const pre = ruleBlock(consoleCss, '.logs-card pre')
  assert.match(pre, /white-space:\s*pre-wrap;/, '必须改成 pre-wrap（<pre> 默认 pre 不折行）')
  assert.match(pre, /word-break:\s*break-all;/, '长路径/URL/堆栈要能断行')
  assert.match(pre, /overflow:\s*auto;/, '纵向滚动保留（内容变高仍要看得到全部）')
  assert.doesNotMatch(pre, /white-space:\s*(pre|nowrap);/, '不许退回不折行的写法')
})

test('与另外两块日志面板写法一致（同一个复制粘贴场景）', () => {
  for (const selector of ['#envLog', '#wizardLog']) {
    const block = ruleBlock(stylesCss, selector)
    assert.match(block, /white-space:\s*pre-wrap;/, selector + ' 应已折行')
    assert.match(block, /user-select:\s*text;/, selector + ' 应已可选中')
  }
})

test('wwwroot 与 ui-src 同步（打包产物不能是旧样式）', () => {
  assert.equal(builtConsoleCss, consoleCss, 'ui-src/console.css 与 wwwroot/console.css 不一致，先跑 npm run build:assets')
})
