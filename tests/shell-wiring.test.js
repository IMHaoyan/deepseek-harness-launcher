// tests/shell-wiring.test.js — 独立窗口壳的按钮接线护栏（node --test）
//
// 反面教材：按钮画出来了却没接事件/没接主进程分支（"打开终端按钮不可用"那类）。
// 这里静态校验四件事：
//   ① browser.js 里 $('x') 引用的 id 必须在 browser.html 里存在（防手滑写错 id）；
//   ② browser.html 里每个 <button id> 都必须被 browser.js 引用（不许有死按钮）；
//   ③ browser.js / loading.js 里 send('x') 的每个命令，主进程都要有 case 'browser:x'（否则点了静默无反应）；
//   ④ loading.js 发出的命令必须都在 trust 的说明页白名单里（否则运行期会被拒，页面按钮变哑巴）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const trust = require('../trust')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const html = read('ui-src/browser.html')
const css = read('ui-src/browser.css')
const shellJs = read('ui-src/browser.js')
const loadingJs = read('ui-src/loading.js')
const viewPreloadJs = read('browser-preload.js')
const mainJs = read('main.js')

const matchAll = (src, re) => [...src.matchAll(re)].map((m) => m[1])
const dirHasStartProgress = () => fs.existsSync(path.join(root, 'start-progress.js'))

test('browser.js 引用的 id 全部存在于 browser.html', () => {
  const ids = new Set(matchAll(html, /\bid="([^"]+)"/g))
  const refs = matchAll(shellJs, /\$\('([^']+)'\)/g)
  const missing = [...new Set(refs)].filter((id) => !ids.has(id))
  assert.deepEqual(missing, [], '壳脚本引用了 HTML 里不存在的 id：' + missing.join(', '))
})

test('browser.html 里的按钮都被 browser.js 接了事件（不许有死按钮）', () => {
  const buttons = matchAll(html, /<button[^>]*\bid="([^"]+)"/g)
  const refs = new Set(matchAll(shellJs, /\$\('([^']+)'\)/g))
  const dead = buttons.filter((id) => !refs.has(id))
  assert.deepEqual(dead, [], '这些按钮没人管：' + dead.join(', '))
  assert.ok(buttons.includes('btnRestart'), '标题栏应有「重启 DSH」按钮（btnRestart）')
})

test('壳/说明页发出的每个命令，主进程都有 browser: 分支', () => {
  const cases = new Set(matchAll(mainJs, /case 'browser:([A-Za-z]+)'/g))
  const sent = [...new Set([...matchAll(shellJs, /send\('([^']+)'/g), ...matchAll(loadingJs, /send\('([^']+)'/g)])]
  const orphans = sent.filter((n) => !cases.has(n))
  assert.deepEqual(orphans, [], '这些命令没有主进程分支：' + orphans.join(', '))
  assert.ok(sent.includes('restartDsh'), '壳里应有重启命令（send(\'restartDsh\')）')
})

test('说明页发出的命令都在 trust 白名单里（否则运行期被拒）', () => {
  const sent = [...new Set(matchAll(loadingJs, /send\('([^']+)'/g))]
  const rejected = sent.filter((n) => !trust.LOADING_PAGE_COMMANDS.has('browser:' + n))
  assert.deepEqual(rejected, [], '说明页发的命令不在白名单：' + rejected.join(', '))
})

test('标题栏 tooltip 的版本来自主进程推送（契约：dshVersionText）', () => {
  const push = mainJs.slice(mainJs.indexOf('function webPushState'), mainJs.indexOf('function webLayout'))
  assert.ok(push.includes('dshVersionText:'), 'webPushState 必须带上 dshVersionText（否则标题栏悬停没有版本）')
  assert.match(mainJs, /function dshTitleTooltipVersion\(\)/, '应由 dshTitleTooltipVersion() 统一出这个值')
  assert.match(mainJs, /return \(envReport && envReport\.dsh && envReport\.dsh\.version\) \|\| ''/, 'tooltip 只给版本号本身，不带前缀/安装形态')
  assert.match(shellJs, /state\.dshVersionText/, '壳要把 DSH 版本号挂到标题文字上')
  assert.match(shellJs, /state\.launcherVersion/, '控制台打开时标题栏要显示启动器版本')
})

test('说明页步骤：主进程推 loading:progress、preload 暴露、页面订阅（缺一环就白做）', () => {
  assert.match(mainJs, /send\('loading:progress'/, '主进程要推 loading:progress')
  assert.match(mainJs, /markLoadingProgress\('spawn'\)/, 'startServer 起完进程必须打点 spawn')
  assert.match(mainJs, /markLoadingProgress\('ready'\)/, '进入等待就绪必须打点 ready')
  assert.ok(dirHasStartProgress(), 'start-progress.js 必须存在（步骤表）')
  assert.match(viewPreloadJs, /onLoadingProgress:/, '视图 preload 要暴露订阅入口')
  assert.match(loadingJs, /onLoadingProgress\(renderProgress\)/, '说明页要订阅并按 reason 过滤')
})

test('齿轮按钮接线完整：HTML / 壳脚本 / 主进程命令三处都有', () => {
  assert.ok(html.includes('id="btnConsole"'), 'browser.html 要有齿轮按钮')
  assert.match(shellJs, /\$\('btnConsole'\)\.addEventListener/, 'browser.js 要接齿轮点击')
  assert.match(shellJs, /send\('consoleToggle'\)/, '齿轮要发 consoleToggle 命令')
  assert.match(mainJs, /case 'browser:consoleToggle'/, '主进程要处理 browser:consoleToggle')
})

test('单窗口架构：控制台视图与旧独立窗口入口都已切换', () => {
  assert.match(mainJs, /require\('\.\/console-surface'\)/, '主进程要加载 console-surface')
  assert.match(mainJs, /createConsoleSurface\(/, '主进程要创建控制台视图')
  assert.match(mainJs, /consoleOpen: consoleIsOpen\(\)/, '壳状态要带 consoleOpen')
  assert.match(mainJs, /case 'consoleClose'/, '控制台要能返回 DSH')
  assert.doesNotMatch(mainJs, /function showPanel\s*\(/, '旧 showPanel 必须移除')
  assert.doesNotMatch(mainJs, /function createWindow\s*\(/, '旧面板窗口创建函数必须移除')
})

test('标题文字必须脱离拖拽区（否则 hover 收不到事件、tooltip 不弹）', () => {
  assert.ok(html.includes('id="titleText"'), '标题文字要有独立元素（titleText）挂 tooltip')
  const rule = css.slice(css.indexOf('.title-only .title-text'))
  const noDrag = rule.indexOf('-webkit-app-region: no-drag')
  assert.ok(noDrag > -1 && noDrag < rule.indexOf('}'), '.title-text 必须声明 -webkit-app-region: no-drag')
  assert.ok(!/id="titleOnly"[^>]*\stitle=/.test(html), 'titleOnly 自身不该再挂 title（拖拽区的 tooltip 不会弹）')
})
test('端口无法监听（EACCES/EADDRINUSE）按冲突上报，并建议可 bind 的高位端口', () => {
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(mainJs, /function canBindPort\(port\) \{/, '应有"真的能 bind"的端口探测（connect 探测看不出端口被系统保留）')
  assert.match(mainJs, /async function findBindablePort\(preferred\) \{/, '应有可 bind 端口查找')
  assert.match(mainJs, /async function reportBindBlocked\(code\) \{/, '应有端口无法监听的上报（复用 blockedReason/suggestedPort 通道）')
  assert.match(mainJs, /listen \(EACCES\|EADDRINUSE\)/i, '应从 stderr 里识别 listen EACCES/EADDRINUSE')
  assert.match(mainJs, /if \(bindErr\) await reportBindBlocked\(bindErr\)/, '子进程启动阶段退出/就绪超时都要上报')
  assert.match(mainJs, /PORT < 15000 \? 15081 : PORT \+ 1/, '建议端口优先落在 15081 以上，避开 Windows 动态端口范围')
})
test('控制台导航收敛为「通用 / 预装插件 / 日志与反馈」，概览与设置已并页', () => {
  const consoleHtml = read('ui-src/index.html')
  const consoleJs = read('ui-src/app.js')
  const navIds = matchAll(consoleHtml, /id="(nav[A-Za-z]+)"/g)
  assert.deepEqual(navIds, ['navGeneral', 'navPlugins', 'navLog'], '一级导航只剩三项')
  assert.match(consoleHtml, /<span>通用<\/span>/, '第一项叫「通用」')
  assert.match(consoleHtml, /id="pageGeneral"[^>]*class="page"/, '默认页是通用（class="page" 且不带 hidden）')
  assert.doesNotMatch(consoleHtml, /id="pageMain"|id="pageSettings"/, '概览/设置页已并进通用')
  assert.doesNotMatch(consoleHtml, /id="navMain"|id="navSettings"/, '旧的导航项已删除')
  // 通用页上半是状态/主操作、下半是偏好设置分组，且都在同一个页面容器里
  const general = consoleHtml.slice(consoleHtml.indexOf('<div id="pageGeneral"'), consoleHtml.indexOf('<!-- 新手安装向导'))
  assert.match(general, /id="statusCard"/, '状态卡在通用页里')
  assert.match(general, /class="card main-actions"/, '主操作卡在通用页里')
  assert.match(general, /class="settings-groups"/, '偏好设置分组也在通用页里')
  assert.equal((general.match(/<div\b/g) || []).length, (general.match(/<\/div>/g) || []).length, '通用页的 div 必须配平')
  assert.match(consoleJs, /main: 'general', settings: 'general'/, '旧页名 main/settings 仍要落到通用（主进程还在推 main）')
  assert.match(mainJs, /getElementById\('navGeneral'\)/, '自检探针跟着新 id')
})
