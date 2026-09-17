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
// 统一成 LF：下面的断言里有跨行的正则（样式块、函数体切片），CRLF 检出会让它们全部失配
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')

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
  assert.match(js, /window\.dshBridge\.upd\(name, value\)/, '更新窗口所有动作必须走 update:cmd')
  assert.doesNotMatch(js, /window\.dshBridge\.cmd\(/, '更新窗口动作不得再走 dsh:cmd')
  // 主进程侧：窗口只开一次、复用同一个，重复点「有更新」不许叠出多个窗口
  assert.match(mainJs, /function showUpdateWindow\(\)/, '主进程应有 showUpdateWindow')
  assert.match(mainJs, /if \(!updateWindowHandle\) \{/, '窗口应复用（已存在就只聚焦）')
  assert.match(mainJs, /createUpdateWindow\(\{/, '应通过 update-window.js 创建窗口')
})

test('更新窗口：update:cmd 放行且只放行窗口需要的动作', () => {
  const start = mainJs.indexOf("ipcMain.handle('update:cmd'")
  const end = mainJs.indexOf("ipcMain.handle('dsh:cmd'", start)
  assert.ok(start > 0 && end > start, '找不到 update:cmd 处理器边界')
  const block = mainJs.slice(start, end)
  for (const name of ['changelogGet', 'getState', 'updaterGetState', 'updaterCheck', 'updaterInstall', 'dshCheckNow', 'dshUpdateNow']) {
    assert.match(block, new RegExp(`case '${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `update:cmd 应处理 ${name}`)
  }
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
  assert.match(shellHtml, /<span class="update-badge-label">有更新<\/span>/, '初始档必须是"有更新"（首帧推送前不许宣称就绪）')
  assert.match(shellCss, /\.win-btn\.update-badge \{/, '徽标应有自己的样式')
  // 默认档（有更新）：灰底白字 —— 只传达"有新东西"，不承诺耗时
  assert.match(shellCss, /\.win-btn\.update-badge \{\n  width: auto;[\s\S]*?color: #FFFFFF;\n  background: #61666B;/, '默认档应为灰底白字（有更新）')
  assert.match(shellCss, /\.win-btn\.update-badge:hover \{ color: #FFFFFF; background: #4B5057; \}/, '默认档悬停应为更深的灰 + 白字')
  // 就绪档只能是绿色实底白字（唯一一档实底强调色）
  assert.match(shellCss, /\.win-btn\.update-badge\.ready \{ color: #FFFFFF; background: #16A34A; \}/, '就绪档应为绿色实底白字（可更新）')
  // 旧的淡绿底/深绿字口径必须彻底退场：两处颜色一旦并存，同一档在不同主题下会变成两种样子
  assert.ok(!/rgba\(22, 163, 74, 0\.14\)/.test(shellCss), '默认档不该再是淡绿底')
  assert.ok(!/rgba\(34, 197, 94, 0\.18\)/.test(shellCss), '深色主题不该再单独改默认档底色')
})

test('导航栏徽标的数据来自主进程推送（两者任一有更新就显示）', () => {
  assert.match(mainJs, /update: \(\(\) => \{/, 'browser:state 应带 update 字段')
  assert.match(mainJs, /function launcherUpdateInfo\(\)/, '应有启动器更新摘要')
  assert.match(mainJs, /function dshUpdateInfo\(\)/, '应有 DSH 更新摘要')
  assert.match(mainJs, /u\.status === 'downloading' \|\| u\.status === 'downloaded'/, '启动器：下载中/已下载 都算有更新')
  assert.match(mainJs, /d\.status === 'available'/, 'DSH：只有 available 才算有更新')
  assert.match(shellJs, /upd\.launcher && upd\.launcher\.latest\) \|\| \(upd\.dsh && upd\.dsh\.latest\)/, '壳按两者取或判断显隐')
})

test('徽标两档：全部可见更新都就绪才是"可更新"，其余一律"有更新"（fail-closed）', () => {
  // 判定是纯函数：直接跑真实源码片段，而不是只做正则匹配
  const start = mainJs.indexOf('function updateBadgeTier(launcher, dsh) {')
  const end = mainJs.indexOf('\n}\n', start) + 3
  assert.ok(start > 0 && end > start, 'main.js 应有 updateBadgeTier 纯函数')
  const tier = new Function(mainJs.slice(start, end) + '\nreturn updateBadgeTier')()
  const L = (latest, ready) => ({ latest, ready })
  // 没有更新 → pending（此时徽标本来就整颗隐藏）
  assert.equal(tier(L('', false), { latest: '' }), 'pending', '无更新应为 pending')
  // 检测到但没就绪 → pending
  assert.equal(tier(L('1.4.6', false), { latest: '' }), 'pending', '启动器下载中 = 有更新')
  assert.equal(tier(L('', false), { latest: '0.2.0', ready: false }), 'pending', 'DSH 预装中 = 有更新')
  // 两侧都就绪 → ready
  assert.equal(tier(L('1.4.6', true), { latest: '0.2.0', ready: true }), 'ready', '两侧都就绪 = 可更新')
  // 只就绪一侧 → 仍是 pending（一半就绪时承诺"就绪"就是假的）
  assert.equal(tier(L('1.4.6', true), { latest: '0.2.0', ready: false }), 'pending', '只启动器就绪：DSH 还得等')
  assert.equal(tier(L('1.4.6', false), { latest: '0.2.0', ready: true }), 'pending', '只 DSH 就绪：启动器还在下')
  // 就绪但这一侧没有更新（不该把它算进来）
  assert.equal(tier(L('', false), { latest: '0.2.0', ready: true }), 'ready', '没有更新的那一侧不参与判定')
  // 缺字段/脏值 → pending（fail-closed）
  for (const bad of [undefined, null, {}, { latest: '1.4.6' }, { latest: '1.4.6', ready: 'true' }, { latest: '1.4.6', ready: 1 }]) {
    assert.equal(tier(bad, null), 'pending', '缺 ready/脏值必须按未就绪：' + JSON.stringify(bad))
  }
})

test('徽标两档的渲染契约：文案、样式与悬停解释都跟着 tier 走', () => {
  assert.match(mainJs, /d\.staged === true && String\(d\.stageVersion \|\| ''\) === latest/, 'DSH 就绪必须认版本号对得上的暂存树')
  assert.match(mainJs, /tier: updateBadgeTier\(lu, du\)/, '主进程算好 tier 再下发')
  assert.match(shellJs, /const updReady = upd\.tier === 'ready';/, '壳只按 tier 渲染，不自己判断')
  assert.match(shellJs, /btnUpdateNotice\.classList\.toggle\('ready', !!updLatest && updReady\)/, '就绪档要切到 .ready 样式')
  assert.match(shellJs, /label\.textContent = updReady \? '✓ 可更新' : '有更新';/, '文案两档一一对应')
  // 类名写错是静默故障：颜色会变、文案永远停在"有更新"。所以把选择器与标记对起来查。
  const labelSel = /btnUpdateNotice\.querySelector\('\.([\w-]+)'\)/.exec(shellJs)
  assert.ok(labelSel, '壳应有取徽标文案节点的查询')
  assert.ok(shellHtml.includes(`class="${labelSel[1]}"`), `browser.html 里没有 .${labelSel[1]}（类名对不上 = 文案永远不更新）`)
  assert.match(shellJs, /const title = \(updReady \? '更新已就绪' : '有新版本'\)/, '悬停提示要说明是哪一档')
  assert.match(shellJs, /function dshReadyHint\(d\)/, 'DSH 侧就绪说明应集中在一处')
  // 状态词与耗时口径必须与控制台按钮、更新窗口同源，否则同一个就绪状态在三处说成三样
  const app = read('ui-src/app.js')
  const updJs = read('ui-src/update.js')
  for (const [state, cost] of [['已预装就绪', '约 15 秒'], ['依赖已缓存', '约 1 分钟'], ['', '约 1-2 分钟']]) {
    for (const [file, src] of [['browser.js', shellJs], ['app.js', app], ['update.js', updJs]]) {
      if (state) assert.ok(src.includes(state), `${file} 缺状态词「${state}」`)
      assert.ok(src.includes(cost), `${file} 缺耗时口径「${cost}」`)
    }
  }
  const builtShell = read('wwwroot/browser.js')
  const builtCss = read('wwwroot/browser.css')
  assert.match(builtShell, /✓ 可更新/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(builtCss, /\.win-btn\.update-badge\.ready/, 'wwwroot 未同步：请执行 npm run build:assets')
})

test('更新窗口：DSH 行的点击闩锁必须由主进程终态释放（不许永远停在「更新中…」）', () => {
  // 判定是纯函数：直接跑真实源码片段，而不是只做正则匹配
  const start = js.indexOf('function dshBusyRelease(input) {')
  const end = js.indexOf('\n}\n', start) + 3
  assert.ok(start > 0 && end > start, 'update.js 应有 dshBusyRelease 纯函数')
  const release = new Function(js.slice(start, end) + '\nreturn dshBusyRelease')()
  const at = (status, error) => release({ busy: true, status, error })
  // 进行中：不许释放（否则按钮闪回，用户以为要再点一次）
  assert.equal(at('updating', ''), false, 'updating 必须保持闩锁')
  assert.equal(at('available', ''), false, 'available（点击后可能先到的旧状态）保持闩锁')
  // 主进程报出的终态：必须释放 —— 这四种里少一种就是"永远卡在更新中"（实测踩过 updated）
  assert.equal(at('updated', ''), true, '更新成功（updated）必须释放闩锁')
  assert.equal(at('up-to-date', ''), true, '已是最新必须释放')
  assert.equal(at('error', 'v0.1.6 启动失败'), true, '更新失败（error）必须释放，否则失败也显示"更新中"')
  assert.equal(at('idle', ''), true, '回到 idle 必须释放')
  assert.equal(at('available', '缓存已作废'), true, '带错误的 available 必须释放')
  // 没点过就不该有闩锁
  assert.equal(release({ busy: false, status: 'updating' }), false, '未点击时无需释放')
  for (const bad of [undefined, null, {}, { busy: true }, { busy: 'true', status: 'updated' }]) {
    assert.equal(typeof release(bad), 'boolean', '脏输入不得抛错：' + JSON.stringify(bad))
  }
  // 接线：renderDsh 必须用它，且成功态有对应文案（否则释放后落到"未检查"，也是一种说谎）
  assert.match(js, /if \(dshBusyRelease\(\{ busy: busy\.dsh, status, error: s\.error \}\)\) busy\.dsh = false/, 'renderDsh 必须用 dshBusyRelease 释放闩锁')
  assert.match(js, /updated: '已更新'/, 'DSH_STATUS 必须有 updated 文案')
  assert.match(js, /const busy = \{ launcher: false, dsh: false \}/, 'busy.dsh 仍应是唯一的点击闩锁')
  assert.match(js, /status === 'up-to-date' \|\| status === 'updated'/, '成功态应与其他"成功"同样用 ok 颜色')
})

test('更新窗口：终态文案覆盖主进程实际会给出的每个状态', () => {
  const start = js.indexOf('const DSH_STATUS = {')
  const end = js.indexOf('\n}\n', start) + 3
  const table = new Function(js.slice(start, end) + '\nreturn DSH_STATUS')()
  // dsh-update.js 的状态机：idle | checking | available | updating | updated | error | up-to-date
  for (const status of ['checking', 'available', 'updating', 'updated', 'up-to-date', 'error', 'idle']) {
    assert.ok(table[status], `DSH_STATUS 缺 ${status} 文案（会回落到"未检查"，与真实状态不符）`)
  }
  assert.equal(table.error, '检查/更新失败', 'error 要同时覆盖"检查失败"与"更新失败"两种情况')
})

test('更新内容：GitHub 限流（403）要给出可读原因，不能只报状态码', () => {
  const changelogMod = require('../changelog')
  const limited = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789614184' }
  const text = changelogMod.httpErrorText(403, limited)
  assert.match(text, /限流/, '403 + 配额用尽必须说"限流"')
  assert.match(text, /60 次\/IP/, '要说清配额口径')
  assert.match(text, /恢复/, '要给出预计恢复时间')
  // 恢复时间按本地时间展示（与启动器其余时间口径一致）：用同一算法算出期望值，避免测试绑死时区
  const local = new Date(1789614184 * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  assert.ok(text.includes(local), `恢复时间应为本地时间 ${local}：` + text)
  // 不带限流头（或不是配额问题）时不许编造原因
  assert.equal(changelogMod.httpErrorText(403, {}), 'HTTP 403')
  assert.equal(changelogMod.httpErrorText(404, limited), 'HTTP 404')
  assert.equal(changelogMod.httpErrorText(500, { 'x-ratelimit-remaining': '59' }), 'HTTP 500')
  const text429 = changelogMod.httpErrorText(429, { 'x-ratelimit-remaining': '59' })
  assert.match(text429, /限流/, '429 本身就是限流')
  assert.ok(!/恢复/.test(text429), '没有 reset 头就不许编恢复时间')
  const changelogJs = read('changelog.js')
  assert.match(changelogJs, /done\(new Error\(httpErrorText\(response\.statusCode, response\.headers\)\)\)/, '取数失败必须走 httpErrorText')
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
  // 回归护栏：更新窗口动作不得再出现在 gated 的 dsh:cmd switch 里
  const dshHandler = mainJs.indexOf("ipcMain.handle('dsh:cmd'")
  assert.ok(dshHandler > 0, '找不到 dsh:cmd 处理器')
  const switchStart = mainJs.indexOf("switch (name) {", dshHandler)
  assert.ok(switchStart > dshHandler, '找不到 dsh:cmd 的 switch')
  const gateStart = mainJs.indexOf('trust.decideCommand(senderOf(event)', dshHandler)
  assert.ok(gateStart > dshHandler, '应有信任判定')
  assert.ok(gateStart < switchStart, '信任判定必须在 switch 之前（先判后执行）')
  // 通用 switch 段里不应再有 changelogGet
  const nextHandler = mainJs.indexOf("ipcMain.handle('dsh:state'", switchStart)
  const switchBlock = mainJs.slice(switchStart, nextHandler > 0 ? nextHandler : switchStart + 8000)
  assert.ok(!switchBlock.includes("changelogGet"), 'changelogGet 不应出现在 dsh:cmd 的 switch 中')
  // senderOf 也不该认识更新窗口（它不属于 dsh:cmd 的信任域）
  assert.ok(!/senderOf[\s\S]{0,600}updateWindowHandle/.test(mainJs), 'senderOf 不应把更新窗口纳入信任域')
})