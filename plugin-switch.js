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
const { ensureProfileBundle } = require('./profile-bundle')

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

/**
 * 行级扫描用户补丁层：按"顶层条目"读，而不是假设 `- id: X` 紧接 `disabled:`。
 * 真实会遇到兄弟键（dsh-mcp-panel / dshmarket 写的是 `- id: X` / `name: …` / `disabled: true`），
 * 只认两行相邻的话，别的工具写的禁用态会被读成"已启用"，随后开关再追加一条重复行。
 * 仍然只做行级扫描（不引 YAML 依赖）：条目内 2 空格缩进的 `disabled:` 才是这条目的开关值，
 * `config:` 下的更深缩进不会被误读。
 */
function readPatchState(patchPath = defaultPatchPath()) {
  const disables = []
  const forced = []
  const inserts = []
  let lines = []
  try { lines = fs.readFileSync(patchPath, 'utf8').split(/\r?\n/u) } catch { return { disables, forced, inserts } }
  let entry = null // { id, disabled: boolean|null }
  let inInsert = false
  const flush = () => {
    if (!entry) return
    if (entry.disabled === true) disables.push(entry.id)
    else if (entry.disabled === false) forced.push(entry.id)
    entry = null
  }
  for (const line of lines) {
    if (/^- insert:\s*$/u.test(line)) { flush(); inInsert = true; continue }
    if (/^- /u.test(line)) {
      inInsert = false
      flush()
      const row = /^- id: ['"]?([A-Za-z0-9_.-]+)['"]?\s*$/u.exec(line)
      if (row !== null) entry = { id: row[1], disabled: null }
      continue
    }
    if (inInsert) {
      const insertRow = /^ {4}- id: ([A-Za-z0-9_.-]+)/u.exec(line)
      if (insertRow !== null) inserts.push(insertRow[1])
      continue
    }
    if (entry) {
      const value = /^ {2}disabled:\s*(true|false)\s*$/u.exec(line) // 恰好 2 空格：条目自己的键
      if (value !== null) entry.disabled = value[1] === 'true'
    }
  }
  flush()
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

/** 原子落盘：同目录临时文件 → rename；失败抛错（调用方决定语义）。 */
function writeFileAtomicSync(file, text) {
  const dir = path.dirname(file)
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  let fd
  try {
    fd = fs.openSync(temp, 'w', 0o600)
    fs.writeFileSync(fd, text)
    try { fs.fsyncSync(fd) } catch { /* 文件系统不支持也不影响 rename 的原子性 */ }
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, file)
  } catch (err) {
    try { if (fd !== undefined) fs.closeSync(fd) } catch { /* noop */ }
    try { fs.unlinkSync(temp) } catch { /* noop */ }
    throw err
  }
}

const PATCH_BACKUP_KEEP = 3
/**
 * 写 profile 补丁层：先留一份时间戳备份再原子替换。
 * 这个文件被 DSH 在启动时**抛错式**解析（坏一个字符就整站起不来），改坏必须能退回去。
 */
function writePatchAtomic(file, text) {
  // fail-closed：结构校验不过就不写。坏文件一旦落盘，DSH 会在启动时抛 YAMLParseError。
  assertPatchShape(text)
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-dshl-${new Date().toISOString().replace(/[:.]/gu, '-')}`
    try { fs.copyFileSync(file, backup) } catch { /* 备份失败不阻断写入，但会缺少回滚点 */ }
    try {
      const dir = path.dirname(file)
      const base = path.basename(file) + '.bak-dshl-'
      const names = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort()
      while (names.length > PATCH_BACKUP_KEEP) { try { fs.unlinkSync(path.join(dir, names.shift())) } catch { /* noop */ } }
    } catch { /* noop */ }
  }
  writeFileAtomicSync(file, text)
}

/** 本工具新增条目时写的裸行形态（`- id: X` 紧接 2 空格缩进）。 */
function rowBlock(rowId, disabled) {
  return `- id: ${rowId}\n  disabled: ${disabled ? 'true' : 'false'}\n`
}

/**
 * 顶层条目块的边界 [start, end)。
 * 条目从顶格 `- id: X` 开始；空行、注释、缩进行都属于它；下一个顶格行（`- ` 条目，
 * 或 `config:` 这类顶格键 —— 后者说明文件结构已经坏了）或文件末尾才是边界。
 *
 * 历史教训（2026-11-28 真机）：旧实现只删 `- id:` 紧接的 `disabled:` 两行，遇到带
 * `config:` 的用户条目会留下 `config:` 残块。DSH 启动时抛 YAMLParseError，整个服务起不来。
 * 条目内容必须按块处理，不能按固定两行处理。
 */
function findEntryBlocks(lines, rowId) {
  const blocks = []
  for (let start = 0; start < lines.length; start += 1) {
    const head = /^- id: ['"]?([A-Za-z0-9_.-]+)['"]?\s*$/u.exec(lines[start])
    if (head === null || head[1] !== rowId) continue
    let end = lines.length
    for (let probe = start + 1; probe < lines.length; probe += 1) {
      const line = lines[probe]
      if (line.trim() === '' || /^[ \t]*#/u.test(line)) continue
      if (/^- /u.test(line) || /^[^\s]/u.test(line)) { end = probe; break }
    }
    blocks.push({ start, end })
    start = end - 1
  }
  return blocks
}

/** 条目内自己的开关行（恰好 2 空格缩进）。config 下的深缩进不会被误认。 */
function disabledLineIndex(lines, block) {
  for (let index = block.start + 1; index < block.end; index += 1) {
    if (/^ {2}disabled:\s*(?:true|false)\s*$/u.test(lines[index])) return index
  }
  return -1
}

/**
 * 写盘前校验顶层结构：除注释/空行/`[]`/文档标记/缩进行外，每一行都必须从顶格 `- ` 开始。
 * 缩进行属于上一个条目（config 子键、`insert:` 下的条目），天然合法；
 * 顶格却不是条目开头的行才是残块（2026-11-28 那次就是顶格的 `config:`）。
 * 这是 fail-closed 的最后一道闸 —— 万一上面的块逻辑再出错，宁可写失败让用户看到，
 * 也不要把一个 YAML 都解析不了的文件落盘（DSH 会因此整个起不来）。
 */
function assertPatchShape(text) {
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^\s*#/u.test(line)) continue
    if (/^- /u.test(line) || /^[ \t]/u.test(line) || /^(?:\[\s*\]|---)\s*$/u.test(line)) continue
    throw new Error(`补丁层第 ${index + 1} 行不在顶层条目内，已拒绝写入：${line.trim().slice(0, 60)}`)
  }
}

function lineEndingOf(text) {
  return /\r\n/u.test(text) ? '\r\n' : '\n'
}

function readPatchLines(patchPath) {
  let text = ''
  try { text = fs.readFileSync(patchPath, 'utf8') } catch { return null }
  return { text, lines: text.split(/\r?\n/u) }
}

/**
 * 设置某条目的开关值：**就地改条目自己的 `disabled:` 行**，没有就插在 `- id:` 之后。
 * 绝不删条目再追加裸行 —— 那会把条目里的 name/config 丢掉或留成残块。
 */
function setRowDisabled(patchPath, rowId, disabled) {
  const read = readPatchLines(patchPath)
  if (read === null) return appendPatchEntry(patchPath, rowBlock(rowId, disabled))
  const { text, lines } = read
  const blocks = findEntryBlocks(lines, rowId)
  if (!blocks.length) return appendPatchEntry(patchPath, rowBlock(rowId, disabled))
  const value = `  disabled: ${disabled ? 'true' : 'false'}`
  // 倒序处理：插入行会改变后面块的下标
  for (const block of [...blocks].reverse()) {
    const at = disabledLineIndex(lines, block)
    if (at >= 0) lines[at] = value
    else lines.splice(block.start + 1, 0, value)
  }
  writePatchAtomic(patchPath, lines.join(lineEndingOf(text)))
  return { ok: true, error: '' }
}

/**
 * 移除条目的开关覆盖（恢复上层默认）。
 *   - 条目只有本工具写的 `- id:` + `disabled:` 两行 → 整块删除；
 *   - 条目还有 name/config 等用户内容 → **只删 `disabled:` 行**，其余原样保留。
 * onlyValue 用于只撤掉某一种覆盖（force 行：disabled: false）。
 */
function clearRowDisabled(patchPath, rowId, onlyValue) {
  const read = readPatchLines(patchPath)
  if (read === null) return { ok: true, error: '' }
  const { text, lines } = read
  const blocks = findEntryBlocks(lines, rowId)
  if (!blocks.length) return { ok: true, error: '' }
  const drop = new Set()
  for (const block of blocks) {
    const at = disabledLineIndex(lines, block)
    if (at < 0) continue
    if (onlyValue && !new RegExp(`^ {2}disabled:\\s*${onlyValue}\\s*$`, 'u').test(lines[at])) continue
    drop.add(at)
    // 删掉开关行后只剩 `- id:` 本身 → 这是本工具写的裸行，整块清掉
    const rest = []
    for (let index = block.start; index < block.end; index += 1) {
      if (drop.has(index)) continue
      if (lines[index].trim() === '' || /^\s*#/u.test(lines[index])) continue
      rest.push(index)
    }
    if (rest.length === 1 && rest[0] === block.start) {
      for (let index = block.start; index < block.end; index += 1) drop.add(index)
    }
  }
  if (!drop.size) return { ok: true, error: '' }
  const next = lines.filter((_, index) => !drop.has(index)).join(lineEndingOf(text))
  writePatchAtomic(patchPath, withPlaceholderRestored(next))
  return { ok: true, error: '' }
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
    writePatchAtomic(patchPath, block)
    return { ok: true, error: '' }
  }
  const withoutComments = text.replace(/^[ \t]*#.*$/gmu, '').trim()
  if (withoutComments === '') {
    const next = text.endsWith('\n') ? text : `${text}\n`
    writePatchAtomic(patchPath, `${next}${block}`)
    return { ok: true, error: '' }
  }
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n')
    const next = commented.endsWith('\n') ? commented : `${commented}\n`
    writePatchAtomic(patchPath, `${next}${block}`)
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
  writePatchAtomic(patchPath, `${next}${block}`)
  return { ok: true, error: '' }
}

function stripRows(patchPath, rowId) {
  const result = clearRowDisabled(patchPath, rowId)
  return result
}

function stripForceRows(patchPath, rowId) {
  return clearRowDisabled(patchPath, rowId, 'false')
}

function disableRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, error: `行 id ${rowId} 含特殊字符，无法写入补丁层` }
  const state = readPatchState(patchPath)
  if (state.disables.includes(rowId)) return { ok: true, error: '' }
  const result = setRowDisabled(patchPath, rowId, true)
  if (result.ok) log(`disabled ${rowId}`)
  return result
}

function enableRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, error: `行 id ${rowId} 含特殊字符，无法写入补丁层` }
  const state = readPatchState(patchPath)
  if (state.disables.includes(rowId)) {
    const result = clearRowDisabled(patchPath, rowId)
    if (result.ok) log(`enabled ${rowId}`)
    return result
  }
  return { ok: true, error: '' }
}

/** Force a foreign row on, unless the user already disabled it explicitly. */
function forceEnableRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, error: `行 id ${rowId} 含特殊字符，无法写入补丁层` }
  const state = readPatchState(patchPath)
  if (state.disables.includes(rowId) || state.forced.includes(rowId)) return { ok: true, error: '' }
  const result = setRowDisabled(patchPath, rowId, false)
  if (result.ok) log(`force-enabled ${rowId}`)
  return result
}

function persistDisabled(packageName, disabled) {
  const statePath = marketStatePath()
  const stateDir = path.dirname(statePath)
  const marketInstalled = fs.existsSync(path.join(profileDir(), 'node_modules', 'dshmarket', 'package.json'))
  if (!marketInstalled && !fs.existsSync(stateDir)) return { ok: true, skipped: true }
  let state = {}
  if (fs.existsSync(statePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('状态不是对象')
      state = parsed
    } catch (err) {
      // fail-closed：这是 dshmarket 的多键状态文件（分组/区域/安装时间都在里面），
      // 解析失败时"重建小形状"会把用户的市场设置整份抹掉。
      log(`market state 不可读，拒绝写入：${(err && err.message) || String(err)}`)
      return { ok: false, error: '市场状态文件不可读，本次启停未保存' }
    }
  }
  const list = Array.isArray(state.disabled) ? state.disabled.filter((item) => typeof item === 'string') : []
  const next = disabled
    ? (list.includes(packageName) ? list : [...list, packageName])
    : list.filter((item) => item !== packageName)
  state.disabled = next
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    if (fs.existsSync(statePath)) { try { fs.copyFileSync(statePath, statePath + '.bak-dshl') } catch { /* noop */ } }
    writeFileAtomicSync(statePath, JSON.stringify(state))
  } catch (err) {
    const message = (err && err.message) || String(err)
    log('market state 写入失败：' + message)
    return { ok: false, error: '市场状态写入失败：' + message }
  }
  return { ok: true }
}

/** 只清掉 durable 的「已停用」选择，不碰补丁层（恢复 Profile 备份后调用）。 */
function clearPersistedDisabled(packageName) {
  return persistDisabled(packageName, false)
}

/** Turn one installed bundle plugin on/off through the user patch layer. */
function setEnabled(packageName, enabled) {
  try {
    const rows = rowIdsForPackage(packageName)
    const carriers = carrierDisableIds(packageName)
    if (!rows.length && !carriers.length) return { ok: false, error: '无法识别该插件的加载项，未写入补丁层' }
    if (enabled) {
      try { ensureProfileBundle(path.dirname(profileManifestPath()), packageName) }
      catch (error) { return { ok: false, error: '无法登记插件 bundle：' + error.message } }
    }
    // 先记 durable 选择，再写 patch：中途崩溃时下次 reconcile 会按选择补全。
    const persisted = persistDisabled(packageName, !enabled)
    if (persisted && persisted.ok === false) return { ok: false, error: persisted.error || '无法保存启停状态' }
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
  } catch (err) {
    const message = (err && err.message) || String(err)
    log('补丁层写入失败：' + message)
    return { ok: false, error: '补丁层写入失败：' + message }
  }
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
  let error = ''
  if (rows.length) {
    try {
      const patchPath = defaultPatchPath()
      for (const rowId of rows) stripForceRows(patchPath, rowId)
    } catch (err) { error = (err && err.message) || String(err) }
  }
  if (error) log('补丁层清理失败（force 行）：' + error)
  return error ? { ok: false, error, rows } : { ok: true, rows }
}

/** Remove exactly the supplied toggle rows (stale row ids after an update). */
function pruneRows(rowIds = []) {
  const rows = [...new Set((Array.isArray(rowIds) ? rowIds : []).filter((id) => ROW_ID_RE.test(id)))]
  let error = ''
  if (rows.length) {
    try {
      const patchPath = defaultPatchPath()
      for (const rowId of rows) stripRows(patchPath, rowId)
    } catch (err) { error = (err && err.message) || String(err) }
  }
  if (error) log('补丁层清理失败：' + error)
  return error ? { ok: false, error, rows } : { ok: true, rows }
}

/** Remove all toggle rows for a package (uninstall / stale-id cleanup). 不抛错：调用方按 ok 处理。 */
function removeRows(packageName, previousRows = [], previousCarriers = []) {
  const rows = new Set([...(Array.isArray(previousRows) ? previousRows : []), ...rowIdsForPackage(packageName)])
  const carriers = new Set([...(Array.isArray(previousCarriers) ? previousCarriers : []), ...carrierDisableIds(packageName)])
  let error = ''
  try {
    const patchPath = defaultPatchPath()
    for (const rowId of rows) stripRows(patchPath, rowId)
    for (const rowId of carriers) stripForceRows(patchPath, rowId)
  } catch (err) { error = (err && err.message) || String(err) }
  const persisted = persistDisabled(packageName, false)
  if (!error && persisted && persisted.ok === false) error = persisted.error
  if (error) log('补丁层清理失败：' + error)
  return error ? { ok: false, error, rows: [...rows], carriers: [...carriers] } : { ok: true, rows: [...rows], carriers: [...carriers] }
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
  clearPersistedDisabled,
  pruneRows,
  removeRows,
  defaultPatchPath,
  PROFILE_NAME,
}
