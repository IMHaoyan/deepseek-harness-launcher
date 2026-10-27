// tests/launcher-update-source.test.js — 启动器更新源：GitHub → 国内加速的源链与回退契约。
//
// 背景（2026-10）：启动器自更新走 electron-updater 的 GitHub provider。国内网络下
// github.com / release-assets.githubusercontent.com 经常不可达，自动更新就只剩「手动下载」
// 一条死路（下载页也在 GitHub）。这里钉住零成本回退方案的契约：
//   ① 默认 auto：GitHub 优先、失败后回退国内加速；上次成功的源排到最前（只付一次超时）；
//   ② 国内加速走公共代理的 releases/latest/download 别名 —— 只覆盖正式版，alpha 不能有代理源；
//   ③ github/domestic 是显式选择，不做跨源回退（fail-closed）；
//   ④ 配置只认三个值；自建镜像地址非法时丢弃；状态/设置页/构建产物同步。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const updaterSrc = read('updater.js')
const main = read('main.js')
const app = read('ui-src/app.js')
const html = read('ui-src/index.html')
const builtApp = read('wwwroot/app.js')
const builtHtml = read('wwwroot/index.html')

// 纯函数求值：从 CHANNELS 到 state 之间是自包含的渠道/源判定代码（不 require electron）。
const pureSlice = updaterSrc.slice(updaterSrc.indexOf('const CHANNELS = '), updaterSrc.indexOf('const state = {'))
const api = new Function(pureSlice + '; return { buildUpdateSources, normalizeUpdateSource, normalizeMirror, GITHUB_LATEST_DOWNLOAD, PUBLIC_PROXIES, UPDATE_SOURCES }')()
const finalSlice = updaterSrc.slice(updaterSrc.indexOf('function finalFailure('), updaterSrc.indexOf('function initUpdater'))
const finalFailure = new Function(finalSlice + '; return finalFailure')()
const ids = (list) => list.map((s) => s.id)

const PROXY_URLS = [
  'https://ghfast.top/https://github.com/IMHaoyan/deepseek-harness-launcher/releases/latest/download/',
  'https://gh-proxy.com/https://github.com/IMHaoyan/deepseek-harness-launcher/releases/latest/download/',
  'https://ghproxy.net/https://github.com/IMHaoyan/deepseek-harness-launcher/releases/latest/download/',
]

test('默认 auto/latest：GitHub 在前，失败后依次回退三个已实测的公共加速代理', () => {
  const sources = api.buildUpdateSources({ source: 'auto', channel: 'latest' })
  assert.deepEqual(ids(sources), ['github', 'proxy:ghfast.top', 'proxy:gh-proxy.com', 'proxy:ghproxy.net'])
  assert.deepEqual(sources[0].feed, { provider: 'github', owner: 'IMHaoyan', repo: 'deepseek-harness-launcher' })
  assert.deepEqual(sources.slice(1).map((s) => s.feed.url), PROXY_URLS, '代理源必须指向 GitHub 的正式版 latest/download 别名')
  for (const s of sources.slice(1)) {
    assert.equal(s.feed.provider, 'generic', '代理走 generic provider（静态目录形状）')
    assert.equal(s.feed.useMultipleRangeRequest, false, '代理不一定支持多段 Range：用单段请求，避免差分包失败')
  }
})

test('alpha 渠道没有公共加速源：latest/download 别名只指向正式版（实测 alpha.yml 404）', () => {
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'auto', channel: 'alpha' })), ['github'])
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'domestic', channel: 'alpha' })), [], '显式 domestic + alpha 且无自建镜像时没有可用源')
})

test('自建镜像（launcherUpdateMirror）覆盖两个渠道，且排在 GitHub 之后、代理之前', () => {
  const mirror = 'https://mirror.example.com/dshl'
  for (const channel of ['latest', 'alpha']) {
    const sources = api.buildUpdateSources({ source: 'auto', channel, mirror })
    assert.deepEqual(ids(sources), ['github', 'mirror'], channel + ' 渠道应回退到自建镜像')
    assert.equal(sources[1].feed.provider, 'generic')
    assert.equal(sources[1].feed.url, 'https://mirror.example.com/dshl/', 'base 要补末尾斜杠（newUrlFromBase 依赖它）')
  }
})

test('显式 github / domestic 是单选，不做跨源回退（fail-closed）', () => {
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'github', channel: 'latest', mirror: 'https://m.example/dshl' })), ['github'])
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'domestic', channel: 'latest', mirror: 'https://m.example/dshl' })), ['mirror'])
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'domestic', channel: 'latest' })), [
    'proxy:ghfast.top', 'proxy:gh-proxy.com', 'proxy:ghproxy.net',
  ], '没配镜像时、显式 domestic 在正式版渠道用公共代理')
})

test('上次成功的源排到最前：国内用户只在第一次检查时付 GitHub 超时', () => {
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'auto', channel: 'latest', lastOk: 'proxy:gh-proxy.com' })), [
    'proxy:gh-proxy.com', 'github', 'proxy:ghfast.top', 'proxy:ghproxy.net',
  ])
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'auto', channel: 'latest', lastOk: 'mirror', mirror: 'https://m.example/dshl' })), [
    'mirror', 'github',
  ])
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'auto', channel: 'latest', lastOk: 'proxy:does-not-exist' })), [
    'github', 'proxy:ghfast.top', 'proxy:gh-proxy.com', 'proxy:ghproxy.net',
  ], '不认识的记账值不能把源链搞坏')
  assert.deepEqual(ids(api.buildUpdateSources({ source: 'github', channel: 'latest', lastOk: 'proxy:ghfast.top' })), ['github'], '显式源不受记账影响')
})

test('normalizeUpdateSource / normalizeMirror：只认合法值，坏配置静默回默认', () => {
  assert.deepEqual(api.UPDATE_SOURCES, ['auto', 'github', 'domestic'])
  assert.equal(api.normalizeUpdateSource('domestic'), 'domestic')
  assert.equal(api.normalizeUpdateSource('github'), 'github')
  for (const bad of ['direct', 'GITHUB', '', null, undefined, 1, {}, []]) {
    assert.equal(api.normalizeUpdateSource(bad), 'auto', '非法源值回落 auto：' + String(bad))
  }
  assert.equal(api.normalizeMirror('https://m.example.com/dshl'), 'https://m.example.com/dshl/')
  assert.equal(api.normalizeMirror('http://10.0.0.8:8080/dshl/'), 'http://10.0.0.8:8080/dshl/', '内网 http 镜像允许（sha512 仍校验内容）')
  assert.equal(api.normalizeMirror('https://m.example.com/dshl#frag'), 'https://m.example.com/dshl/', '去掉 hash，别把片段拼进请求')
  for (const bad of ['', '   ', 'not a url', 'ftp://m.example/dshl', 'file:///C:/dshl', null, undefined, 1]) {
    assert.equal(api.normalizeMirror(bad), '', '非法镜像地址直接丢弃：' + String(bad))
  }
})

test('最终失败文案：承认国内加速也试过；alpha 要说清"公共加速帮不上忙"', () => {
  const net = { kind: 'network', text: '网络不可达：连不上更新服务器（可能需要代理或 VPN 才能访问 GitHub）', hint: 'x' }
  const latest = finalFailure(net, 'latest', true)
  assert.match(latest.text, /GitHub 与国内加速源/, '正式版渠道两条路都试过，要一起说出来')
  assert.match(latest.hint, /同事|GitHub/, '仍要给出可执行的下一步')
  assert.equal(finalFailure(net, 'latest', false).hint, 'x', '没试过国内源时不能编造"国内加速也失败"')
  const alpha = finalFailure(net, 'alpha', false)
  assert.match(alpha.hint, /alpha 渠道没有国内加速源/, 'alpha 的边界要如实写出来，避免用户反复重试')
  const domesticOnly = finalFailure(net, 'latest', true, false)
  assert.match(domesticOnly.text, /国内加速源都连不上/, '显式 domestic 没试过 GitHub，不能说"GitHub 也连不上"')
  assert.doesNotMatch(domesticOnly.text, /GitHub 与/, '文案要与真实尝试过的源一致')
  const checksum = { kind: 'checksum', text: '更新包校验失败', hint: 'x' }
  assert.deepEqual(finalFailure(checksum, 'latest', true), checksum, '校验类失败不套用"两条路都断"的结论')
})

test('updater 运行时接线：源落到 setFeedURL，失败切下一个，成功后记账', () => {
  assert.match(updaterSrc, /function applySource\(reset\)/, '要有统一的源落地函数')
  assert.match(updaterSrc, /autoUpdater\.setFeedURL\(source\.feed\)/, '当前源必须落到 electron-updater')
  assert.match(updaterSrc, /function advanceSource\(reason\)/, '要有前进到下一个源的逻辑')
  assert.match(updaterSrc, /function fallbackToNextSource\(reason\)/, '检查/下载失败要触发换源重试')
  assert.match(updaterSrc, /setTimeout\(\(\) => \{[\s\S]{0,400}?void runCheck\(\)/, '延迟重试：等 electron-updater 清掉旧 downloadPromise')
  assert.match(updaterSrc, /function noteSourceSucceeded\(\)/, '成功后要记账（下次优先用）')
  assert.match(updaterSrc, /onSourceChanged, normalizeUpdateSource, normalizeMirror, buildUpdateSources, UPDATE_SOURCES, PUBLIC_PROXIES, finalFailure/, '新入口要导出（主进程与测试都用）')
  assert.match(updaterSrc, /applyChannel\(\)[\s\S]{0,160}?applySource\(true\)/, 'initUpdater 里渠道先定、再定源链')
  assert.match(updaterSrc, /if \(desc\.kind === 'install' \|\| !fallbackToNextSource\(desc\.kind\)\)/, '安装类失败换源无意义，直接报错')
})

test('main：配置读写、状态下发、设置命令与「恢复默认」都覆盖更新源', () => {
  assert.match(main, /launcherUpdateSource: 'auto', launcherUpdateMirror: '', launcherUpdateSourceOk: ''/, '配置默认值：auto + 空镜像')
  assert.match(main, /if \(cfg\.launcherUpdateSource === 'auto' \|\| cfg\.launcherUpdateSource === 'github' \|\| cfg\.launcherUpdateSource === 'domestic'\)/, '只接受三个合法值（写坏回默认）')
  assert.match(main, /Config\.launcherUpdateMirror = updater\.normalizeMirror\(cfg\.launcherUpdateMirror\)/, '镜像地址要归一化/丢弃非法值')
  assert.match(main, /launcherUpdateSource: Config\.launcherUpdateSource,/, 'stateJson 应下发当前更新源')
  assert.match(main, /case 'setLauncherSource': \{/, '应有切换命令')
  assert.match(main, /updater\.onSourceChanged\(\)/, '切换后要重建源链并作废已下载的包')
  assert.match(main, /getSource: \(\) => Config\.launcherUpdateSource,/, '主进程应把源策略注入 updater')
  assert.match(main, /getMirror: \(\) => Config\.launcherUpdateMirror,/, '自建镜像也要注入')
  assert.match(main, /recordSource: \(id\) => \{[\s\S]{0,160}?Config\.launcherUpdateSourceOk = id/, '成功的源要落盘记账')
  assert.match(main, /Config\.launcherUpdateSource = 'auto' \/\/ 更新源也回默认/, '恢复默认要一起回退')
})

test('控制台接线：设置页有「启动器更新源」选项，且构建产物同步', () => {
  assert.match(html, /id="launcherSourceChips"/, '设置页应有一组更新源选项')
  assert.match(html, /<span class="label">启动器更新源<\/span>/, '选项要有自己的标签')
  assert.match(html, /只覆盖正式版/, 'tooltip 要讲清国内加速只覆盖正式版')
  assert.match(html, /失败也不走第三方/, 'tooltip 要讲清 GitHub 显式选择不做第三方回退')
  assert.match(app, /const LAUNCHER_SOURCE_VALUES = \[/, '页面应有源取值定义')
  assert.match(app, /buildChips\('launcherSourceChips', LAUNCHER_SOURCE_VALUES, launcherSource, \(c\) => cmd\('setLauncherSource', c\.key\)\)/, '选项应走真实命令')
  assert.match(app, /const launcherSource = state\.launcherUpdateSource === 'github' \|\| state\.launcherUpdateSource === 'domestic'/, '页面取值要判合法')
  assert.match(builtApp, /launcherSourceChips/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(builtHtml, /id="launcherSourceChips"/, 'wwwroot 未同步：请执行 npm run build:assets')
})
