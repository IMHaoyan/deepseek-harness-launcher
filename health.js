// health.js — 健康快照（last-known-good）与启动失败回退（借鉴 dsh-desktop 的 profile-checkpoint.ts）
// 语义：
//  - 只有"健康启动"（服务 owned 且就绪 + 页面加载成功 / 存活 120s）才 captureHealthy()；
//  - 快照 = config.json 全量拷贝 + meta.json（sha256/size/时间/DSH 版本等），三槽轮转；
//  - 写入全部原子（临时文件 + rename）；读取校验 sha256/size，拒收符号链接/损坏槽；
//  - 恢复 = 备份当前配置为 config.broken-<ts>.json → 原子写回快照配置；
//    恢复前先持久化 skip marker：下一次健康启动只消费标记、不覆盖快照（防"刚回退的未验证状态"入槽）；
//  - shouldRecover 是纯决策函数：错误文本不参与决策（只依赖 连续失败次数 + 是否存在不同快照）。
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SLOT_IDS = ['slot-1', 'slot-2', 'slot-3']
const META_VERSION = 1
const META_MAX_BYTES = 64 * 1024
const CONFIG_MAX_BYTES = 1 * 1024 * 1024
const SKIP_MARKER_VERSION = 1
const BROKEN_KEEP = 3
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

let configPath = ''
let snapshotDir = ''
let logRef = () => {}

function initHealth({ configPath: cp, snapshotDir: sd, log } = {}) {
  if (!cp || !sd) return
  configPath = cp
  snapshotDir = sd
  logRef = log || (() => {})
  try { fs.mkdirSync(snapshotDir, { recursive: true }) } catch { /* noop */ }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function info(message) {
  try { logRef(message) } catch { /* noop */ }
}

// 原子写入：临时文件 + rename（+ fsync best effort）
function writeDurable(file, bytes, mode = PRIVATE_FILE_MODE) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE })
  const dirStat = fs.lstatSync(path.dirname(file))
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('health snapshot directory is not a real directory')
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, 'wx', mode)
    fs.writeSync(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* noop */ } }
    try { fs.unlinkSync(tmp) } catch { /* 已 rename */ }
  }
}

function lstatOptional(p) {
  try { return fs.lstatSync(p) } catch (e) { if (e && e.code === 'ENOENT') return undefined; throw e }
}

function readJsonChecked(file, maxBytes) {
  const st = lstatOptional(file)
  if (st === undefined) return undefined
  if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) throw new Error(`unsafe or oversized health file: ${file}`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`corrupt health file: ${file}`)
  }
}

function writeJsonChecked(file, value) {
  writeDurable(file, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
}

function slotDir(slotId) {
  return path.join(snapshotDir, slotId)
}

function metaPath(slotId) {
  return path.join(slotDir(slotId), 'meta.json')
}

function snapshotConfigPath(slotId) {
  return path.join(slotDir(slotId), 'config.json')
}

function skipMarkerPath() {
  return path.join(snapshotDir, 'skip-next-healthy.json')
}

function readMeta(slotId) {
  const meta = readJsonChecked(metaPath(slotId), META_MAX_BYTES)
  if (meta === undefined) return undefined
  if (meta.version !== META_VERSION || meta.slotId !== slotId || typeof meta.capturedAt !== 'string'
    || typeof meta.sha256 !== 'string' || !Number.isSafeInteger(meta.size) || meta.size < 0) {
    throw new Error(`invalid health manifest: ${slotId}`)
  }
  return meta
}

function readSnapshotConfig(slotId) {
  const meta = readMeta(slotId)
  if (meta === undefined) return undefined
  const cfgPath = snapshotConfigPath(slotId)
  const st = lstatOptional(cfgPath)
  if (st === undefined) return undefined
  if (st.isSymbolicLink() || !st.isFile() || st.size !== meta.size || st.size > CONFIG_MAX_BYTES) {
    throw new Error(`unsafe or mismatched snapshot config: ${slotId}`)
  }
  const bytes = fs.readFileSync(cfgPath)
  if (sha256(bytes) !== meta.sha256) throw new Error(`snapshot config checksum mismatch: ${slotId}`)
  return { meta, bytes }
}

// 恢复槽目录的孤儿（rename 一半时崩溃留下 .old-*）：槽位缺失时优先补回最新的
function recoverOrphanSlot(slotId) {
  if (fs.existsSync(slotDir(slotId))) return
  let names = []
  try { names = fs.readdirSync(snapshotDir).filter((n) => n.startsWith(`${slotId}.old-`)).sort().reverse() } catch { return }
  for (const name of names) {
    const candidate = path.join(snapshotDir, name)
    try {
      const st = fs.lstatSync(candidate)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
      fs.renameSync(candidate, slotDir(slotId))
      return
    } catch { /* 下一个 */ }
  }
}

// 完整列出三槽（损坏槽安全报告，不弹错）
function listSlots() {
  const out = []
  for (const slotId of SLOT_IDS) {
    recoverOrphanSlot(slotId)
    const entry = { slotId, exists: false, valid: false, meta: undefined, configSha: '' }
    try {
      const snap = readSnapshotConfig(slotId)
      if (snap) {
        entry.exists = true
        entry.valid = true
        entry.meta = snap.meta
        entry.configSha = snap.meta.sha256
      } else if (readMeta(slotId) !== undefined) {
        entry.exists = true // meta 在但 config 缺失（写入中断）→ 无效槽
      }
    } catch { /* 损坏槽：无效 */ }
    out.push(entry)
  }
  return out
}

function readSkipMarker() {
  try {
    const v = readJsonChecked(skipMarkerPath(), 4096)
    if (v === undefined) return undefined
    if (v.version !== SKIP_MARKER_VERSION || typeof v.restoredSlotId !== 'string' || typeof v.restoredAt !== 'string') {
      throw new Error('invalid skip marker')
    }
    return v
  } catch { return undefined }
}

/**
 * 健康启动快照。存在 skip marker 时只消费标记（不覆盖快照）。
 * @param {{dshlVersion, dshKind, dshVersion, nodeVersion, port, reason}} meta
 */
function captureHealthy(meta = {}) {
  const cfgSt = lstatOptional(configPath)
  if (cfgSt === undefined) throw new Error('config file is unavailable for health snapshot')
  if (cfgSt.isSymbolicLink() || !cfgSt.isFile() || cfgSt.size > CONFIG_MAX_BYTES) {
    throw new Error('config file is unsafe for health snapshot')
  }
  const skip = readSkipMarker()
  if (skip !== undefined) {
    try { fs.unlinkSync(skipMarkerPath()) } catch { /* noop */ }
    info(`health: skip marker consumed (restored slot ${skip.restoredSlotId})`)
    return { status: 'skipped', restoredSlotId: skip.restoredSlotId }
  }
  const configBytes = fs.readFileSync(configPath)
  const snapshotId = crypto.randomUUID()
  const capturedAt = new Date().toISOString()
  const slots = listSlots()
  const empty = slots.find((s) => !s.exists)
  const target = empty ?? [...slots].sort((a, b) => {
    const ta = a.meta ? Date.parse(a.meta.capturedAt) || 0 : 0
    const tb = b.meta ? Date.parse(b.meta.capturedAt) || 0 : 0
    return ta - tb
  })[0]
  if (target === undefined) throw new Error('no health snapshot slot available')
  const staging = path.join(snapshotDir, `.staging-${target.slotId}-${process.pid}-${crypto.randomUUID()}`)
  const created = { ok: false }
  try {
    fs.mkdirSync(staging, { recursive: true, mode: PRIVATE_DIR_MODE })
    writeDurable(path.join(staging, 'config.json'), configBytes)
    writeJsonChecked(path.join(staging, 'meta.json'), {
      version: META_VERSION,
      snapshotId,
      slotId: target.slotId,
      capturedAt,
      reason: String(meta.reason || 'healthy-startup').slice(0, 64),
      dshlVersion: String(meta.dshlVersion || '').slice(0, 64),
      dshKind: String(meta.dshKind || '').slice(0, 64),
      dshVersion: String(meta.dshVersion || '').slice(0, 64),
      nodeVersion: String(meta.nodeVersion || '').slice(0, 64),
      port: Number.isInteger(meta.port) ? meta.port : 0,
      sha256: sha256(configBytes),
      size: configBytes.byteLength,
    })
    replaceSlot(target.slotId, staging)
    created.ok = true
    info(`health: captured slot ${target.slotId} (${capturedAt}, ${configBytes.byteLength}B, reason=${meta.reason || 'healthy-startup'})`)
    return { status: 'captured', slotId: target.slotId }
  } finally {
    if (!created.ok) { try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* noop */ } }
  }
}

function replaceSlot(slotId, staging) {
  const target = slotDir(slotId)
  if (!fs.existsSync(target)) {
    fs.renameSync(staging, target)
    return
  }
  const old = `${target}.old-${crypto.randomUUID()}`
  fs.renameSync(target, old)
  try {
    fs.renameSync(staging, target)
  } catch (e) {
    try { fs.renameSync(old, target) } catch { /* noop */ }
    throw e
  }
  try { fs.rmSync(old, { recursive: true, force: true }) } catch { /* noop */ }
}

/** 当前配置 sha256（用于决策"是否有不同快照"）。失败返回 ''。 */
function configHash() {
  try {
    const st = lstatOptional(configPath)
    if (st === undefined || st.isSymbolicLink() || !st.isFile()) return ''
    return sha256(fs.readFileSync(configPath))
  } catch { return '' }
}

/**
 * 选择要恢复的槽。语义：只有当"最新有效快照 ≠ 当前配置"（当前配置尚未被健康捕获，即最近改动后从未正常启动）
 * 时才回退到最新的已知良好配置；若最新快照与当前一致，说明当前配置本身就是 known-good，返回 null。
 * excludeSlotId 用于排除本次会话已恢复过的槽（避免来回切换）。
 */
function pickRestoreTarget(currentSha, excludeSlotId) {
  const valid = listSlots().filter((s) => s.valid && s.slotId !== excludeSlotId)
  if (!valid.length) return null
  valid.sort((a, b) => (Date.parse(b.meta.capturedAt) || 0) - (Date.parse(a.meta.capturedAt) || 0))
  const newest = valid[0]
  if (currentSha && newest.configSha === currentSha) return null
  return newest.slotId
}

/**
 * 恢复一个槽：先持久化 skip marker，再备份当前配置，最后原子写回快照配置。
 * @returns {{status:'restored', slotId, backupPath} | {status:'noop', slotId}}
 */
function restore(slotId) {
  if (!SLOT_IDS.includes(slotId)) throw new Error(`invalid restore slot: ${slotId}`)
  const snap = readSnapshotConfig(slotId)
  if (snap === undefined) return { status: 'noop', slotId }
  const restoredAt = new Date().toISOString()
  // 先持久化 skip marker：恢复后下一次健康启动不覆盖检查点（先写后改，崩溃中途也安全）
  writeJsonChecked(skipMarkerPath(), { version: SKIP_MARKER_VERSION, restoredSlotId: slotId, restoredAt })
  // 备份当前配置（保留最近 BROKEN_KEEP 份）
  const backupPath = `${configPath}.broken-${restoredAt.replace(/[:T]/g, '-').slice(0, 19)}.json`
  const cur = lstatOptional(configPath)
  if (cur !== undefined && cur.isFile() && !cur.isSymbolicLink()) {
    writeDurable(backupPath, fs.readFileSync(configPath))
    pruneBrokenBackups()
  }
  // 原子写回快照配置（再校验一次，防恢复期间快照被改）
  const bytes = fs.readFileSync(snapshotConfigPath(slotId))
  if (sha256(bytes) !== snap.meta.sha256) throw new Error(`checkpoint changed during restore: ${slotId}`)
  writeDurable(configPath, bytes)
  info(`health: restored slot ${slotId} (${restoredAt}), backup=${path.basename(backupPath)}`)
  return { status: 'restored', slotId, backupPath }
}

function pruneBrokenBackups() {
  try {
    const dir = path.dirname(configPath)
    const names = fs.readdirSync(dir)
      .filter((n) => /^config\.broken-.*\.json$/.test(n))
      .sort()
    while (names.length > BROKEN_KEEP) {
      const oldest = names.shift()
      try { fs.unlinkSync(path.join(dir, oldest)) } catch { /* noop */ }
    }
  } catch { /* noop */ }
}

/** 纯决策函数：连续失败次数达到上限且存在不同快照才回退。 */
function shouldRecover(attempts, hasDifferentSnapshot) {
  return Number.isInteger(attempts) && attempts >= 5 && hasDifferentSnapshot === true
}

module.exports = {
  initHealth,
  captureHealthy,
  listSlots,
  pickRestoreTarget,
  restore,
  shouldRecover,
  configHash,
  sha256,
}
