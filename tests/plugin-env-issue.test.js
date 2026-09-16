// tests/plugin-env-issue.test.js — 插件安装的「环境级故障」护栏。
//
// 为什么需要这一层：pnpm 11 的 24h 新版本观察期拒绝的是**整份 lockfile**，node_modules 被占用、
// npm 源限流、pnpm 未就绪同理 —— 这些失败与「装哪个插件」无关，一次批量里所有插件会一起失败。
// 逐张卡片各写一条「操作失败」会让人以为插件坏了，所以主进程归类成一条解释 + 一次「重试失败的插件」。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')
const market = require('../market')

const AGE_OUTPUT = '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 2 lockfile entries failed verification:\n'
  + '  @michengai/dsh-codex-ui@1.1.8 was published at 2026-09-15T09:53:00.584Z, within the minimumReleaseAge cutoff (x)\n'
  + '  dsh-chat-import@0.17.0 was published at 2026-09-15T15:39:20.245Z, within the minimumReleaseAge cutoff (x)\n'
  + 'The lockfile contains entries that the active policies reject. This can mean the lockfile is stale, or that someone committed a lockfile that bypassed the policy locally.'

/** 取真实的聚合实现（含 module 内的 pluginEnvIssue/pluginEnvNote），注入最小上下文跑真流程。 */
function loadAggregator(overrides = {}) {
  const start = main.indexOf('let pluginEnvIssue = null')
  const retryAt = main.indexOf('async function retryPluginEnvFailures() {')
  assert.ok(start > 0 && retryAt > start, '找不到插件环境级故障聚合实现')
  const end = main.indexOf('\n}\n', retryAt) + 3
  const ctx = {
    MANAGED_NPM_PLUGINS: [
      { id: 'usage-billing', name: '用量与计费', npm: '@kenz1117/dsh-ui-usage-billing' },
      { id: 'rename-me', name: '另一个插件', npm: 'other-pkg' },
    ],
    market,
    runManagedPluginAction: async () => ({ ok: true }),
    broadcastState: () => {},
    ...overrides,
  }
  const names = Object.keys(ctx)
  const body = main.slice(start, end)
    + '\nreturn { pluginDisplayName, notePluginEnvFailure, clearPluginEnvFailure, notePluginReleaseAgeRetry, retryPluginEnvFailures, issue: () => pluginEnvIssue, note: () => pluginEnvNote }'
  return new Function(...names, body)(...names.map((k) => ctx[k]))
}

test('同一原因的多次失败合成一条：受影响插件并列，重试项去重', () => {
  const agg = loadAggregator()
  const info = market.classifyEnvFailure(AGE_OUTPUT)
  assert.equal(info.kind, 'release-age')
  agg.notePluginEnvFailure('usage-billing', 'install', info)
  agg.notePluginEnvFailure('rename-me', 'install', info)
  agg.notePluginEnvFailure('usage-billing', 'install', info) // 重复失败不重复记账
  const issue = agg.issue()
  assert.equal(issue.kind, 'release-age')
  assert.deepEqual(issue.names, ['用量与计费', '另一个插件'])
  assert.deepEqual(issue.retry.map((x) => x.id), ['usage-billing', 'rename-me'])
  assert.equal(issue.entries.length, 2, '被 pnpm 拒绝的条目要带上（提示条 tooltip 用）')
  assert.equal(issue.recoversAt, '2026-09-16T15:39:20.245Z', '自愈时刻按最晚的发布时间 + 24h')
})

test('换一类原因就重新开始；不同原因不混成一条', () => {
  const agg = loadAggregator()
  agg.notePluginEnvFailure('usage-billing', 'install', market.classifyEnvFailure(AGE_OUTPUT))
  agg.notePluginEnvFailure('rename-me', 'install', market.classifyEnvFailure('ERR_PNPM_EPERM: operation not permitted, rename'))
  const issue = agg.issue()
  assert.equal(issue.kind, 'locked')
  assert.deepEqual(issue.names, ['另一个插件'], '旧原因下的失败项不跟着新提示走')
})

test('不可重试的原因不产生「重试」项：按钮必须对应真实可用的动作', () => {
  const agg = loadAggregator()
  const env = market.classifyEnvFailure('pnpm 未就绪：Corepack 未对齐。请先在运行环境页安装/修复 pnpm。')
  assert.equal(env.recoverable, false)
  agg.notePluginEnvFailure('usage-billing', 'install', env)
  assert.deepEqual(agg.issue().retry, [])
  assert.deepEqual(agg.issue().names, ['用量与计费'], '仍然要显示出来，只是不给重试按钮')
})

test('无法归类的原因不占版面；成功一次就把自己摘掉，摘空即整条消失', () => {
  const agg = loadAggregator()
  agg.notePluginEnvFailure('usage-billing', 'install', market.classifyEnvFailure('安装后 profile 未正确记录该插件'))
  assert.equal(agg.issue(), null, '归不了类的失败只留在卡片上')
  const info = market.classifyEnvFailure(AGE_OUTPUT)
  agg.notePluginEnvFailure('usage-billing', 'install', info)
  agg.notePluginEnvFailure('rename-me', 'install', info)
  agg.clearPluginEnvFailure('usage-billing')
  assert.deepEqual(agg.issue().names, ['另一个插件'])
  agg.clearPluginEnvFailure('rename-me')
  assert.equal(agg.issue(), null)
})

test('靠一次性放行装好时：只给低噪提示（含按本地时间写的自愈时刻），不占版面', () => {
  const agg = loadAggregator()
  const releaseAge = { retried: true, entries: [{ name: 'dshmarket@1.47.0', publishedAt: '2026-09-15T04:59:30.465Z' }] }
  assert.equal(agg.notePluginReleaseAgeRetry(releaseAge), true)
  assert.match(agg.note(), /1 个不足 24h 的新版本/)
  // 期望值按"同一条规则"现算（发布时刻 + 24h，再按本机本地时间格式化）：硬编码成某个时区的字符串
  // 会让这条断言只在 UTC+8 的机器上绿（换台机器/出差改时区就红），而它真正要守的是"本地时间、不是 ISO 串"。
  const expected = new Date(Date.parse('2026-09-15T04:59:30.465Z') + 24 * 60 * 60 * 1000)
    .toLocaleString('sv-SE', { hour12: false })
  assert.ok(expected, '期望值应能算出来')
  assert.match(agg.note(), new RegExp(expected.replace(/:/g, '\\:')), `按本地时间展示（期望含 ${expected}）`)
  assert.doesNotMatch(agg.note(), /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, '不能把 ISO 串直接摊给用户')
  assert.equal(agg.issue(), null, '操作成功不该弹提示条')
  assert.equal(agg.notePluginReleaseAgeRetry(null), false)
  assert.equal(agg.notePluginReleaseAgeRetry({ retried: false, entries: [] }), false)
})

test('重试失败项：只跑这批、攒着等一次重启、失败原样回报', async () => {
  const calls = []
  const agg = loadAggregator({
    runManagedPluginAction: async (id, action, opts) => {
      calls.push({ id, action, defer: !!(opts && opts.defer) })
      return id === 'rename-me' ? { ok: false, error: '还没好' } : { ok: true }
    },
  })
  assert.deepEqual(await agg.retryPluginEnvFailures(), { ok: false, error: '没有可重试的失败项' })
  const info = market.classifyEnvFailure(AGE_OUTPUT)
  agg.notePluginEnvFailure('usage-billing', 'install', info)
  agg.notePluginEnvFailure('rename-me', 'update', info)
  const r = await agg.retryPluginEnvFailures()
  assert.equal(r.ok, false)
  assert.match(r.error, /另一个插件：还没好/)
  assert.deepEqual(calls, [
    { id: 'usage-billing', action: 'install', defer: true },
    { id: 'rename-me', action: 'update', defer: true },
  ], '重试必须沿用原动作，并走 defer（不逐项重启服务）')
})

test('主进程接线：状态下发、动作记账、IPC 命令齐全', () => {
  assert.match(main, /pluginEnvIssue: pluginEnvIssue/, 'stateJson 应下发聚合状态')
  assert.match(main, /pluginEnvNote: pluginEnvNote \|\| ''/, 'stateJson 应下发放行完成的低噪提示')
  assert.match(main, /notePluginEnvFailure\(id, action, r\.env \|\| market\.classifyEnvFailure/, '动作失败应归类记账')
  assert.match(main, /clearPluginEnvFailure\(id\)/, '动作成功应把自己从聚合里摘掉')
  assert.match(main, /notePluginEnvFailure\(target\.key, 'install'/, '一键全部安装的失败项也要记账')
  assert.match(main, /notePluginEnvFailure\(d\.id, 'install'/, '默认代装的失败项也要记账')
  // 命令必须存在；插件操作统一走 profile 写锁（withProfileOp），所以匹配的是包了一层的形态
  assert.match(main, /case 'pluginsRetryEnvFailed': return JSON\.stringify\(await withProfileOp\([^)]*\(\) => retryPluginEnvFailures\(\)\)\)/, '应有重试失败项的命令')
  assert.match(main, /pluginDisplayName\(id\)/, '提示条里的插件名应走统一取名')
})

test('控制台接线：提示条结构、渲染、重试与「知道了」都在壳里', () => {
  const html = read('ui-src/index.html')
  const app = read('ui-src/app.js')
  const css = read('ui-src/console.css')
  assert.match(html, /id="pluginEnvBar"[^>]*role="status"/, '插件页应有环境级故障提示条')
  assert.match(html, /id="pluginEnvTitle"/, '提示条应有标题位')
  assert.match(html, /id="pluginEnvDetail"/, '提示条应有解释位')
  assert.match(html, /id="btnPluginEnvRetry"/, '提示条应有「重试失败的插件」')
  assert.match(html, /id="btnPluginEnvDismiss"/, '提示条应能收起')
  assert.match(app, /function renderPluginEnvIssue\(info, note\)/, '应有提示条渲染器')
  assert.match(app, /renderPluginEnvIssue\(state\.pluginEnvIssue, state\.pluginEnvNote\)/, '状态推送应驱动提示条')
  assert.match(app, /cmd\('pluginsRetryEnvFailed'\)/, '重试按钮应走真实命令')
  assert.match(app, /window\._pluginEnvDismissedAt === issue\.at/, '「知道了」按这条故障记，不吞掉下一次失败')
  assert.match(app, /envNote\.split\('；'\)\[0\]/, '环境提示只占概览行后缀，全文退到 tooltip')
  assert.match(css, /\.plugin-env-bar \{/, '提示条应有样式')
  assert.match(css, /\.plugin-env-bar\.hidden \{ display: none; \}/, '隐藏态必须真的不占位')
  // 构建产物同步：wwwroot 由 ui-src 生成，改完 UI 必须重新 build:assets
  const built = read('wwwroot/app.js')
  assert.match(built, /function renderPluginEnvIssue\(info, note\)/, 'wwwroot 未同步：请执行 npm run build:assets')
  assert.match(read('wwwroot/index.html'), /id="pluginEnvBar"/, 'wwwroot 未同步：请执行 npm run build:assets')
})
