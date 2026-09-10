// tests/dsh-update-target.test.js — 更新目标准入判定（node --test）
//
// 背景（回归用例）：面板上那个「重试」按钮走的是 updateNow，而 updateNow 允许从 status='error' 进入、
// 并直接使用"上一次成功检查"缓存的 state.latest 且不重新校验。缓存一旦与实际安装版本脱节，点「重试」
// 就会照着缓存装 —— 把用户从更高版本"更新"回更低版本，而更新后校验（decideRollback 只比
// "跑起来的 == 目标"）拦不住。这里钉住准入判定的语义。
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const dshUpdater = require('../dsh-update')

// 同渠道的常规调用（覆盖最常用路径）
function same(target, installed, userChoseChannel = false) {
  return dshUpdater.decideUpdateTarget({
    target,
    installed,
    targetChannel: 'latest',
    currentChannel: 'latest',
    userChoseChannel,
  })
}

test('常规升级：目标高于当前 → 放行，且不算非升级', () => {
  assert.deepEqual(same('0.1.9', '0.1.8'), { action: 'install', nonUpgrade: false })
  assert.deepEqual(same('0.2.0', '0.1.9'), { action: 'install', nonUpgrade: false })
})

test('预发布版只要版本号更高就算升级（主版本号领先）', () => {
  assert.deepEqual(same('0.2.0-alpha.5', '0.1.9'), { action: 'install', nonUpgrade: false })
})

test('rc/alpha 编号按数值比较，不是字典序', () => {
  assert.deepEqual(same('0.1.5-rc.11', '0.1.5-rc.2'), { action: 'install', nonUpgrade: false })
  assert.equal(same('0.1.5-rc.2', '0.1.5-rc.11').code, 'downgrade')
})

test('目标等于当前 → 拒绝（不白装一遍）', () => {
  const r = same('0.1.8', '0.1.8')
  assert.equal(r.action, 'block')
  assert.equal(r.code, 'same-version')
})

test('核心回归：缓存比实际安装旧、且本次会话没切过渠道 → 拒绝静默降级', () => {
  // 场景：缓存在先前某次检查里存了 0.1.8，用户随后在终端里把 dsh 升到 0.1.9-alpha.2，
  // 之后一次强制检查失败让面板落到「重试」。此时点重试绝不能装 0.1.8。
  const r = same('0.1.8', '0.1.9-alpha.2')
  assert.equal(r.action, 'block')
  assert.equal(r.code, 'downgrade')
  assert.match(r.reason, /0\.1\.8/)
  assert.match(r.reason, /0\.1\.9-alpha\.2/)
})

test('同版本正式版与预发布版之间：正式版更高（semver 优先级）', () => {
  assert.deepEqual(same('0.1.9', '0.1.9-alpha.5'), { action: 'install', nonUpgrade: false })
  assert.equal(same('0.1.9-alpha.5', '0.1.9').code, 'downgrade')
})

test('用户显式切过渠道时的版本号下降 → 放行，但标记为非升级（通知要写明）', () => {
  // 场景：latest=0.1.9，切到 alpha 而 alpha 仍指向 0.1.9-alpha.5（刚发完正式版的窗口期），
  // 按 semver 这是下降，但那是用户的明确意图。
  const r = same('0.1.9-alpha.5', '0.1.9', true)
  assert.deepEqual(r, { action: 'install', nonUpgrade: true })
})

test('未切渠道时，同一对版本仍然被拦（显式选择才是放行的唯一依据）', () => {
  assert.equal(same('0.1.9-alpha.5', '0.1.9', false).code, 'downgrade')
})

test('缓存来源渠道与当前渠道不一致 → 拒绝（即使目标版本更高）', () => {
  const r = dshUpdater.decideUpdateTarget({
    target: '0.2.0-alpha.5',
    installed: '0.1.9',
    targetChannel: 'alpha',
    currentChannel: 'latest',
    userChoseChannel: false,
  })
  assert.equal(r.action, 'block')
  assert.equal(r.code, 'channel-mismatch')
})

test('渠道不一致优先于降级判定（判定顺序固定）', () => {
  const r = dshUpdater.decideUpdateTarget({
    target: '0.1.8',
    installed: '0.1.9-alpha.2',
    targetChannel: 'latest',
    currentChannel: 'alpha',
    userChoseChannel: false,
  })
  assert.equal(r.code, 'channel-mismatch')
})

test('没有缓存版本号（切渠道已作废 / 从未成功检查过）→ 拒绝并要求先检查', () => {
  for (const target of ['', null, undefined, 'latest', '0.1']) {
    const r = same(target, '0.1.8')
    assert.equal(r.action, 'block', `target=${JSON.stringify(target)} 应被拒绝`)
    assert.equal(r.code, 'no-target')
  }
})

test('v 前缀的版本号照常比较（semver 允许并归一化；plan.dshVersion 可能带前缀）', () => {
  assert.deepEqual(same('v0.1.9', 'v0.1.8'), { action: 'install', nonUpgrade: false })
  assert.deepEqual(same('0.1.9', 'v0.1.8'), { action: 'install', nonUpgrade: false })
  assert.equal(same('v0.1.8', 'v0.1.9').code, 'downgrade')
  assert.equal(same('v0.1.8', '0.1.8').code, 'same-version')
})

test('当前版本取不到（源码形态 / 探测失败）→ 不拦，保持历史行为', () => {
  for (const installed of ['', null, undefined, 'unknown']) {
    assert.deepEqual(same('0.1.8', installed), { action: 'install', nonUpgrade: false })
  }
})

test('切渠道会作废缓存里的版本号（否则「重试」会照旧渠道的缓存装）', () => {
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'alpha' } })
  dshUpdater.noteChannelChange()
  const s = dshUpdater.getState()
  assert.equal(s.latest, '')
  assert.equal(s.latestChannel, '')
  assert.equal(s.status, 'idle')
  assert.equal(s.prewarmed, false)
  // 作废之后即使硬点更新，也会被 no-target 拦下，而不是装旧渠道的缓存
  assert.equal(
    dshUpdater.decideUpdateTarget({
      target: s.latest,
      installed: '0.1.8',
      targetChannel: s.latestChannel,
      currentChannel: s.channel,
      userChoseChannel: true,
    }).code,
    'no-target',
  )
})
