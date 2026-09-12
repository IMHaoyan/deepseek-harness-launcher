// notify-policy.js — 通知分类开关与「同一版本只提醒一次」的纯策略（无 Electron / fs 依赖，可单测）
//
// 语义：
//  - 总开关 Config.notify === false → 全静默（所有分类与未分类都不弹）；
//  - 未分类（category 为 undefined / 未知值）不受分类开关限制 —— 只受总开关约束。
//    例如测试通知、最小化到托盘提示、用户插件投递的消息，都应始终提醒；
//  - 已知分类（service / recovery / update）看对应开关，缺省 true；
//  - 配置读取 fail-closed：类型不符一律回落到默认值（开关默认 true、版本号默认 ''）。
'use strict'

const CATEGORIES = ['service', 'recovery', 'update']

// 版本去重字段：launcher = 启动器自身更新，dsh = DSH 更新
const VERSION_FIELDS = { launcher: 'notifiedLauncherVersion', dsh: 'notifiedDshVersion' }

function defaultCategories() {
  return { service: true, recovery: true, update: true }
}

/** 归一化分类开关：非对象 / 字段非布尔 / 缺字段 → 该字段用默认值 true。 */
function normalizeNotifyCategories(value) {
  const out = defaultCategories()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const key of CATEGORIES) {
    if (typeof value[key] === 'boolean') out[key] = value[key]
  }
  return out
}

/** 归一化版本记账字段：非字符串 → ''。 */
function normalizeVersionField(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 该通知当前是否允许弹出。
 * @param {object} config 运行中的 Config（含 notify / notifyCategories）
 * @param {string|undefined} category 'service' | 'recovery' | 'update' | undefined
 * @returns {boolean}
 */
function categoryEnabled(config, category) {
  const cfg = config && typeof config === 'object' ? config : {}
  if (cfg.notify === false) return false // 总开关：关闭即全静默
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return true // 未分类不受限
  const cats = normalizeNotifyCategories(cfg.notifyCategories)
  return cats[category] !== false
}

/**
 * 「同一个版本只提醒一次」的判定（纯函数，不改动入参）。
 * @param {{launcher?: string, dsh?: string}} store 已提醒过的版本记账
 * @param {'launcher'|'dsh'} key 记账位
 * @param {string} version 触发提醒的版本号
 * @returns {{claimed: boolean, store: {launcher: string, dsh: string}}}
 *          claimed=true 表示应该提醒，调用方把返回的 store 写回配置持久化。
 */
function claimVersionNotice(store, key, version) {
  const field = VERSION_FIELDS[key]
  const current = {
    launcher: normalizeVersionField(store && store.launcher),
    dsh: normalizeVersionField(store && store.dsh),
  }
  const v = normalizeVersionField(version).trim()
  if (!field || !v) return { claimed: false, store: current } // 没有版本号无从去重：不认领
  if (current[key] === v) return { claimed: false, store: current }
  current[key] = v
  return { claimed: true, store: current }
}

module.exports = {
  CATEGORIES,
  VERSION_FIELDS,
  defaultCategories,
  normalizeNotifyCategories,
  normalizeVersionField,
  categoryEnabled,
  claimVersionNotice,
}