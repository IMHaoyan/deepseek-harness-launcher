// diagnostics.js — 诊断报告（借鉴 dsh-desktop 的 diagnostic-export.ts 思路：上限 + 保留 3 份 + 脱敏）
// 报告为文本 Markdown（避免新增压缩依赖）；保留最近 3 份 diag-*.md。
'use strict'

const fs = require('fs')
const path = require('path')
const { redact } = require('./redact')

const KEEP = 3
const REPORT_MAX_BYTES = 4 * 1024 * 1024

let dir = ''
let logRef = () => {}

function initDiagnostics({ dir: d, log } = {}) {
  if (!d || typeof d !== 'string') return
  dir = d
  logRef = log || (() => {})
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
}

function listRecent() {
  try {
    return fs.readdirSync(dir)
      .filter((n) => /^diag-.*\.md$/.test(n))
      .sort()
      .reverse()
  } catch { return [] }
}

/**
 * 生成诊断报告文本。
 * @param {{
 *   appVersion: string, platform: string,
 *   envSummary: object|string, installState: object|string,
 *   updaterState: object|string, dshUpdateState: object|string,
 *   serverState: object|string, configRedacted: string,
 *   lastExit: string, lastCrashAt: string,
 *   lifecycleTail: string,
 *   tails: Array<{label: string, text: string}>
 * }} p — 由 main.js 组装；文本在拼接后统一脱敏。
 * @returns {string}
 */
function collectReport(p = {}) {
  const parts = [
    '# DeepSeek Harness Launcher 诊断报告',
    '',
    `- 生成时间：${new Date().toLocaleString('sv-SE', { hour12: false })}`,
    `- 启动器版本：v${p.appVersion || '?'}`,
    `- 平台：${p.platform || process.platform}`,
    `- 上次退出：${p.lastExit === 'crashed' ? `非正常（最近一次启动 ${p.lastCrashAt || '未知'}）` : (p.lastExit || '未知')}`,
    '',
    '## 配置（已脱敏）',
    '```json',
    String(p.configRedacted || '').slice(0, 200 * 1024),
    '```',
    '',
    '## 环境',
    '```',
    typeof p.envSummary === 'string' ? p.envSummary : JSON.stringify(p.envSummary, null, 2),
    '```',
    '',
    '## 服务状态',
    '```',
    typeof p.serverState === 'string' ? p.serverState : JSON.stringify(p.serverState, null, 2),
    '```',
    '',
    '## 安装任务',
    '```',
    typeof p.installState === 'string' ? p.installState : JSON.stringify(p.installState, null, 2),
    '```',
    '',
    '## 更新状态',
    '```json',
    JSON.stringify({ launcher: p.updaterState || null, dsh: p.dshUpdateState || null }, null, 2),
    '```',
    '',
    '## 生命周期事件（尾部）',
    '```',
    String(p.lifecycleTail || '').slice(0, 64 * 1024),
    '```',
  ]
  for (const t of p.tails || []) {
    parts.push('', `## 日志 ${t.label}`, '```', String(t.text || '').slice(0, 512 * 1024), '```')
  }
  let body = parts.join('\n')
  if (Buffer.byteLength(body, 'utf8') > REPORT_MAX_BYTES) {
    body = body.slice(0, REPORT_MAX_BYTES - 400) + '\n\n…（诊断报告超出长度上限，已截断）'
  }
  return redact(body)
}

/** 保存报告（保留最近 KEEP 份），返回文件路径。失败返回 ''。 */
function saveReport(text) {
  if (!dir) return ''
  try {
    fs.mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const file = path.join(dir, `diag-${ts}.md`)
    fs.writeFileSync(file, text, 'utf8')
    prune()
    try { logRef('diagnostics saved: ' + file) } catch { /* noop */ }
    return file
  } catch (e) {
    try { logRef('diagnostics save failed: ' + (e && e.message ? e.message : String(e))) } catch { /* noop */ }
    return ''
  }
}

function prune() {
  try {
    const files = listRecent()
    while (files.length > KEEP) {
      const oldest = files.pop()
      try { fs.unlinkSync(path.join(dir, oldest)) } catch { /* noop */ }
    }
  } catch { /* noop */ }
}

module.exports = { initDiagnostics, collectReport, saveReport, listRecent }
