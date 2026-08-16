// balance.js — DeepSeek 余额查询（参照 cc-switch src-tauri/src/services/balance.rs）
// 官方接口：GET https://api.deepseek.com/user/balance  + Authorization: Bearer <key>
// 响应：{ is_available: bool, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
// 语义与 cc-switch 一致：401/403 → 鉴权失败；非 2xx → 接口错误；数值兼容字符串与数字；is_available 缺省视为 true。
// 密钥/接口来源优先级：面板输入 → dshl 配置 → DSH 的 .credentials.yaml（DEEPSEEK_API_KEY）/ settings.yaml（llm-deepseek.baseURL）→ 官方默认。
'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')

const OFFICIAL_BASE = 'https://api.deepseek.com'
const TIMEOUT_MS = 15000

// 极简 YAML 行解析（只取顶层 `KEY: value`，够 .credentials.yaml 用）
function parseSimpleYaml(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

// 从 DSH 配置读取 DeepSeek 密钥与自定义接口（零配置体验）：
//   ~/.dsh/.credentials.yaml  →  DEEPSEEK_API_KEY: sk-...
//   ~/.dsh/settings.yaml      →  llm-deepseek: { baseURL: https://..., apiKeyEnv: DEEPSEEK_API_KEY }
function readDshKeyInfo(homeDir) {
  const info = { key: '', baseUrl: '' }
  try {
    const cred = parseSimpleYaml(fs.readFileSync(path.join(homeDir, '.credentials.yaml'), 'utf8'))
    if (typeof cred.DEEPSEEK_API_KEY === 'string' && cred.DEEPSEEK_API_KEY) info.key = cred.DEEPSEEK_API_KEY
  } catch { /* 文件不存在/读不了：忽略 */ }
  try {
    const lines = fs.readFileSync(path.join(homeDir, 'settings.yaml'), 'utf8').split(/\r?\n/)
    let inSection = false
    for (const line of lines) {
      if (/^llm-deepseek\s*:/.test(line)) { inSection = true; continue }
      if (inSection && /^\S/.test(line)) inSection = false
      if (inSection) {
        const m = line.match(/^\s+baseURL\s*:\s*(\S+)/)
        if (m) {
          info.baseUrl = m[1].replace(/^["']|["']$/g, '').replace(/\/+$/, '')
          break
        }
      }
    }
  } catch { /* 忽略 */ }
  return info
}

function normalizeBase(base) {
  let b = String(base || '').trim()
  if (!b) b = OFFICIAL_BASE
  if (!/^https?:\/\//i.test(b)) b = 'https://' + b
  return b.replace(/\/+$/, '')
}

// 只保留 origin：自定义 baseURL 可能带 /v1 等路径，余额接口在根路径 /user/balance
function originOf(base) {
  try { return new URL(normalizeBase(base)).origin } catch { return normalizeBase(base) }
}

function queryBalance(baseUrl, apiKey) {
  return new Promise((resolve) => {
    const key = String(apiKey || '').trim()
    if (!key) {
      resolve({ ok: false, error: '未找到 API Key：请在接口设置中填写，或配置 DSH 的 DEEPSEEK_API_KEY' })
      return
    }
    let target
    try { target = new URL(originOf(baseUrl) + '/user/balance') } catch (err) {
      resolve({ ok: false, error: '接口地址无效：' + err.message })
      return
    }
    requestOnce(target, key, 5, resolve)
  })
}

// 单次请求；跟随重定向（与 cc-switch 的 reqwest 默认行为一致，最多 5 跳；
// 跨域重定向时按浏览器惯例去掉 Authorization 头）
function requestOnce(target, key, redirectsLeft, resolve) {
  const lib = target.protocol === 'http:' ? http : https
  const req = lib.request(target, {
    method: 'GET',
    timeout: TIMEOUT_MS,
    headers: {
      Authorization: 'Bearer ' + key,
      Accept: 'application/json',
      'User-Agent': 'DSHL (DeepSeek Harness Launcher)',
    },
  }, (res) => {
    const status = res.statusCode || 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      const loc = res.headers.location
      res.resume()
      if (!loc) { resolve({ ok: false, error: `接口返回重定向（HTTP ${status}）但没有 Location 头`, httpStatus: status }); return }
      if (redirectsLeft <= 0) { resolve({ ok: false, error: '重定向次数过多（超过 5 次）', httpStatus: status }); return }
      let next
      try { next = new URL(loc, target) } catch (err) { resolve({ ok: false, error: '重定向地址无效：' + err.message }); return }
      // 跨域重定向 → 目标可能不是 DeepSeek 兼容接口（多半是登录/门户页），直接报错更明确
      if (next.origin !== target.origin) {
        resolve({ ok: false, error: `接口重定向到其他站点（HTTP ${status} → ${next.origin}）：该接口可能不是 DeepSeek 兼容的余额接口`, httpStatus: status })
        return
      }
      requestOnce(next, key, redirectsLeft - 1, resolve)
      return
    }
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (status === 401 || status === 403) {
        resolve({ ok: false, error: `鉴权失败（HTTP ${status}）：API Key 无效或已禁用`, httpStatus: status })
        return
      }
      if (status < 200 || status >= 300) {
        resolve({ ok: false, error: `接口返回错误（HTTP ${status}）${raw ? '：' + raw.slice(0, 200) : ''}`, httpStatus: status })
        return
      }
      let body
      try { body = JSON.parse(raw) } catch (err) {
        resolve({ ok: false, error: '响应不是合法 JSON：' + err.message })
        return
      }
      const num = (v) => {
        const n = typeof v === 'string' ? parseFloat(v) : v
        return (typeof n === 'number' && Number.isFinite(n)) ? n : null
      }
      const infos = Array.isArray(body && body.balance_infos)
        ? body.balance_infos.map((i) => ({
            currency: (i && typeof i.currency === 'string') ? i.currency : 'CNY',
            total: num(i && i.total_balance),
            granted: num(i && i.granted_balance),
            toppedUp: num(i && i.topped_up_balance),
          }))
        : []
      if (!infos.length) {
        resolve({ ok: false, error: '响应缺少 balance_infos：该接口可能不是 DeepSeek 兼容的余额接口' })
        return
      }
      resolve({ ok: true, data: { is_available: body.is_available !== false, balance_infos: infos }, endpoint: target.origin })
    })
  })
  req.on('timeout', () => req.destroy(new Error('请求超时（15 秒）')))
  req.on('error', (err) => resolve({ ok: false, error: '网络错误：' + err.message }))
  req.end()
}

module.exports = { OFFICIAL_BASE, readDshKeyInfo, queryBalance }
