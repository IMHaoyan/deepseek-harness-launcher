// tests/plugin-safe-mode.test.js — 插件冲突「安全模式」的护栏。
//
// 背景：2026-11-23 用户另一台机器 —— 用量与计费插件打断 DSH 的 UI 服务链，
// 服务 HTTP ready，但页面是 Failed to load plugins；逐个禁用十几个插件排查代价太高。
// 这里钉住：安全模式只保留官方 bundle（+ 桌面登录辅助）、写入前备份、可整体恢复；
// 同时确认不再归 DSHL 管理的电脑操作插件不会出现在插件页/未生效提示/兼容预判里。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')
const app = read('ui-src/app.js')
const html = read('ui-src/index.html')

function sliceBetween(src, startMarker, endMarker, label) {
  const at = src.indexOf(startMarker)
  assert.ok(at >= 0, `源码里找不到：${label || startMarker}`)
  const end = src.indexOf(endMarker, at + startMarker.length)
  assert.ok(end > at, `源码里找不到 ${label || startMarker} 的结束边界`)
  return src.slice(at, end)
}

test('safeModeKeepsBundle：只保留官方 @deepseek-ai/* 与桌面登录辅助', () => {
  const block = sliceBetween(main, 'const SAFE_MODE_KEEP_PREFIX', 'function readProfileManifestSafe', 'safe mode keep helpers')
  const ctx = {}
  vm.runInNewContext(block + '\n;globalThis.keep = safeModeKeepsBundle', ctx)
  assert.equal(ctx.keep('@deepseek-ai/dsh-base'), true)
  assert.equal(ctx.keep('@deepseek-ai/dsh-web-app'), true)
  assert.equal(ctx.keep('dshl-desktop-signin'), true)
  assert.equal(ctx.keep('@kenz1117/dsh-ui-usage-billing'), false)
  assert.equal(ctx.keep('dsh-better-sidebar'), false)
  assert.equal(ctx.keep('dsh-computer-use-win'), false)
})

test('电脑操作不再归 DSHL 管理：注册表移除 + 忽略清单 + 三条数据链过滤', () => {
  const regOnly = main.slice(main.indexOf('const MANAGED_NPM_PLUGINS = ['), main.indexOf('\n]\n', main.indexOf('const MANAGED_NPM_PLUGINS = [')) + 3)
  assert.doesNotMatch(regOnly, /dsh-computer-use-win/, '注册表里不应再有电脑操作卡片')
  assert.match(main, /IGNORED_NPM_PLUGINS = new Set\(\['dsh-computer-use-win'\]\)/, '要有明确的忽略清单')
  assert.match(main, /if \(IGNORED_NPM_PLUGINS\.has\(String\(packageName \|\| ''\)\)\) return undefined/,
    '未生效证据要过滤掉忽略清单里的包')
  assert.match(main, /Array\.from\(IGNORED_NPM_PLUGINS\)/, 'Profile 其他插件清单也要过滤（否则会以「Profile」卡片回来）')
  assert.match(main, /filter\(\(x\) => !IGNORED_NPM_PLUGINS\.has\(String\(\(x && x\.name\) \|\| ''\)\)\)/,
    '升级兼容预判也不应再点名它')
})

test('安全模式：先备份 package.json / cordis.patch.yml，再写 bundle 列表；可整体恢复', () => {
  const enable = sliceBetween(main, 'async function enablePluginSafeMode()', 'async function restorePluginSafeMode()', 'enablePluginSafeMode')
  assert.match(enable, /copyFileSync\(DSH_PROFILE_PACKAGE, manifestBak\)/, '必须先备份 package.json')
  assert.match(enable, /copyFileSync\(DSH_PROFILE_PATCH, patchBak\)/, '用户补丁层也要备份')
  assert.match(enable, /next\.dsh\.profile\.bundles = bundles\.filter\(\(n\) => safeModeKeepsBundle\(n\)\)/,
    '安全模式只保留官方 bundle + 桌面登录辅助')
  assert.match(enable, /writeProfileManifestAtomic\(next\)/, '清单要原子落盘')
  assert.match(enable, /Config\.pluginSafeModeBackup = \{ at: new Date\(\)\.toISOString\(\), manifest: manifestBak, patch: patchBak, removed: thirdParty \}/,
    '备份落点要持久化，恢复时才找得到')
  assert.match(enable, /await restartDshForConsole\(\)/, '改完 Profile 必须重启服务才生效')

  const restore = sliceBetween(main, 'async function restorePluginSafeMode()', '/** 插件卡片 / 提示条用的人类可读名字', 'restorePluginSafeMode')
  assert.match(restore, /copyFileSync\(bak\.manifest, DSH_PROFILE_PACKAGE\)/, '恢复要拷回 package.json')
  assert.match(restore, /copyFileSync\(bak\.patch, DSH_PROFILE_PATCH\)/, '有补丁层备份时也要拷回')
  assert.match(restore, /Config\.pluginSafeModeBackup = null/, '恢复后清掉备份记录')
  assert.match(restore, /await restartDshForConsole\(\)/, '恢复后重启服务')
  assert.match(main, /case 'pluginSafeMode': return JSON\.stringify\(await withProfileOp\(/, '安全模式写入口要走 profile 写锁')
  assert.match(main, /case 'pluginSafeModeRestore': return JSON\.stringify\(await withProfileOp\(/, '恢复入口也要走 profile 写锁')
})

test('状态与界面：pluginUi 只读事实 + 恢复页安全模式卡片 + 主页面警示卡升级', () => {
  const state = sliceBetween(main, 'function pluginUiState()', '/** 安全模式：保留官方 bundle', 'pluginUiState')
  assert.match(state, /degraded: issues\.length > 0/, '有未激活条目就是界面未就绪')
  assert.match(state, /thirdParty,/, '要告诉界面哪些第三方 bundle 会被临时停用')
  assert.match(state, /canSafeMode: thirdParty\.length > 0/, '没有第三方插件时不能给安全模式按钮')
  assert.match(main, /pluginUi: pluginUiState\(\),/, '状态快照要下发 pluginUi')

  for (const id of ['pluginRecoveryCard', 'pluginRecoveryTitle', 'btnPluginSafeMode', 'btnPluginSafeModeRestore', 'btnPluginOpenList']) {
    assert.match(html, new RegExp('id="' + id + '"'), `index.html 缺 ${id}`)
  }
  const render = sliceBetween(app, 'function renderPluginRecovery(p)', 'function renderRecovery(state)', 'renderPluginRecovery')
  assert.match(render, /安全模式已启用/, '安全模式生效后要能解释当前状态')
  assert.match(render, /恢复到安全模式前的完整 Profile/, '要给整体恢复的出路')
  assert.match(app, /renderPluginRecovery\(state\.pluginUi\)/, '状态推送时要渲染这张卡')
  assert.match(app, /pluginDegraded \? '处理插件冲突'/, '主页面警示卡要升级为「处理插件冲突」')
  assert.match(app, /cmd\('pluginSafeMode'\)/, '安全模式按钮要真的调用主进程')
  assert.match(app, /cmd\('pluginSafeModeRestore'\)/, '恢复按钮要真的调用主进程')
})
