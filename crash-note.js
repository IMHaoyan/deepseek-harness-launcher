// crash-note.js — 「上次启动器异常退出」提示的分级决策（纯函数，可单测）
//
// 为什么需要分级：启动器进程异常退出（强杀 / 断电 / 崩溃）在绝大多数情况下对用户没有影响 ——
// 下次启动照常把服务拉起来，会话与配置都在。把所有异常退出都渲染成"需要恢复"的红卡，
// 会把真正需要处理的情况（配置已回退、自动恢复已停止、反复崩溃）淹没在噪音里。
//
// 三档：
//   info   —— 单次异常退出、无影响：中性一行，主按钮「知道了」，不推恢复、不弹系统通知
//   notice —— 24 小时内第二次：中性提示"近期连续异常退出 N 次"，弹一次系统通知
//   alert  —— 有影响（配置已回退 / 自动恢复已停止）或 24 小时内 ≥3 次：红卡 + 「打开恢复」
'use strict'

const STREAK_WINDOW_MS = 24 * 60 * 60 * 1000
const ALERT_STREAK = 3
const MAX_STREAK = 99

/**
 * 连续异常退出计数：与上一条崩溃记录间隔在窗口内才累加，否则从 1 重新计数。
 * @param {{streak?: number, lastAt?: string}} state 上一次记账（count + 崩溃记录时间）
 * @param {string} recordAt 本次崩溃记录的启动时间（ISO）
 * @param {number} [windowMs]
 * @returns {number} 1..MAX_STREAK
 */
function nextStreak(state, recordAt, windowMs = STREAK_WINDOW_MS) {
  const cur = Math.floor(Number(state && state.streak) || 0)
  const prevMs = Date.parse(String((state && state.lastAt) || ''))
  const recMs = Date.parse(String(recordAt || ''))
  if (!Number.isFinite(recMs) || !Number.isFinite(prevMs)) return 1
  const delta = recMs - prevMs
  if (delta < 0 || delta > windowMs) return 1
  return Math.min(MAX_STREAK, Math.max(1, cur) + 1)
}

/**
 * 提示分级。
 * @param {{hasPreviousRun: boolean, streak?: number, hasImpact?: boolean}} input
 *        hasImpact = 本次运行里出现了"配置已回退"或"自动恢复已停止"这类真实影响
 * @returns {'none'|'info'|'notice'|'alert'}
 */
function severityFor(input) {
  const o = input || {}
  if (!o.hasPreviousRun) return 'none'
  if (o.hasImpact) return 'alert'
  const n = Math.floor(Number(o.streak) || 0)
  if (n >= ALERT_STREAK) return 'alert'
  if (n >= 2) return 'notice'
  return 'info'
}

/** 单次孤立异常退出不弹系统通知：只有反复出现或已影响服务时才打扰用户。 */
function shouldNotify(severity) {
  return severity === 'notice' || severity === 'alert'
}

module.exports = { STREAK_WINDOW_MS, ALERT_STREAK, MAX_STREAK, nextStreak, severityFor, shouldNotify }