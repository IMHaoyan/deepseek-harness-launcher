// tests/release-age.test.js — pnpm 11「24h 新版本观察期」判定的护栏（node --test）
//
// 这组测试对应一次真实的用户可见故障（2026-10-12）：两个插件更新直接失败，
// 界面上只剩一行被切掉开头的 pnpm 报错。根因是标记表漏了 pnpm 11.8 的第三种表现，
// 于是**自动放行兜底从未触发** —— 而这套兜底本来就是为了让这种失败不成为死路。
//
// 四条不变量：
//   ① 三种表现（整份 lockfile 被拒 / remove 硬失败 / 精确版本无匹配）都要认出来；
//   ② 抠条目不能要求条目在行首 —— 精确版本形态里它在行中（这次就是栽在这）；
//   ③ 恢复时刻算得出来，界面才能说"等到什么时候"而不是"稍后再试"；
//   ④ 错误文案不能把错误码切掉（那是用户唯一能拿去搜的 token）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const ra = require('../release-age')

// 真机上抄下来的原串（~/.dsh/dshl-logs/dshl.log，2026-10-12 14:26:54）
const REAL_PRECISE = '[ERR_PNPM_NO_MATCHING_VERSION] 1 version does not meet the minimumReleaseAge constraint: '
  + '@michengai/dsh-skills-manager@1.1.16 was published at 2026-10-12T05:30:14.858Z, '
  + 'within the minimumReleaseAge cutoff (2026-10-11T06:26:52.060Z)'

test('① 三种表现都认：整份 lockfile 被拒 / remove 硬失败 / 精确版本无匹配', () => {
  assert.equal(ra.isViolation('[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:'), true)
  assert.equal(ra.isViolation('✗ Lockfile failed supply-chain policy check (275 entries in 3.4s)'), true)
  assert.equal(ra.isViolation('the lockfile is stale, or that someone committed a lockfile that bypassed the policy locally'), true)
  assert.equal(ra.isViolation('[ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED] 1 resolution-policy violation was produced'), true)
  // ★ 这一条就是本次故障：不加它，兜底永远不会触发
  assert.equal(ra.isViolation(REAL_PRECISE), true, '真机原串必须认出来（兜底全靠这个判定）')
  // 反例：别的错误不许误判 —— 误判会让不该放行的操作被放行
  assert.equal(ra.isViolation('ERR_PNPM_EPERM: operation not permitted'), false)
  assert.equal(ra.isViolation('ERR_PNPM_NO_MATCHING_VERSION: No matching version found for foo@^9'), false,
    '「版本压根不存在」不是观察期问题，不许放行重试')
  assert.equal(ra.isViolation(''), false)
  assert.equal(ra.isViolation(undefined), false)
})

test('② 抠条目不要求行首：精确版本形态里名字在行中', () => {
  const precise = ra.parseEntries(REAL_PRECISE)
  assert.equal(precise.length, 1, '行中形态也要抠得到（旧正则锚了 ^，这里会抠成空数组）')
  assert.equal(precise[0].name, '@michengai/dsh-skills-manager@1.1.16')
  assert.equal(precise[0].publishedAt, '2026-10-12T05:30:14.858Z')
  // 整份 lockfile 形态（一条一行）不能被改坏
  const lockfile = '[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 2 lockfile entries failed verification:\n'
    + '  @scope/a@1.0.0 was published at 2026-09-15T04:59:30.465Z, within the minimumReleaseAge cutoff (x)\n'
    + '  @scope/b@2.0.0 was published at 2026-09-16T15:39:20.245Z, within the minimumReleaseAge cutoff (y)'
  const many = ra.parseEntries(lockfile)
  assert.deepEqual(many.map((e) => e.name), ['@scope/a@1.0.0', '@scope/b@2.0.0'])
  // 同一条重复出现只留一次
  assert.equal(ra.parseEntries(REAL_PRECISE + '\n' + REAL_PRECISE).length, 1)
  assert.deepEqual(ra.parseEntries(''), [])
})

test('③ 恢复时刻 = 最晚发布时刻 + 24h（界面据此说"等到什么时候"）', () => {
  // 真机两次失败的发布时间：取最晚的那个 + 24h
  const two = [
    { name: 'a', publishedAt: '2026-10-12T05:30:14.858Z' },
    { name: 'b', publishedAt: '2026-10-12T00:38:34.434Z' },
  ]
  assert.equal(ra.recoversAt(two), '2026-10-13T05:30:14.858Z')
  assert.equal(ra.recoversAt(ra.parseEntries(REAL_PRECISE)), '2026-10-13T05:30:14.858Z')
  assert.equal(ra.recoversAt([]), '', '算不出来就给空串，界面不许编一个时间')
  assert.equal(ra.recoversAt([{ name: 'a', publishedAt: 'not-a-date' }]), '')
  assert.equal(ra.recoversAt(undefined), '')
})

test('④ 错误文案保留头部：错误码是最有辨识度的 token，不能被切掉', () => {
  const q = ra.quoteForError(REAL_PRECISE)
  assert.ok(q.includes('ERR_PNPM_NO_MATCHING_VERSION'), '错误码必须在：' + q.slice(0, 80))
  assert.ok(q.includes('minimumReleaseAge constraint'), '关键解释也要在')
  // 旧实现是 slice(-400)，真机上切出了 `TCHING_VERSION]` 这种残骸
  assert.ok(!/^TCHING_VERSION/u.test(q), '不许再出现被切掉开头的错误码')
  // 短输出原样返回，不长出无意义的省略号
  assert.equal(ra.quoteForError('boom'), 'boom')
  assert.equal(ra.quoteForError(''), '')
  assert.equal(ra.quoteForError(undefined), '')
  // 长输出：头 + 尾，且长度有界
  const long = 'HEAD'.repeat(200) + 'TAIL'.repeat(200)
  const cut = ra.quoteForError(long)
  assert.ok(cut.length < long.length && cut.includes('中略'), '长输出要省略且长度有界')
  assert.ok(cut.startsWith('HEAD'), '头部要留着')
  assert.ok(cut.endsWith('TAIL'), '尾部要留着')
})

test('一次性放行参数只注入 add / remove，且不重复注入', () => {
  assert.deepEqual(ra.withOverride(['add', 'x@1.0.0']), ['add', ra.RELEASE_AGE_OVERRIDE, 'x@1.0.0'])
  assert.deepEqual(ra.withOverride(['remove', 'x']), ['remove', ra.RELEASE_AGE_OVERRIDE, 'x'])
  assert.deepEqual(ra.withOverride(['list']), ['list'], '其它子命令原样透传')
  assert.deepEqual(ra.withOverride(['add', ra.RELEASE_AGE_OVERRIDE, 'x']), ['add', ra.RELEASE_AGE_OVERRIDE, 'x'],
    '已经带过就不再叠一个')
  assert.deepEqual(ra.withOverride(undefined), [])
})

test('market.js 与 bridge.js 共用这一份判定，不许再有第二份副本', () => {
  // 这次故障的**结构性**成因：两个模块各有一份复制粘贴的标记表，注释还写着"口径一致"，
  // 实际是两份各自会漂移的常量 —— 2026-10-12 两份同时漏掉了第三种表现。
  for (const rel of ['market.js', 'bridge.js']) {
    const src = read(rel)
    assert.match(src, /require\('\.\/release-age'\)/, rel + ' 要从 release-age.js 取判定')
    assert.ok(!/const RELEASE_AGE_MARKERS = \[/.test(src), rel + ' 不许再定义自己的标记表')
    assert.ok(!/was published at \(\[,\\s\]\+\)/u.test(src), rel + ' 不许再定义自己的抠条目正则')
  }
  // 两个模块导出的行为必须一致（同一个函数，不是"看起来一样"）
  const market = require('../market')
  const bridge = require('../bridge')
  for (const probe of [REAL_PRECISE, 'ERR_PNPM_EPERM: nope', '']) {
    assert.equal(market.releaseAgeViolation(probe), bridge.releaseAgeViolation(probe), '两侧判定必须同一口径')
    assert.equal(market.releaseAgeViolation(probe), ra.isViolation(probe))
  }
  assert.equal(market.releaseAgeRecoversAt(ra.parseEntries(REAL_PRECISE)), '2026-10-13T05:30:14.858Z')
})

test('release-age.js 进了打包清单（否则装机版 require 失败，只有装完才会暴露）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(pkg.build.files.includes('release-age.js'), 'build.files 缺 release-age.js')
})
