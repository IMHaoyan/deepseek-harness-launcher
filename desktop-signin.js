// desktop-signin.js — 把"桌面壳登录"缺的那半步补上：替 DSH 打开平台授权页
//
// 为什么需要它：一旦页面带上 dshDesktop 标记，DSH 账号登录会走 desktop 分支
// （dsh-client-ui-settings-account：startSignIn(..., 'desktop')），这时 Host 只等浏览器回调，
// **不再由前端预开标签页**；官方桌面 App 由自己的主进程打开 authorizeUrl，DSHL 不是官方壳，
// 不补这半步登录弹窗就只能停在「复制登录链接」。
//
// 做法：随启动器分发一个极小的 DSH host bundle（assets/dshl-desktop-signin，插件根目录见下），
// 用官方 CLI 语义 `dsh plugin --profile web add link:<dir>` 装进 web profile（与 bridge.js 同一机制）。
// 该插件只做一件事：watch 账号尝试，发现新的 authorizeUrl 就交给系统默认浏览器。
//
// 安装时机：仅当 Config.desktopShell=true，且在 startServerInner **拉起服务之前**（此刻服务已停，
// pnpm 可以安全改写 profile）。安装失败不阻断启动——登录退化成「复制链接」，其余桌面能力不受影响。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const bridge = require('./bridge')

const PKG_NAME = 'dshl-desktop-signin'
const PROFILE_NAME = 'web'
const CACHE_DIRNAME = 'desktop-signin'
const STATE_BASENAME = 'state.json'
const PROFILE_MANIFEST_MAX_BYTES = 1 * 1024 * 1024
// Windows FILETIME(ticks, 1601-01-01) → Unix 毫秒的偏移量；用于比较"服务启动时刻"与"辅助安装时刻"。
const WINDOWS_TICKS_EPOCH_DIFF_MS = 11644473600000

let HOME = ''
let logFn = () => {}
let envDetect = null
let payloadRoot = ''
let payload = null
let payloadError = ''

function init(opts = {}) {
  HOME = opts.home || ''
  logFn = opts.log || (() => {})
  envDetect = opts.envDetect || null
  payloadRoot = opts.payloadRoot || ''
  loadPayload()
}

function log(message) {
  try { logFn('[desktop-signin] ' + message) } catch { /* noop */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

/** 校验随包 payload：package.json 身份 + dsh.bundle.patch + 入口文件。 */
function loadPayload() {
  payload = null
  payloadError = ''
  if (!payloadRoot) { payloadError = 'payload 目录未配置'; return }
  try {
    const pkg = readJson(path.join(payloadRoot, 'package.json'))
    if (!pkg || pkg.name !== PKG_NAME) throw new Error('package.json 身份不符')
    if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json 缺少 version')
    const bundle = pkg.dsh && pkg.dsh.bundle
    if (!bundle || typeof bundle.patch !== 'string') throw new Error('package.json 缺少 dsh.bundle.patch')
    const entryRel = typeof pkg.main === 'string' && pkg.main ? pkg.main : './lib/index.js'
    const entry = path.join(payloadRoot, entryRel)
    const patch = path.join(payloadRoot, bundle.patch)
    if (!fs.existsSync(entry)) throw new Error('入口文件缺失：' + entryRel)
    if (!fs.existsSync(patch)) throw new Error('bundle patch 缺失：' + bundle.patch)
    payload = { version: pkg.version, dir: payloadRoot, pkg, entry, patch }
  } catch (error) {
    payloadError = (error && error.message) || String(error)
    log('payload 不可用：' + payloadError)
  }
}

function payloadVersion() {
  return payload ? payload.version : ''
}

function payloadState() {
  return { version: payloadVersion(), dir: payload ? payload.dir : '', error: payloadError }
}

// ---------- 安装记账（升级默认开启后的"激活闸门"依据） ----------

function stateFile() {
  return HOME ? path.join(HOME, 'dshl', CACHE_DIRNAME, STATE_BASENAME) : ''
}

/**
 * Windows FILETIME（100ns since 1601）→ Unix 毫秒。非法/溢出返回 0（调用方按"未知"处理）。
 * @param {string|number} ticks
 * @returns {number}
 */
function windowsTicksToUnixMs(ticks) {
  const value = Number(ticks)
  if (!Number.isFinite(value) || value <= 0) return 0
  const ms = Math.round(value / 10000) - WINDOWS_TICKS_EPOCH_DIFF_MS
  return ms > 0 ? ms : 0
}

/**
 * 当前服务是否"加载过"登录辅助（决定本次能不能启用 desktop runtime 的纯判定）。
 * 自管服务一定加载过（启动前先装）；认领/接管的外部世代只能靠时间证据：
 * 服务启动时刻晚于辅助安装时刻 → 它启动时 bundle 已在 profile 里。
 * 非 Windows 的 startedAt 是开机 ticks，不能和墙钟比较 → 一律按未加载（fail-closed）。
 * @param {{platform?:string, owned?:boolean, serviceStartedAtMs?:number, installedAtMs?:number}} value
 * @returns {boolean}
 */
function helperLoadedByService(value) {
  const v = value || {}
  if (v.owned === true) return true
  if (v.platform !== 'win32') return false
  const started = Number(v.serviceStartedAtMs)
  const installed = Number(v.installedAtMs)
  if (!Number.isFinite(started) || started <= 0) return false
  if (!Number.isFinite(installed) || installed <= 0) return false
  return started >= installed
}

/** 读安装记账；版本与文件缺失/损坏时返回 null（调用方回退到缓存目录 mtime）。 */
function readInstallState() {
  const file = stateFile()
  if (!file) return null
  const value = readJson(file)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.version !== 'string' || !value.version) return null
  const installedAtMs = Date.parse(String(value.installedAt || ''))
  if (!Number.isFinite(installedAtMs)) return null
  return {
    version: value.version,
    spec: typeof value.spec === 'string' ? value.spec : '',
    installedAt: value.installedAt,
    installedAtMs,
  }
}

function writeInstallState(version, spec, installedAtMs) {
  const file = stateFile()
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify({
      version,
      spec: String(spec || ''),
      installedAt: new Date(installedAtMs || Date.now()).toISOString(),
    }))
    fs.renameSync(tmp, file)
  } catch {
    // 记账失败不影响安装本身；激活闸门会退化为"按缓存目录 mtime"判断（更保守）
  }
}

/** 辅助被安装进 profile 的时刻（毫秒）：优先记账，缺失时用版本缓存目录的 mtime。 */
function installedAtMs() {
  const state = readInstallState()
  if (state && state.version === payloadVersion()) return state.installedAtMs
  const target = linkTarget()
  if (!target) return 0
  try {
    return Math.max(0, Math.floor(fs.statSync(target).mtimeMs))
  } catch {
    return 0
  }
}

/** 安装成功后记账；已满足时只补缺失的记账（用缓存目录 mtime，避免把旧安装记成"刚装"）。 */
function recordInstalled(spec, updated) {
  const version = payloadVersion()
  if (!version) return 0
  const now = Date.now()
  const state = readInstallState()
  if (!updated && state && state.version === version && state.spec === String(spec || '')) {
    return state.installedAtMs
  }
  const installedAt = updated ? now : (state && state.version === version ? state.installedAtMs : installedAtMs() || now)
  writeInstallState(version, spec, installedAt)
  return installedAt
}

function profileDir() {
  return path.join(HOME, 'profiles', PROFILE_NAME)
}

function readProfileManifest() {
  const manifestPath = path.join(profileDir(), 'package.json')
  let st
  try { st = fs.lstatSync(manifestPath) } catch { return undefined }
  // 与 bridge.js 同一判据：profile 的 package.json 本身不能是符号链接（防被指向任意位置）
  if (st.isSymbolicLink() || !st.isFile() || st.size > PROFILE_MANIFEST_MAX_BYTES) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function dependenciesOf(manifest) {
  const deps = manifest && manifest.dependencies
  return deps && typeof deps === 'object' && !Array.isArray(deps) ? deps : {}
}

function bundlesOf(manifest) {
  const profile = manifest && manifest.dsh && manifest.dsh.profile
  return profile && Array.isArray(profile.bundles) ? profile.bundles.filter((b) => typeof b === 'string') : []
}

/** 物化目录（版本戳）：link: 的目标必须稳定，且不能随启动器升级被原地覆盖。 */
function linkTarget() {
  if (!payload) return ''
  return path.join(HOME, 'dshl', CACHE_DIRNAME, payload.version)
}

/** pnpm 的 link: 规格统一正斜杠；Windows 盘符大小写不参与比较。 */
function normalizeSpec(spec) {
  if (typeof spec !== 'string') return ''
  return spec.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
}

function expectedSpec() {
  const target = linkTarget()
  return target ? 'link:' + target.replace(/\\/gu, '/') : ''
}

/** 已安装判定：manifest 依赖 + bundles + 磁盘上的包版本三者都对齐。纯函数，便于单测。 */
function pluginSatisfied({ manifest, spec, version, materializedPackage }) {
  if (!manifest || typeof spec !== 'string' || !spec) return false
  const deps = dependenciesOf(manifest)
  if (normalizeSpec(deps[PKG_NAME]) !== normalizeSpec(spec)) return false
  if (!bundlesOf(manifest).includes(PKG_NAME)) return false
  return !!(materializedPackage && materializedPackage.name === PKG_NAME && materializedPackage.version === version)
}

function materializedPackageInfo() {
  return readJson(path.join(profileDir(), 'node_modules', PKG_NAME, 'package.json'))
}

/**
 * 把 payload 复制到版本戳缓存目录；已存在且内容完整则复用。
 * @returns {string} 可交给 link: 的目录
 */
function materialize() {
  const target = linkTarget()
  if (!target) throw new Error('payload 不可用')
  const existing = readJson(path.join(target, 'package.json'))
  if (existing && existing.name === PKG_NAME && existing.version === payload.version
    && fs.existsSync(path.join(target, 'cordis.patch.yml'))
    && fs.existsSync(path.join(target, 'lib', 'index.js'))) {
    return target
  }
  const tmp = target + '.tmp-' + process.pid
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(payload.dir, tmp, { recursive: true })
  const copied = readJson(path.join(tmp, 'package.json'))
  if (!copied || copied.name !== PKG_NAME || copied.version !== payload.version) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
    throw new Error('payload 复制后校验失败')
  }
  try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* noop */ }
  fs.renameSync(tmp, target)
  return target
}

/**
 * 幂等安装。调用前提：DSH 服务已停（pnpm 改写 profile 依赖树时不能有进程占用）。
 * @returns {Promise<{ok:boolean, installed?:boolean, updated?:boolean, version?:string, error?:string}>}
 */
async function ensure() {
  if (!payload) return { ok: false, error: payloadError || 'payload 不可用' }
  try {
    const spec = expectedSpec()
    if (!spec) throw new Error('payload 不可用')
    const before = readProfileManifest()
    if (!before) throw new Error('读不到 web profile 的 package.json')
    if (pluginSatisfied({ manifest: before, spec, version: payload.version, materializedPackage: materializedPackageInfo() })) {
      const installedAt = recordInstalled(spec, false)
      return { ok: true, installed: true, updated: false, version: payload.version, installedAtMs: installedAt }
    }
    if (typeof bridge.runCli !== 'function') throw new Error('bridge.runCli 不可用（bridge 未初始化）')
    const target = materialize()
    log('安装到 profile：link:' + target)
    await bridge.runCli(['add', 'link:' + target.replace(/\\/gu, '/')])
    const after = readProfileManifest()
    if (!pluginSatisfied({ manifest: after, spec, version: payload.version, materializedPackage: materializedPackageInfo() })) {
      throw new Error('安装后校验失败（profile dependencies / bundles / node_modules 不一致）')
    }
    const installedAt = recordInstalled(spec, true)
    log('已安装 v' + payload.version)
    return { ok: true, installed: true, updated: true, version: payload.version, installedAtMs: installedAt }
  } catch (error) {
    const message = (error && error.message) || String(error)
    log('安装失败（登录将降级为"复制链接"）：' + message)
    return { ok: false, error: message }
  }
}

/** 诊断用状态。 */
function getState() {
  const manifest = readProfileManifest()
  const spec = expectedSpec()
  return {
    payload: payloadState(),
    installed: manifest ? pluginSatisfied({ manifest, spec, version: payloadVersion(), materializedPackage: materializedPackageInfo() }) : false,
    spec,
    version: payloadVersion(),
    installedAtMs: installedAtMs(),
    statePath: stateFile(),
  }
}

module.exports = {
  PKG_NAME,
  PROFILE_NAME,
  init,
  ensure,
  getState,
  // 纯函数（单测用）
  payloadVersion,
  payloadState,
  pluginSatisfied,
  normalizeSpec,
  expectedSpec,
  dependenciesOf,
  bundlesOf,
  windowsTicksToUnixMs,
  helperLoadedByService,
  readInstallState,
  installedAtMs,
}
