// lifecycle.js — 有界 JSONL 生命周期事件日志（借鉴 dsh-desktop 的 lifecycle-events.ts）
// 文件：<dir>/lifecycle.jsonl，每行 {ts, event, detail}。
// 上限：单条 8KB、detail 值截断 128 字符/最多 16 项、文件 256KB（超限丢最旧行）。
// 原则：emit 永不抛错（日志证据，不能影响主流程）；未知事件名直接忽略。
'use strict'

const fs = require('fs')
const path = require('path')

const MAX_FILE_BYTES = 256 * 1024
const MAX_EVENT_BYTES = 8 * 1024
const MAX_DETAIL_VALUE = 128
const MAX_DETAIL_ITEMS = 16

// 事件名白名单：与 main.js / dsh-update.js / updater.js 的接线点一一对应
const EVENTS = new Set([
  'app.started',
  'app.exit',
  'app.uncaught',
  'crash.previousRun',
  'env.detect',
  'env.diag',
  'service.start',
  'service.ready',
  'service.readyTimeout',
  'service.exit',
  'service.adopt',
  'service.blocked',
  'service.portSwitch',
  'service.autoRestart',
  'service.autoRestartExhausted',
  'service.autoRestartHalted',
  'update.launcher',
  'update.dsh',
  'recovery.restore',
  'health.capture',
  'diagnostics.saved',
])

let filePath = ''
let logRef = () => {}

function initLifecycle({ dir, log } = {}) {
  if (!dir || typeof dir !== 'string') return
  filePath = path.join(dir, 'lifecycle.jsonl')
  logRef = log || (() => {})
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
}

function getPath() {
  return filePath
}

function emit(event, detail = {}) {
  if (!EVENTS.has(event) || !filePath) return
  const short = {}
  try {
    const entries = Object.entries(detail || {}).slice(0, MAX_DETAIL_ITEMS)
    for (const [k, v] of entries) {
      if (typeof v === 'string') short[k] = v.slice(0, MAX_DETAIL_VALUE)
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) short[k] = v
      else if (Array.isArray(v)) short[k] = v.map((x) => String(x).slice(0, MAX_DETAIL_VALUE)).slice(0, MAX_DETAIL_ITEMS)
      else short[k] = String(v).slice(0, MAX_DETAIL_VALUE)
    }
  } catch { /* 序列化失败则丢弃详情 */ }
  let line = JSON.stringify({ ts: new Date().toISOString(), event, detail: short })
  // 单条字节上限：按 UTF-8 边界截断
  if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
    let cut = 0
    let bytes = 0
    while (cut < line.length) {
      const ch = line.charCodeAt(cut)
      const b = ch < 0x80 ? 1 : ch < 0x800 ? 2 : ch < 0x10000 ? 3 : 4
      if (bytes + b > MAX_EVENT_BYTES - 2) break
      bytes += b
      cut += 1
    }
    line = line.slice(0, cut) + '…'
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, line + '\n')
    trimOldest()
  } catch (e) {
    try { logRef('lifecycle emit failed: ' + (e && e.message ? e.message : String(e))) } catch { /* noop */ }
  }
}

function trimOldest() {
  let size
  try {
    size = fs.statSync(filePath).size
  } catch { return }
  if (size <= MAX_FILE_BYTES) return
  let lines
  try {
    lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
  } catch { return }
  // 从尾部保留，直到接近上限（保留 90%，留出后续写入空间再触发一次清理）
  const budget = Math.floor(MAX_FILE_BYTES * 0.9)
  let kept = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!l) continue
    const b = Buffer.byteLength(l, 'utf8') + 1
    if (bytes + b > budget && kept.length > 0) break
    bytes += b
    kept.unshift(l)
  }
  if (kept.length === lines.length) return
  // 原子替换：临时文件 + rename，证据文件永不写出半行
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
    fs.renameSync(tmp, filePath)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* noop */ }
    try { logRef('lifecycle trim failed: ' + (e && e.message ? e.message : String(e))) } catch { /* noop */ }
  }
}

function tail(count = 40) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-count)
  } catch { return [] }
}

module.exports = { initLifecycle, emit, tail, getPath, EVENTS }
