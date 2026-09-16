// tests/service-failure-wiring.test.js — 服务失败原因/确定性判定/profile 写锁/退出证据 的接线护栏
//
// 这些断言对应一轮真实排查（用户侧「各种报错 + 循环重启」）落地的修复。它们防的是"改回去"：
//   - 崩因（server.err.log）不进控制台 → 用户看不到原因；
//   - 同一份磁盘状态导致的同一失败被重试 5 次才停；
//   - 插件操作并发改写同一份 profile；
//   - 关机/注销被当成启动器异常退出。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')
const html = read('ui-src/index.html')
const app = read('ui-src/app.js')

// ---------- 退出证据：受控退出必须 markClean ----------

test('关机/注销/中断都算受控退出：session-end / SIGINT / will-quit 都要清理 active-run 标记', () => {
  // Windows 关机与注销走 session-end，**不经过** before-quit；缺了它每次重启电脑都会被判成崩溃
  assert.match(main, /app\.on\('session-end',[\s\S]{0,400}?markClean\(\)/, 'session-end 必须清理标记')
  // 控制台 Ctrl+C / VS Code 停止按钮在 Windows 上是 SIGINT（不是 SIGTERM）
  assert.match(main, /process\.on\('SIGINT',[\s\S]{0,400}?markClean\(\)/, 'SIGINT 必须清理标记')
  assert.match(main, /app\.on\('will-quit',[\s\S]{0,300}?markClean\(\)/, 'will-quit 作为兜底')
  // 原有的两条不能丢
  assert.match(main, /app\.on\('before-quit',[\s\S]{0,400}?markClean\(\)/, 'before-quit 仍要清理')
  assert.match(main, /process\.on\('SIGTERM',[\s\S]{0,400}?markClean\(\)/, 'SIGTERM 仍要清理')
})

test('开发者热重启的标记文件路径保持有效（别被"重构"掉）', () => {
  assert.match(main, /\.dev-restart\.json/, 'dev.mjs 写的预期重启标记必须仍被消费')
  assert.match(read('tools/dev.mjs'), /\.dev-restart\.json/, 'dev.mjs 必须仍然写这个标记')
})

// ---------- 失败原因：进内存证据、进通知、进状态 ----------

test('子进程 stderr 进环形缓冲（原因的唯一来源），新一代启动时清空', () => {
  assert.match(main, /server\.errTail\.push\(line\)/, 'stderr 必须留证')
  assert.match(main, /server\.errTail = \[\]/, '新进程启动时必须清掉上一代的证据')
  assert.match(main, /const ERR_TAIL_LINES = \d+/, '必须有明确的行数上限')
})

test('崩溃与启动失败都要记录原因（startup / ready-timeout / 崩溃裁决三条路径）', () => {
  assert.match(main, /noteServiceFailure\('startup'\)/, '启动阶段退出必须留因')
  assert.match(main, /noteServiceFailure\('ready-timeout'\)/, '就绪超时必须留因')
  assert.match(main, /function handleUnexpectedExit[\s\S]{0,400}?noteServiceFailure\(/, '崩溃路径必须留因')
})

test('通知正文带原因，而不是只说"请打开控制台查看日志"', () => {
  assert.match(main, /服务启动失败：\$\{why\}/, '启动失败通知应带原因')
  assert.match(main, /服务意外退出：\$\{why\}/, '意外退出通知应带原因')
  assert.match(main, /自动恢复已停止：\$\{why\}/, '停止自动恢复时应交代原因')
})

test('原因进状态下发（控制台据此显示原因行）', () => {
  assert.match(main, /serviceError: lastServiceError/, 'state 应下发 serviceError')
  assert.match(app, /state\.serviceError/, '控制台应消费 serviceError')
  assert.match(html, /id="logCause"/, '应有原因行容器')
  assert.match(html, /id="logCauseText"/, '应有原因行文本节点')
})

test('一次成功就绪后清掉失败证据（不把过期原因长期挂在界面上）', () => {
  assert.match(main, /function clearServiceFailureTracking\(\)[\s\S]{0,300}?lastServiceError = ''/, '就绪后应清空')
  assert.match(main, /function markReady[\s\S]{0,600}?clearServiceFailureTracking\(\)/, 'markReady 应调用它')
})

// ---------- 确定性失败：同一种失败不再烧完额度 ----------

test('同一种可判定失败连续出现即收敛，不再把 5 次重启额度烧完', () => {
  const body = main.slice(main.indexOf('async function maybeAutoRestart()'))
  const at = body.indexOf('deterministicFailure()')
  const attemptsAt = body.indexOf('const attempts = restartAttemptsInWindow()')
  const streakAt = body.indexOf('if (fastCrashStreak >= RESTART_MAX)')
  assert.ok(at > 0, 'maybeAutoRestart 必须做确定性判定')
  assert.ok(attemptsAt > at, '确定性判定必须排在"计数窗口阈值"之前（否则一样会烧完额度）')
  assert.ok(streakAt > 0 && at > streakAt, '硬止损（就绪后立即崩溃）优先级仍高于确定性判定')
  assert.match(body, /haltAutoRestart\(deterministic\)/, '判定成立应直接收敛并带上原因')
  assert.match(main, /reason: 'deterministic-' \+ deterministic\.kind/, '生命周期事件要记下是哪种确定性失败')
})

test('没有可回退的快照时也要显式声明停止（不能停在"不重启也不解释"的僵尸态）', () => {
  const body = main.slice(main.indexOf('async function maybeAutoRestart()'))
  const call = body.indexOf('await attemptConfigRecovery()')
  assert.ok(call > 0, '计数阈值那条路径应尝试回退')
  const after = body.slice(call)
  assert.match(after, /if \(!autoRestartStopped && !server\.running\(\) && !recoveryDone && !restartRetryPending\(\)\)/, '回退空转后必须判定僵尸态')
  assert.match(after, /haltAutoRestart\(\)/, '僵尸态必须收敛为显式停止')
})

// ---------- 控制台日志来源可切 ----------

test('运行日志可切来源：启动器 / 服务错误 / 服务输出', () => {
  assert.match(main, /const LOG_SOURCES = \{/, '主进程应有来源表')
  assert.match(main, /'server-err': \{ label: '服务错误'[^}]*ERR_LOG/, '服务错误来源必须指向 server.err.log')
  assert.match(main, /'server-out': \{ label: '服务输出'[^}]*OUT_LOG/, '服务输出来源必须指向 server.out.log')
  assert.match(main, /case 'logRead': return JSON\.stringify\(readLogSource\(/, '应有 logRead 命令')
  // 落盘文本必须脱敏：server.out.log 里有一次性 launch token
  assert.match(main, /function readLogSource[\s\S]{0,900}?redact\(text\)/, '读日志必须过 redact()')
})

test('来源切换的界面接线完整（按钮 / 事件 / 命令三处都在）', () => {
  for (const src of ['launcher', 'server-err', 'server-out']) {
    assert.match(html, new RegExp(`data-log-source="${src}"`), `缺少来源按钮 ${src}`)
    assert.match(app, new RegExp(`['"]?${src}['"]?:`), `缺少来源提示文案 ${src}`)
  }
  assert.match(app, /#logSources \[data-log-source\]/, '应有来源按钮事件绑定')
  assert.match(app, /cmd\('logRead'/, '前台必须调 logRead')
  assert.match(html, /id="btnLogCauseJump"/, '原因行应有"查看服务错误日志"入口')
  // 默认来源仍是启动器日志：不改变老用户看到的东西
  assert.match(app, /window\._logSource = 'launcher'/, '默认来源必须是启动器日志')
})

// ---------- profile 写锁 ----------

test('profile 写锁：所有会改 profile 的入口都必须过锁', () => {
  const guarded = [
    ['marketInstall', /case 'marketInstall': return JSON\.stringify\(await withProfileOp\(/],
    ['marketUninstall', /case 'marketUninstall': return JSON\.stringify\(await withProfileOp\(/],
    ['pluginAction', /case 'pluginAction':[\s\S]{0,400}?withProfileOp\(/],
    ['pluginsInstallAll', /case 'pluginsInstallAll':[\s\S]{0,400}?profileOpBusy\(\)/],
    ['pluginsRetryEnvFailed', /case 'pluginsRetryEnvFailed': return JSON\.stringify\(await withProfileOp\(/],
    ['remoteConnectSet', /case 'remoteConnectSet': return JSON\.stringify\(await withProfileOp\(/],
    ['remoteConnectReinstall', /case 'remoteConnectReinstall': return JSON\.stringify\(await withProfileOp\(/],
    ['pluginsApplyRestart', /case 'pluginsApplyRestart': return JSON\.stringify\(await withProfileOp\(/],
  ]
  for (const [name, re] of guarded) {
    assert.match(main, re, `${name} 必须走 profile 写锁`)
  }
})

test('后台自动流程也要占锁，拿不到就跳过且不记账', () => {
  for (const label of ['自动安装插件市场', '自动安装远程连接插件', '自动安装推荐插件']) {
    assert.match(main, new RegExp(`tryBeginBackgroundProfileOp\\('${label}'\\)`), `${label} 必须占锁`)
  }
  // 一行式：拿不到锁就把单飞标志复位并返回（不能把"已尝试过"记账写下去）
  assert.match(main, /if \(!releaseProfileOp\) \{ (marketAutoInstalling|bridgeAutoInstalling|recommendedAutoInstalling) = false; return \}/, '拿不到锁必须复位标志并返回')
})

test('锁是 fail-fast：后来者立刻拿到可读的拒绝，不排队', () => {
  const start = main.indexOf('const PROFILE_BUSY_ERROR')
  const end = main.indexOf('\n}\n', main.indexOf('function tryBeginBackgroundProfileOp')) + 3
  assert.ok(start > 0 && end > start, '找不到 profile 写锁实现')
  const cfg = {}
  const factory = new Function('cfg', main.slice(start, end) + '\nreturn { tryBeginProfileOp, profileOpBusy, withProfileOp, tryBeginBackgroundProfileOp }')
  const api = factory(cfg)

  assert.equal(api.profileOpBusy(), false, '初始应为空闲')
  const release = api.tryBeginProfileOp('第一个')
  assert.ok(typeof release === 'function')
  assert.equal(api.profileOpBusy(), true)
  assert.equal(api.tryBeginProfileOp('第二个'), null, '锁被占用时第二个调用者必须拿不到')
  release()
  assert.equal(api.profileOpBusy(), false, 'release 后应恢复空闲')
  release() // 重复 release 幂等
  assert.equal(api.profileOpBusy(), false)
})

test('锁：withProfileOp 被占用时不执行 fn，并回可读错误', async () => {
  const start = main.indexOf('const PROFILE_BUSY_ERROR')
  const end = main.indexOf('\n}\n', main.indexOf('function tryBeginBackgroundProfileOp')) + 3
  const factory = new Function('log', main.slice(start, end) + '\nreturn { tryBeginProfileOp, withProfileOp }')
  const api = factory(() => {})

  let ran = 0
  const release = api.tryBeginProfileOp('占用者')
  const blocked = await api.withProfileOp('第二个', async () => { ran++; return { ok: true } })
  assert.equal(ran, 0, '拿不到锁就绝不能执行')
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /另一个插件操作正在进行/u)
  release()
  const ok = await api.withProfileOp('第三个', async () => { ran++; return { ok: true } })
  assert.equal(ran, 1)
  assert.equal(ok.ok, true)
})

test('锁：fn 抛错也必须释放（否则整个插件页会永久卡住）', async () => {
  const start = main.indexOf('const PROFILE_BUSY_ERROR')
  const end = main.indexOf('\n}\n', main.indexOf('function tryBeginBackgroundProfileOp')) + 3
  const factory = new Function('log', main.slice(start, end) + '\nreturn { tryBeginProfileOp, profileOpBusy, withProfileOp }')
  const api = factory(() => {})
  await assert.rejects(api.withProfileOp('会炸的', async () => { throw new Error('boom') }))
  assert.equal(api.profileOpBusy(), false, '抛错后锁必须已释放')
})

test('停服务失败时调用方必须中止（不得在别人占着依赖树时改写 profile）', () => {
  assert.match(main, /async function stopServiceForPluginChange\(\)[\s\S]{0,700}?return \{ ok: false, error: '服务正在停止中，请稍候重试'/, '停不下来必须如实返回失败')
  assert.match(main, /const stop = await stopServiceForPluginChange\(\)\s*\n\s*if \(!stop\.ok\) return stop/, 'dispatchManagedPluginAction 必须检查返回值')
  assert.match(main, /const stop = await stopServiceForPluginChange\(\)\s*\n\s*if \(!stop\.ok\) return stop/, 'applyRemoteConnect 必须检查返回值')
})

// ---------- 启动互斥 ----------

test('启动互斥：并发启动共用同一次，绝不 spawn 两个抢同一端口', () => {
  assert.match(main, /function startServer\(occupantRetry = 0\) \{\s*\n\s*if \(server\.startPromise\) return server\.startPromise/, 'startServer 必须是带互斥的包装')
  assert.match(main, /async function startServerInner\(occupantRetry = 0\)/, '真正的实现应改名为 startServerInner')
  // 内部递归必须走 inner：走包装会 await 到自己这次 startPromise，直接死锁
  assert.match(main, /return startServerInner\(retryDepth \+ 1\)/, 'handlePortOccupied 的递归必须走 inner')
})

// ---------- 健康快照覆盖面 ----------

test('健康快照纳入 DSH 侧状态文件，且 package.json 带回退前置校验', () => {
  assert.match(main, /extraFiles: healthExtraFiles\(\)/, 'initHealth 必须传 extraFiles')
  assert.match(main, /id: 'dsh-settings-yaml'/, 'settings.yaml 必须进快照')
  assert.match(main, /id: 'profile-cordis-patch'/, 'profile 的 cordis.patch.yml 必须进快照')
  assert.match(main, /id: 'profile-package'[\s\S]{0,120}?validate: profilePackageRestorable/, 'package.json 必须带前置校验')
  // 校验的核心：快照声明的插件当前不在 node_modules 里 → 拒绝回退（否则亲手造出 cannot resolve profile bundle）
  assert.match(main, /function profilePackageRestorable[\s\S]{0,900}?ok: false[\s\S]{0,200}?当前未安装/, '缺插件时必须拒绝')
  assert.match(main, /name\.startsWith\('@deepseek-ai\/'\)\) continue/, 'DSH 自带的层不算缺失')
})

test('回退结果里的"跳过了什么"必须被说出来（日志 + 通知）', () => {
  assert.match(main, /function describeRestoreExtras\(/, '应有 extras 结果转述')
  const auto = main.slice(main.indexOf('async function attemptConfigRecovery'))
  assert.match(auto, /describeRestoreExtras\(r\.extras\)/, '自动回退要转述 extras 结果')
  const manual = main.slice(main.indexOf('async function restoreCheckpoint'))
  assert.match(manual, /describeRestoreExtras\(r\.extras\)/, '手动回退要转述 extras 结果')
})
