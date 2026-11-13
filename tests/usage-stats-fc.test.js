// tests/usage-stats-fc.test.js — 阿里云 FC/OTS 版的字段收敛、聚合与路由（假 OTS）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../stats/fc/core')
const { createApp } = require('../stats/fc/index')

function fakeClient() {
  const rows = []
  return {
    rows,
    async putRow(params) {
      const attrs = {}
      for (const item of params.attributeColumns) Object.assign(attrs, item)
      rows.push({ primaryKey: params.primaryKey, attributes: [attrs] })
    },
    async getRange(params) {
      const start = params.inclusiveStartPrimaryKey[0].pk
      const end = params.exclusiveEndPrimaryKey[0].pk
      return {
        rows: rows.filter((row) => {
          const pk = row.primaryKey[0].pk
          return pk >= start && pk < end
        }),
        nextStartPrimaryKey: null,
      }
    },
  }
}

const NOW = Date.parse('2026-11-13T08:00:00.000Z')
const GOOD = {
  dshlVersion: '1.4.15',
  dshlChannel: 'latest',
  dshVersion: '0.2.2-rc.2',
  dshChannel: 'alpha',
  windowsVersion: 'Windows 11 23H2',
}

test('FC core：只接受固定 5 字段；日期与随机主键不含设备信息', () => {
  assert.deepEqual(core.validateReport(GOOD), GOOD)
  assert.equal(core.validateReport({ ...GOOD, installId: 'x' }), null)
  assert.equal(core.validateReport({ ...GOOD, dshVersion: 'C:\\secret' }), null)
  assert.equal(core.dayKey(NOW), '2026-11-13')
  const pk = core.reportKey('2026-11-13', 'abcdef012345')
  assert.match(pk, /^2026-11-13#[0-9a-f]+$/u)
  assert.doesNotMatch(pk, /127\.0\.0\.1|hostname/u)
})

test('FC aggregate：同一版本组合累加计数，不按对象身份拆散', () => {
  const rows = [
    { day: '2026-11-13', ...GOOD },
    { day: '2026-11-13', ...GOOD },
    { day: '2026-11-12', ...GOOD },
  ]
  const result = core.aggregate(rows)
  assert.equal(result.totals.reports, 3)
  assert.equal(result.totals.combinations, 1)
  assert.equal(result.byDshlVersion[0].reports, 3)
  assert.equal(result.daily.find((d) => d.day === '2026-11-13').reports, 2)
})

test('FC 路由：合法报告写一条 OTS 行，返回 204', async () => {
  const client = fakeClient()
  const app = createApp({ client, tableName: 't', adminToken: 'secret', now: () => NOW })
  const result = await app.handleRequest({
    method: 'POST', path: '/v1/report', headers: {}, body: JSON.stringify(GOOD),
  })
  assert.equal(result.statusCode, 204)
  assert.equal(client.rows.length, 1)
  const attrs = client.rows[0].attributes[0]
  assert.equal(attrs.day, '2026-11-13')
  assert.equal(attrs.dshlVersion, '1.4.15')
  assert.equal(attrs.windowsVersion, 'Windows 11 23H2')
  assert.equal(client.rows[0].primaryKey[0].pk.split('#')[0], '2026-11-13')
})

test('FC 路由：多字段/坏 JSON 不写库；无 token 查询 401', async () => {
  const client = fakeClient()
  const app = createApp({ client, tableName: 't', adminToken: 'secret', now: () => NOW })
  const extra = await app.handleRequest({
    method: 'POST', path: '/v1/report', headers: {}, body: JSON.stringify({ ...GOOD, ip: '1.2.3.4' }),
  })
  assert.equal(extra.statusCode, 400)
  const bad = await app.handleRequest({ method: 'POST', path: '/v1/report', headers: {}, body: 'nope' })
  assert.equal(bad.statusCode, 400)
  assert.equal(client.rows.length, 0)

  const unauthorized = await app.handleRequest({ method: 'GET', path: '/api/summary', headers: {} })
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(client.rows.length, 0)
})

test('FC 路由：带 token 的 summary 聚合当天数据；后台页面可打开', async () => {
  const client = fakeClient()
  const app = createApp({ client, tableName: 't', adminToken: 'secret', now: () => NOW })
  await app.handleRequest({ method: 'POST', path: '/v1/report', headers: {}, body: JSON.stringify(GOOD) })
  const response = await app.handleRequest({
    method: 'GET', path: '/api/summary', headers: { authorization: 'Bearer secret' }, query: { days: '7' },
  })
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.totals.reports, 1)
  assert.equal(body.byDshlVersion[0].version, '1.4.15')
  assert.equal(body.windows[0].windowsVersion, 'Windows 11 23H2')
  assert.equal(body.since, '2026-11-07')
  const page = await app.handleRequest({ method: 'GET', path: '/', headers: {} })
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /DSHL 使用量统计/u)
})
