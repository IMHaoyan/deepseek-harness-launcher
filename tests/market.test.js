// tests/market.test.js — npm 分发插件安装器纯函数测试：
//   profile 状态判定（任意包名）+ npm manifest 校验 + 按包名记账的瞬时状态
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const market = require('../market')

const NAME = market.PLUGIN_NAME

function manifestWith(deps, bundles) {
  return {
    name: 'dsh-profile-web',
    dependencies: deps,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...(bundles || [])] } },
  }
}

test('pluginStateOf：dependencies + bundles 都在 → 已安装且启用', () => {
  const s = market.pluginStateOf(manifestWith({ [NAME]: '^1.45.0' }, [NAME]))
  assert.deepEqual(s, { installed: true, version: '^1.45.0', bundle: true })
})

test('pluginStateOf：只在 dependencies、不在 bundles → 不算装好', () => {
  const s = market.pluginStateOf(manifestWith({ [NAME]: '1.45.0' }, []))
  assert.equal(s.installed, true)
  assert.equal(s.bundle, false)
})

test('pluginStateOf：只在 bundles、没有依赖 → 未安装', () => {
  const s = market.pluginStateOf(manifestWith({}, [NAME]))
  assert.equal(s.installed, false)
  assert.equal(s.bundle, true)
})

test('pluginStateOf：空/畸形 manifest 不抛错', () => {
  assert.deepEqual(market.pluginStateOf(undefined), { installed: false, version: '', bundle: false })
  assert.deepEqual(market.pluginStateOf({}), { installed: false, version: '', bundle: false })
  assert.deepEqual(market.pluginStateOf({ dependencies: null, dsh: { profile: { bundles: 'x' } } }), { installed: false, version: '', bundle: false })
})

test('verifyNpmManifestShape：合法 manifest 返回精确版本', () => {
  const r = market.verifyNpmManifestShape({ name: NAME, version: '1.45.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, NAME)
  assert.deepEqual(r, { name: NAME, version: '1.45.0' })
})

test('verifyNpmManifestShape：精确的预发布版本也接受（上游只发预览版的插件要能用）', () => {
  const bundle = { dsh: { bundle: { patch: './cordis.patch.yml' } } }
  // 真实案例：dsh-mcp-lens 在 npm 上只有 0.1.0-rc.9，latest 也指向它
  assert.deepEqual(
    market.verifyNpmManifestShape({ name: NAME, version: '0.1.0-rc.9', ...bundle }, NAME),
    { name: NAME, version: '0.1.0-rc.9' },
  )
  for (const v of ['1.4.5-alpha.1', '2.0.0-beta', '1.0.0-0', '1.0.0+build.5', '1.0.0-rc.1+build.5']) {
    assert.equal(market.verifyNpmManifestShape({ name: NAME, version: v, ...bundle }, NAME).version, v, v + ' 是精确版本，应接受')
  }
})

test('verifyNpmManifestShape：包名不符/非精确版本/无 bundle 声明 → 拒绝', () => {
  const base = { name: NAME, version: '1.45.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  assert.throws(() => market.verifyNpmManifestShape({ ...base, name: 'other-pkg' }, NAME), /包身份/)
  // 范围 / dist-tag / 缺段：装的是哪一版会变得不可预测，一律拒绝
  for (const v of ['^1.45.0', '~1.45.0', '1.45', '1', 'latest', 'next', '1.45.0 - 2.0.0', 'v1.45.0', '1.45.0-']) {
    assert.throws(() => market.verifyNpmManifestShape({ ...base, version: v }, NAME), /精确/, '应拒绝 ' + v)
  }
  assert.throws(() => market.verifyNpmManifestShape({ ...base, dsh: {} }, NAME), /DSH bundle/)
  assert.throws(() => market.verifyNpmManifestShape({ ...base, dsh: { bundle: { patch: '../evil.js' } } }, NAME), /DSH bundle/)
  assert.throws(() => market.verifyNpmManifestShape(null, NAME), /invalid/)
})

test('installed()：HOME 未初始化时不抛错，返回未安装', () => {
  const s = market.installed()
  assert.equal(typeof s, 'object')
  assert.equal(s.installed, false)
})

test('getState()：字段形状稳定（面板依赖这些字段）', () => {
  const s = market.getState()
  for (const k of ['installed', 'version', 'bundle', 'busy', 'error', 'lastChange', 'plugin']) {
    assert.ok(k in s, '缺少字段 ' + k)
  }
  assert.equal(s.plugin, NAME)
})

test('pluginStateOf：能判定任意包名（推荐插件复用同一套 profile 判定）', () => {
  const other = 'dsh-better-sidebar'
  const s = market.pluginStateOf(manifestWith({ [other]: '^0.19.1' }, [other]), other)
  assert.deepEqual(s, { installed: true, version: '^0.19.1', bundle: true })
  assert.equal(market.pluginStateOf(manifestWith({}, []), other).installed, false)
})

test('安装器暴露按包名操作的入口（控制台插件页依赖）', () => {
  for (const fn of ['installByName', 'uninstallByName', 'getState', 'verifyNpmPackage']) {
    assert.equal(typeof market[fn], 'function', '缺少入口 ' + fn)
  }
})

test('installByName：空包名直接拒绝；按包名各自记账', async () => {
  const r = await market.installByName('')
  assert.equal(r.ok, false)
  assert.match(r.error, /不能为空/)
  const other = market.getState('dsh-chat-import')
  assert.equal(other.plugin, 'dsh-chat-import')
  assert.equal(other.installed, false)
  assert.equal(other.busy, '')
})

test('pnpm 视图：默认不关策略，只有被 24h 观察期整体拒绝时才一次性放行重试', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'market.js'), 'utf8')
  assert.match(src, /const RELEASE_AGE_OVERRIDE = '--config\.minimumReleaseAge=0'/, '放行参数应集中声明并说明原因')
  assert.match(src, /withReleaseAgeOverride\(withReleaseAgeOverride\(list\)\)|withReleaseAgeOverride\(list\)/, '放行参数只用在重试路径上')
  assert.match(src, /async function runCliOnce\(args\)/, '必须有一个「不注入放行参数」的基础执行器')
  assert.match(src, /if \(!releaseAgeViolation\(e && e\.output\)\) throw e/, '只有命中 24h 观察期判定才重试，其它错误原样抛出')
  assert.deepEqual(market.withReleaseAgeOverride(['add', 'pkg@1.0.0', '-w']), ['add', '--config.minimumReleaseAge=0', 'pkg@1.0.0', '-w'])
  assert.deepEqual(market.withReleaseAgeOverride(['remove', 'pkg', '-w']), ['remove', '--config.minimumReleaseAge=0', 'pkg', '-w'])
  assert.deepEqual(market.withReleaseAgeOverride(['list']), ['list'])
})

test('releaseAgeViolation：认得 pnpm 的四种稳定标记（含错误码被尾部截断的情形）', () => {
  assert.equal(market.releaseAgeViolation('[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:'), true)
  assert.equal(market.releaseAgeViolation('✗ Lockfile failed supply-chain policy check (275 entries in 3.4s)'), true)
  assert.equal(market.releaseAgeViolation('the lockfile is stale, or that someone committed a lockfile that bypassed the policy locally'), true)
  // pnpm 11.8 的 remove 路径缺观察期处理器时的硬失败（同一棵树 add 会自愈、remove 报这个码）：
  // 它同样属于「被 24h 观察期拒绝」，必须命中重试，否则卸载路径永远拿不到那一次放行
  assert.equal(market.releaseAgeViolation('[ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED] 1 resolution-policy violation was produced but no handleResolutionPolicyViolations callback was wired to react to them.'), true)
  assert.equal(market.releaseAgeViolation('ERR_PNPM_EPERM: operation not permitted'), false)
  assert.equal(market.releaseAgeViolation(''), false)
  assert.equal(market.releaseAgeViolation(undefined), false)
})

test('parseReleaseAgeEntries：抠出被拒条目并按最晚发布时间给自愈时刻', () => {
  const out = [
    '✗ Lockfile failed supply-chain policy check (275 entries in 3.4s)',
    '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 3 lockfile entries failed verification:',
    '  @michengai/dsh-codex-ui@1.1.8 was published at 2026-09-15T09:53:00.584Z, within the minimumReleaseAge cutoff (2026-09-15T03:21:47.012Z)',
    '  dsh-chat-import@0.17.0 was published at 2026-09-15T15:39:20.245Z, within the minimumReleaseAge cutoff (2026-09-15T03:21:47.012Z)',
    '  dsh-chat-import@0.17.0 was published at 2026-09-15T15:39:20.245Z, within the minimumReleaseAge cutoff (2026-09-15T03:21:47.012Z)',
    'The lockfile contains entries that the active policies reject.',
  ].join('\n')
  const entries = market.parseReleaseAgeEntries(out)
  assert.deepEqual(entries.map((e) => e.name), ['@michengai/dsh-codex-ui@1.1.8', 'dsh-chat-import@0.17.0'], '重复行只记一次')
  assert.equal(entries[0].publishedAt, '2026-09-15T09:53:00.584Z')
  // 全部条目满 24h 后自动放行：取最晚的发布时间 + 24h（本地时间由界面展示）
  assert.equal(market.releaseAgeRecoversAt(entries), '2026-09-16T15:39:20.245Z')
  assert.deepEqual(market.parseReleaseAgeEntries('nothing here'), [])
  assert.equal(market.releaseAgeRecoversAt([]), '')
})

test('classifyEnvFailure：与「装哪个插件」无关的失败各归一类，未知原因不硬套', () => {
  const age = market.classifyEnvFailure('[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n'
    + '  dshmarket@1.47.0 was published at 2026-09-15T04:59:30.465Z, within the minimumReleaseAge cutoff (2026-09-15T03:00:00.000Z)')
  assert.equal(age.kind, 'release-age')
  assert.equal(age.recoverable, true)
  assert.equal(age.entries.length, 1)
  assert.equal(age.recoversAt, '2026-09-16T04:59:30.465Z')
  assert.match(age.reason, /不足 24 小时/)
  assert.match(market.classifyEnvFailure('ERR_PNPM_EPERM: [importPackage ~\\.dsh\\profiles\\web\\node_modules] EPERM: operation not permitted, rename').kind, /^locked$/)
  assert.equal(market.classifyEnvFailure('无法从 npm 官方源验证包（HTTP 429）').kind, 'rate-limit')
  assert.equal(market.classifyEnvFailure('ERR_PNPM_NO_MATCHING_VERSION: No matching version found for dsh-chat-import@0.11.3 while fetching it from http://mirror/').kind, 'registry-missing')
  assert.equal(market.classifyEnvFailure('pnpm 未就绪：Corepack 未对齐。请先在运行环境页安装/修复 pnpm。').kind, 'env')
  assert.equal(market.classifyEnvFailure('pnpm 未就绪：x').recoverable, false, '环境没修好之前「重试」不是真实可用的动作')
  assert.equal(market.classifyEnvFailure('安装后 profile 未正确记录该插件').kind, '')
})

test('runCli：默认跑一次；命中判定才放行重试一次；其它错误不重试（注入桩执行真实流程）', async () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'market.js'), 'utf8').replace(/\r\n?/gu, '\n')
  const start = src.indexOf('async function runCli(args) {')
  const end = src.indexOf('\n}\n', src.indexOf('async function runCli(args) {')) + 3
  assert.ok(start > 0 && end > start, '找不到 runCli')
  const fnSrc = src.slice(start, end)

  const mk = (behaviour) => {
    const calls = []
    const ctx = {
      log: () => {},
      withReleaseAgeOverride: market.withReleaseAgeOverride,
      releaseAgeViolation: market.releaseAgeViolation,
      parseReleaseAgeEntries: market.parseReleaseAgeEntries,
      runCliOnce: async (args) => {
        calls.push(args.slice())
        const r = behaviour(args, calls.length)
        if (r instanceof Error) throw r
        return r
      },
    }
    const names = Object.keys(ctx)
    const run = new Function(...names, fnSrc + '\nreturn runCli')(...names.map((k) => ctx[k]))
    return { run, calls }
  }
  const violation = () => {
    const e = new Error('dsh plugin 退出码 1：…bypassed the policy locally')
    e.output = '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n'
      + '  dshmarket@1.47.0 was published at 2026-09-15T04:59:30.465Z, within the minimumReleaseAge cutoff (2026-09-15T03:00:00.000Z)'
    return e
  }

  // 1) 干净 lockfile：一次成功，且**不带**放行参数（pnpm 自己会写 exclude，lockfile 保持合规）
  const ok = mk(() => ({ code: 0, output: 'Done' }))
  const r1 = await ok.run(['add', 'pkg@1.0.0', '-w'])
  assert.equal(r1.code, 0)
  assert.deepEqual(ok.calls, [['add', 'pkg@1.0.0', '-w']], '默认路径不得注入放行参数')

  // 2) 被 24h 观察期整体拒绝：第二次带放行参数重试，并回传被拒条目
  const retried = mk((args, n) => (n === 1 ? violation() : { code: 0, output: 'Done' }))
  const r2 = await retried.run(['add', 'pkg@1.0.0', '-w'])
  assert.deepEqual(retried.calls, [['add', 'pkg@1.0.0', '-w'], ['add', '--config.minimumReleaseAge=0', 'pkg@1.0.0', '-w']])
  assert.equal(r2.releaseAge.retried, true)
  assert.equal(r2.releaseAge.entries.length, 1)

  // 3) 其它错误（占用/网络）：不重试，原样抛出
  const other = mk(() => { const e = new Error('ERR_PNPM_EPERM: operation not permitted'); e.output = 'ERR_PNPM_EPERM: operation not permitted'; return e })
  await assert.rejects(() => other.run(['add', 'pkg@1.0.0', '-w']), /EPERM/)
  assert.equal(other.calls.length, 1, '非 24h 观察期的失败不得重试')

  // 4) 重试也失败：错误里说明「已经放行过一次」，并保留完整输出供上层分类
  const both = mk(() => violation())
  await assert.rejects(() => both.run(['add', 'pkg@1.0.0', '-w']), (e) => {
    assert.match(e.message, /已用一次性放行重试过一次/)
    assert.match(e.output, /MINIMUM_RELEASE_AGE_VIOLATION/)
    return true
  })
  assert.equal(both.calls.length, 2)
})