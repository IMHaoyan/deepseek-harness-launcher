// tests/console-zoom.test.js — 两个缩放控件：控制台默认 100%、5% 滑块、百分比输入、配置持久化
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')

test('控制台缩放不使用系统 DPI 叠加校正', () => {
  const main = read('main.js')
  assert.match(main, /const Config = \{ consoleZoom: 100, webZoom: 100,/, '控制台缩放应默认 100%')
  assert.doesNotMatch(main, /Config\.zoom\b|cfg\.zoom\b/, '旧 zoom 字段应退场，避免历史系统值被当成用户设置')
  assert.doesNotMatch(main, /cssZoomPct\(/, '不应再对控制台应用 scaleFactor ÷1.2 校正')
  assert.doesNotMatch(main, /Config\.consoleZoom = systemZoom\(\)/, '启动时不得用系统 DPI 覆盖用户设置')
  assert.match(main, /zoom: Config\.consoleZoom,/, '状态应把实际控制台缩放下发给界面')
  assert.match(main, /cssZoom: Config\.consoleZoom,/, 'CSS 缩放应与显示值一致')
})

test('两个缩放都是 5% 滑块，并带有可编辑百分比框', () => {
  const html = read('ui-src/index.html')
  const app = read('ui-src/app.js')
  const css = read('ui-src/styles.css')

  assert.match(html, /id="btnZoom"[\s\S]*?class="zoom-slider"[^>]*min="50" max="200" step="5"/, '控制台缩放应是 50–200、5% 一档的滑块')
  assert.match(html, /id="btnWebZoom"[\s\S]*?class="zoom-slider"[^>]*min="50" max="300" step="5"/, '对话界面缩放应是 50–300、5% 一档的滑块')
  assert.match(html, /id="btnZoom"[\s\S]*?class="zoom-value" type="text"[\s\S]*?value="100%"/, '控制台滑块后应有百分比文本框')
  assert.match(html, /id="btnWebZoom"[\s\S]*?class="zoom-value" type="text"[\s\S]*?value="100%"/, '对话界面滑块后应有百分比文本框')
  assert.match(app, /slider\.addEventListener\('input'/, '拖动滑块时要实时更新')
  assert.match(app, /valueEl\.addEventListener\('focus'/, '点击百分比框要进入编辑')
  assert.match(app, /valueEl\.select\(\)/, '编辑时应全选当前比例')
  assert.match(html, /id="btnZoomReset"[^>]*>恢复默认<\/button>/, '控制台缩放后应有恢复默认按钮')
  assert.match(html, /id="btnWebZoomReset"[^>]*>恢复默认<\/button>/, '对话界面缩放后应有恢复默认按钮')
  assert.match(app, /resetEl\.addEventListener\('click',[\s\S]{0,120}?cmd\(resetCmdName\)/, '恢复默认按钮应走主进程默认值命令')
  assert.match(app, /replace\('%', ''\)/, '输入支持带百分号的值')
  assert.match(css, /\.zoom-slider \{[\s\S]{0,220}?flex: 1 1 240px;[\s\S]{0,120}?max-width: 300px;/, '滑块应比原按钮更长并自适应')
})

test('两个缩放默认值同源，且都可恢复默认', () => {
  const main = read('main.js')
  assert.match(main, /if \(Number\.isInteger\(cfg\.consoleZoom\) && cfg\.consoleZoom >= 50 && cfg\.consoleZoom <= 200\) \{[\s\S]{0,220}?Config\.consoleZoom = cfg\.consoleZoom[\s\S]{0,120}?consoleZoomLoaded = true/, '配置读取应恢复用户设置并标记已保存')
  assert.match(main, /if \(Number\.isInteger\(z\) && z >= 50 && z <= 200\) \{[\s\S]{0,160}?Config\.consoleZoom = z[\s\S]{0,120}?saveConfig\(\)/, '修改控制台缩放必须持久化')
  assert.match(main, /if \(!consoleZoomLoaded\) Config\.consoleZoom = zoomDefault/, '未保存过控制台缩放时应使用统一默认值')
  assert.match(main, /if \(!webZoomLoaded\) Config\.webZoom = zoomDefault/, '未保存过对话缩放时应使用统一默认值')
  assert.match(main, /case 'resetZoom'[\s\S]{0,160}?Config\.consoleZoom = defaultWebZoomPct\(\)/, '控制台恢复默认应重新取系统默认值')
  assert.match(main, /case 'resetWebZoom'[\s\S]{0,500}?Config\.webZoom = z/, '对话界面恢复默认应重新取系统默认值')
  assert.match(main, /function defaultWebZoomPct\(\) \{[\s\S]{0,180}?systemZoom\(\)/, '默认值仍按系统 DPI 独立计算')
})

test('默认缩放：按系统缩放收敛到 100–125%，高 DPI（225%/250%）不再掉回 100%', () => {
  const main = read('main.js')
  const slice = (sig) => {
    const start = main.indexOf(sig)
    assert.ok(start > 0, '找不到 ' + sig)
    return main.slice(start, main.indexOf('\n}\n', start) + 3)
  }
  const src = slice('function systemZoom() {') + '\n' + slice('function defaultWebZoomPct() {')
  const disp = { scaleFactor: 1 }
  const ctx = { IS_WIN: true, screen: { getPrimaryDisplay: () => disp } }
  const names = Object.keys(ctx)
  const ev = new Function(...names, src + '\nreturn { systemZoom, defaultWebZoomPct }')(...names.map((k) => ctx[k]))

  // 真函数跑表：默认缩放 = clamp(round(系统缩放 ÷ 1.2), 100, 125)
  for (const [scale, expected] of [
    [75, 100], [100, 100], [120, 100], // 低缩放全被下限收敛到 100
    [125, 104], [130, 108], [135, 113], [140, 117], // 中间档按比例
    [150, 125], [160, 125], [175, 125], [200, 125], // 150% 起被上限收敛到 125
    [225, 125], [250, 125], [300, 125], [500, 125], // ← 修复点：以前 225% 以上会被当成异常读数掉回 100%
  ]) {
    disp.scaleFactor = scale / 100
    assert.equal(ev.systemZoom(), scale, `系统 ${scale}% 应被当成合法缩放值`)
    assert.equal(ev.defaultWebZoomPct(), expected, `系统 ${scale}% → 默认 ${expected}%`)
  }

  // 异常读数（失败、0、明显不是缩放值）：fail-closed 回退 100%，不抛错也不算出离谱的值
  for (const bad of [0, 0.5, NaN, 6]) {
    disp.scaleFactor = bad
    assert.equal(ev.systemZoom(), 100, `异常读数 ${bad} 应回退 100`)
    assert.equal(ev.defaultWebZoomPct(), 100)
  }
  const throwing = new Function(names[0], names[1], src + '\nreturn defaultWebZoomPct')(
    true, { getPrimaryDisplay: () => { throw new Error('no display') } },
  )
  assert.equal(throwing(), 100, '读显示器失败也要有确定结果')

  // 非 Windows：不读系统缩放，恒 100%
  const mac = new Function(names[0], names[1], src + '\nreturn defaultWebZoomPct')(
    false, { getPrimaryDisplay: () => ({ scaleFactor: 2 }) },
  )
  assert.equal(mac(), 100, 'mac / Linux 不做 DPI 校正')
})

test('控制台缩放控件可见，且 wwwroot 与源码同步', () => {
  const html = read('ui-src/index.html')
  const app = read('ui-src/app.js')
  const builtHtml = read('wwwroot/index.html')
  const builtApp = read('wwwroot/app.js')

  assert.match(html, /<span class="label">控制台缩放<\/span>/, '设置页应显示控制台缩放')
  assert.doesNotMatch(html, /<div class="row hidden">\s*<span class="label">控制台缩放/, '控制台缩放不能继续隐藏')
  assert.match(html, /id="btnZoom"[\s\S]*?class="zoom-slider"/, '控制台缩放控件应存在')
  assert.match(app, /zoomWidgets\.launcher\.setFromState\(state\.zoom\)/, '控件应跟随主进程状态')
  assert.match(app, /applyZoom\(state\.cssZoom \?\? state\.zoom\)/, '页面应按主进程下发值应用缩放')
  assert.match(builtHtml, /id="btnZoom"[\s\S]*?class="zoom-slider"/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(builtApp, /slider\.addEventListener\('input'/, 'wwwroot 未同步：请执行 npm run build:assets')
})