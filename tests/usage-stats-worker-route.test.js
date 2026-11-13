// tests/usage-stats-worker-route.test.js — Worker 路由行为（假 D1，不联网）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const workerUrl = pathToFileURL(path.join(__dirname, '..', 'stats', 'worker.mjs')).href

function fakeDb() {
  const calls = []
  return {
    calls,
    prepare(sql) {
      const row = { sql }
      return {
        bind(...args) { row.args = args; return this },
        async run() { calls.push({ kind: 'run', ...row }); return { success: true } },
        async all() { calls.push({ kind: 'all', ...row }); return { results: [] } },
        async first() { calls.push({ kind: 'first', ...row }); return { combinations: 0, reports: 0 } },
      }
    },
  }
}

const GOOD = JSON.stringify({
  dshlVersion: '1.4.15',
  dshlChannel: 'latest',
  dshVersion: '0.2.2-rc.2',
  dshChannel: 'alpha',
  windowsVersion: 'Windows 11 23H2',
})

test('POST /v1/report：合法报告只写一条聚合计数，返回 204', async () => {
  const { default: worker } = await import(workerUrl)
  const db = fakeDb()
  const response = await worker.fetch(new Request('https://stats.example.com/v1/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: GOOD,
  }), { DB: db, ADMIN_TOKEN: 'secret' })
  assert.equal(response.status, 204)
  assert.equal(db.calls.length, 1)
  assert.match(db.calls[0].sql, /INSERT INTO daily_counts/u)
  assert.match(db.calls[0].sql, /ON CONFLICT/u)
  assert.equal(db.calls[0].args.length, 6)
  assert.deepEqual(db.calls[0].args.slice(1), ['1.4.15', 'latest', '0.2.2-rc.2', 'alpha', 'Windows 11 23H2'])
  assert.match(db.calls[0].args[0], /^\d{4}-\d{2}-\d{2}$/u)
})

test('POST /v1/report：多字段、缺字段、坏 JSON、超大请求体一律拒绝且不写库', async () => {
  const { default: worker } = await import(workerUrl)
  const cases = [
    { body: JSON.stringify({ ...JSON.parse(GOOD), installId: 'x' }), status: 400 },
    { body: JSON.stringify({ dshlVersion: '1.4.15' }), status: 400 },
    { body: 'not-json', status: 400 },
    { body: 'x'.repeat(2048), status: 413 },
  ]
  for (const item of cases) {
    const db = fakeDb()
    const response = await worker.fetch(new Request('https://stats.example.com/v1/report', { method: 'POST', body: item.body }), { DB: db, ADMIN_TOKEN: 'secret' })
    assert.equal(response.status, item.status)
    assert.equal(db.calls.length, 0)
  }
})

test('GET /api/summary：无 token / 错 token 拒绝；正确 token 返回聚合结构', async () => {
  const { default: worker } = await import(workerUrl)
  const db = fakeDb()
  const env = { DB: db, ADMIN_TOKEN: 'secret-token' }

  const unauthorized = await worker.fetch(new Request('https://stats.example.com/api/summary'), env)
  assert.equal(unauthorized.status, 401)
  const wrong = await worker.fetch(new Request('https://stats.example.com/api/summary', { headers: { authorization: 'Bearer nope' } }), env)
  assert.equal(wrong.status, 401)
  assert.equal(db.calls.length, 0, '鉴权失败不得查询数据库')

  const ok = await worker.fetch(new Request('https://stats.example.com/api/summary', { headers: { authorization: 'Bearer secret-token' } }), env)
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.totals, { reports: 0, combinations: 0 })
  for (const key of ['daily', 'byDshlVersion', 'byDshVersion', 'channels', 'windows']) {
    assert.ok(Array.isArray(body[key]), key + ' 必须是数组')
  }
  assert.equal(db.calls.length, 6, '六条聚合查询都要执行')
})

test('GET / 返回后台页面，未知路径 404', async () => {
  const { default: worker } = await import(workerUrl)
  const page = await worker.fetch(new Request('https://stats.example.com/'), { DB: fakeDb() })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /DSHL 使用量统计/u)
  const missing = await worker.fetch(new Request('https://stats.example.com/nope'), { DB: fakeDb() })
  assert.equal(missing.status, 404)
})
