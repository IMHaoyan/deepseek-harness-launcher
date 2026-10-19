// tests/updater-failure-hint.test.js — 启动器更新失败态必须"说清楚 + 给出路"。
//
// 背景（2026-10）：没开 VPN 的同事点「检查更新」只看到一句失败原因不可见的提示 ——
// electron-updater 的原始报错（net::ERR_INTERNET_DISCONNECTED 之类）只写进主进程日志，
// 界面上既没有"是网络不可达还是 GitHub 被拦"，也没有任何可执行动作。
// 这里钉住三件事：
//   ① 失败原因必须分类（网络不可达 / 访问受限 / 无发布信息 / 校验失败 / 安装失败），
//      每类都给「手动下载」这条自动更新之外的出路；
//   ② 控制台版本行与更新窗口都能看到分类后的短标签，失败提示常驻（不再 8 秒消失）；
//   ③ 两处界面都有「手动下载」按钮，走固定命令 openLauncherDownload（不接收 URL 参数），
//      控制台与更新窗口两个 IPC 通道都放行。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')

const updaterSrc = read('updater.js')
const app = read('ui-src/app.js')
const builtApp = read('wwwroot/app.js')
const updateJs = read('ui-src/update.js')
const builtUpdateJs = read('wwwroot/update.js')
const html = read('ui-src/index.html')
const builtHtml = read('wwwroot/index.html')
const mainJs = read('main.js')

// 纯函数求值（与 updater-selfupdate.test.js 同一套路：不 require electron）
const pureSlice = updaterSrc.slice(updaterSrc.indexOf('const FAILURE_GUIDE'), updaterSrc.indexOf('function initUpdater'))
const describe = new Function(pureSlice + '; return describeUpdateError')()

test('失败分类：网络不可达 / 访问受限 / 无发布信息 / 校验失败 / 安装失败 / 未知', () => {
  const cases = [
    ['net::ERR_INTERNET_DISCONNECTED', 'network'],
    ['getaddrinfo ENOTFOUND github.com', 'network'],
    ['connect ETIMEDOUT 140.82.112.3:443', 'network'],
    ['net::ERR_PROXY_CONNECTION_FAILED', 'network'],
    ['HttpError: 403 Forbidden', 'blocked'],
    ['429 Too Many Requests (rate limit)', 'blocked'],
    ['Cannot find channel "alpha.yml" update info: 404', 'not-found'],
    ['Cannot parse update info from latest.yml: rawData: <html>', 'not-found'],
    ['sha512 checksum mismatch', 'checksum'],
    ['Cannot install: NSIS error', 'install'],
    ['some totally new failure', 'unknown'],
    ['', 'unknown'],
  ]
  for (const [raw, kind] of cases) {
    assert.equal(describe(new Error(raw)).kind, kind, `${raw || '(空)'} 应归类为 ${kind}`)
  }
  // 用户能看懂的话：不许原样丢英文报错；每条都带「手动下载」这条出路
  assert.match(describe(new Error('net::ERR_INTERNET_DISCONNECTED')).text, /网络不可达/, '网络类要说"网络不可达"')
  assert.match(describe(new Error('net::ERR_INTERNET_DISCONNECTED')).text, /代理|VPN/, '要提示可能需要代理/VPN')
  assert.match(describe(new Error('HttpError: 403')).text, /拒绝访问|受限/, '403 要说"访问受限"')
  for (const raw of ['net::ERR_INTERNET_DISCONNECTED', 'HttpError: 403', 'sha512 checksum mismatch', 'Cannot install', 'weird']) {
    const d = describe(new Error(raw))
    assert.match(d.hint, /手动下载/, '失败指引必须给出「手动下载」这条出路')
    assert.match(d.hint, /GitHub/, '指引要点明需要访问的站点是 GitHub')
    assert.ok(d.text && d.text.length > 0, '每类失败都要有一句人话')
  }
  assert.match(describe(new Error('weird unknown')).text, /weird unknown/, '未知类要保留原始信息便于排查')
})

test('updater.js：两条失败入口都用分类结果写状态，原始报错只进日志', () => {
  assert.match(updaterSrc, /function describeUpdateError\(err\)/, '要有可单测的纯函数')
  const errHandler = updaterSrc.slice(updaterSrc.indexOf("autoUpdater.on('error'"), updaterSrc.indexOf('function getState'))
  assert.match(errHandler, /describeUpdateError\(err\)/, 'error 事件必须走分类')
  assert.match(errHandler, /errorKind: desc\.kind/, '失败分类要进状态')
  assert.match(errHandler, /errorHint: desc\.hint/, '行动指引要进状态')
  const checkFn = updaterSrc.slice(updaterSrc.indexOf('async function check()'), updaterSrc.indexOf('// 启动后自动检查'))
  assert.match(checkFn, /describeUpdateError\(err\)/, 'check() 的 catch 也要走分类')
  // 状态字段存在，且换状态时清掉旧失败信息（避免成功之后还挂着上次的失败 tooltip）
  assert.match(updaterSrc, /errorKind: '', \/\/ network \| blocked \| not-found \| checksum \| install \| unknown/, '状态里要有 errorKind')
  assert.match(updaterSrc, /setStatus\('checking', \{ error: '', errorKind: '', errorHint: '' \}\)/, '开始检查要清掉旧失败信息')
  assert.match(updaterSrc, /setStatus\('up-to-date', \{ latest: '', error: '', errorKind: '', errorHint: '' \}\)/, '成功态要清掉旧失败信息')
})

test('控制台：失败态显示分类短标签 + 常驻提示 + 手动下载按钮', () => {
  assert.match(app, /const UPDATER_FAIL_LABELS = \{/, '要有失败短标签表')
  for (const [kind, label] of [['network', '网络不可达'], ['blocked', 'GitHub 访问受限'], ['not-found', '暂无发布信息'], ['checksum', '安装包校验失败'], ['install', '安装程序启动失败']]) {
    const quoted = app.includes("'" + kind + "': '" + label + "'")
    const bare = app.includes(kind + ": '" + label + "'")
    assert.ok(quoted || bare, `缺少 ${kind} 的短标签`)
  }
  // 失败态：sticky（不再 8 秒消失），tooltip 带完整原因 + 行动指引
  assert.match(app, /else if \(u\.status === 'error'\) \{ text = updaterFailureLabel\(u\); title = updaterFailureTitle\(u\); sticky = true; \}/,
    '失败提示要常驻且带完整 tooltip')
  // 手动下载按钮：只在失败态出现，点击走固定命令
  assert.match(app, /const failed = u\.status === 'error';[\s\S]{0,160}manualBtn\.classList\.toggle\('hidden', !failed\)/,
    '失败才显示手动下载')
  assert.match(app, /manualBtn\.title = failed \? \(updaterFailureTitle\(u\) \|\| '在浏览器打开发布页手动下载安装包'\) : ''/, '按钮 tooltip 要带原因')
  assert.ok(app.includes("$('btnUpManual').addEventListener('click', () => void cmd('openLauncherDownload'))"),
    '点击要发 openLauncherDownload')
  assert.match(html, /id="btnUpManual"/, 'index.html 要有手动下载按钮')
})

test('更新窗口：失败原因进 tooltip，并给「手动下载」按钮', () => {
  assert.match(updateJs, /note\.title = \[s\.error, s\.errorHint\]\.filter\(Boolean\)\.join\('\\n'\)/, '更新窗口也要说清失败原因')
  assert.match(updateJs, /btn\.textContent = '手动下载'/, '更新窗口要有手动下载按钮')
  assert.match(updateJs, /cmd\('openLauncherDownload'\)/, '按钮走同一命令')
})

test('主进程：固定发布页出口，在 dsh:cmd 与 update:cmd 两个通道都放行', () => {
  assert.match(mainJs, /const LAUNCHER_RELEASES_URL = 'https:\/\/github\.com\/IMHaoyan\/deepseek-harness-launcher\/releases'/, '发布页 URL 只定义一处')
  const updateHandler = mainJs.slice(mainJs.indexOf("ipcMain.handle('update:cmd'"), mainJs.indexOf("ipcMain.handle('dsh:cmd'"))
  assert.match(updateHandler, /case 'openLauncherDownload': try \{ shell\.openExternal\(LAUNCHER_RELEASES_URL\) \}/, '更新窗口通道要放行')
  const dshHandler = mainJs.slice(mainJs.indexOf("ipcMain.handle('dsh:cmd'"))
  const block = dshHandler.slice(0, dshHandler.indexOf("ipcMain.handle('dsh:find'"))
  assert.match(block, /case 'openLauncherDownload': try \{ shell\.openExternal\(LAUNCHER_RELEASES_URL\) \}/, '控制台通道要放行')
  // 不接受来自渲染层的 URL 参数：页面伪造不了跳转目标
  const caseLocs = mainJs.split('\n').filter((line) => line.includes("case 'openLauncherDownload'"))
  assert.equal(caseLocs.length, 2, '两个通道各一条命令')
  for (const line of caseLocs) {
    assert.match(line, /shell\.openExternal\(LAUNCHER_RELEASES_URL\)/, '只打开固定地址')
    assert.doesNotMatch(line, /value/, '不得使用渲染层传入的参数')
  }
})

test('更新窗口状态负载带上失败分类与指引', () => {
  assert.match(mainJs, /errorKind: launcher\.errorKind \|\| '',/, 'updateStateSnapshot 要带 errorKind')
  assert.match(mainJs, /errorHint: launcher\.errorHint \|\| '',/, 'updateStateSnapshot 要带 errorHint')
})

test('构建产物与源同步（wwwroot 是打包真正读的那份）', () => {
  assert.equal(builtApp, app, 'wwwroot/app.js 未同步：请执行 npm run build:assets')
  assert.equal(builtUpdateJs, updateJs, 'wwwroot/update.js 未同步：请执行 npm run build:assets')
  assert.match(builtHtml, /id="btnUpManual"/, 'wwwroot/index.html 未同步：请执行 npm run build:assets')
})
