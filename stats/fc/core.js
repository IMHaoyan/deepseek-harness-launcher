// stats/fc/core.js — FC/OTS 统计端的纯函数（无网络、无 SDK，便于单测）
'use strict'

const FIELDS = ['dshlVersion', 'dshlChannel', 'dshVersion', 'dshChannel', 'windowsVersion']
const FIELD_RE = /^[\x20-\x7E]{1,48}$/
const VERSION_RE = /^[0-9A-Za-z.+_-]{1,48}$/
const CHANNELS = new Set(['latest', 'alpha', 'unknown'])

function validateReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Object.keys(value).length !== FIELDS.length) return null
  const out = {}
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return null
    const text = typeof value[field] === 'string' ? value[field].trim() : ''
    if (!FIELD_RE.test(text)) return null
    // 版本号只允许版本字符；渠道只允许白名单值；系统名禁止路径分隔符。
    if ((field === 'dshlVersion' || field === 'dshVersion') && !VERSION_RE.test(text)) return null
    if ((field === 'dshlChannel' || field === 'dshChannel') && !CHANNELS.has(text)) return null
    if (field === 'windowsVersion' && /[\\/:]/.test(text)) return null
    out[field] = text
  }
  return out
}

function dayKey(now) {
  return new Date(Number.isFinite(now) ? now : Date.now()).toISOString().slice(0, 10)
}

// 主键只用于"按天前缀扫描"；随机后缀不含任何安装/设备信息。
function reportKey(day, randomHex) {
  return `${day}#${String(randomHex || '').slice(0, 32)}`
}

function rowToReport(row) {
  const attrs = {}
  for (const item of (row && row.attributes) || []) Object.assign(attrs, item)
  return {
    day: String(attrs.day || ''),
    dshlVersion: String(attrs.dshlVersion || ''),
    dshlChannel: String(attrs.dshlChannel || ''),
    dshVersion: String(attrs.dshVersion || ''),
    dshChannel: String(attrs.dshChannel || ''),
    windowsVersion: String(attrs.windowsVersion || ''),
  }
}

function bump(map, keyObj, reports) {
  const key = JSON.stringify(keyObj)
  const current = map.get(key)
  if (current) current.reports += reports
  else map.set(key, { ...keyObj, reports })
}

/**
 * 把逐条报告聚合成后台需要的 5 组数据。
 * @param {Array<{day:string,dshlVersion:string,dshlChannel:string,dshVersion:string,dshChannel:string,windowsVersion:string}>} reports
 * @param {(a:object,b:object)=>number} [compare]
 */
function aggregate(reports, compare) {
  const daily = new Map()
  const byDshl = new Map()
  const byDsh = new Map()
  const channels = new Map()
  const windows = new Map()
  let total = 0
  for (const r of reports || []) {
    if (!r || !r.day) continue
    total += 1
    bump(daily, { day: r.day }, 1)
    bump(byDshl, { version: r.dshlVersion, channel: r.dshlChannel }, 1)
    bump(byDsh, { version: r.dshVersion, channel: r.dshChannel }, 1)
    bump(channels, { launcherChannel: r.dshlChannel, dshChannel: r.dshChannel }, 1)
    bump(windows, { windowsVersion: r.windowsVersion }, 1)
  }
  const sort = compare || ((a, b) => b.reports - a.reports)
  const list = (map) => [...map.values()].sort(sort)
  return {
    totals: { reports: total, combinations: byDshl.size },
    daily: list(daily).sort((a, b) => (a.day < b.day ? 1 : -1)),
    byDshlVersion: list(byDshl),
    byDshVersion: list(byDsh),
    channels: list(channels),
    windows: list(windows),
  }
}

module.exports = {
  FIELDS,
  FIELD_RE,
  validateReport,
  dayKey,
  reportKey,
  rowToReport,
  aggregate,
}
