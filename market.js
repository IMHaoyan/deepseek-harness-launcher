// market.js — npm 分发插件的通用安装器（dshmarket / dsh-better-sidebar / dsh-chat-import / …）
// 定位：不做目录浏览，只负责「把某个 npm 分发的 DSH 插件装进 DSH 的 web profile」。
//   - dshmarket 仍是默认插件：install()/uninstall()/getState() 保持旧签名；
//   - 其余插件走 installByName(name)/uninstallByName(name)/stateOf(name)，按包名各自记账。
// 机制（与 DSH 官方 CLI 完全一致，不自造安装器）：
//   - 安装：`<dshBin> plugin --profile web add <包名>@<精确版本>` —— 该命令是 pnpm 的薄封装，
//     会在 profile 目录执行 pnpm add，并自动把插件写进 `dsh.profile.bundles`（reconcilePlugins）。
//     dsh CLI 需要 PATH 上有 pnpm；DSHL 负责把固定版本的 pnpm 安装/对齐到用户全局路径。
//   - 卸载：`<dshBin> plugin --profile web remove dshmarket`（对称）。
//   - 状态：永远以 profile 的 package.json 为准（dependencies + dsh.profile.bundles），不维护安装回执。
// 安全/稳健：
//   - 安装前用 npm registry 官方源校验包身份（包名一致 + 精确稳定版本 + 声明合法 dsh.bundle.patch）；
//   - 安装后二次校验 profile（必须同时出现在 dependencies 与 bundles），否则视为失败；
//   - 任何一步失败都不破坏现有 profile（pnpm add 失败时依赖树保持原样）。
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PLUGIN_NAME = 'dshmarket'
const PROFILE_NAME = 'web'
const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const PROFILE_MANIFEST_MAX_BYTES = 1 * 1024 * 1024
const CLI_TIMEOUT_MS = 15 * 60 * 1000 // 首次安装要拉完整依赖树，给足时间
const MAX_CLI_OUTPUT_BYTES = 64 * 1024

let HOME = ''
let envDetect = null
let logFn = () => {}

// 按包名分别记账：一个插件在装/卸时不影响另一个插件的状态展示。
// 每个进程内只保留瞬时状态；「是否已安装」永远以 profile 的 package.json 为准。
const states = new Map()
function stateOf(name = PLUGIN_NAME) {
  let s = states.get(name)
  if (!s) {
    s = { installed: false, version: '', bundle: false, busy: '', error: '', lastChange: '' }
    states.set(name, s)
  }
  return s
}

function initMarket(opts = {}) {
  HOME = opts.home || ''
  envDetect = opts.envDetect || null
  logFn = opts.log || (() => {})
}

function log(message) {
  try { logFn('[market] ' + message) } catch { /* noop */ }
}

// ---------- profile 读取（状态唯一来源） ----------

function profileDir() {
  return path.join(HOME, 'profiles', PROFILE_NAME)
}

function readProfileManifest() {
  const manifestPath = path.join(profileDir(), 'package.json')
  let st
  try { st = fs.lstatSync(manifestPath) } catch { return undefined }
  if (st.isSymbolicLink() || !st.isFile() || st.size > PROFILE_MANIFEST_MAX_BYTES) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return (value && typeof value === 'object' && !Array.isArray(value)) ? value : undefined
  } catch { return undefined }
}

function bundlesOf(manifest) {
  const dsh = (manifest && manifest.dsh && typeof manifest.dsh === 'object') ? manifest.dsh : {}
  const profile = (dsh.profile && typeof dsh.profile === 'object') ? dsh.profile : {}
  return Array.isArray(profile.bundles) && profile.bundles.every((b) => typeof b === 'string') ? profile.bundles : []
}

/** 纯函数：从 profile manifest 判定插件是否已安装并启用。 */
function pluginStateOf(manifest, name = PLUGIN_NAME) {
  if (!manifest || typeof manifest !== 'object') return { installed: false, version: '', bundle: false }
  const deps = (manifest.dependencies && typeof manifest.dependencies === 'object') ? manifest.dependencies : {}
  const version = typeof deps[name] === 'string' ? deps[name] : ''
  const bundle = bundlesOf(manifest).includes(name)
  return { installed: !!version, version, bundle }
}

/** 已安装 = 依赖里有 + bundles 里启用（缺任一条都算没装好）。 */
function installed() {
  return pluginStateOf(readProfileManifest())
}

/**
 * 读 profile 里实际物化安装的版本（node_modules 里的 package.json）。
 * manifest 里的 dependencies 记的是「依赖范围」（如 ^1.2.6 / file:…），不是真实版本，
 * 卡片上要展示真实版本，所以以 node_modules 为准；读不到返回空串由调用方兜底。
 */
function installedPackageVersion(name) {
  try {
    const pkgPath = path.join(profileDir(), 'node_modules', ...String(name || '').split('/'), 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    return (pkg && typeof pkg.version === 'string') ? pkg.version : ''
  } catch { return '' }
}

/** 单个插件的状态。name 省略时等于 dshmarket（兼容旧调用）。 */
function getState(name = PLUGIN_NAME) {
  const cur = pluginStateOf(readProfileManifest(), name)
  const s = stateOf(name)
  s.installed = cur.installed && cur.bundle
  s.version = cur.version
  s.bundle = cur.bundle
  return {
    installed: s.installed,
    version: s.version,
    installedPackageVersion: s.installed ? installedPackageVersion(name) : '',
    bundle: s.bundle,
    busy: s.busy,
    error: s.error,
    lastChange: s.lastChange,
    plugin: name,
  }
}

// ---------- npm 身份校验（官方源 + 精确稳定版本 + 合法 bundle 声明） ----------

function httpJsonFetch(url, { allowedOrigin, maxBytes = 1 * 1024 * 1024, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
      if (parsed.protocol !== 'https:') throw new Error('only https is allowed')
      if (allowedOrigin && parsed.origin !== allowedOrigin) throw new Error('unexpected origin')
    } catch (e) { return reject(e) }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const finish = (fn, value) => { clearTimeout(timer); fn(value) }
    fetch(parsed.href, { signal: controller.signal, redirect: 'error', cache: 'no-store' })
      .then((res) => {
        if (res.status !== 200) throw new Error('HTTP ' + res.status)
        const finalOrigin = (() => { try { return new URL(res.url).origin } catch { return '' } })()
        if (allowedOrigin && finalOrigin !== allowedOrigin) throw new Error('redirect escaped allowed origin')
        return res.arrayBuffer().then((buf) => {
          if (buf.byteLength > maxBytes) throw new Error('response too large')
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
          try { return JSON.parse(text) } catch { throw new Error('response is not valid JSON') }
        })
      })
      .then((value) => finish(resolve, value))
      .catch((e) => finish(reject, e))
  })
}

/** npm manifest 校验：name 一致 + 精确稳定版本 + 合法 dsh.bundle.patch 形状。 */
function verifyNpmManifestShape(manifest, expectedName) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('npm manifest is invalid')
  }
  if (manifest.name !== expectedName) throw new Error('npm 包身份不一致')
  const version = manifest.version
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error('npm 未提供精确的稳定版本号')
  }
  const dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {}
  const bundle = dsh.bundle && typeof dsh.bundle === 'object' ? dsh.bundle : {}
  const patch = bundle.patch
  if (typeof patch !== 'string' || patch.length === 0 || patch.length > 512 || patch.includes('\0')) {
    throw new Error('npm 包未声明合法的 DSH bundle')
  }
  const p = patch.startsWith('./') ? patch.slice(2) : patch
  if (p.length === 0 || p.startsWith('/') || p.includes('\\')
    || p.split('/').some((s) => s.length === 0 || s === '.' || s === '..' || s.includes(':'))) {
    throw new Error('npm 包未声明合法的 DSH bundle')
  }
  return { name: expectedName, version }
}

async function verifyNpmPackage(name) {
  if (!NPM_PACKAGE_PATTERN.test(name)) throw new Error('npm 包名格式不合法')
  let raw
  try {
    raw = await httpJsonFetch(`${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}/latest`, {
      allowedOrigin: NPM_REGISTRY_ORIGIN,
      maxBytes: 1 * 1024 * 1024,
    })
  } catch (e) {
    throw new Error('无法从 npm 官方源验证包（' + ((e && e.message) || String(e)) + '）')
  }
  return verifyNpmManifestShape(raw, name)
}

// ---------- 执行 dsh plugin（DSHL 保证 PATH 上的 pnpm 可用） ----------

function pnpmReady(env) {
  return !!(env && env.pnpm && env.pnpm.status === 'ok')
}

function withToolchainPath(baseEnv, dirs) {
  const env = Object.assign({}, baseEnv)
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH'
  const prefix = dirs.filter(Boolean).join(path.delimiter)
  env[pathKey] = prefix ? prefix + path.delimiter + (env[pathKey] || '') : (env[pathKey] || '')
  return env
}

async function runCli(args) {
  if (!envDetect) throw new Error('market: envDetect 未初始化')
  const env = await envDetect.detectEnv(false)
  if (!env || !env.plan) throw new Error('运行环境未就绪，无法安装插件')
  if (!pnpmReady(env)) {
    const detail = env.pnpm ? (env.pnpm.detail || '未就绪') : '未检测到 pnpm'
    throw new Error('pnpm 未就绪：' + detail + '。请先在运行环境页安装/修复 pnpm。')
  }
  const { nodeCmd, dshBin } = env.plan
  if (!fs.existsSync(dshBin)) throw new Error('DSH 入口不存在：' + dshBin)
  const nodeDir = nodeCmd.includes(path.sep) || nodeCmd.includes('/') ? path.dirname(nodeCmd) : ''
  const pnpmDir = env.pnpm && env.pnpm.path ? path.dirname(env.pnpm.path) : ''
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(nodeCmd, [dshBin, 'plugin', '--profile', PROFILE_NAME, ...args], {
        cwd: profileDir(),
        env: withToolchainPath(Object.assign({}, process.env, { DSH_HOME: HOME }), [nodeDir, pnpmDir]),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) { return reject(e) }
    const chunks = []
    let bytes = 0
    const cap = (d) => {
      chunks.push(d)
      bytes += Buffer.byteLength(d)
      while (bytes > MAX_CLI_OUTPUT_BYTES && chunks.length > 0) {
        bytes -= Buffer.byteLength(chunks[0])
        chunks.shift()
      }
    }
    child.stdout.on('data', cap)
    child.stderr.on('data', cap)
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, CLI_TIMEOUT_MS)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const output = chunks.join('').trimEnd()
      if (code === 0) resolve({ code, output })
      else reject(new Error('dsh plugin 退出码 ' + code + (output ? '：' + output.slice(-400) : '')))
    })
  })
}

// ---------- 安装 / 卸载 ----------

/**
 * 安装（或更新）任意 npm 分发的 DSH 插件：
 * npm 身份校验 → dsh plugin add <包名>@<精确版本> → 二次校验 profile。
 * force=true 时即使已装也重新解析版本并覆盖安装（用于「更新到最新」）。
 */
async function installByName(name, opts = {}) {
  const pkg = String(name || '')
  if (!pkg) return { ok: false, error: '插件名不能为空' }
  const s = stateOf(pkg)
  if (s.busy) return { ok: false, error: '该插件已有操作正在进行' }
  s.busy = 'installing'
  s.error = ''
  try {
    const before = pluginStateOf(readProfileManifest(), pkg)
    if (before.installed && before.bundle && !opts.force) {
      s.busy = ''
      return { ok: true, already: true, version: before.version }
    }
    const verified = await verifyNpmPackage(pkg)
    log('installing ' + pkg + '@' + verified.version + '（npm 官方源校验通过）…')
    // -w：profile 目录本身是一个 pnpm workspace 根（pnpm-workspace.yaml），
    // 新版本 pnpm 拒绝在 workspace 根加依赖，除非显式 -w/--workspace-root。
    // --config.minimumReleaseAge=0：pnpm 11.7 起默认带 24h「新版本观察期」，刚发布的版本会被策略拦下
    // （The lockfile contains entries that the active policies reject），还会把 profile 留在
    // 「node_modules 已是新版、dependencies 仍是旧版」的半成品状态。dshmarket 等同类插件管理器
    // 对「用户点名安装的精确版本」也是显式关掉该策略，这里对齐。
    await runCli(['add', '--config.minimumReleaseAge=0', pkg + '@' + verified.version, '-w'])
    const after = pluginStateOf(readProfileManifest(), pkg)
    if (!after.installed || !after.bundle) {
      throw new Error('安装后 profile 未正确记录该插件（dependencies/bundles 缺一）')
    }
    s.lastChange = '已安装 ' + pkg + '@' + after.version
    log('installed ' + pkg + '@' + after.version)
    s.busy = ''
    return { ok: true, version: after.version }
  } catch (e) {
    s.error = (e && e.message) || String(e)
    s.busy = ''
    log('install failed: ' + pkg + '：' + s.error)
    return { ok: false, error: s.error }
  }
}

/** 卸载任意 npm 分发的 DSH 插件：dsh plugin remove → 校验 profile 已移除。 */
async function uninstallByName(name) {
  const pkg = String(name || '')
  if (!pkg) return { ok: false, error: '插件名不能为空' }
  const s = stateOf(pkg)
  if (s.busy) return { ok: false, error: '该插件已有操作正在进行' }
  s.busy = 'uninstalling'
  s.error = ''
  try {
    const before = pluginStateOf(readProfileManifest(), pkg)
    if (!before.installed && !before.bundle) {
      s.busy = ''
      return { ok: true, already: true }
    }
    await runCli(['remove', pkg, '-w'])
    const after = pluginStateOf(readProfileManifest(), pkg)
    if (after.installed || after.bundle) {
      throw new Error('卸载后 profile 仍记录该插件')
    }
    s.lastChange = '已卸载 ' + pkg
    log('uninstalled ' + pkg)
    s.busy = ''
    return { ok: true }
  } catch (e) {
    s.error = (e && e.message) || String(e)
    s.busy = ''
    log('uninstall failed: ' + pkg + '：' + s.error)
    return { ok: false, error: s.error }
  }
}

/**
 * 安装/卸载 dshmarket（默认插件）——保留旧签名给既有调用点。
 * opts.force=true：即使已安装也重新解析版本并覆盖安装（卡片上的「重新安装」）。
 */
function install(opts) { return installByName(PLUGIN_NAME, opts) }
function uninstall() { return uninstallByName(PLUGIN_NAME) }

module.exports = {
  initMarket,
  getState,
  installed,
  install,
  uninstall,
  // 任意 npm 插件（控制台「插件」页的推荐插件用）
  installByName,
  uninstallByName,
  installedPackageVersion,
  verifyNpmPackage,
  // 纯函数（测试用）
  pluginStateOf,
  verifyNpmManifestShape,
  pnpmReady,
  PLUGIN_NAME,
  PROFILE_NAME,
  NPM_REGISTRY_ORIGIN,
}
