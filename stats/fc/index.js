// stats/fc/index.js — 阿里云函数计算 FC 3.0（Node.js）HTTP 入口 + 表格存储 OTS
//
// 与 Cloudflare 版同口径：只接收 5 个字段，不读取/不保存来源 IP，不存安装 ID。
// OTS 里每条报告一行（主键含随机后缀，不关联设备），后台按天扫描后聚合。
'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const core = require('./core')

const MAX_BODY_BYTES = 1024
const DEFAULT_DAYS = 30
const MAX_DAYS = 400
const PAGE_LIMIT = 5000
const MAX_ROWS_PER_DAY = 20000

const ADMIN_HTML = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8')

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  }
}

function htmlResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body,
    isBase64Encoded: false,
  }
}

function tokenMatches(expected, given) {
  const a = String(expected || '')
  const b = String(given || '')
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function lowerHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) out[String(key).toLowerCase()] = value
  return out
}

function parseQuery(queryParameters) {
  const out = {}
  for (const [key, value] of Object.entries(queryParameters || {})) {
    out[String(key)] = Array.isArray(value) ? value[0] : value
  }
  return out
}

function daysAgoKeys(days, now) {
  const list = []
  const base = new Date(Number.isFinite(now) ? now : Date.now())
  for (let i = 0; i < days; i += 1) list.push(new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10))
  return list
}

function otsClientFromEnv(env) {
  // OTS SDK 只在真正需要时加载（本地单测不装 SDK 也能跑纯函数）
  const TableStore = require('tablestore')
  if (!env.OTS_ENDPOINT || !env.OTS_INSTANCE || !env.OTS_AK_ID || !env.OTS_AK_SECRET) return null
  return new TableStore.Client({
    accessKeyId: env.OTS_AK_ID,
    accessKeySecret: env.OTS_AK_SECRET,
    endpoint: env.OTS_ENDPOINT,
    instancename: env.OTS_INSTANCE,
    maxRetries: 3,
  })
}

function createApp({ client, tableName, adminToken, now = Date.now, logger = console }) {
  if (!client) throw new Error('createApp 需要 OTS client')
  const table = tableName || 'dshl_stats'

  async function putReport(report) {
    const day = core.dayKey(now())
    const pk = core.reportKey(day, crypto.randomBytes(12).toString('hex'))
    await client.putRow({
      tableName: table,
      primaryKey: [{ pk }],
      attributeColumns: [
        { day },
        { dshlVersion: report.dshlVersion },
        { dshlChannel: report.dshlChannel },
        { dshVersion: report.dshVersion },
        { dshChannel: report.dshChannel },
        { windowsVersion: report.windowsVersion },
        { createdAt: now() },
      ],
    })
  }

  async function readDay(day) {
    const rows = []
    let start = [{ pk: `${day}#` }]
    while (rows.length < MAX_ROWS_PER_DAY) {
      const page = await client.getRange({
        tableName: table,
        direction: 'FORWARD',
        maxVersions: 1,
        inclusiveStartPrimaryKey: start,
        exclusiveEndPrimaryKey: [{ pk: `${day}$` }],
        columnsToGet: ['day', 'dshlVersion', 'dshlChannel', 'dshVersion', 'dshChannel', 'windowsVersion'],
        limit: PAGE_LIMIT,
      })
      for (const row of page.rows || []) rows.push(core.rowToReport(row))
      if (!page.nextStartPrimaryKey) break
      start = page.nextStartPrimaryKey
    }
    return { rows: rows.slice(0, MAX_ROWS_PER_DAY), truncated: rows.length >= MAX_ROWS_PER_DAY }
  }

  async function summary(days) {
    const keys = daysAgoKeys(days, now())
    const pages = await Promise.all(keys.map((day) => readDay(day)))
    const rows = []
    let truncated = false
    for (const page of pages) {
      rows.push(...page.rows)
      if (page.truncated) truncated = true
    }
    return { ...core.aggregate(rows), truncated }
  }

  async function handleRequest(request) {
    const method = String(request.method || 'GET').toUpperCase()
    const pathname = String(request.path || '/').split('?')[0]
    const headers = lowerHeaders(request.headers)
    const query = parseQuery(request.query)

    if (method === 'POST' && pathname === '/v1/report') {
      let text = String(request.body || '')
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return jsonResponse(413, { ok: false, error: 'too-large' })
      let parsed
      try { parsed = JSON.parse(text) } catch { return jsonResponse(400, { ok: false, error: 'invalid-json' }) }
      const report = core.validateReport(parsed)
      if (!report) return jsonResponse(400, { ok: false, error: 'invalid-fields' })
      try {
        await putReport(report)
      } catch (error) {
        logger.warn('[dshl-stats] putRow failed: ' + (error && error.message ? error.message : String(error)))
        return jsonResponse(503, { ok: false, error: 'storage-unavailable' })
      }
      return jsonResponse(204, null)
    }

    if (method === 'GET' && pathname === '/api/summary') {
      const authorization = String(headers.authorization || '')
      const m = /^Bearer\s+(.+)$/i.exec(authorization)
      if (!tokenMatches(adminToken, m ? m[1].trim() : '')) return jsonResponse(401, { ok: false, error: 'unauthorized' })
      const days = Math.min(MAX_DAYS, Math.max(1, Number.parseInt(query.days, 10) || DEFAULT_DAYS))
      try {
        const body = await summary(days)
        return jsonResponse(200, { ok: true, since: daysAgoKeys(days, now()).at(-1), days, ...body })
      } catch (error) {
        logger.warn('[dshl-stats] summary failed: ' + (error && error.message ? error.message : String(error)))
        return jsonResponse(503, { ok: false, error: 'query-failed' })
      }
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/admin')) return htmlResponse(200, ADMIN_HTML)
    return jsonResponse(404, { ok: false, error: 'not-found' })
  }

  return { handleRequest, summary }
}

function normalizeEvent(event) {
  let value = event
  if (Buffer.isBuffer(value)) value = value.toString('utf8')
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { value = {} }
  }
  return value && typeof value === 'object' ? value : {}
}

async function readStreamBody(req) {
  if (req && req.body !== undefined) {
    return typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
  }
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function appFromEnv(env) {
  const client = otsClientFromEnv(env)
  if (!client) return null
  return createApp({
    client,
    tableName: env.OTS_TABLE || 'dshl_stats',
    adminToken: env.ADMIN_TOKEN,
  })
}

let cachedApp = null
exports.handler = async function handler(event, context) {
  // Web 函数模式：平台直接给 (req, res)；事件模式给 (event, context)
  const isWeb = event && typeof event === 'object' && context && typeof context.setHeader === 'function'
  if (isWeb) {
    const app = cachedApp || (cachedApp = appFromEnv(process.env))
    if (!app) {
      context.statusCode = 503
      context.setHeader('content-type', 'application/json; charset=utf-8')
      context.end(JSON.stringify({ ok: false, error: 'storage-unavailable' }))
      return
    }
    const body = await readStreamBody(event)
    const result = await app.handleRequest({
      method: event.method,
      path: event.url,
      headers: event.headers,
      body,
    })
    context.statusCode = result.statusCode === 204 ? 204 : result.statusCode
    for (const [key, value] of Object.entries(result.headers || {})) context.setHeader(key, value)
    context.end(result.body === null ? '' : result.body)
    return
  }

  const app = cachedApp || (cachedApp = appFromEnv(process.env))
  if (!app) return jsonResponse(503, { ok: false, error: 'storage-unavailable' })

  const e = normalizeEvent(event)
  const method = e.httpMethod || (e.requestContext && e.requestContext.http && e.requestContext.http.method) || 'GET'
  const pathname = e.rawPath || e.path || '/'
  let body = e.body || ''
  if (e.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8')
  const result = await app.handleRequest({
    method,
    path: pathname,
    headers: e.headers || {},
    query: e.queryParameters || {},
    body,
  })
  if (result.statusCode === 204) return { ...result, body: '' }
  return result
}

exports.createApp = createApp
exports.core = core
