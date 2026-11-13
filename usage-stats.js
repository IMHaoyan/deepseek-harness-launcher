// usage-stats.js — 可关闭的使用量统计（只报版本与系统信息，不含安装 ID / 主机名 / 路径 / 对话）
//
// 口径（与 stats/README.md 一致）：
//   - 每条报告只有 5 个字段：DSHL 版本、DSHL 更新渠道、DSH 版本、DSH 更新渠道、Windows 版本；
//   - 没有安装 ID、设备指纹、随机数或时间戳，因此服务端无法跨日报去重；
//   - 接收端不持久化来源 IP（Cloudflare 网络层仍能看到连接来源，不在本模块可控范围）；
//   - 发送失败静默跳过，绝不阻塞或影响服务启动。
'use strict'

const os = require('node:os')

const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000
const MAX_FIELD_LEN = 48
const MAX_BODY_BYTES = 1024

const CHANNELS = new Set(['latest', 'alpha'])

// 只认 http(s)；明文 http 仅允许回环地址（本地联调），其余一律拒绝，避免凭证/统计被旁路嗅探。
function normalizeEndpoint(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { return '' }
  if (url.protocol === 'https:') return url.href
  if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return url.href
  return ''
}

function cleanField(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (!text) return ''
  // 只留可打印 ASCII：版本号/渠道/系统名不需要别的字符，顺手挡住意外带进来的路径或中文备注
  if (!/^[\x20-\x7E]+$/.test(text)) return ''
  return text.slice(0, MAX_FIELD_LEN)
}

// 版本号只允许版本字符：`C:\secret`、带空格的路径、命令行片段一律判为不可上报。
const VERSION_RE = /^[0-9A-Za-z.+_-]{1,48}$/
function cleanVersion(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().slice(0, MAX_FIELD_LEN)
  return VERSION_RE.test(text) ? text : ''
}

function normalizeChannel(value) {
  const text = cleanField(value).toLowerCase()
  return CHANNELS.has(text) ? text : 'unknown'
}

// 只列"能确定"的版本号；其余按 build 号展示，不臆测。
const WINDOWS11_LABELS = {
  22000: '21H2',
  22621: '22H2',
  22631: '23H2',
  26100: '24H2',
  26200: '25H2',
}
const WINDOWS10_LABELS = {
  19041: '2004',
  19042: '20H2',
  19043: '21H1',
  19044: '21H2',
  19045: '22H2',
  18363: '1909',
}

/**
 * Windows 版本的可读名：release 形如 `10.0.22631`。
 * 市场名与内部版本号的对应是固定事实表；未知 build 保留 build 号，绝不猜成别的版本。
 * @param {string} release os.release()
 * @returns {string} 例：`Windows 11 23H2` / `Windows 11（build 22635）` / `Windows 10`
 */
function describeWindows(release) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(release || '').trim())
  if (!m) return 'unknown'
  const major = Number(m[1])
  const build = Number(m[3])
  if (major !== 10) return `Windows ${major}`
  if (build < 22000) {
    const label = WINDOWS10_LABELS[build]
    return label ? `Windows 10 ${label}` : `Windows 10 (build ${build})`
  }
  const label = WINDOWS11_LABELS[build]
  return label ? `Windows 11 ${label}` : `Windows 11 (build ${build})`
}

/**
 * 组装上报体。字段固定为 5 个；任一必填字段不合法就返回 null（宁可不报，也不报假数据）。
 * @param {{launcherVersion?:string, launcherChannel?:string, dshVersion?:string,
 *          dshChannel?:string, platform?:string, release?:string}} input
 * @returns {{dshlVersion:string, dshlChannel:string, dshVersion:string,
 *            dshChannel:string, windowsVersion:string}|null}
 */
function buildPayload(input) {
  const src = input || {}
  const dshlVersion = cleanVersion(src.launcherVersion)
  const dshVersion = cleanVersion(src.dshVersion)
  if (!dshlVersion || !dshVersion) return null
  const platform = cleanField(src.platform) || process.platform
  const windowsVersion = platform === 'win32'
    ? describeWindows(src.release === undefined ? os.release() : src.release)
    : `${platform} ${cleanField(src.release) || 'unknown'}`
  if (!windowsVersion || windowsVersion === 'unknown') return null
  return {
    dshlVersion,
    dshlChannel: normalizeChannel(src.launcherChannel),
    dshVersion,
    dshChannel: normalizeChannel(src.dshChannel),
    windowsVersion: windowsVersion.slice(0, MAX_FIELD_LEN),
  }
}

/** 距离上次成功上报是否已满一个周期（lastAt 非法一律按"从未上报"）。 */
function shouldReport(state) {
  const s = state || {}
  if (s.enabled !== true) return false
  const last = Number(s.lastAt)
  const now = Number(s.now)
  if (!Number.isFinite(now) || now <= 0) return false
  if (!Number.isFinite(last) || last <= 0) return true
  return now - last >= (Number(s.intervalMs) > 0 ? Number(s.intervalMs) : REPORT_INTERVAL_MS)
}

/** 上报体的确定性序列化：字段顺序固定，便于服务端去重与测试断言。 */
function serialize(payload) {
  if (!payload) return ''
  return JSON.stringify({
    dshlVersion: payload.dshlVersion,
    dshlChannel: payload.dshlChannel,
    dshVersion: payload.dshVersion,
    dshChannel: payload.dshChannel,
    windowsVersion: payload.windowsVersion,
  })
}

/**
 * 发送一次报告。任何失败都收敛成 {ok:false,error}，绝不抛错、不重试（重试由调用方按日周期决定）。
 * 不读取、不发送安装 ID；不携带 cookie；不跟随跨域重定向（避免把报告带到非预期主机）。
 * @param {{endpoint:string, payload:object, fetchImpl?:Function, timeoutMs?:number}} options
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
async function sendReport(options) {
  const opts = options || {}
  const endpoint = normalizeEndpoint(opts.endpoint)
  if (!endpoint) return { ok: false, error: 'endpoint-invalid' }
  const body = serialize(opts.payload)
  if (!body) return { ok: false, error: 'payload-invalid' }
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return { ok: false, error: 'payload-too-large' }
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch-unavailable' }
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : REQUEST_TIMEOUT_MS
  let timer = null
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `DSHL-usage-stats/${opts.payload && opts.payload.dshlVersion ? opts.payload.dshlVersion : 'unknown'}`,
      },
      body,
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response || !response.ok) return { ok: false, status: response ? response.status : 0, error: 'http-' + String(response ? response.status : 'none') }
    return { ok: true, status: response.status }
  } catch (error) {
    const name = error && error.name ? error.name : ''
    return { ok: false, error: name === 'AbortError' ? 'timeout' : (error && error.message ? error.message : String(error)) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

module.exports = {
  REPORT_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  MAX_BODY_BYTES,
  normalizeEndpoint,
  normalizeChannel,
  describeWindows,
  buildPayload,
  shouldReport,
  serialize,
  sendReport,
}
