// plugin-switch.js — install-independent plugin enable/disable for DSH web profile.
//
// DSH composes a profile from bundle layers + the user patch layer
// (<profile>/cordis.patch.yml). A top-level row
//
//   - id: <loader row id>
//     disabled: true
//
// stops that loader entry, and `disabled: false` force-enables a row that a
// lower layer disabled. The web profile uses patchReload: live, so the running
// DSH applies the change through its own watcher. This is the same durable
// mechanism dshmarket / dsh-plugin-hub use, not a DSHL-only state file.
'use strict'

const fs = require('fs')
const path = require('path')

const PROFILE_NAME = 'web'
const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/u
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

let HOME = ''
let logFn = () => {}

function initPluginSwitch(opts = {}) {
  HOME = opts.home || ''
  logFn = opts.log || (() => {})
}

function log(message) {
  try { logFn('[plugin-switch] ' + message) } catch { /* noop */ }
}

function profileDir() {
  return path.join(HOME, 'profiles', PROFILE_NAME)
}

function defaultPatchPath() {
  return path.join(profileDir(), 'cordis.patch.yml')
}

function marketStatePath() {
  return path.join(profileDir(), '.dsh-market', 'state.json')
}

function profileManifestPath() {
  return path.join(profileDir(), 'package.json')
}

/**
 * Row ids inserted by one bundle patch. Mirrors the DSH ecosystem's
 * insertedIds rule: only rows nested under `insert:` belong to the package;
 * a top-level `- id: X` + `disabled: true` row targets ANOTHER plugin and
 * is recorded as a carrier side effect rather than a package-owned row.
 */
function parsePatchRows(text) {
  const names = []
  const ids = []
  const insertedIds = []
  const foreignDisables = []
  const lines = String(text || '').split(/\r?\n/u)
  let insertIndent = null
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = raw.replace(/#.*$/u, '')
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (insertIndent !== null && indent <= insertIndent && !/^\s*-?\s*(id|name|config):/u.test(line)) {
      insertIndent = null
    }
    if (/^\s*-?\s*insert:\s*$/u.test(line)) {
      insertIndent = indent
      continue
    }
    const name = /^\s*-?\s*name:\s*['"]?([^'"\s]+)/u.exec(line)
    if (name !== null && !names.includes(name[1])) names.push(name[1])
    const id = /^\s*-?\s*id:\s*['"]?([^'"\s]+)/u.exec(line)
    if (id !== null) {
      if (!ids.includes(id[1])) ids.push(id[1])
      if (insertIndent !== null && indent > insertIndent) {
        if (!insertedIds.includes(id[1])) insertedIds.push(id[1])
      } else if (indent <= (insertIndent ?? -1)) {
        insertIndent = null
      }
      if (indent === 0) {
        let next = ''
        for (let probe = index + 1; probe < lines.length; probe += 1) {
          const candidate = lines[probe].replace(/#.*$/u, '')
          if (candidate.trim() === '') continue
          next = candidate
          break
        }
        if (/^\s+disabled:\s*true\s*$/u.test(next) && !foreignDisables.includes(id[1])) foreignDisables.push(id[1])
      }
    }
  }
  return { names, ids, insertedIds, foreignDisables: foreignDisables.filter((id) => !insertedIds.includes(id)) }
}

/** Line-wise scan of the user patch layer; enough to read DSHL toggle rows. */
function readPatchState(patchPath = defaultPatchPath()) {
  const disables = []
  const forced = []
  const inserts = []
  let text = ''
  try { text = fs.readFileSync(patchPath, 'utf8') } catch { /* no patch file */ }
  const lines = text.split(/\r?\n/u)
  let inInsert = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^- insert:\s*$/u.test(line)) {
      inInsert = true
      continue
    }
    if (/^- /u.test(line)) inInsert = false
    if (inInsert) {
      const insertRow = /^ {4}- id: ([A-Za-z0-9_.-]+)/u.exec(line)
      if (insertRow !== null) inserts.push(insertRow[1])
      continue
    }
    const disableRow = /^- id: ['"]?([A-Za-z0-9_.-]+)['"]?\s*$/u.exec(line)
    if (disableRow === null) continue
    const next = lines[index + 1] ?? ''
    if (/^ {2}disabled: true\s*$/u.test(next)) disables.push(disableRow[1])
    else if (/^ {2}disabled: false\s*$/u.test(next)) forced.push(disableRow[1])
  }
  return { disables, forced, inserts }
}

function packagePatchFiles(packageName, explicitProfileDir = '') {
  const name = String(packageName || '')
  if (!name || !PACKAGE_NAME_RE.test(name)) return []
  const dir = explicitProfileDir || profileDir()
  const packageDir = path.join(dir, 'node_modules', name)
  const files = []
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    const declared = manifest && manifest.dsh && manifest.dsh.bundle ? manifest.dsh.bundle.patch : ''
    if (typeof declared === 'string' && declared !== '') {
      const patchFile = path.resolve(packageDir, declared)
      const rel = path.relative(packageDir, patchFile)
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) files.push(patchFile)
    }
  } catch { /* package not installed or manifest unreadable */ }
  files.push(path.join(packageDir, 'cordis.patch.yml'))
  return files
}

/** The loader row ids one installed package owns. */
function rowIdsForPackage(packageName, explicitProfileDir = '') {
  const ids = new Set()
  for (const file of packagePatchFiles(packageName, explicitProfileDir)) {
    try {
      for (const id of parsePatchRows(fs.readFileSync(file, 'utf8')).insertedIds) ids.add(id)
    } catch { /* patch unreadable */ }
  }
  return [...ids].filter((id) => ROW_ID_RE.test(id))
}

/** Top-level `disabled: true` rows a bundle applies to OTHER plugins. */
function carrierDisableIds(packageName, explicitProfileDir = '') {
  const ids = new Set()
  for (const file of packagePatchFiles(packageName, explicitProfileDir)) {
    try {
      for (const id of parsePatchRows(fs.readFileSync(file, 'utf8')).foreignDisables) ids.add(id)
    } catch { /* patch unreadable */ }
  }
  return [...ids].filter((id) => ROW_ID_RE.test(id))
}

function readMarketDisabledState() {
  try {
    const state = JSON.parse(fs.readFileSync(marketStatePath(), 'utf8'))
    return { ok: true, disabled: new Set(Array.isArray(state.disabled) ? state.disabled.filter((item) => typeof item === 'string') : []) }
  } catch { return { ok: false, disabled: new Set() } }
}

function readMarketDisabled() {
  return readMarketDisabledState().disabled
}

function isMarketDisabled(packageName) {
  return readMarketDisabledState().disabled.has(packageName)
}

function bundleActive(packageName) {
  try {
    const manifest = JSON.parse(fs.readFileSync(profileManifestPath(), 'utf8'))
    const bundles = manifest && manifest.dsh && manifest.dsh.profile ? manifest.dsh.profile.bundles : []
    return Array.isArray(bundles) && bundles.includes(packageName)
  } catch { return false }
}

function canToggle(packageName, explicitProfileDir = '') {
  return rowIdsForPackage(packageName, explicitProfileDir).length > 0 || carrierDisableIds(packageName, explicitProfileDir).length > 0
}

/** Whether the package ships a client half whose UI needs a page refresh. */
function hasClientPart(packageName, explicitProfileDir = '') {
  const name = String(packageName || '')
  if (!name || !PACKAGE_NAME_RE.test(name)) return false
  const dir = explicitProfileDir || profileDir()
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8'))
    return !!(manifest && manifest.dsh && manifest.dsh.client !== undefined)
  } catch { return false }
}

function isDisabled(packageName, explicitProfileDir = '') {
  if (isMarketDisabled(packageName)) return true
  const rows = rowIdsForPackage(packageName, explicitProfileDir)
  if (!rows.length) return false
  if (!bundleActive(packageName)) return true
  const state = readPatchState(defaultPatchPath())
  return rows.some((id) => state.disables.includes(id))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function rowBlock(rowId, disabled) {
  return `- id: ${rowId}\n  disabled: ${disabled ? 'true' : 'false'}\n`
}

/** Put the empty-list placeholder back when the last toggle row is removed. */
function withPlaceholderRestored(text) {
  if (text.replace(/^[ \t]*#.*$/gmu, '').trim() !== '') return text
  const uncommented = text.replace(/^[ \t]*#[ \t]*\[[ \t]*\][ \t]*(?:\r?\n|$)/mu, '[]\n')
  if (uncommented !== text) return uncommented
  return text === '' || text.endsWith('\n') ? `${text}[]\n` : `${text}\n[]\n`
}

/**
 * Append one top-level patch entry. The DSH profile template ships `[]` as a
 * placeholder; appending after it would create two top-level YAML documents,
 * so the placeholder is commented out exactly once.
 */
function appendPatchEntry(patchPath, block) {
  let text = ''
  try { text = fs.readFileSync(patchPath, 'utf8') } catch { /* created below */ }
  const core = text.trim()
  if (core === '') {
    fs.writeFileSync(patchPath, block)
    return { ok: true, error: '' }
  }
  const withoutComments = text.replace(/^[ \t]*#.*$/gmu, '').trim()
  if (withoutComments === '') {
    const next = text.endsWith('\n') ? text : `${text}\n`
    fs.writeFileSync(patchPath, `${next}${block}`)
    return { ok: true, error: '' }
  }
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n')
    const next = commented.endsWith('\n') ? commented : `${commented}\n`
    fs.writeFileSync(patchPath, `${next}${block}`)
    return { ok: true, error: '' }
  }
  const contentLines = text.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  const lastContentLine = contentLines.pop() ?? ''
  if (/^[[{]/u.test(lastContentLine)) {
    return { ok: false, error: 'cordis.patch.yml 以顶层流式结构结尾，拒绝自动追加；请先整理为条目列表' }
  }
  const firstContentLine = contentLines.length ? contentLines[0] : lastContentLine
  if (!/^-/u.test(firstContentLine)) {
    return { ok: false, error: 'cordis.patch.yml 不是合法的顶层条目列表，拒绝自动追加' }
  }
  const next = text.endsWith('\n') ? text : `${text}\n`
  fs.writeFileSync(patchPath, `${next}${block}`)
  return { ok: true, error: '' }
}

function stripRows(patchPath, rowId) {
  let text = ''
  try { text = fs.readFileSync(patchPath, 'utf8') } catch { return }
  const blockRe = new RegExp(`^- id: ['"]?${escapeRegExp(rowId)}['"]?\\s*\\r?\\n[ \\t]+disabled: (?:true|false)\\s*\\r?\\n?`, 'mgu')
  const next = text.replace(blockRe, '')
  if (next !== text) fs.writeFileSync(patchPath, withPlaceholderRestored(next))
}

function stripForceRows(patchPath, rowId) {
  let text = ''
  try { text = fs.readFileSync(patchPath, 'utf8') } catch { return { ok: true, error: '' } }
  const blockRe = new RegExp(`^- id: ['"]?${escapeRegExp(rowId)}['"]?\\s*\\r?\\n[ \\t]+disabled: false\\s*\\r?\\n?`, 'mgu')
  const next = text.replace(blockRe, '')
  if (next !== text) fs.writeFileSync(patchPath, withPlaceholderRestored(next))
  return { ok: true, error: '' }
}

function disableRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, error: `行 id ${rowId} 含特殊字符，无法写入补丁层` }
  const state = readPatchState(patchPath)
  if (state.disables.includes(rowId)) return { ok: true, error: '' }
  stripRows(patchPath, rowId)
  const result = appendPatchEntry(patchPath, rowBlock(rowId, true))
  if (result.ok) log(`disabled ${rowId}`)
  return result
}

function enableRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, error: `行 id ${rowId} 含特殊字符，无法写入补丁层` }
  const state = readPatchState(patchPath)
  if (state.disables.includes(rowId)) {
    stripRows(patchPath, rowId)
    log(`enabled ${rowId}`)
    return { ok: true, error: '' }
  }
  if (state.forced.includes(rowId)) return { ok: true, error: '' }
  // The row is enabled by its bundle. A force row is only needed when the
  // user patch already has one; adding one unconditionally would turn every
  // normal on/off cycle into a permanent override.
  return { ok: true, error: '' }
}

/** Force a foreign row on, unless the user already disabled it explicitly. */
function forceEnableRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, error: `行 id ${rowId} 含特殊字符，无法写入补丁层` }
  const state = readPatchState(patchPath)
  if (state.disables.includes(rowId) || state.forced.includes(rowId)) return { ok: true, error: '' }
  stripRows(patchPath, rowId)
  const result = appendPatchEntry(patchPath, rowBlock(rowId, false))
  if (result.ok) log(`force-enabled ${rowId}`)
  return result
}

function persistDisabled(packageName, disabled) {
  const statePath = marketStatePath()
  const stateDir = path.dirname(statePath)
  const marketInstalled = fs.existsSync(path.join(profileDir(), 'node_modules', 'dshmarket', 'package.json'))
  if (!marketInstalled && !fs.existsSync(stateDir)) return
  let state = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed
  } catch { /* missing or malformed state: recreate the small shape below */ }
  const list = Array.isArray(state.disabled) ? state.disabled.filter((item) => typeof item === 'string') : []
  const next = disabled
    ? (list.includes(packageName) ? list : [...list, packageName])
    : list.filter((item) => item !== packageName)
  state.disabled = next
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(statePath, JSON.stringify(state))
}

/** Turn one installed bundle plugin on/off through the user patch layer. */
function setEnabled(packageName, enabled) {
  const rows = rowIdsForPackage(packageName)
  const carriers = carrierDisableIds(packageName)
  if (!rows.length && !carriers.length) return { ok: false, error: '无法识别该插件的加载项，未写入补丁层' }
  // 先记 durable 选择，再写 patch：中途崩溃时下次 reconcile 会按选择补全。
  persistDisabled(packageName, !enabled)
  const patchPath = defaultPatchPath()
  for (const rowId of rows) {
    const result = enabled ? enableRow(patchPath, rowId) : disableRow(patchPath, rowId)
    if (!result.ok) return result
  }
  for (const rowId of carriers) {
    const result = enabled ? stripForceRows(patchPath, rowId) : forceEnableRow(patchPath, rowId)
    if (!result.ok) return result
  }
  return { ok: true, rows, carriers }
}

/** Persist DSH market's enabled/disabled choices onto the patch layer for managed plugins. */
function reconcileDisabledPackages(packageNames = []) {
  const marketState = readMarketDisabledState()
  if (!marketState.ok) return { changed: false, names: [] }
  const disabled = marketState.disabled
  const names = []
  const patchPath = defaultPatchPath()
  for (const packageName of packageNames) {
    const rows = rowIdsForPackage(packageName)
    const carriers = carrierDisableIds(packageName)
    if (!rows.length && !carriers.length) continue
    const state = readPatchState(patchPath)
    if (disabled.has(packageName)) {
      const rowsOff = rows.length > 0 && rows.every((id) => state.disables.includes(id))
      const carriersOn = carriers.every((id) => state.forced.includes(id))
      if (rowsOff && carriersOn) continue
      const result = setEnabled(packageName, false)
      if (result.ok) names.push(packageName)
      continue
    }
    // Market says enabled: remove DSHL's old off/force rows so a carrier's
    // own foreign-disable patch takes effect again (e.g. re-enabling codex-ui).
    const rowsOff = rows.some((id) => state.disables.includes(id))
    const carriersForced = carriers.some((id) => state.forced.includes(id))
    if (!rowsOff && !carriersForced) continue
    let ok = true
    for (const rowId of rows) {
      const result = enableRow(patchPath, rowId)
      if (!result.ok) { ok = false; break }
    }
    if (ok) {
      for (const rowId of carriers) {
        const result = stripForceRows(patchPath, rowId)
        if (!result.ok) { ok = false; break }
      }
    }
    if (ok) names.push(packageName)
  }
  return { changed: names.length > 0, names }
}

/** Remove only stale carrier force-enable rows after a version change. */
function pruneCarrierForces(rowIds = []) {
  const rows = [...new Set((Array.isArray(rowIds) ? rowIds : []).filter((id) => ROW_ID_RE.test(id)))]
  if (rows.length) {
    const patchPath = defaultPatchPath()
    for (const rowId of rows) stripForceRows(patchPath, rowId)
  }
  return { ok: true, rows }
}

/** Remove exactly the supplied toggle rows (stale row ids after an update). */
function pruneRows(rowIds = []) {
  const rows = [...new Set((Array.isArray(rowIds) ? rowIds : []).filter((id) => ROW_ID_RE.test(id)))]
  if (rows.length) {
    const patchPath = defaultPatchPath()
    for (const rowId of rows) stripRows(patchPath, rowId)
  }
  return { ok: true, rows }
}

/** Remove all toggle rows for a package (uninstall / stale-id cleanup). */
function removeRows(packageName, previousRows = [], previousCarriers = []) {
  const rows = new Set([...(Array.isArray(previousRows) ? previousRows : []), ...rowIdsForPackage(packageName)])
  const carriers = new Set([...(Array.isArray(previousCarriers) ? previousCarriers : []), ...carrierDisableIds(packageName)])
  const patchPath = defaultPatchPath()
  for (const rowId of rows) stripRows(patchPath, rowId)
  for (const rowId of carriers) stripForceRows(patchPath, rowId)
  persistDisabled(packageName, false)
  return { ok: true, rows: [...rows], carriers: [...carriers] }
}

module.exports = {
  initPluginSwitch,
  parsePatchRows,
  readPatchState,
  rowIdsForPackage,
  carrierDisableIds,
  canToggle,
  hasClientPart,
  isDisabled,
  isMarketDisabled,
  reconcileDisabledPackages,
  setEnabled,
  pruneRows,
  removeRows,
  defaultPatchPath,
  PROFILE_NAME,
}