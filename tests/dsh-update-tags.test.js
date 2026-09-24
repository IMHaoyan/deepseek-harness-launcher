// tests/dsh-update-tags.test.js — alpha 渠道的 npm tag 合成，以及界面 (next) 标记的来源（node --test）
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const dshUpdater = require('../dsh-update')

const root = join(__dirname, '..')
const dshUpdateSrc = readFileSync(join(root, 'dsh-update.js'), 'utf8')
const appSrc = readFileSync(join(root, 'ui-src', 'app.js'), 'utf8')
const indexHtml = readFileSync(join(root, 'ui-src', 'index.html'), 'utf8')

test('alpha 渠道除 alpha 外还要读 next —— rc 只推 next 时预览线才看得到', () => {
  assert.deepEqual(dshUpdater.channelTags('alpha'), ['alpha', 'next'])
  assert.deepEqual(dshUpdater.channelTags('latest'), ['latest'])
  assert.deepEqual(dshUpdater.channelTags('beta'), ['latest'], '未知渠道回落 latest，不把用户带进未知 tag')
})

test('两个 tag 取版本号更高者：rc 高于同版本 alpha', () => {
  assert.deepEqual(
    dshUpdater.pickHighestTagged(
      [{ version: '0.1.7-alpha.2', tag: 'alpha' }, { version: '0.1.7-rc.1', tag: 'next' }], 'alpha'),
    { version: '0.1.7-rc.1', tag: 'next' })
})

test('回迁热修不把预览线拉低：老分支 rc 低于主线 alpha 时仍取 alpha', () => {
  assert.deepEqual(
    dshUpdater.pickHighestTagged(
      [{ version: '0.1.6-alpha.2', tag: 'alpha' }, { version: '0.1.5-rc.3', tag: 'next' }], 'alpha'),
    { version: '0.1.6-alpha.2', tag: 'alpha' })
})

test('同版本挂在两个 tag 时取本渠道主 tag —— 上游一推到 alpha，(next) 标记即失效', () => {
  for (const entries of [
    [{ version: '0.1.7-rc.1', tag: 'next' }, { version: '0.1.7-rc.1', tag: 'alpha' }],
    [{ version: '0.1.7-rc.1', tag: 'alpha' }, { version: '0.1.7-rc.1', tag: 'next' }],
  ]) {
    assert.deepEqual(dshUpdater.pickHighestTagged(entries, 'alpha'), { version: '0.1.7-rc.1', tag: 'alpha' })
  }
})

test('next 缺失或输出异常时不误判：只有一个候选就用它，全空返回 null', () => {
  assert.deepEqual(dshUpdater.pickHighestTagged([{ version: '0.1.7-alpha.2', tag: 'alpha' }], 'alpha'),
    { version: '0.1.7-alpha.2', tag: 'alpha' })
  assert.equal(dshUpdater.pickHighestTagged([], 'alpha'), null)
  assert.equal(dshUpdater.pickHighestTagged([{ version: '不是版本号', tag: 'next' }], 'alpha'), null)
  assert.equal(dshUpdater.pickHighestTagged(null, 'alpha'), null)
})

test('来源标记每次检查重算，且不参与安装判定（渠道记账不被 tag 合成带偏）', () => {
  assert.ok(dshUpdateSrc.includes("latestTag: latest.tag || ''"), '每次检查都要重写 latestTag，标记才会在下次检查消失')
  assert.ok(dshUpdateSrc.includes('latestChannel: latest.channel || channelOf()'), 'channel-mismatch 仍按配置渠道记账')
  assert.ok(dshUpdateSrc.includes('tagForDisplay(best, distTags.latest'), 'latest 取自同一份 dist-tags 响应')
  assert.ok(!dshUpdateSrc.includes('latestTagVersion'), '不再为标记单独发一次 npm view（那是检查慢到 5 秒的主因）')
})

test('检查只发一次 npm view：dist-tags 一次拿全 alpha/next/latest', () => {
  assert.ok(dshUpdateSrc.includes("const args = ['view', '@deepseek-ai/dsh', 'dist-tags', '--json']"), '一次调用拿全部 tag')
  assert.ok(!/view', `@deepseek-ai\/dsh@\$\{tag\}`/.test(dshUpdateSrc), '不许退回"每个 tag 各查一次"（3 次串行约 4.5 秒，实测）')
})

test('parseDistTags：容忍提示行、丢掉非法版本、非 JSON 返回 null', () => {
  assert.deepEqual(
    dshUpdater.parseDistTags('npm warn foo\n{\n  "latest": "0.1.5-rc.3",\n  "next": "0.1.7-rc.1",\n  "alpha": "0.1.7-alpha.2"\n}\n'),
    { latest: '0.1.5-rc.3', next: '0.1.7-rc.1', alpha: '0.1.7-alpha.2' })
  assert.deepEqual(dshUpdater.parseDistTags('{"alpha":"0.1.7-alpha.2","bogus":"not-a-version"}'), { alpha: '0.1.7-alpha.2' })
  assert.deepEqual(dshUpdater.parseDistTags('{}'), {})
  assert.equal(dshUpdater.parseDistTags('not json'), null)
  assert.equal(dshUpdater.parseDistTags(''), null)
  assert.equal(dshUpdater.parseDistTags(null), null)
  assert.equal(dshUpdater.parseDistTags('[1,2,3]'), null, '数组不是 dist-tags')
})

test('上游把该版本推到 latest 后不再算 next —— 标记随下一次检查消失', () => {
  const next = { version: '0.1.7-rc.1', tag: 'next' }
  assert.equal(dshUpdater.tagForDisplay(next, '0.1.7-rc.1'), 'latest', 'latest 已指向同一版本 → 不再标 next')
  assert.equal(dshUpdater.tagForDisplay(next, '0.1.5-rc.3'), 'next', 'latest 还指着别的版本 → 仍标 next')
  assert.equal(dshUpdater.tagForDisplay(next, ''), 'next', 'latest 读不到时保守地仍标 next，不谎报转正')
  assert.equal(dshUpdater.tagForDisplay({ version: '0.1.7-rc.1', tag: 'alpha' }, '0.1.5-rc.3'), 'alpha', '本渠道 tag 命中就不是 next')
  assert.equal(dshUpdater.tagForDisplay({ version: '0.1.7-alpha.2', tag: 'latest' }, ''), 'latest')
  assert.equal(dshUpdater.tagForDisplay(null, '0.1.7-rc.1'), '', '没有候选就没有标记')
})

test('界面：目标版本常驻显示 (next)，本次检查不再来源 next 时立即清空', () => {
  assert.ok(indexHtml.includes('id="dshUpdTarget"'), '版本行要有承载目标版本的常驻元素')
  assert.ok(appSrc.includes("const nextMark = u && u.latestTag === 'next' ? ' (next)' : ''"), '(next) 只由本次检查的 latestTag 决定')
  assert.ok(appSrc.includes("targetEl.textContent = showTarget ? `→ v${latest}${nextMark}` : ''"), '非可用/更新中状态必须清空标记')
  assert.ok(appSrc.includes("targetEl.classList.toggle('hidden', !showTarget)"), '清空时要隐藏，避免留一个空占位')
})

test('界面：已安装的这一版本身就来自 next 时，版本号后也要标注 (next)（升完级标记不消失）', () => {
  assert.ok(appSrc.includes("dshUpd.latestTag === 'next' && dshV && dshUpd.latest === dshV"), '只在「当前版本 == 渠道最新版，且该版本只挂 next」时标注')
  assert.ok(appSrc.includes('`v${dshV}${dshNextMark}`'), '标记要拼在已安装版本号后面')
  assert.ok(appSrc.includes('目前只发布在 npm next'), 'tooltip 要说明标记的含义与消失条件')
})
