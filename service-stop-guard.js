// service-stop-guard.js — 服务停止的防重入 + 看门狗（可单测，零依赖）
//
// 为什么需要看门狗：底层 taskkill 在 Windows 上偶发"回调不返回"（进程无响应/需要弹窗），
// 若只用布尔标志做防重入，标志会永久停在 true：面板按钮变灰、点停止没反应、服务一直不停。
// 这里在置位时同时起一个定时器，到期强制复位并回调告警，保证状态一定能自愈。
'use strict'

const DEFAULT_TIMEOUT_MS = 30000

let stopping = false
let timer = null
let timerFn = setTimeout
let clearFn = clearTimeout

/** 测试用：替换定时器实现（返回句柄）。传 null 恢复默认。 */
function _setTimersForTest(setFn, clearFunction) {
  timerFn = setFn || setTimeout
  clearFn = clearFunction || clearTimeout
}

function isStopping() {
  return stopping
}

/**
 * 开始一次停止。已在停止中 → 返回 false（调用方直接放弃，不重复杀进程）。
 * @param {{timeoutMs?: number, onTimeout?: () => void}} opts
 * @returns {boolean} 是否成功置位
 */
function beginStop(opts = {}) {
  if (stopping) return false
  stopping = true
  const ms = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  if (timer) { clearFn(timer); timer = null }
  timer = timerFn(() => {
    if (!stopping) return
    stopping = false
    timer = null
    try { if (opts.onTimeout) opts.onTimeout() } catch { /* 告警回调失败不影响复位 */ }
  }, ms)
  return true
}

/** 停止流程结束（正常或异常）→ 复位并取消看门狗。幂等。 */
function endStop() {
  stopping = false
  if (timer) { clearFn(timer); timer = null }
}

module.exports = { beginStop, endStop, isStopping, DEFAULT_TIMEOUT_MS, _setTimersForTest }
