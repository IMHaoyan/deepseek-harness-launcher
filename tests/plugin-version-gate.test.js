// tests/plugin-version-gate.test.js — DSH 的「精确版本门禁」：归类、更新前预判、授权闭环。
//
// 背景（2026-10-08 实测，profile 的 .plugin-manager/logs 里同一条拒绝出现过 18 次）：
// 运行 dsh 0.2.1-alpha.1，插件 @michengai/dsh-skills-manager@1.1.13 的 peer 是**精确版本并集**且止于
// 0.2.0-rc.2 → `dsh plugin add` 在安装前就整条拒绝（nothing was installed）。而 DSHL 的卡片只比 npm
// 版本号，界面先承诺「可更新到 v1.1.13」，点下去必然失败；失败原文是一大段英文，也没有下一步动作。
//
// 这一层要守的三件事：
//   1. 判据与 DSH 一致：只看 @deepseek-ai/dsh*、semver includePrerelease、compatibility.json 的精确豁免算数；
//   2. 界面文案与真实动作一一对应：会被门禁拒绝的，不许写「可更新到 vX」，按钮换成「授权并更新」；
//   3. 授权由 dsh 自己的 allow-version 落盘，DSHL 绝不自己写 compatibility.json，且授权后要读盘复核。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')
const market = require('../market')
const compat = require('../dsh-plugin-compat')

const RUNTIME = '0.2.1-alpha.1'
/** 真实 npm manifest 里 1.1.13 的 dsh peer 并集（从被拒日志抄下来，不是编的）。 */
const REAL_UNION = '0.1.2-rc.1 || 0.1.5-rc.1 || 0.1.5-rc.2 || 0.1.5-rc.3 || 0.1.7-rc.1 || 0.1.7-rc.2 || 0.2.0-rc.1 || 0.2.0-rc.2'
const GATE_OUTPUT = 'dsh: installation rejected: Plugin @michengai/dsh-skills-manager@1.1.13 is incompatible with '
  + 'dsh 0.2.1-alpha.1: peerDependencies {"@deepseek-ai/dsh-skill":"' + REAL_UNION + '"}. Running it may cause '
  + 'crashes or data loss. To accept this risk explicitly, grant the exact-version exemption for '
  + '@michengai/dsh-skills-manager@1.1.13 on dsh 0.2.1-alpha.1 with `dsh plugin allow-version` or the plugin '
  + 'manager, then retry the installation or restart dsh. Exact-version exemption: not active.\n'
  + 'dsh: nothing was installed.'

// ---------- 归类：把 DSH 的拒绝原文变成结构化事实 ----------

test('parseVersionGate：抠出 包@版本 与 dsh 版本（scope 的 @ 不能当分隔符）', () => {
  const gate = market.parseVersionGate(GATE_OUTPUT)
  assert.deepEqual(gate, {
    packageName: '@michengai/dsh-skills-manager',
    version: '1.1.13',
    dshVersion: '0.2.1-alpha.1',
    exemptionActive: false,
  })
})

test('parseVersionGate：启动期跳过 bundle 的同款措辞也能认（安装期/启动期一套判据）', () => {
  const boot = 'dsh: skipping profile bundle "@michengai/dsh-skills-manager": Plugin '
    + '@michengai/dsh-skills-manager@1.1.13 is incompatible with dsh 0.2.1-alpha.1: peerDependencies {}. '
    + 'Exact-version exemption: active.'
  const gate = market.parseVersionGate(boot)
  assert.equal(gate.packageName, '@michengai/dsh-skills-manager')
  assert.equal(gate.version, '1.1.13')
  assert.equal(gate.dshVersion, '0.2.1-alpha.1')
  assert.equal(gate.exemptionActive, true, '已授权过要能看出来（界面文案据此区分）')
})

test('parseVersionGate：不是门禁就返回 null，别的失败照旧走各自的分类', () => {
  assert.equal(market.parseVersionGate('[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed'), null)
  assert.equal(market.parseVersionGate('ERR_PNPM_EPERM: operation not permitted, rename'), null)
  assert.equal(market.parseVersionGate(''), null)
  assert.equal(market.parseVersionGate(null), null)
})

test('未装上清单的弹窗：主进程下发、控制台只弹一次、点完 ack、并把人引导到预装插件页', () => {
  const app = read('ui-src/app.js')
  const html = read('ui-src/index.html')
  // 主进程：清单进 state、ack 有命令
  assert.match(main, /pluginGateNotice: Config\.pluginGateNotice \|\| null/, 'stateJson 要下发待确认清单')
  assert.match(main, /case 'pluginsAckGateNotice': return JSON\.stringify\(ackPluginGateNotice\(\)\)/, '要有 ack 命令')
  assert.match(main, /setPluginGateNotice\(gated\.map\(/, '默认代装跳过时要记下这条清单')
  assert.match(main, /if \(!consoleIsOpen\(\)\) \{[\s\S]{0,300}?notify\('DeepSeek Harness Launcher'/, '控制台没开时退回系统通知')
  // 控制台：弹窗 + 引导 + 一次性
  assert.match(app, /function renderPluginGateNotice\(notice\)/, '要有弹窗渲染器')
  assert.match(app, /void renderPluginGateNotice\(state\.pluginGateNotice\)/, '状态推送要驱动弹窗')
  assert.match(app, /confirmText: '去预装插件页安装'/, '弹窗的主按钮要指向真实动作')
  assert.match(app, /cancelText: '稍后再说'/, '只提醒不强迫：取消文案要说清是"稍后"')
  assert.match(app, /await cmd\('pluginsAckGateNotice'\)/, '看过就要 ack（不然每次都弹）')
  assert.match(app, /if \(ok\) \{\n\s+showPage\('plugins'\)/, '确认后要跳到「预装插件」页')
  assert.match(app, /plugin-latest\.gate[\s\S]{0,120}?scrollIntoView/, '顺手把第一张需授权的卡片滚进视野')
  assert.match(app, /window\._gateNoticeAt === info\.at/, '同一条只弹一次（状态每次都推）')
  assert.match(app, /cancelBtn\.textContent = o\.cancelText \|\| '取消'/, 'confirmDialog 要支持自定义取消文案')
  assert.match(html, /id="confirmTitle"/, '复用现有弹窗结构，不另造一套')
  assert.match(read('wwwroot/app.js'), /function renderPluginGateNotice\(notice\)/, 'wwwroot 未同步：请执行 npm run build:assets')
})

test('同一份文案：安装期解析出的门禁失败与「装之前预判」给出完全一样的归类', () => {
  const parsed = market.classifyEnvFailure(GATE_OUTPUT)
  const predicted = market.versionGateFailure({
    packageName: '@michengai/dsh-skills-manager',
    version: '1.1.13',
    dshVersion: '0.2.1-alpha.1',
  })
  assert.deepEqual(predicted, parsed, '两条路必须同源，否则同一个原因在提示条上会有两种说法')
  assert.equal(predicted.recoverable, false, '预判出来的同类失败也不该给「重试」按钮')
  // 拿不到包名/版本时也要能说清（预判可能只有 dsh 版本）
  const vague = market.versionGateFailure({ dshVersion: '0.2.1-alpha.1' })
  assert.equal(vague.kind, 'version-gate')
  assert.match(vague.reason, /0\.2\.1-alpha\.1/)
})

test('classifyEnvFailure：门禁单独一类，且不给"重试"按钮（普通重试不会变好）', () => {
  const info = market.classifyEnvFailure(GATE_OUTPUT)
  assert.equal(info.kind, 'version-gate')
  assert.equal(info.recoverable, false, '必须先授权；普通重试点了还会同样失败')
  assert.deepEqual(info.gate, {
    packageName: '@michengai/dsh-skills-manager',
    version: '1.1.13',
    dshVersion: '0.2.1-alpha.1',
    exemptionActive: false,
  })
  assert.match(info.title, /不含当前 dsh/, '标题要一句话说清是什么')
  assert.match(info.reason, /@michengai\/dsh-skills-manager@1\.1\.13/, '解释里要出现被拒的精确版本')
  assert.match(info.reason, /0\.2\.1-alpha\.1/, '解释里要出现当前 dsh 版本')
  assert.match(info.reason, /授权/, '要说出下一步是授权，而不是"稍后重试"')
  assert.doesNotMatch(info.reason, /Running it may cause crashes/, '不要把英文长文原样摊给用户')
})

// ---------- 预判：判据必须与 DSH 的 evaluatePluginCompatibility 同口径 ----------

test('同口径：这份真实 peer 并集在 0.2.1-alpha.1 下判为不兼容（与 DSH 的拒绝一致）', () => {
  const verdict = compat.evaluateManifestPeers({ peerDependencies: { '@deepseek-ai/dsh-skill': REAL_UNION } }, RUNTIME)
  assert.equal(verdict.compatible, false, 'DSH 拒了它，预判也必须判它不兼容')
  assert.equal(verdict.peers.length, 1)
  assert.equal(verdict.peers[0].name, '@deepseek-ai/dsh-skill')
  // 非 DSH 命名空间的 peer 不参与门禁（react 之类不该让插件"看起来不兼容"）
  assert.equal(compat.evaluateManifestPeers({ peerDependencies: { react: '^18.2.0' } }, RUNTIME).compatible, true)
})

test('顺手把 manifest 的 peer 声明带出来：预判与安装必须用同一份数据', () => {
  const manifest = {
    name: 'x', version: '1.1.13',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/dsh-skill': REAL_UNION, react: '^18.2.0', broken: 42 },
  }
  const verified = market.verifyNpmManifestShape(manifest, 'x')
  assert.equal(verified.version, '1.1.13')
  assert.equal(verified.peerDependencies['@deepseek-ai/dsh-skill'], REAL_UNION)
  assert.equal(verified.peerDependencies.react, '^18.2.0')
  assert.equal(verified.peerDependencies.broken, undefined, '非字符串值直接丢掉，别让它进判定')
  // 没有 peerDependencies 的包照常通过（空对象，而不是 undefined）
  assert.deepEqual(market.verifyNpmManifestShape({ name: 'y', version: '1.0.0', dsh: { bundle: { patch: './p.yml' } } }, 'y').peerDependencies, {})
})

test('pluginGateVerdict：gated / exempt / ok / unknown 四态（执行 main.js 里的真实实现）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-gate-'))
  const profile = path.join(tmp, 'profiles', 'web')
  fs.mkdirSync(profile, { recursive: true })
  const writeExemptions = (value) => fs.writeFileSync(path.join(profile, 'compatibility.json'), JSON.stringify(value))

  const start = main.indexOf('function runningDshVersion() {')
  const end = main.indexOf('\n}\n', main.indexOf('function pluginGateVerdict(')) + 3
  assert.ok(start > 0 && end > start, '找不到门禁预判实现')
  const src = main.slice(start, end)
  // 每个实例一套注入（envReport 是按值传进去的，改外层 ctx 不会影响已建好的实例）
  const makeVerdict = (envReport, cache) => {
    const ctx = {
      envReport,
      DSH_PROFILE_DIR: profile,
      fs, path, semver: require('semver'), pluginCompat: compat,
      npmVersionCache: cache,
      log: () => {},
    }
    const names = Object.keys(ctx)
    return new Function(...names, src + '\nreturn pluginGateVerdict')(...names.map((k) => ctx[k]))
  }
  const cache = new Map()
  const verdictOf = makeVerdict({ dsh: { version: RUNTIME } }, cache)
  const put = (version, peers) => cache.set('@michengai/dsh-skills-manager', { version, peerDependencies: peers, at: Date.now() })

  put('1.1.13', { '@deepseek-ai/dsh-skill': REAL_UNION })
  assert.equal(verdictOf('@michengai/dsh-skills-manager', '1.1.13').state, 'gated', '声明不含运行中的 dsh → gated')
  assert.equal(verdictOf('@michengai/dsh-skills-manager', '1.1.13').peers.length, 1, '要带出不满足的那条声明')

  writeExemptions({ '@michengai/dsh-skills-manager@1.1.13': [RUNTIME] })
  assert.equal(verdictOf('@michengai/dsh-skills-manager', '1.1.13').state, 'exempt', '已授权的精确版本算数（否则刚授权完还一直报"需授权"）')

  writeExemptions({ '@michengai/dsh-skills-manager@1.1.12': [RUNTIME] })
  assert.equal(verdictOf('@michengai/dsh-skills-manager', '1.1.13').state, 'gated', '豁免是精确版本粒度：换一版就要重新授权')

  fs.rmSync(path.join(profile, 'compatibility.json'), { force: true })
  put('1.1.14', { '@deepseek-ai/dsh-skill': '>=0.2.0-rc.1 <0.3.0' })
  assert.equal(verdictOf('@michengai/dsh-skills-manager', '1.1.14').state, 'ok', '区间声明覆盖运行中的 dsh → ok')

  assert.equal(verdictOf('@michengai/dsh-skills-manager', '9.9.9').state, 'unknown', '还没查到这一版的 manifest → 拿不准')
  assert.equal(verdictOf('nope-pkg', '1.0.0').state, 'unknown', '没有 npm 侧数据 → 拿不准')
  const noDsh = makeVerdict({ dsh: {} }, cache)
  assert.equal(noDsh('@michengai/dsh-skills-manager', '1.1.14').state, 'unknown', 'dsh 版本未知 → 拿不准（fail-closed，不假装兼容）')
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ---------- 授权：交给 dsh 自己的命令，并且读盘复核 ----------

test('授权走 dsh 自己的 allow-version：精确版本 + --accept-risk + --dsh-version，形状不合法就不发命令', async () => {
  const calls = []
  market.initMarket({ home: '', envDetect: null, log: () => {} })
  // 形状校验在发命令之前：拿不到 envDetect 时应当直接失败，而不是带着范围/dist-tag 去授权
  const badPkg = await market.allowVersionExemption('not a package', '1.0.0', RUNTIME)
  assert.equal(badPkg.ok, false)
  assert.match(badPkg.error, /包名/)
  const badRange = await market.allowVersionExemption('@scope/pkg', '^1.0.0', RUNTIME)
  assert.equal(badRange.ok, false)
  assert.match(badRange.error, /精确版本/)
  const badRuntime = await market.allowVersionExemption('@scope/pkg', '1.0.0', 'latest')
  assert.equal(badRuntime.ok, false)
  assert.match(badRuntime.error, /精确版本/)
  assert.deepEqual(calls, [])
  const src = read('market.js')
  assert.match(src, /runCliOnce\(\['allow-version', pkg \+ '@' \+ ver, '--dsh-version', runtime, '--accept-risk'\]\)/,
    '必须原样调 dsh 的 allow-version（带 --accept-risk），不自造豁免写法')
})

test('DSHL 绝不自己写 compatibility.json：那是 dsh 的授权账本', () => {
  const marketSrc = read('market.js')
  assert.doesNotMatch(marketSrc, /writeFileSync\([^)]*compatibility\.json/u, 'market.js 不得直接写豁免文件')
  assert.doesNotMatch(main, /writeFileSync\([^)]*compatibility\.json/u, 'main.js 不得直接写豁免文件')
  // 复核必须是读盘：命令报成功也要看盘上有没有这一对
  assert.match(main, /grantVersionExemptionFor[\s\S]{0,1400}?pluginCompat\.readProfileExemptions\(DSH_PROFILE_DIR\)/,
    '授权后要读盘复核（只信盘上的结果，不信命令回执）')
  assert.match(main, /视为未生效，已中止安装/, '复核不过时必须中止安装，不能把失败甩给"安装失败"')
  assert.match(main, /授权失败：/, '授权命令本身失败要给一句能归因的话')
})

// ---------- 界面：文案与真实动作一一对应 ----------

test('按钮形态：被门禁挡住时按钮换成「授权并安装 / 授权并更新到 vX」', () => {
  const start = main.indexOf('function pluginCardActions(')
  const end = main.indexOf('\n}', start) + 2
  const build = new Function(main.slice(start, end) + '; return pluginCardActions')()

  const gatedUpdate = build({ installed: true, outdated: true, latestVersion: '1.1.13', name: '技能管理', gateState: 'gated', grantBody: '风险说明' })
  assert.equal(gatedUpdate[0].action, 'grant-update', '被门禁挡住时不能给普通的 update')
  assert.match(gatedUpdate[0].label, /授权/)
  assert.match(gatedUpdate[0].label, /1\.1\.13/, '按钮上要写清会更新到哪一版')
  assert.equal(gatedUpdate[0].confirmBody, '风险说明', '授权前必须有风险确认正文')
  assert.equal(gatedUpdate[1].action, 'uninstall', '已安装时仍是两个按钮')

  const gatedInstall = build({ installed: false, name: '技能管理', gateState: 'gated', grantBody: '风险说明' })
  assert.equal(gatedInstall.length, 1)
  assert.equal(gatedInstall[0].action, 'grant-install')
  assert.equal(gatedInstall[0].confirmTitle, '先授权再安装？')

  // 拿不准（unknown）与正常情形保持原样：不能用"拿不准"挡住真实可用的动作
  const unknown = build({ installed: true, outdated: true, latestVersion: '1.1.13', name: '技能管理', gateState: 'unknown' })
  assert.equal(unknown[0].action, 'update')
  assert.equal(build({ installed: true, outdated: true, latestVersion: '1.1.13', name: 'x', gateState: 'exempt' })[0].action, 'update')
})

test('卡片与提示条接线：需授权文案、gate 字段、授权命令都在', () => {
  const app = read('ui-src/app.js')
  const html = read('ui-src/index.html')
  assert.match(main, /gate: \{\n\s+state: gate\.state,/, '卡片要带上门禁预判结果')
  assert.match(main, /const gate = pluginGateVerdict\(d\.npm, latest\)/, 'npm 插件卡片要按目标版本预判')
  assert.match(main, /gateState: gate\.state,/, '按钮形态要吃预判结果')
  assert.match(main, /pluginBusyLabel[\s\S]{0,400}?grant-update'\) return '授权并更新中…'/, '授权中要有自己的忙态文案')
  assert.match(app, /'需授权后更新到 v' \+ p\.latestVersion/, '被挡住时不能写「可更新到 vX」')
  assert.match(app, /'需授权后安装 v' \+ p\.latestVersion/, '未安装但会被拒的也要说清')
  assert.match(app, /plugin-latest gate/, '需授权那行要有自己的样式钩子')
  assert.match(app, /function pluginGateHint\(p\)/, '长尾（不满足的声明）退到 tooltip')
  assert.match(html, /id="btnPluginEnvGrant"/, '提示条要有「授权并重试」')
  assert.match(read('ui-src/console.css'), /\.plugin-latest\.gate \{ color: #B45309; \}/, '需授权提示要有 warn 色')
  // 确认正文是多行结构（风险说明 + 不满足的 peer 清单）：modal-body 必须保留换行
  assert.match(read('ui-src/styles.css'), /\.modal-body \{[\s\S]{0,300}?white-space: pre-line;/,
    '确认框正文要保留换行，否则授权说明与 peer 清单会被折成一整段')
})

test('一键更新/一键安装不替用户授权：跳过需授权的那批，并如实说出来', () => {
  const app = read('ui-src/app.js')
  assert.match(main, /const gated = all\.filter\(\(t\) => t\.gated\)/, '一键更新要先摘出需授权的目标')
  assert.match(main, /一键更新跳过[\s\S]{0,200}?需先授权/, '跳过要留日志')
  assert.match(main, /个插件需先授权才能更新（在卡片上点「授权并更新到 vX」）/, '一个都没更新成时要说清原因与下一步')
  assert.match(main, /个插件需先授权才能安装（在卡片上点「授权并安装」）/, '一键安装同样要说明')
  assert.match(main, /const targets = all\.filter\(\(t\) => !t\.gated\)/, '批量目标要排除需授权的')
  assert.match(app, /const gated = outdated\.filter\(\(p\) => p\.gate && p\.gate\.state === 'gated'\)/, '前台的确认文案要说明这批里没有它们')
  assert.match(app, /另有 ' \+ gated\.length \+ ' 个需先授权/, '确认弹窗要说清跳过了谁')
  assert.match(app, /updateBtn\.disabled = !updatable\.length/, '全是被挡住的插件时按钮不该可点')
  // 构建产物同步：wwwroot 由 ui-src 生成，改完 UI 必须同步
  assert.match(read('wwwroot/app.js'), /function pluginGateHint\(p\)/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(read('wwwroot/index.html'), /id="btnPluginEnvGrant"/, 'wwwroot 未同步：请执行 npm run build:assets')
})
