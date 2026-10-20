// feedback-pack.js — 反馈正文的压缩与分片发送（纯逻辑 + 可注入 IO，可单测）
//
// 为什么需要：反馈正文 POST 到飞书**群自定义机器人** webhook，而飞书对文本消息有长度上限，
// 超出部分被截断（作者只看到前半段）。自定义机器人不支持文件消息，所以只能在客户端解决：
//   1) 压缩：反馈日志的长度主因是**同一行体反复出现**（心跳、同类错误，且多数并不相邻），
//      折叠成 `… ×N` 后常小一个数量级；
//   2) 分片：压缩后仍超上限就切成多条，每条带 [i/N] 前缀，串行 + 节流 + 命中限流退避重试。
//
// 计长口径：**UTF-16 码元**（JS 字符串 .length），不是 UTF-8 字节 —— 飞书按字符计长，
// 按字节截断会在中文场景下"看着没超却仍被截断"。
//
// 折叠的前提：server.err/out.log 现在每行都带时间戳前缀（见 log-stamp.js），
// 所以**必须先剥掉前缀再比**，否则每行都不同、一行都折不动。
'use strict'

const DEFAULT_CHUNK_CHARS = 6000 // 单条消息的字符上限（保守值；飞书侧上限更大时改这里即可）
const MIN_CHUNK_CHARS = 500
const MAX_CHUNK_CHARS = 50000
const PREFIX_RESERVE = 24 // 给 "[12/34] " 这类前缀留的余量

// 日志行前缀，两种真实格式都要剥：
//   · server.err/out.log：[2026-09-21T18:39:32.610+08:00]（log-stamp.js 写入的 ISO + 偏移）
//   · dshl.log：[2026-10-19 14:34:00]（启动器自己写本地时间，空格分隔、无时区）
// 只认前者会让 dshl.log 连时间戳一起参与比较 → 每行都"不同"、一行都折不动（真实反馈里
// dshl.log 200 行有 35×"打开窗口"、25×"已是最新"却全量入包，是多条飞书消息的主因之一）。
const STAMP_RE = /^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:[+-]\d{2}:\d{2})?)\]\s?/

/** 把任意输入夹到 [MIN_CHUNK_CHARS, MAX_CHUNK_CHARS]；非法值回落默认。 */
function clampChunkChars (value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_CHARS
  return Math.min(MAX_CHUNK_CHARS, Math.max(MIN_CHUNK_CHARS, n))
}

/**
 * 折叠重复的日志行：同一行体（剥掉时间戳后比较）只保留首次出现，
 * 后续出现（无论是否相邻）折算成 `… ×N（首个 → 末个）`。
 *
 * 为什么从「仅连续重复」改成「跨行重复」：真实反馈里最常见的两种重复恰好都不相邻 ——
 *   - 服务 stdout 的心跳：`[usage-billing] swallowed…` 与 model listing 交替出现
 *     （实测 100 行尾部里有 96 行是这两句，旧实现只比相邻行，一条都折不掉）；
 *   - 服务 stderr 的同类错误：同一句鉴权失败每半小时出现一次，中间夹着别的日志（实测 48 次）。
 * 折叠后仍保留出现次数与首末时间；未折叠原文另存 `.full.md`，排查时间线不受影响。
 * 空行不参与折叠（折了也没信息量）。
 * @param {string} text
 * @returns {string}
 */
function compactLog (text) {
  const lines = String(text === undefined || text === null ? '' : text).split(/\r?\n/)
  const out = [] // 首次出现的行原位保留；重复行先记账，最后统一折算
  const seen = new Map() // 行体 → { index, count, first, last }
  for (const line of lines) {
    const stamp = STAMP_RE.exec(line)
    const body = stamp ? line.slice(stamp[0].length) : line
    if (body === '') { out.push(line); continue }
    const rec = seen.get(body)
    if (rec) {
      rec.count++
      rec.last = stamp ? stamp[1] : '' // 末次出现没有时间戳就不报范围，与旧行为一致
      continue
    }
    seen.set(body, { index: out.length, count: 1, first: stamp ? stamp[1] : '', last: stamp ? stamp[1] : '' })
    out.push(line)
  }
  for (const [body, rec] of seen) {
    if (rec.count < 2) continue
    const range = rec.first && rec.last ? `（${rec.first} → ${rec.last}）` : ''
    out[rec.index] = `${body}  … ×${rec.count}${range}`
  }
  return out.join('\n')
}

/**
 * 按**行边界**切分正文，保证每块 ≤ maxChars（单行自身超限时硬切）。
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitForFeishu (text, maxChars) {
  const limit = Math.max(1, clampChunkChars(maxChars) - PREFIX_RESERVE)
  const src = String(text === undefined || text === null ? '' : text)
  if (src.length <= limit) return [src]
  const chunks = []
  let buf = ''
  const flush = () => { if (buf !== '') { chunks.push(buf); buf = '' } }
  for (const rawLine of src.split('\n')) {
    let rest = rawLine
    while (rest.length > limit) {
      flush() // 先把手里的块发出去，避免与长行拼成超限块
      chunks.push(rest.slice(0, limit))
      rest = rest.slice(limit)
    }
    if (buf === '') { buf = rest; continue }
    if (buf.length + 1 + rest.length > limit) { flush(); buf = rest } else { buf += '\n' + rest }
  }
  flush()
  return chunks.length > 0 ? chunks : ['']
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 分片串行发送。单块直接原样发出（不加前缀，保持与旧行为一致）；多块时每条带 `[i/N] `。
 * `sendOne` 抛出的错误若带 `retryable === true`（限流/5xx）则按 delayMs × 2^n 退避重试。
 * 失败时抛出的错误会写明**第几条失败**与**前几条已发出**，界面据此如实告诉用户。
 * @param {{text: string, maxChars: number, sendOne: (chunk: string) => Promise<unknown>, sleep?: (ms: number) => Promise<void>, delayMs?: number, retries?: number}} options
 * @returns {Promise<{chunks: number, sent: number}>}
 */
async function sendChunked (options) {
  const opts = options || {}
  const sendOne = opts.sendOne
  if (typeof sendOne !== 'function') throw new Error('sendChunked 需要 sendOne')
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep
  const delayMs = Number.isFinite(opts.delayMs) && opts.delayMs >= 0 ? opts.delayMs : 400
  const retries = Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : 2

  const chunks = splitForFeishu(opts.text, opts.maxChars)
  const total = chunks.length
  let sent = 0
  for (let i = 0; i < total; i++) {
    const label = total > 1 ? `[${i + 1}/${total}] ` : ''
    let attempt = 0
    for (;;) {
      try {
        await sendOne(label + chunks[i])
        break
      } catch (error) {
        const retryable = !!(error && error.retryable)
        const message = (error && error.message) || String(error)
        if (!retryable || attempt >= retries) {
          const failure = new Error(`第 ${i + 1}/${total} 条发送失败：${message}${sent > 0 ? `（前 ${sent} 条已发出）` : ''}`)
          failure.sent = sent
          failure.total = total
          failure.chunk = i + 1
          failure.retryable = retryable
          throw failure
        }
        attempt++
        await sleep(delayMs * 2 ** (attempt - 1))
      }
    }
    sent++
    if (i < total - 1) await sleep(delayMs) // 分片间隔：自定义机器人有频率限制
  }
  return { chunks: total, sent }
}

module.exports = {
  DEFAULT_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  MAX_CHUNK_CHARS,
  PREFIX_RESERVE,
  clampChunkChars,
  compactLog,
  splitForFeishu,
  sendChunked,
}
