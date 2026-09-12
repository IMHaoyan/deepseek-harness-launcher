// tests/dsh-update-outcome.test.js — 更新收尾判定（node --test）
//
// 背景（回归用例）：收尾结论此前只看 startOk，而 decideRollback 检出的"版本不符"只写日志、照样弹
// "已更新"；managed / npx 两个分支更是在校验块之前就 return，装不上、起不来、版本没换都报成功。
// 这里钉住"什么才算更新成功"以及相应的用户可见措辞。
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const dshUpdater = require('../dsh-update')

function outcome(patch) {
  return dshUpdater.decideUpdateOutcome(Object.assign({
    startOk: true,
    runningVersion: '0.1.9',
    latest: '0.1.9',
    from: '0.1.8',
    nonUpgrade: false,
    hasToken: true,
  }, patch))
}

test('服务起来了且版本对上 → 成功', () => {
  const r = outcome({})
  assert.equal(r.ok, true)
  assert.equal(r.message, '已更新到 v0.1.9')
})

test('服务没起来 → 判失败，并给出可执行指引', () => {
  const r = outcome({ startOk: false })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'start-failed')
  assert.match(r.message, /服务未能启动/)
  assert.match(r.message, /DSHL 控制台/)
})

test('startOk 缺失/非布尔真值一律按失败处理（不把"忘了传"当成功）', () => {
  for (const startOk of [undefined, null, 0, 'true']) {
    assert.equal(outcome({ startOk }).ok, false, `startOk=${JSON.stringify(startOk)} 应判失败`)
  }
})

test('核心回归：实际运行的版本与目标不符 → 判失败，而不是弹"已更新"', () => {
  // 典型来源：npx 预热"成功"但版本其实没换过来；或装到了另一个 prefix 而探测命中的是旧安装
  const r = outcome({ runningVersion: '0.1.8' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'version-mismatch')
  assert.match(r.message, /0\.1\.9/)
  assert.match(r.message, /0\.1\.8/)
})

test('探测不到版本（空）时不得据此报失败', () => {
  assert.equal(outcome({ runningVersion: '' }).ok, true)
  assert.equal(outcome({ runningVersion: '' }).message, '已更新到 v0.1.9')
})

test('没有目标版本时不判版本不符（无从比较）', () => {
  assert.equal(outcome({ latest: '', runningVersion: '0.1.8' }).ok, true)
})

test('非升级（用户显式切渠道）：成功与失败措辞都用"已切换到"，成功时保留原版本', () => {
  const ok = outcome({ nonUpgrade: true, latest: '0.1.9-alpha.5', from: '0.1.9', runningVersion: '0.1.9-alpha.5' })
  assert.equal(ok.ok, true)
  assert.equal(ok.message, '已切换到 v0.1.9-alpha.5（原 v0.1.9）')
  const bad = outcome({ nonUpgrade: true, startOk: false, latest: '0.1.9-alpha.5' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /^已切换到 v0\.1\.9-alpha\.5/)
})

test('非升级也必须版本对上才算成功（切到 alpha 却没换过去 = 失败）', () => {
  const r = outcome({ nonUpgrade: true, latest: '0.1.9-alpha.5', from: '0.1.9', runningVersion: '0.1.9' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'version-mismatch')
})

test('拿不到本轮页面凭据（接管的外部实例）→ 成功通知附上"重新打开"的指引', () => {
  const r = outcome({ hasToken: false })
  assert.equal(r.ok, true)
  assert.match(r.message, /页面访问凭据已变化/)
  assert.match(r.message, /重新打开/)
})

test('凭据正常或未注入 → 不加多余提示', () => {
  assert.equal(outcome({ hasToken: true }).message, '已更新到 v0.1.9')
  assert.equal(outcome({ hasToken: undefined }).message, '已更新到 v0.1.9')
})

test('失败措辞里不掺入凭据提示（那是成功路径的事）', () => {
  const r = outcome({ startOk: false, hasToken: false })
  assert.equal(/凭据/.test(r.message), false)
})
