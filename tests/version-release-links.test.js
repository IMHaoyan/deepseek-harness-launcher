// tests/version-release-links.test.js — 版本行点击到对应 GitHub Release
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const links = require('../changelog')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

test('Release URL：DSHL 使用 v-prefix，DSH 使用 dsh-v-prefix，且支持冗余 v 前缀', () => {
  const launcher = 'https://github.com/IMHaoyan/deepseek-harness-launcher/releases/tag/v1.4.6-alpha.1'
  const dsh = 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2'
  assert.equal(links.launcherReleaseUrl('1.4.6-alpha.1'), launcher)
  assert.equal(links.launcherReleaseUrl('v1.4.6-alpha.1'), launcher)
  assert.equal(links.dshReleaseUrl('0.1.6-alpha.2'), dsh)
  assert.equal(links.dshReleaseUrl('v0.1.6-alpha.2'), dsh)
  assert.equal(links.launcherReleaseUrl(''), 'https://github.com/IMHaoyan/deepseek-harness-launcher/releases')
  assert.equal(links.dshReleaseUrl(''), 'https://github.com/deepseek-ai/deepseek-harness/releases')
})

test('版本行接线：HTML / 控制台 / 主进程 / wwwroot 四处一致', () => {
  const html = read('ui-src/index.html')
  const app = read('ui-src/app.js')
  const main = read('main.js')
  const builtHtml = read('wwwroot/index.html')
  const builtApp = read('wwwroot/app.js')

  assert.match(html, /id="launcherVersion"[^>]*title="在浏览器打开 GitHub Release 页面"/, '启动器版本要标成 Release 链接')
  assert.match(html, /class="version-value link"[^>]*id="launcherVersion"/, '启动器版本要有可点击样式')
  assert.match(html, /id="dshVersion"[^>]*title="在浏览器打开 GitHub Release 页面"/, 'DSH 版本要标成 Release 链接')
  assert.match(app, /\$\('launcherVersion'\)\.addEventListener\('click', \(\) => cmd\('openLauncherRelease'\)\)/, '启动器版本要接 openLauncherRelease')
  assert.match(app, /\$\('dshVersion'\)\.addEventListener\('click', \(\) => cmd\('openDshRelease'\)\)/, 'DSH 版本要接 openDshRelease')
  assert.doesNotMatch(app, /openNpmDsh/, '不应继续打开 npm 页面')
  assert.match(main, /case 'openLauncherRelease'[\s\S]{0,300}?changelog\.launcherReleaseUrl\(app\.getVersion\(\)\)/, '主进程要用 app 版本打开 DSHL Release')
  assert.match(main, /case 'openDshRelease'[\s\S]{0,500}?changelog\.dshReleaseUrl\(version\)/, '主进程要用已安装 DSH 版本打开 DSH Release')
  assert.match(main, /envReport && envReport\.dsh && envReport\.dsh\.version/, 'DSH 版本优先取环境探测结果')
  assert.match(main, /dshUpdater\.getState\(\)\.current/, '环境探测缺失时回退更新器当前版本')
  assert.match(builtHtml, /id="launcherVersion"[^>]*title="在浏览器打开 GitHub Release 页面"/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(builtApp, /openLauncherRelease/, 'wwwroot/app.js 未同步：请执行 npm run build:assets')
})