// tests/update-window.test.js — 更新窗口静态接线护栏。
//
// 这个窗口的三件事必须始终成立，否则功能会静默失效：
//   1) 页面 id 与脚本引用的 id 一一对应（改 id 忘改脚本 = 白窗口）
//   2) 更新动作走既有命令（updaterCheck/updaterInstall/dshCheckNow/dshUpdateNow），不自造更新逻辑
//   3) 更新内容来自 GitHub Releases，且 CSP 放开了 api.github.com（否则 fetch 被 CSP 拦掉）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const html = read('ui-src/update.html')
const js = read('ui-src/update.js')
const css = read('ui-src/update.css')
const preload = read('preload.js')
const mainJs = read('main.js')
const shellHtml = read('ui-src/browser.html')
const shellJs = read('ui-src/browser.js')
const shellCss = read('ui-src/browser.css')
const winModule = read('update-window.js')
const pkg = JSON.parse(read('package.json'))

test('更新窗口：页面元素齐全，且 update.js 没有引用不存在的 id', () => {
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))
  for (const required of [
    'updLauncherVersion', 'updLauncherActions', 'updDshVersion', 'updDshActions',
    'updChangelog', 'updChangelogStatus', 'btnUpdRefresh', 'updOrderHint',
  ]) {
    assert.ok(htmlIds.has(required), `update.html 缺少 #${required}`)
  }
  // update.js 里出现的字面量 id（$('x')）必须都在页面里，避免改 id 后静默失效
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))
  for (const id of used) assert.ok(htmlIds.has(id), `update.js 引用了 update.html 中不存在的 #${id}`)
})

test('更新窗口：动作走既有更新命令，不新造更新逻辑', () => {
  assert.match(js, /cmd\('updaterInstall'\)/, '启动器更新应调 updaterInstall')
  assert.match(js, /cmd\('updaterCheck'\)/, '启动器检查应调 updaterCheck')
  assert.match(js, /cmd\('dshCheckNow'\)/, 'DSH 检查应调 dshCheckNow')
  assert.match(js, /cmd\('dshUpdateNow'\)/, 'DSH 更新应调 dshUpdateNow')
  // 主进程侧：窗口只开一次、复用同一个，重复点「有更新」不许叠出多个窗口
  assert.match(mainJs, /function showUpdateWindow\(\)/, '主进程应有 showUpdateWindow')
  assert.match(mainJs, /if \(!updateWindowHandle\) \{/, '窗口应复用（已存在就只聚焦）')
  assert.match(mainJs, /createUpdateWindow\(\{/, '应通过 update-window.js 创建窗口')
})

test('更新窗口：状态推送链路完整（main → preload → 页面）', () => {
  assert.match(preload, /onUpdate: \(cb\) => ipcRenderer\.on\('dsh:update'/, 'preload 应暴露 onUpdate')
  assert.match(mainJs, /pushUpdateState\(\)/, '主进程应推送更新状态')
  assert.match(mainJs, /window\.updateWindowHandle\.send\('dsh:update'|updateWindowHandle\.send\('dsh:update'/, '推送通道应为 dsh:update')
  assert.match(js, /window\.dshBridge\.onUpdate\(/, '页面应订阅 onUpdate')
  // 启动器状态变化时也要刷（否则下载进度/已下载状态在窗口里不动）
  assert.match(mainJs, /webPushState\(\) \/\/ 壳「有更新」徽标跟随/, '启动器更新推送应同步壳徽标')
  assert.match(mainJs, /pushUpdateState\(\) \/\/ 更新窗口若开着/, '启动器更新推送应同步更新窗口')
})

test('更新窗口：更新内容由主进程从 GitHub Releases 取，页面不发网络请求', () => {
  // 渲染 Release 正文只能用 DOM API，不许 innerHTML（正文来自网络）
  // 页面不发网络请求：更新内容由主进程 changelog.js 提供（file:// 页面直连 GitHub 会被 CORS/UA 挡掉）
  assert.match(js, /cmdUpd\('changelogGet', \{ force: !!force \}\)/, '页面应通过更新窗口专用通道取更新内容')
  assert.match(preload, /upd: \(name, value\) => ipcRenderer\.invoke\('update:cmd'/, 'preload 应暴露更新窗口专用命令通道')
  assert.match(mainJs, /ipcMain\.handle\('update:cmd'/, '主进程应有 update:cmd 处理器')
  assert.match(mainJs, /event\.sender !== wc/, 'update:cmd 必须校验发送方就是更新窗口')
  assert.ok(!/fetch\(/.test(js), '页面不应自己发网络请求')
  const changelogJs = read('changelog.js')
  assert.match(changelogJs, /https:\/\/api\.github\.com\/repos\/IMHaoyan\/deepseek-harness-launcher\/releases/, '主进程应拉 GitHub Releases')
  assert.match(changelogJs, /'User-Agent': 'DSHL'/, 'GitHub API 必须带 User-Agent，否则 403')
  const publish = pkg.build.publish
  assert.equal(publish.owner + '/' + publish.repo, 'IMHaoyan/deepseek-harness-launcher', 'package.json publish 的 owner/repo 应与 changelog.js 一致')
  assert.ok(pkg.build.files.includes('changelog.js'), 'changelog.js 必须进打包清单')
  assert.match(html, /default-src 'self'/, 'CSP 保持全本地')
  assert.ok(!/innerHTML\s*=/.test(js), '渲染网络内容不得给 innerHTML 赋值')
  assert.match(js, /document\.createTextNode/, '应使用 createTextNode 输出文本')
})


test('更新窗口：全历史版本，最新在最上', () => {
  assert.match(js, /const MAX_VERSIONS = \d+/, '应有版本条数上限（避免无限长列表）')
  assert.match(js, /\.slice\(0, MAX_VERSIONS\)/, '页面按主进程给的顺序取最近 N 个（最新在前）')
  assert.match(read('changelog.js'), /if \(!rel \|\| rel\.draft\) continue/, '应在主进程过滤草稿，只列已发布版本')
  assert.match(js, /'预发布'/, '预发布版本应有标记')
})

test('导航栏「有更新」徽标：位置、显隐与点击都在壳里', () => {
  assert.match(shellHtml, /id="btnUpdateNotice"/, 'browser.html 应有徽标按钮')
  // 位置契约：必须在控制台按钮前面（用户要求「控制台按钮左边」）
  const iBadge = shellHtml.indexOf('id="btnUpdateNotice"')
  const iConsole = shellHtml.indexOf('id="btnConsole"')
  assert.ok(iBadge > 0 && iConsole > 0 && iBadge < iConsole, '徽标必须在控制台按钮左边')
  assert.match(shellJs, /btnUpdateNotice\.classList\.toggle\('hidden', !updLatest\)/, '无更新时应隐藏徽标')
  assert.match(shellJs, /send\('updateOpen'\)/, '点击应打开更新窗口')
  assert.match(mainJs, /case 'browser:updateOpen': showUpdateWindow\(\)/, '主进程应有 browser:updateOpen 分支')
  assert.match(shellCss, /\.win-btn\.update-badge \{/, '徽标应有自己的样式')
  assert.match(shellCss, /\.win-btn\.update-badge \{\n  width: auto;[\s\S]*?background: #16A34A;/, '徽标应为绿色实底')
})

test('导航栏徽标的数据来自主进程推送（两者任一有更新就显示）', () => {
  assert.match(mainJs, /update: \(\(\) => \{/, 'browser:state 应带 update 字段')
  assert.match(mainJs, /function launcherUpdateInfo\(\)/, '应有启动器更新摘要')
  assert.match(mainJs, /function dshUpdateInfo\(\)/, '应有 DSH 更新摘要')
  assert.match(mainJs, /u\.status === 'downloading' \|\| u\.status === 'downloaded'/, '启动器：下载中/已下载 都算有更新')
  assert.match(mainJs, /d\.status === 'available'/, 'DSH：只有 available 才算有更新')
  assert.match(shellJs, /upd\.launcher && upd\.launcher\.latest\) \|\| \(upd\.dsh && upd\.dsh\.latest\)/, '壳按两者取或判断显隐')
})

test('更新窗口的窗口模块与打包清单', () => {
  assert.match(winModule, /new BrowserWindow\(/, '应创建独立 BrowserWindow')
  assert.match(winModule, /show: false/, '应先隐藏、等 ready-to-show 再显示（避免白屏）')
  assert.match(winModule, /pending\.push\(\{ channel, payload \}\)/, '页面加载前的推送应排队补发')
  assert.ok(pkg.build.files.includes('update-window.js'), 'update-window.js 必须进打包清单')
  assert.ok(pkg.build.files.includes('wwwroot/**/*'), 'wwwroot（含 update.html）必须进打包清单')
})

test('构建脚本自动发现页面文件（新增页面不必改三处清单）', () => {
  const build = read('tools/build-assets.mjs')
  const dev = read('tools/dev.mjs')
  assert.match(build, /const copied = \[\]/, 'build-assets 应自动发现 ui-src 页面文件')
  assert.match(dev, /const COPIED = readdirSync\(uiSrc\)/, 'dev 应自动发现 ui-src 页面文件')
  // 三个新页面文件必须都能被自动发现规则匹配到（html/css/js）
  for (const f of ['update.html', 'update.css', 'update.js']) {
    assert.match(f, /\.(html|css|js)$/u, `${f} 应匹配自动发现规则`)
  }
})

test('安全边界：更新窗口走专用通道，不进 dsh:cmd 的信任表', () => {
  const trust = require('../trust')
  // 不变量本身：无法归类的发送方一律拒绝（更新窗口若走通用通道就是这个下场）
  assert.equal(trust.decideCommand({ kind: 'none' }, 'x', 'changelogGet'), 'deny', '无法归类的发送方必须被拒')
  // 回归护栏：changelogGet 不得再出现在 gated 的 dsh:cmd switch 里
  const switchStart = mainJs.indexOf("switch (name) {")
  assert.ok(switchStart > 0, '找不到 dsh:cmd 的 switch')
  const gateStart = mainJs.indexOf('trust.decideCommand(senderOf(event)')
  assert.ok(gateStart > 0, '应有信任判定')
  assert.ok(gateStart < switchStart, '信任判定必须在 switch 之前（先判后执行）')
  // 通用 switch 段里不应再有 changelogGet
  const nextHandler = mainJs.indexOf("ipcMain.handle('dsh:state'", switchStart)
  const switchBlock = mainJs.slice(switchStart, nextHandler > 0 ? nextHandler : switchStart + 8000)
  assert.ok(!switchBlock.includes("changelogGet"), 'changelogGet 不应出现在 dsh:cmd 的 switch 中')
  // senderOf 也不该认识更新窗口（它不属于 dsh:cmd 的信任域）
  assert.ok(!/senderOf[\s\S]{0,600}updateWindowHandle/.test(mainJs), 'senderOf 不应把更新窗口纳入信任域')
})