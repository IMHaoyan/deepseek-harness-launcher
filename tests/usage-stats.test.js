// tests/usage-stats.test.js — 使用量统计的字段收敛、匿名边界与发送失败收敛
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const stats = require('../usage-stats')

test('上报体字段固定为 5 个，且没有安装 ID / 主机名 / 路径', () => {
  const payload = stats.buildPayload({
    launcherVersion: '1.4.15',
    launcherChannel: 'latest',
    dshVersion: '0.2.2-rc.2',
    dshChannel: 'alpha',
    platform: 'win32',
    release: '10.0.22631',
  })
  assert.deepEqual(Object.keys(payload).sort(), [
    'dshChannel', 'dshVersion', 'dshlChannel', 'dshlVersion', 'windowsVersion',
  ])
  assert.equal(payload.windowsVersion, 'Windows 11 23H2')
  assert.doesNotMatch(JSON.stringify(payload), /id|host|path|user|token/i)
})

test('未知渠道收敛为 unknown，不把脏值当渠道上报', () => {
  const payload = stats.buildPayload({
    launcherVersion: '1.4.15', launcherChannel: 'weird', dshVersion: '0.2.2-rc.2', dshChannel: undefined,
    platform: 'win32', release: '10.0.19045',
  })
  assert.equal(payload.dshlChannel, 'unknown')
  assert.equal(payload.dshChannel, 'unknown')
})

test('版本缺失或含不可打印字符 → 不组包（宁可不报，也不报假数据）', () => {
  assert.equal(stats.buildPayload({ launcherVersion: '', dshVersion: '0.2.2', platform: 'win32', release: '10.0.22631' }), null)
  assert.equal(stats.buildPayload({ launcherVersion: '1.4.15', dshVersion: 'C:\\secret', platform: 'win32', release: '10.0.22631' }), null)
  assert.equal(stats.buildPayload({ launcherVersion: '1.4.15', dshVersion: '0.2.2', platform: 'win32', release: '乱码' }), null)
})

test('Windows 版本按 build 事实表展示；未知 build 保留号，不臆测', () => {
  assert.equal(stats.describeWindows('10.0.22621'), 'Windows 11 22H2')
  assert.equal(stats.describeWindows('10.0.22635'), 'Windows 11 (build 22635)')
  assert.equal(stats.describeWindows('10.0.19045'), 'Windows 10 22H2')
  assert.equal(stats.describeWindows('6.3.9600'), 'Windows 6')
  assert.equal(stats.describeWindows('not-a-version'), 'unknown')
})

test('一天最多一次：未到周期不发；从未上报过则立即可以发', () => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.UTC(2026, 10, 13, 8, 0, 0)
  assert.equal(stats.shouldReport({ enabled: true, now, lastAt: 0 }), true)
  assert.equal(stats.shouldReport({ enabled: true, now, lastAt: now - day + 1 }), false)
  assert.equal(stats.shouldReport({ enabled: true, now, lastAt: now - day }), true)
  assert.equal(stats.shouldReport({ enabled: false, now, lastAt: 0 }), false)
})

test('端点只接受 https；明文 http 仅回环地址', () => {
  assert.equal(stats.normalizeEndpoint('https://stats.example.com/v1/report'), 'https://stats.example.com/v1/report')
  assert.equal(stats.normalizeEndpoint('http://127.0.0.1:8787/v1/report'), 'http://127.0.0.1:8787/v1/report')
  assert.equal(stats.normalizeEndpoint('http://stats.example.com/v1/report'), '')
  assert.equal(stats.normalizeEndpoint('file:///etc/passwd'), '')
  assert.equal(stats.normalizeEndpoint(''), '')
})

test('发送成功返回 ok；HTTP 失败与超时都收敛为 ok:false，不抛错', async () => {
  const payload = stats.buildPayload({
    launcherVersion: '1.4.15', launcherChannel: 'latest', dshVersion: '0.2.2-rc.2', dshChannel: 'latest',
    platform: 'win32', release: '10.0.22631',
  })
  const ok = await stats.sendReport({
    endpoint: 'https://stats.example.com/v1/report',
    payload,
    fetchImpl: async (url, init) => {
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), [
        'dshChannel', 'dshVersion', 'dshlChannel', 'dshlVersion', 'windowsVersion',
      ])
      return { ok: true, status: 204 }
    },
  })
  assert.deepEqual(ok, { ok: true, status: 204 })

  const rejected = await stats.sendReport({
    endpoint: 'https://stats.example.com/v1/report',
    payload,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.status, 500)

  const broken = await stats.sendReport({
    endpoint: 'https://stats.example.com/v1/report',
    payload,
    fetchImpl: async () => { throw new Error('network down') },
  })
  assert.equal(broken.ok, false)
  assert.match(broken.error, /network down/)
})

test('非法端点 / 非法上报体不发请求', async () => {
  let called = 0
  const fetchImpl = async () => { called += 1; return { ok: true, status: 204 } }
  const noEndpoint = await stats.sendReport({ endpoint: 'http://example.com/x', payload: {}, fetchImpl })
  assert.equal(noEndpoint.error, 'endpoint-invalid')
  const noPayload = await stats.sendReport({ endpoint: 'https://stats.example.com/x', payload: null, fetchImpl })
  assert.equal(noPayload.error, 'payload-invalid')
  assert.equal(called, 0)
})
