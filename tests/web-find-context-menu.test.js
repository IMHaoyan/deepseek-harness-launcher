// tests/web-find-context-menu.test.js — DSH 独立窗口的页面右键菜单与 Ctrl+F 查找接线护栏。
// 这两项都是 Electron 宿主能力，不是网页自动获得的能力；用静态测试防止后续重构再次漏挂。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const mainJs = read('main.js')
const viewPreloadJs = read('browser-preload.js')

function block(src, start, end) {
  const a = src.indexOf(start)
  assert.notEqual(a, -1, `找不到起始标记：${start}`)
  const b = end ? src.indexOf(end, a + start.length) : src.length
  assert.notEqual(b, -1, `找不到结束标记：${end}`)
  return src.slice(a, b)
}

test('WebUI 页面视图挂载右键复制/粘贴/全选菜单', () => {
  const menu = block(mainJs, 'function attachContextMenu', '// ---------- 页面内查找')
  assert.match(menu, /role:\s*'cut'/)
  assert.match(menu, /role:\s*'copy'/)
  assert.match(menu, /role:\s*'paste'/)
  assert.match(menu, /role:\s*'selectAll'/)
  assert.match(menu, /label:\s*'搜索'/, '选中文字右键必须有搜索项')
  assert.match(menu, /https:\/\/www\.google\.com\/search\?q=\s*'\s*\+\s*encodeURIComponent\(query\)/, '搜索项必须用默认浏览器打开 Google 搜索')
  assert.match(menu, /shell\.openExternal\(url\)/, '搜索项必须走系统默认浏览器')

  const create = block(mainJs, 'function webCreateTab', '// 分屏聚焦控件')
  assert.match(create, /const wc = view\.webContents[\s\S]*attachContextMenu\(wc\)/, '每个 tab 的 WebContentsView 必须挂右键菜单')
})

test('Ctrl+F 在页面与窗口壳都会打开查找条', () => {
  const create = block(mainJs, 'function webCreateTab', '// 分屏聚焦控件')
  assert.match(create, /key === 'f'[\s\S]*webOpenFindFromPage\(tab\)/, '焦点在页面内时 Ctrl+F 要优先读取选区并打开当前 tab 查找条')

  const shell = block(mainJs, "webWin.webContents.on('before-input-event'", 'attachContextMenu(webWin.webContents)')
  assert.match(shell, /key === 'f'[\s\S]*webOpenFind\(\)/, '焦点在标签栏壳时 Ctrl+F 仍要查找当前页面')
})

test('Ctrl+F 会读取页面选区并立即搜索', () => {
  const find = block(mainJs, '// ---------- 页面内查找（Ctrl+F）', '// ---------- 分屏状态与布局')
  assert.match(find, /async function webOpenFindFromPage/)
  assert.match(find, /window\.getSelection\(\)\.toString\(\)/, '普通页面文字选区要转成搜索词')
  assert.match(find, /ae\.selectionStart[\s\S]{0,160}ae\.selectionEnd/, '输入框/文本域选区也要支持')
  assert.match(find, /replace\(\/\\s\+\/g, ' '\)[\s\S]{0,120}trim\(\)[\s\S]{0,120}slice\(0, 500\)/, '选区要规范化为单行搜索词并限长')
})

test('查找条使用页面内分块索引与 CSS Highlight，不再全页 findInPage', () => {
  const find = block(mainJs, '// ---------- 页面内查找（Ctrl+F）', '// ---------- 分屏状态与布局')
  assert.match(find, /function injectFindBar/)
  assert.match(find, /__dshFindInput/)
  assert.match(find, /input\.placeholder = '输入后按 F4 查找'/)
  assert.doesNotMatch(find, /emit\('draft'/, '输入过程不再发送 draft IPC')
  const inputHandler = find.slice(find.indexOf("input.addEventListener('input'"), find.indexOf("input.addEventListener('focus'"))
  assert.doesNotMatch(inputHandler, /emit\(/, '普通输入不得跨进程或启动搜索')
  assert.match(inputHandler, /setTimeout\(function\(\)[\s\S]{0,160}search\(true\)/, '输入停顿后要实时搜索')
  assert.match(find, /@media \(prefers-color-scheme: dark\)/, '查找条必须跟随 DSHL 的亮色/暗色主题')
  assert.match(find, /document\.createTreeWalker/, '页面文本索引必须用 TreeWalker 构建')
  assert.match(find, /performance\.now\(\) \+ 8/, '索引构建必须分块，不能长时间占住渲染线程')
  assert.match(find, /MutationObserver/, '页面变更后索引必须失效重建')
  assert.match(find, /CSS\.highlights\.set\('dshl-find-all'/, '匹配结果必须用 CSS Highlight 展示')
  assert.match(find, /::highlight\(dshl-find-current\)/, '当前匹配必须有独立高亮')
  assert.match(find, /state\.active < 0\) state\.active = state\.matches\.length - 1/, '新搜索默认定位最后一个匹配')
  assert.doesNotMatch(find, /findInPage\(/, '查找条不得重新引入全页 findInPage')
})

test('查找导航固定为 F3 上一个、F4 下一个', () => {
  const find = block(mainJs, '// ---------- 页面内查找（Ctrl+F）', '// ---------- 分屏状态与布局')
  assert.match(find, /prev\.title = '上一个 \(F3\)'/)
  assert.match(find, /next\.title = '下一个 \(F4\)'/)
  assert.match(find, /e\.key === 'F3'[\s\S]{0,120}runSearch\(false\)/)
  assert.match(find, /e\.key === 'F4'[\s\S]{0,120}runSearch\(true\)/)
  assert.match(find, /e\.key === 'Enter'[\s\S]{0,120}runSearch\(!e\.shiftKey\)/)

  const create = block(mainJs, 'function webCreateTab', '// 分屏聚焦控件')
  assert.match(create, /input\.key === 'F3'[\s\S]{0,120}webFindFromInput\(tab, false\)/)
  assert.match(create, /input\.key === 'F4'[\s\S]{0,120}webFindFromInput\(tab, true\)/)
  assert.match(create, /input\.key === 'Enter'[\s\S]{0,120}webFindFromInput\(tab, !input\.shift\)/)
})

test('查找框失焦后 F3/F4/Esc 仍作用于已打开的查找', () => {
  const create = block(mainJs, 'function webCreateTab', '// 分屏聚焦控件')
  assert.doesNotMatch(create, /if \(tab\.findOpen && tab\.findInputFocused\)/, '不能只在输入框聚焦时处理查找快捷键')
  assert.match(create, /if \(tab\.findOpen\)[\s\S]{0,260}input\.key === 'Escape'[\s\S]{0,260}input\.key === 'F3'[\s\S]{0,260}input\.key === 'F4'/)

  const shell = block(mainJs, "webWin.webContents.on('before-input-event'", 'attachContextMenu(webWin.webContents)')
  assert.match(shell, /if \(tab && tab\.findOpen\)[\s\S]{0,180}input\.key === 'Escape'[\s\S]{0,180}input\.key === 'F3'[\s\S]{0,180}input\.key === 'F4'/, '焦点在窗口壳时也要处理')
})

test('查找 IPC 只能操作发送方自身 tab，不进入 browser:* 控制域', () => {
  assert.match(viewPreloadJs, /findCommand:\s*\(action, payload\) => ipcRenderer\.invoke\('dsh:find'/)
  const handler = block(mainJs, "ipcMain.handle('dsh:find'", "ipcMain.handle('dsh:cmd'")
  assert.match(handler, /webFindTabByContents\(event\.sender\)/)
  assert.match(handler, /event\.sender\.isDestroyed\(\)/)
  assert.match(handler, /webHandleFindCommand/)
  assert.doesNotMatch(handler, /ipcMain\.handle\('dsh:cmd'/)
})
