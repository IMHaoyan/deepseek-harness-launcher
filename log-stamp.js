// log-stamp.js — 给子进程输出逐行打时间戳（纯逻辑，可单测）
//
// 为什么需要：server.err.log / server.out.log 原来是原样落盘的，**没有时间戳**。
// 2026-09-20 排查"设备昨晚几点掉线"时，这批日志里的错误无法定位到时刻，
// 只能靠相邻记录的推断 —— 而这两份日志正是启动失败/崩溃时唯一的现场。
//
// 边界（刻意划清）：
//   - 只影响**落盘文件**；内存里的 errTail 与"当前环节"解析仍用原始行，
//     所以 boot-failure 的规则匹配与 start-progress 的 [name] 前缀都不受影响；
//   - 时间戳用本地时间 + 偏移量：人看的时钟与它一致，跨时区也能换算；
//   - 半行（chunk 可能把一行劈开）留在缓冲里等换行，没等到就在 flush() 时补上；
//     一直不换行的超长输出不会把内存憋住（超过 pendingMax 就先落一行）。
'use strict'

const DEFAULT_PENDING_MAX = 8 * 1024

/**
 * 本地时间 + 偏移量，例如 `[2026-09-20T21:20:31.123+08:00]`。
 * @param {Date} [date]
 * @returns {string}
 */
function formatStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `[${ymd}T${hms}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}]`
}

/**
 * 造一个"逐行打戳"的写入器。
 * @param {(text: string) => void} sink 真正落盘的回调（调用方负责流是否已关闭）
 * @param {{now?: () => Date, pendingMax?: number}} [opts]
 * @returns {{write: (chunk: unknown) => void, flush: () => void}}
 */
function createStampWriter(sink, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date()
  const pendingMax = Number.isFinite(opts.pendingMax) ? opts.pendingMax : DEFAULT_PENDING_MAX
  let pending = ''

  const emit = (text) => {
    try {
      sink(`${formatStamp(now())} ${text}\n`)
    } catch {
      /* 落盘失败不该影响服务：与 writeSafe 同样的取舍 */
    }
  }

  return {
    write(chunk) {
      pending += String(chunk === undefined || chunk === null ? '' : chunk)
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        emit(pending.slice(0, index))
        pending = pending.slice(index + 1)
      }
      // 没有换行的长输出（进度条之类）：先落一行，别把内存憋住
      if (pending.length > pendingMax) {
        emit(pending)
        pending = ''
      }
    },
    flush() {
      if (!pending) return
      const rest = pending
      pending = ''
      emit(rest)
    },
  }
}

module.exports = { formatStamp, createStampWriter }
