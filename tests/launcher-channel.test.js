// tests/launcher-channel.test.js — 启动器自身的更新渠道（latest / alpha）。
//
// 契约：
//   - 渠道值只认 latest / alpha，配置写坏了回落到 latest（绝不因为配置脏就去拉预发布包）；
//   - channel 与 allowPrerelease 必须成对落到 electron-updater：alpha 靠 allowPrerelease=true 才能
//     看到 GitHub prerelease，并靠 provider 的 latest.yml 回落拿到正式版；
//   - 换渠道要作废已下载的旧渠道包（否则会显示「更新到 vX」却装的是旧渠道的版本）；
//   - 发布侧按版本号决定渠道：x.y.z-alpha.N → alpha.yml + GitHub prerelease；x.y.z → latest.yml。
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
const release = read('tools/release.mjs')

test(' normalizeChannel：只认 latest / alpha，未知值回落 latest', () => {
  const start = updaterSrc.indexOf('const CHANNELS = ')
  const end = updaterSrc.indexOf('\n}\n', updaterSrc.indexOf('function normalizeChannel(value) {')) + 3
  assert.ok(start > 0 && end > start, '找不到渠道定义')
  const api = new Function(updaterSrc.slice(start, end) + '\nreturn { CHANNELS, normalizeChannel }')()
  assert.deepEqual(api.CHANNELS, ['latest', 'alpha'])
  assert.equal(api.normalizeChannel('alpha'), 'alpha')
  assert.equal(api.normalizeChannel('latest'), 'latest')
  for (const bad of ['beta', 'rc', 'ALPHA', '', null, undefined, 1, {}, []]) {
    assert.equal(api.normalizeChannel(bad), 'latest', '非法渠道值应回落 latest：' + String(bad))
  }
})

test('updater：channel 与 allowPrerelease 成对设置，且默认仍是正式版', () => {
  assert.match(updaterSrc, /channel: 'latest',\n\}/, 'state 里要带当前渠道（界面据此渲染选项）')
  assert.match(updaterSrc, /function applyChannel\(\) \{/, '应有统一的渠道落地函数')
  assert.match(updaterSrc, /autoUpdater\.channel = channel/, 'channel 要落到 electron-updater')
  assert.match(updaterSrc, /autoUpdater\.allowPrerelease = channel === 'alpha'/, 'allowPrerelease 必须跟着渠道走')
  assert.doesNotMatch(updaterSrc, /allowPrerelease = false\n/, '不应残留写死的 allowPrerelease=false')
  assert.match(updaterSrc, /readChannel = typeof opts\.getChannel === 'function' \? opts\.getChannel : readChannel/, '渠道来源由主进程注入')
  assert.match(main, /getChannel: \(\) => Config\.launcherChannel/, '主进程应按配置提供渠道')
  assert.match(updaterSrc, /onChannelChanged, normalizeChannel, isNewerVersion, CHANNELS/, '渠道相关入口要导出（测试与主进程都用）')
})

test('updater：显式关掉 electron-updater 的 allowDowngrade 副作用（降级闸）', () => {
  // electron-updater 的 channel setter 会把 allowDowngrade 置 true（AppUpdater.js:44 + 其文档注释），
  // 于是"装了 alpha 的机器切回 latest"会把更旧的正式版当成更新：2026-09-21 实测
  // v1.4.8-alpha.4 被提示「可更新到 v1.4.7」并自动下载（退出时会自动安装 = 静默降级）。
  const setChannelAt = updaterSrc.indexOf('autoUpdater.channel = channel')
  const allowPrereleaseAt = updaterSrc.indexOf("autoUpdater.allowPrerelease = channel === 'alpha'")
  const disableAt = updaterSrc.indexOf('autoUpdater.allowDowngrade = false')
  assert.ok(disableAt > 0, 'applyChannel 必须显式关掉 allowDowngrade（不能依赖 electron-updater 的默认值）')
  assert.ok(disableAt > setChannelAt && disableAt > allowPrereleaseAt, '必须在设置 channel 之后关（setter 每次都把它打开）')
  assert.match(updaterSrc, /allowDowngrade/, '要有注释说明这个副作用，避免以后被"清理"掉')
})

test('updater：更新源给了更旧/同版也不当更新（界面文案与真实动作一致）', () => {
  assert.match(updaterSrc, /if \(!isNewerVersion\(info\.version, state\.current\)\) \{/, 'update-available 必须过一遍版本大小闸')
  assert.match(updaterSrc, /updater: 忽略不比当前新的版本/, '拦下时要留日志（可解释）')
  assert.match(updaterSrc, /setStatus\('up-to-date', \{ latest: '', error: '' \}\)/, '拦下后按"已是最新"呈现，且不带 latest')
  assert.match(updaterSrc, /autoUpdater\.on\('update-not-available', \(\) => \{[\s\S]{0,220}?setStatus\('up-to-date', \{ latest: '', error: '' \}\)/, '检不到更新时必须清掉残留的 latest')
})

test('isNewerVersion：跑真实源码片段 —— 降级与同版都不算更新', () => {
  const start = updaterSrc.indexOf('function isNewerVersion(')
  assert.ok(start > 0, '找不到 isNewerVersion')
  const end = updaterSrc.indexOf('\n}\n', start) + 3
  const isNewer = new Function('semver', updaterSrc.slice(start, end) + '\nreturn isNewerVersion')(require('semver'))
  // 2026-09-21 事件原样：渠道 latest、已装 v1.4.8-alpha.4、latest.yml 给 v1.4.7
  assert.equal(isNewer('1.4.7', '1.4.8-alpha.4'), false, '更旧的正式版绝不能算更新')
  assert.equal(isNewer('1.4.8-alpha.4', '1.4.8-alpha.4'), false, '同版不算更新')
  assert.equal(isNewer('1.4.8-alpha.5', '1.4.8-alpha.4'), true, 'alpha 之间的正常升级要放行')
  assert.equal(isNewer('1.4.8', '1.4.8-alpha.4'), true, 'alpha 转正式版要放行（这是预期路径）')
  assert.equal(isNewer('1.5.0', '1.4.8-alpha.4'), true)
  assert.equal(isNewer('', '1.4.8-alpha.4'), true, '版本号取不到时 fail-open（宁可多给一次更新）')
  assert.equal(isNewer('not-semver', '1.4.8-alpha.4'), true)
})

test('updater：换渠道无条件作废旧渠道的 latest（不留脏值）', () => {
  assert.match(updaterSrc, /function onChannelChanged\(\) \{/, '应有渠道变更入口')
  assert.doesNotMatch(updaterSrc, /if \(state\.status === 'downloading' \|\| state\.status === 'downloaded'\) \{/, '不再按状态判断：任何残留都必须清掉')
  assert.match(updaterSrc, /state\.latest = ''\n\s+state\.percent = 0\n\s+state\.status = 'idle'/, '作废要清到 idle 状态')
  assert.match(main, /case 'setLauncherChannel': \{/, '应有切换命令')
  assert.match(main, /updater\.onChannelChanged\(\)/, '切换后要落到 electron-updater')
  assert.match(main, /void updater\.check\(\)/, '切换后要立刻按新渠道检查一次')
})

test('main：配置读写、状态下发与「恢复默认」都覆盖启动器渠道', () => {
  assert.match(main, /launcherChannel: 'latest',/, '配置默认值应为 latest')
  assert.match(main, /if \(cfg\.launcherChannel === 'alpha' \|\| cfg\.launcherChannel === 'latest'\) Config\.launcherChannel = cfg\.launcherChannel/, '只接受两个合法值（写坏保持默认）')
  assert.match(main, /launcherChannel: Config\.launcherChannel,/, 'stateJson 应下发当前渠道')
  assert.match(main, /Config\.launcherChannel = 'latest' \/\/ 启动器更新渠道同理/, '恢复默认要一起回退')
  assert.match(main, /config\.json/, '渠道随配置持久化（saveConfig 已有的路径）')
})

test('控制台接线：设置页有「启动器更新渠道」选项，且构建产物同步', () => {
  assert.match(html, /id="launcherChannelChips"/, '设置页应有一组渠道选项')
  assert.match(html, /<span class="label">启动器更新渠道<\/span>/, '选项要有自己的标签')
  assert.match(html, /切回 latest 不会把已装的 alpha 降级/, 'tooltip 要讲清切回去的后果')
  assert.match(app, /const LAUNCHER_CHANNEL_VALUES = \[/, '页面应有渠道取值定义')
  assert.match(app, /buildChips\('launcherChannelChips', LAUNCHER_CHANNEL_VALUES, launcherChannel, \(c\) => cmd\('setLauncherChannel', c\.key\)\)/, '选项应走真实命令')
  assert.match(app, /const launcherChannel = state\.launcherChannel === 'alpha' \? 'alpha' : 'latest';/, '页面取值要判合法')
  const builtApp = read('wwwroot/app.js')
  assert.match(builtApp, /launcherChannelChips/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(read('wwwroot/index.html'), /id="launcherChannelChips"/, 'wwwroot 未同步：请执行 npm run build:assets')
})

test('发布脚本：渠道由版本号决定，产物 yml 与 GitHub prerelease 同步跟随', () => {
  assert.match(release, /const channel = prereleaseTag === 'alpha' \? 'alpha' : 'latest'/, '按版本号判定渠道')
  assert.match(release, /const channelYml = join\(root, 'dist', channel === 'latest' \? 'latest\.yml' : `\$\{channel\}\.yml`\)/, '产物 yml 名随渠道')
  assert.match(release, /if \(prereleaseTag && prereleaseTag !== 'alpha'\) \{/, '非 alpha 的预发布段直接拒绝（rc 等自定义渠道会被 updater 忽略）')
  assert.match(release, /const prereleaseArgs = channel === 'latest' \? \[\] : \['--prerelease', '--latest=false'\]/, 'alpha 必须发成不占 Latest 的 prerelease')
  assert.match(release, /for \(const f of \[exePath, blockmapPath, channelYml\]\)/, '产物断言要校验渠道 yml')
  // electron-builder 的 yargs 会把短形式 `-c.publish.channel=x` 解析成「-c 的值 = .publish.channel=x」，
  // 再拿它当配置文件路径 → ENOENT。这里同时钉住「必须用长形式」和「不许回退到短形式」。
  assert.match(release, /run\(npm, \['run', 'dist:win', '--', `--config\.publish\.channel=\$\{channel\}`\]\)/, '构建时要按渠道显式传给 electron-builder（它默认只写 latest.yml），且必须用 --config.<路径>=<值> 长形式')
  assert.doesNotMatch(release, /'-c\.publish\.channel=/, '短形式 -c.publish.channel= 会被 yargs 当成 -c 的值，实测 ENOENT')
  assert.match(release, /run\(process\.execPath, \['tools\/assert-package\.cjs'\]\)/, '构建后要跑产物断言（tools/assert-package.cjs）')
  assert.match(release, /const ymlVersion = \(\/\^version:\\s\*\(\\S\+\)\/mu\.exec\(ymlText\) \|\| \[\]\)\[1\] \|\| ''/, '要读 yml 里的版本号')
  assert.match(release, /if \(ymlVersion !== version\) \{/, 'yml 版本必须与 package.json 一致（防旧产物）')
  assert.match(release, /if \(!ymlText\.includes\(exe\)\) \{/, 'yml 必须指向这次的安装包')
  assert.match(release, /run\('gh', \['release', 'create', tag, exePath, blockmapPath, channelYml,/, '上传渠道 yml')
  assert.match(release, /if \(channel === 'latest' && !process\.argv\.slice\(2\)\.includes\('--stable'\)\) \{/, '正式版必须显式 --stable 确认（默认发 alpha）')
})

test('发布脚本的渠道判定：跑真实源码片段，四种版本号各归各位', () => {
  const start = release.indexOf("const prereleaseTag = version.includes('-')")
  const end = release.indexOf('\n', release.indexOf('const channelYml = join(')) + 1
  assert.ok(start > 0 && end > start, '找不到渠道判定片段')
  const body = release.slice(start, end)
  const path = require('node:path')
  const decide = (version, args = []) => {
    const realProcess = process
    const fake = {
      argv: ['node', 'release.mjs', ...args],
      exit: (code) => { throw new Error('exit:' + code) },
      env: realProcess.env,
    }
    const fn = new Function('version', 'process', 'join', 'root', 'console', body + '\nreturn { channel, channelYml, prereleaseTag }')
    return fn(version, fake, path.join, path.join('C:', 'repo'), { error: () => {} })
  }
  // alpha：发 prerelease + alpha.yml
  const a = decide('1.4.5-alpha.1')
  assert.equal(a.channel, 'alpha')
  assert.equal(a.channelYml, path.join('C:', 'repo', 'dist', 'alpha.yml'))
  // 正式版必须显式确认
  assert.throws(() => decide('1.4.5'), /exit:1/, '忘了写 alpha 的正式版应被拦下')
  const s = decide('1.4.5', ['--stable'])
  assert.equal(s.channel, 'latest')
  assert.equal(s.channelYml, path.join('C:', 'repo', 'dist', 'latest.yml'))
  // 历史 rc 写法：会被 updater 当自定义渠道忽略，直接拒绝
  assert.throws(() => decide('1.4.5-rc.1'), /exit:1/)
})
