// health.js — 健康快照（last-known-good）与启动失败回退（借鉴 dsh-desktop 的 profile-checkpoint.ts）
// 语义：
//  - 只有"健康启动"（服务 owned 且就绪 + 页面加载成功 / 存活 120s）才 captureHealthy()；
//  - 快照 = 主配置全量拷贝 + **声明的 DSH 侧状态文件**（可选的 extraFiles）+ meta.json（逐文件 sha256/size），
//    三槽轮转；
//  - 写入全部原子（临时文件 + rename）；读取校验 sha256/size，拒收符号链接/损坏槽；
//  - 恢复 = 备份当前文件为 <name>.broken-<ts> → 原子写回快照内容；
//    恢复前先持久化 skip marker：下一次健康启动只消费标记、不覆盖快照（防"刚回退的未验证状态"入槽）；
//  - 每个 extra 文件可带 validate()：回退前置校验不通过就**跳过该文件并说明原因**（fail-closed，
//    宁可少恢复一个文件，也不制造出"声明了但没装"这类新的启动失败）；
//  - shouldRecover 是纯决策函数：错误文本不参与决策（只依赖 连续失败次数 + 是否存在不同快照）。
//
// 为什么要有 extraFiles：实测的崩溃循环里，坏掉的是 ~/.dsh/settings.yaml 与 profile 的
// cordis.patch.yml / package.json，而 主配置（~/.dsh/dshl/config.json）从头到尾没变过。
// 只快照主配置时，pickRestoreTarget 会因为"当前 == 最新快照"而返回 null —— 自动回退永远不会发生，
// 却把当次运行唯一的一次恢复额度记成"已用过"。extraFiles 就是为了让这条路径真的能命中。
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const SLOT_IDS = ['slot-1', 'slot-2', 'slot-3']
const META_VERSION = 1
const META_MAX_BYTES = 64 * 1024
const CONFIG_MAX_BYTES = 1 * 1024 * 1024
const EXTRA_MAX_BYTES = 1 * 1024 * 1024
const EXTRA_DIR = 'files'
const SKIP_MARKER_VERSION = 1
const BROKEN_KEEP = 3
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

let configPath = ''
let snapshotDir = ''
let logRef = () => {}
let extraFiles = [] // 归一化后的 [{ id, path, maxBytes, validate }]

function initHealth({ configPath: cp, snapshotDir: sd, extraFiles: extras, log } = {}) {
  if (!cp || !sd) return
  configPath = cp
  snapshotDir = sd
  logRef = log || (() => {})
  extraFiles = normalizeExtras(extras)
  try { fs.mkdirSync(snapshotDir, { recursive: true }) } catch { /* noop */ }
}

/** 只接受形状正确的 extra 声明；id 必须能安全当文件名用。 */
function normalizeExtras(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const id = String(raw.id || '')
    const p = String(raw.path || '')
    if (!/^[A-Za-z0-9_.-]{1,40}$/u.test(id) || !p || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      path: p,
      maxBytes: Number.isSafeInteger(raw.maxBytes) && raw.maxBytes > 0 ? raw.maxBytes : EXTRA_MAX_BYTES,
      validate: typeof raw.validate === 'function' ? raw.validate : null,
    })
  }
  return out
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

function snapshotExtraPath(slotId, id) {
  return path.join(slotDir(slotId), EXTRA_DIR, id)
}

function skipMarkerPath() {
  return path.join(snapshotDir, 'skip-next-healthy.json')
}

/** meta.extras 只做形状校验；旧槽（没有这个字段）一律当成空数组。 */
function readExtrasFromMeta(meta) {
  if (!Array.isArray(meta.extras)) return []
  const out = []
  for (const raw of meta.extras) {
    if (!raw || typeof raw !== 'object') continue
    if (typeof raw.id !== 'string' || !raw.id) continue
    const present = raw.present === true
    const entry = { id: raw.id, present }
    if (present) {
      if (typeof raw.sha256 !== 'string' || !Number.isSafeInteger(raw.size) || raw.size < 0) continue
      entry.sha256 = raw.sha256
      entry.size = raw.size
    } else if (typeof raw.skipped === 'string' && raw.skipped) {
      entry.skipped = raw.skipped.slice(0, 64)
    }
    out.push(entry)
  }
  return out
}

function readMeta(slotId) {
  const meta = readJsonChecked(metaPath(slotId), META_MAX_BYTES)
  if (meta === undefined) return undefined
  if (meta.version !== META_VERSION || meta.slotId !== slotId || typeof meta.capturedAt !== 'string'
    || typeof meta.sha256 !== 'string' || !Number.isSafeInteger(meta.size) || meta.size < 0) {
    throw new Error(`invalid health manifest: ${slotId}`)
  }
  meta.extras = readExtrasFromMeta(meta)
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

/** 读一个槽里的 extra 文件内容并校验；缺失/不安全/校验不过都抛错（调用方决定是跳过还是放弃）。 */
function readSnapshotExtra(slotId, entry) {
  const p = snapshotExtraPath(slotId, entry.id)
  const st = lstatOptional(p)
  if (st === undefined) throw new Error(`snapshot extra is missing: ${entry.id}`)
  if (st.isSymbolicLink() || !st.isFile() || st.size !== entry.size) {
    throw new Error(`unsafe or mismatched snapshot extra: ${entry.id}`)
  }
  const bytes = fs.readFileSync(p)
  if (sha256(bytes) !== entry.sha256) throw new Error(`snapshot extra checksum mismatch: ${entry.id}`)
  return bytes
}

// 恢复槽目录的孤儿（rename 一半时崩溃留下 .old-*）：槽位缺失时优先补回最新的。
// 注意：孤儿目录名里的 UUID 是随机的，按名字排序毫无意义——必须按目录 mtime 取最新。
function recoverOrphanSlot(slotId) {
  if (fs.existsSync(slotDir(slotId))) return
  let names = []
  try { names = fs.readdirSync(snapshotDir).filter((n) => n.startsWith(`${slotId}.old-`)) } catch { return }
  const candidates = []
  for (const name of names) {
    const p = path.join(snapshotDir, name)
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
      candidates.push({ p, mtime: st.mtimeMs })
    } catch { /* 跳过不可读项 */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime) // 最新在前
  for (const c of candidates) {
    try { fs.renameSync(c.p, slotDir(slotId)); return } catch { /* 下一个 */ }
  }
}

// 完整列出三槽（损坏槽安全报告，不弹错）
function listSlots() {
  const out = []
  const nowShas = currentExtraShas() // 一次调用只读一遍磁盘：drift 判定会被三个槽各问一次
  for (const slotId of SLOT_IDS) {
    recoverOrphanSlot(slotId)
    const entry = { slotId, exists: false, valid: false, meta: undefined, configSha: '', extrasChanged: [] }
    try {
      const snap = readSnapshotConfig(slotId)
      if (snap) {
        entry.exists = true
        entry.valid = true
        entry.meta = snap.meta
        entry.configSha = snap.meta.sha256
        entry.extrasChanged = extraDrift(snap.meta, nowShas)
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
    // restoredSha：恢复当时写回的配置哈希。只有当前配置仍等于它（即"刚恢复的配置一直没被改过"）
    // 才跳过捕获；用户之后又改过配置时，标记失效并正常捕获新快照。
    if (v.restoredSha !== undefined && typeof v.restoredSha !== 'string') throw new Error('invalid skip marker sha')
    return v
  } catch { return undefined }
}

/** 读一个 extra 的当前内容；不存在/不安全/超限都返回 undefined（调用方按"缺失"处理）。 */
function readCurrentExtra(entry) {
  try {
    const st = lstatOptional(entry.path)
    if (st === undefined) return { present: false }
    if (st.isSymbolicLink() || !st.isFile()) return { present: false, skipped: 'not-a-regular-file' }
    if (st.size > entry.maxBytes) return { present: false, skipped: 'too-large' }
    return { present: true, bytes: fs.readFileSync(entry.path) }
  } catch {
    return { present: false, skipped: 'unreadable' }
  }
}

/** 当前 extra 文件的 sha（缺失返回 ''）。 */
function currentExtraShas() {
  const out = {}
  for (const e of extraFiles) {
    const cur = readCurrentExtra(e)
    out[e.id] = cur.present ? sha256(cur.bytes) : ''
  }
  return out
}

/**
 * 槽内的 extra 与当前磁盘比，哪些不一致（用于"当前配置没变但 DSH 侧状态变了"的判定与展示）。
 * @param {object} metaArg 已归一化的 meta（含 extras）
 * @param {Record<string,string>} [nowShas] 当前各 extra 的 sha；不传则现读一遍
 * @returns {string[]} 变化的 extra id 列表
 */
function extraDrift(metaArg, nowShas) {
  if (!extraFiles.length) return []
  const entries = Array.isArray(metaArg && metaArg.extras) ? metaArg.extras : []
  if (!entries.length) return []
  const now = nowShas || currentExtraShas()
  const changed = []
  for (const entry of entries) {
    if (!entry.present) continue // 当时就没这个文件：不参与比较
    if (now[entry.id] !== entry.sha256) changed.push(entry.id)
  }
  return changed
}

/** 对外导出：某个槽的 extra 漂移（槽不存在或读不出时返回空数组）。 */
function extraDriftOfSlot(slotId) {
  try {
    const meta = readMeta(slotId)
    if (meta === undefined) return []
    return extraDrift(meta)
  } catch { return [] }
}

/**
 * 健康启动快照。存在**仍然适用**的 skip marker 时只消费标记（不覆盖快照）。
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
    const currentSha = sha256(fs.readFileSync(configPath))
    if (skip.restoredSha && currentSha !== skip.restoredSha) {
      // 恢复后又改过配置：标记失效，删掉它并继续正常捕获
      try { fs.unlinkSync(skipMarkerPath()) } catch { /* noop */ }
      info(`health: skip marker stale (config changed since restore of ${skip.restoredSlotId}), capturing instead`)
    } else {
      try { fs.unlinkSync(skipMarkerPath()) } catch { /* noop */ }
      info(`health: skip marker consumed (restored slot ${skip.restoredSlotId})`)
      return { status: 'skipped', restoredSlotId: skip.restoredSlotId }
    }
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
    const extrasMeta = []
    for (const e of extraFiles) {
      const cur = readCurrentExtra(e)
      if (!cur.present) {
        // 文件当时不存在（或不可安全读取）：记为 present=false。恢复时**不会**去创建/删除它。
        extrasMeta.push({ id: e.id, present: false, ...(cur.skipped ? { skipped: cur.skipped } : {}) })
        if (cur.skipped) info(`health: extra ${e.id} not captured (${cur.skipped})`)
        continue
      }
      writeDurable(path.join(staging, EXTRA_DIR, e.id), cur.bytes)
      extrasMeta.push({ id: e.id, present: true, sha256: sha256(cur.bytes), size: cur.bytes.byteLength })
    }
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
      extras: extrasMeta,
    })
    replaceSlot(target.slotId, staging)
    created.ok = true
    info(`health: captured slot ${target.slotId} (${capturedAt}, ${configBytes.byteLength}B, extras=${extrasMeta.filter((x) => x.present).length}/${extraFiles.length}, reason=${meta.reason || 'healthy-startup'})`)
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
 * 选择要恢复的槽。语义：只有当"最新有效快照 ≠ 当前状态"（当前状态尚未被健康捕获，
 * 即最近改动后从未正常启动）时才回退到最新的已知良好状态；若最新快照与当前一致，
 * 说明当前状态本身就是 known-good，返回 null。
 *
 * "≠ 当前状态"包含两部分：主配置哈希不同，**或**任一 extra 文件与快照不同。
 * 只看主配置时，settings.yaml / cordis.patch.yml 坏掉但主配置没动过的场景永远选不出目标
 * ——那正是实测里最常见的崩溃循环。
 *
 * excludeSlotId 用于排除本次会话已恢复过的槽（避免来回切换）。
 */
function pickRestoreTarget(currentSha, excludeSlotId) {
  const valid = listSlots().filter((s) => s.valid && s.slotId !== excludeSlotId)
  if (!valid.length) return null
  valid.sort((a, b) => (Date.parse(b.meta.capturedAt) || 0) - (Date.parse(a.meta.capturedAt) || 0))
  const newest = valid[0]
  const configSame = !!(currentSha && newest.configSha === currentSha)
  const extrasSame = (newest.extrasChanged || []).length === 0
  if (configSame && extrasSame) return null
  return newest.slotId
}

/** 备份一个文件到 <name>.broken-<ts>，并保留最近 BROKEN_KEEP 份。失败返回 ''。 */
function backupBroken(filePath, stamp) {
  try {
    const cur = lstatOptional(filePath)
    if (cur === undefined || !cur.isFile() || cur.isSymbolicLink()) return ''
    const backupPath = `${filePath}.broken-${stamp}-${crypto.randomUUID().slice(0, 8)}`
    writeDurable(backupPath, fs.readFileSync(filePath))
    pruneBrokenBackups(filePath, backupPath)
    return backupPath
  } catch {
    return ''
  }
}

/**
 * 恢复一个槽：先持久化 skip marker，再备份当前文件，最后原子写回快照内容。
 * extra 文件逐个走可选的 validate()：不通过就跳过并给出原因（绝不为了"恢复完整"而制造新的启动失败）。
 * @returns {{status:'restored', slotId, backupPath, extras: Array<{id,status,backupPath?,reason?}>}
 *          | {status:'noop', slotId}}
 */
function restore(slotId) {
  if (!SLOT_IDS.includes(slotId)) throw new Error(`invalid restore slot: ${slotId}`)
  const snap = readSnapshotConfig(slotId)
  if (snap === undefined) return { status: 'noop', slotId }
  const restoredAt = new Date().toISOString()
  const stamp = restoredAt.replace(/[:T]/g, '-').slice(0, 19)
  // 快照内容先读出来并校验（防恢复期间快照被改）。校验必须在写 skip marker 之前：
  // 否则校验失败会留下一个"白吃一次快照刷新"的标记。
  const bytes = fs.readFileSync(snapshotConfigPath(slotId))
  if (sha256(bytes) !== snap.meta.sha256) throw new Error(`checkpoint changed during restore: ${slotId}`)
  // extra 也在动手之前全部读出来校验：半读半写比不回退更糟
  const extraPlan = []
  for (const entry of snap.meta.extras) {
    if (!entry.present) continue
    let extraBytes
    try {
      extraBytes = readSnapshotExtra(slotId, entry)
    } catch (e) {
      extraPlan.push({ id: entry.id, status: 'skipped', reason: '快照里的该文件已损坏：' + ((e && e.message) || String(e)) })
      continue
    }
    extraPlan.push({ id: entry.id, status: 'ready', bytes: extraBytes })
  }
  const restoredSha = sha256(bytes)
  // 持久化 skip marker：记录写回的配置哈希，仅当配置仍等于它时才跳过下次捕获（先写后改，崩溃中途也安全）
  writeJsonChecked(skipMarkerPath(), { version: SKIP_MARKER_VERSION, restoredSlotId: slotId, restoredAt, restoredSha })
  // 备份当前配置（保留最近 BROKEN_KEEP 份）
  const backupPath = `${configPath}.broken-${stamp}-${crypto.randomUUID().slice(0, 8)}.json`
  const cur = lstatOptional(configPath)
  if (cur !== undefined && cur.isFile() && !cur.isSymbolicLink()) {
    writeDurable(backupPath, fs.readFileSync(configPath))
    pruneBrokenBackups(configPath, backupPath)
  }
  // 原子写回快照配置
  writeDurable(configPath, bytes)
  info(`health: restored slot ${slotId} (${restoredAt}), backup=${path.basename(backupPath)}`)

  const extras = []
  for (const plan of extraPlan) {
    const decl = extraFiles.find((e) => e.id === plan.id)
    if (plan.status !== 'ready') { extras.push({ id: plan.id, status: 'skipped', reason: plan.reason }); continue }
    if (!decl) {
      // 快照里有、当前版本已不再管理的 extra：不猜路径，明确跳过
      extras.push({ id: plan.id, status: 'skipped', reason: '该文件已不在当前版本的管理范围内' })
      continue
    }
    if (decl.validate) {
      let verdict
      try {
        verdict = decl.validate({ snapshotBytes: plan.bytes, currentPath: decl.path }) || { ok: true }
      } catch (e) {
        verdict = { ok: false, reason: '前置校验抛错：' + ((e && e.message) || String(e)) }
      }
      if (!verdict.ok) {
        info(`health: extra ${plan.id} restore skipped (${verdict.reason || 'validate failed'})`)
        extras.push({ id: plan.id, status: 'skipped', reason: verdict.reason || '前置校验未通过' })
        continue
      }
    }
    try {
      const fileBackup = backupBroken(decl.path, stamp)
      writeDurable(decl.path, plan.bytes)
      info(`health: extra ${plan.id} restored (backup=${fileBackup ? path.basename(fileBackup) : '无（原文件不存在）'})`)
      extras.push({ id: plan.id, status: 'restored', backupPath: fileBackup })
    } catch (e) {
      extras.push({ id: plan.id, status: 'failed', reason: (e && e.message) || String(e) })
    }
  }
  return { status: 'restored', slotId, backupPath, extras }
}

function pruneBrokenBackups(filePath, keepPath) {
  try {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    // 真实文件名形如 config.json.broken-<时间戳>.json —— 正则必须按 basename 前缀匹配，
    // 此前写成 /^config\.broken-/ 永不命中，BROKEN_KEEP 形同虚设。
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.broken-.*$`)
    const names = fs.readdirSync(dir).filter((n) => re.test(n) && path.join(dir, n) !== keepPath).sort() // 时间戳升序 = 最旧在前
    while (names.length > BROKEN_KEEP - 1) {
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
  extraDriftOfSlot,
  sha256,
  EXTRA_MAX_BYTES,
}
