// tests/node-reuse.test.js — 复用用户级 Node 前的版本判定（Node 18 用户不再卡在"重试无效"）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const envInstall = require('../env-install')
const envDetect = require('../env-detect')

test('目录里没有 node → 不复用（走正常安装）', () => {
  assert.deepEqual(envInstall.decideUserNodeReuse({ exists: false, version: '' }), { reuse: false, reason: 'no-existing' })
})

test('版本达标才复用（^22.19.0 || >=24.0.0）', () => {
  for (const v of ['v22.19.0', '22.19.0', 'v22.23.2', 'v24.0.0', 'v24.16.0', 'v26.1.0']) {
    assert.equal(envInstall.decideUserNodeReuse({ exists: true, version: v }).reuse, true, v + ' 应复用')
  }
})

test('版本过低一律不复用（这就是 Node 18 卡死的修法）', () => {
  for (const v of ['v18.20.4', 'v20.11.0', 'v21.7.3', 'v22.18.0', 'v23.5.0']) {
    const r = envInstall.decideUserNodeReuse({ exists: true, version: v })
    assert.equal(r.reuse, false, v + ' 不应复用')
    assert.equal(r.reason, 'too-old', v)
  }
})

test('拿不到版本 / 解析失败 → 不复用（重装一次好过卡死）', () => {
  for (const v of ['', '   ', 'not-a-version', 'v']) {
    const r = envInstall.decideUserNodeReuse({ exists: true, version: v })
    assert.equal(r.reuse, false, JSON.stringify(v))
    assert.ok(r.reason === 'unknown' || r.reason === 'too-old')
  }
})

test('判据与 env-detect 的 engines 范围同源', () => {
  assert.equal(envDetect.DEFAULT_ENGINE_RANGE, '^22.19.0 || >=24.0.0')
  // 自定义范围也应生效（将来 DSH 提高要求时只需改一处）
  assert.equal(envInstall.decideUserNodeReuse({ exists: true, version: 'v20.0.0', range: '>=20' }).reuse, true)
  assert.equal(envInstall.decideUserNodeReuse({ exists: true, version: 'v22.19.0', range: '>=24' }).reuse, false)
})
test('探针拿到非字符串（例如误传 {stdout}）→ 判为拿不到版本，绝不复用', () => {
  for (const v of [undefined, null, 22, { stdout: 'v22.19.0' }, ['v24.0.0']]) {
    const r = envInstall.decideUserNodeReuse({ exists: true, version: v })
    assert.equal(r.reuse, false, JSON.stringify(v))
    assert.equal(r.reason, 'unknown', JSON.stringify(v))
  }
})