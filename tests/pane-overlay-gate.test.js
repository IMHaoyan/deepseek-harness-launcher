// tests/pane-overlay-gate.test.js — 分屏浮层注入护栏（2026-09 线上复现的回归）。
//
// 事故形态：分屏自 v1.1.7 起恒关（Config.tabsEnabled 常 false），但浮层仍挂在每个标签页的
// did-finish-load 上注入；而它的“默认隐藏”只写在注入的 <style> 里。executeJavaScript 只绕过
// “脚本”的 CSP，注入的 <style> 仍受页面 style-src 约束 —— 样式一旦不生效，裸 DOM 就落进文档流
// 末尾，页面被滚到底时露出（底部左侧 ⋯/✕ + 三行菜单），界面还会被顶高一个浮层的高度。
// 这里固化三条不变量：① 功能关闭时不注入；② 默认隐藏必须同时落在 DOM（hidden）上；
// ③ 功能关闭时清理历史残留，且只删自己注入的节点。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

function block(src, start, end) {
  const a = src.indexOf(start)
  assert.notEqual(a, -1, `找不到起始标记：${start}`)
  const b = end ? src.indexOf(end, a + start.length) : src.length
  assert.notEqual(b, -1, `找不到结束标记：${end}`)
  return src.slice(a, b)
}

test('分屏恒关：浮层不注入，只清残留', () => {
  const inject = block(mainJs, 'function injectPaneOverlay', '// 清掉页面上残留的分屏浮层')
  assert.match(inject, /if \(!Config\.tabsEnabled\) return/, '注入前必须过功能开关，恒关时不得注入')
  assert.doesNotMatch(mainJs, /不受页面 CSP 限制/, '注释不得再声称注入不受 CSP 限制（<style> 仍受 style-src 约束）')

  const load = block(mainJs, "wc.on('did-finish-load'", 'pushLoadingProgress(wc)')
  assert.match(
    load,
    /if \(Config\.tabsEnabled\) injectPaneOverlay\(tab\)\s*\n\s*else removePaneOverlay\(tab\)/,
    'did-finish-load 必须二选一：功能开着才注入，关闭则清理残留',
  )
})

test('默认隐藏不能只靠注入的 <style>', () => {
  const inject = block(mainJs, 'function injectPaneOverlay', '// 清掉页面上残留的分屏浮层')
  assert.match(inject, /root\.hidden = true/, '注入时必须把隐藏态落到 DOM 属性上（<style> 可能被页面 CSP 拦掉）')

  const refresh = block(mainJs, 'function refreshPaneOverlays', 'function webActivateTab')
  assert.match(refresh, /if \(!Config\.tabsEnabled\) return/, '恒关时不得向页面下发显示/隐藏指令')
  assert.match(refresh, /el\.hidden\s*=\s*!on/, '显隐切换必须同步 hidden 属性，不能只改 class')
})

test('残留清理只删自己注入的节点', () => {
  const remove = block(mainJs, 'function removePaneOverlay', '// 仅"分屏开启')
  assert.match(remove, /getElementById\('__dshPaneRoot'\)/, '必须按 id 找到浮层根节点')
  assert.match(remove, /indexOf\('__dshPaneRoot'\) >= 0/, '注入的 <style> 没有 id，只能按内容特征识别')
  assert.match(remove, /removeChild/, '清理必须走 DOM 删除')
  assert.doesNotMatch(remove, /innerHTML/, '清理不得改写页面内容')
})

// 注入脚本是塞进模板字符串里下发给页面的：语法错了只会在 .catch 里静默消失，
// 静态正则断言看不出来 —— 所以必须真的拿 JS 解析器过一遍。
test('注入到页面的脚本必须能被解析', () => {
  const samples = []

  const inject = block(mainJs, 'function injectPaneOverlay', '// 清掉页面上残留的分屏浮层')
  const injectJs = inject.match(/const js = `([\s\S]*?)`\s*\n\s*wc\.executeJavaScript/)
  assert.notEqual(injectJs, null, 'injectPaneOverlay 的脚本必须以 const js = `…` 下发')
  // ${paneId} 在源码里就是脚本内的字面量位置（形如 { id: '${paneId}' }），
  // 下发时由主进程插值；这里按同样语义替换成裸标识符即可。
  samples.push(['injectPaneOverlay', injectJs[1].replace(/\$\{paneId\}/g, 't1')])

  const remove = block(mainJs, 'function removePaneOverlay', '// 仅"分屏开启')
  const removeJs = remove.match(/const js = `([\s\S]*?)`\s*\n\s*let url/)
  assert.notEqual(removeJs, null, 'removePaneOverlay 的脚本必须以 const js = `…` 下发')
  samples.push(['removePaneOverlay', removeJs[1]])

  const refresh = block(mainJs, 'function refreshPaneOverlays', 'function webActivateTab')
  const refreshJs = refresh.match(/wc\.executeJavaScript\(`([\s\S]*?)`\)/)
  assert.notEqual(refreshJs, null, 'refreshPaneOverlays 的显隐脚本必须以模板字符串下发')
  samples.push(['refreshPaneOverlays', refreshJs[1].replace(/\$\{shown\}/g, 'false')])

  for (const [name, body] of samples) {
    assert.doesNotThrow(() => new Function(`return ${body}`), `${name} 下发的脚本不是合法 JS`)
  }
})

// 清理脚本真跑一遍：只允许删「浮层根节点」和「含 __dshPaneRoot 的那段注入样式」，
// 页面自己的 <style> 必须原样留着（清理不得误伤页面）。
test('清理脚本在最小 DOM 上只删自己注入的节点', () => {
  const remove = block(mainJs, 'function removePaneOverlay', '// 仅"分屏开启')
  const body = remove.match(/const js = `([\s\S]*?)`\s*\n\s*let url/)[1]
  const run = new Function('document', `return ${body}`)

  const removed = []
  const parent = { removeChild: (n) => removed.push(n) }
  const makeNode = (textContent) => ({ textContent, parentNode: parent })
  const paneRoot = { id: '__dshPaneRoot', parentNode: parent }
  const paneStyle = makeNode('#__dshPaneRoot{display:none}')
  const pageStyle = makeNode('.app-shell{display:flex}')
  const noParent = { id: '__dshPaneRoot', parentNode: null }

  const docWithResidue = {
    getElementById: (id) => (id === '__dshPaneRoot' ? paneRoot : null),
    querySelectorAll: (sel) => (sel === 'style' ? [pageStyle, paneStyle] : []),
  }
  assert.equal(run(docWithResidue), 2, '应当删掉浮层根节点 + 注入样式各一个')
  assert.deepEqual(removed, [paneRoot, paneStyle], '删除顺序：先根节点、再注入样式')
  assert.ok(removed.indexOf(pageStyle) === -1, '页面自己的 <style> 不得被删')

  const cleanDoc = {
    getElementById: () => null,
    querySelectorAll: (sel) => (sel === 'style' ? [pageStyle] : []),
  }
  assert.equal(run(cleanDoc), 0, '没有残留时必须返回 0，不能误报')

  // 节点已被移出文档（parentNode 为空）时不得抛错，也不该计入清理数
  const orphanDoc = {
    getElementById: () => noParent,
    querySelectorAll: () => [],
  }
  assert.equal(run(orphanDoc), 0, '孤儿节点不该被重复计数')
})


