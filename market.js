// market.js — 插件市场（单一插件：dshmarket）
// 定位：不做目录浏览，只负责「把 dshmarket 这个插件装进 DSH 的 web profile」这一件事。
// 机制（与 DSH 官方 CLI 完全一致，不自造安装器）：
//   - 安装：`<dshBin> plugin --profile web add dshmarket` —— 该命令是 pnpm 的薄封装，
//     会在 profile 目录执行 pnpm add，并自动把插件写进 `dsh.profile.bundles`（reconcilePlugins）。
//     dsh CLI 自带编译版 pnpm，用户机器无需预装 pnpm。
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

const state = {
  installed: false,
  version: '',
  bundle: false,
  busy: '', // '' | 'installing' | 'uninstalling'
  error: '',
  lastChange: '',
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

function getState() {
  const cur = installed()
  state.installed = cur.installed && cur.bundle
  state.version = cur.version
  state.bundle = cur.bundle
  return {
    installed: state.installed,
    version: state.version,
    bundle: state.bundle,
    busy: state.busy,
    error: state.error,
    lastChange: state.lastChange,
    plugin: PLUGIN_NAME,
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

// ---------- 执行 dsh plugin（CLI 薄封装，自带 pnpm） ----------

async function runCli(args) {
  if (!envDetect) throw new Error('market: envDetect 未初始化')
  const env = await envDetect.detectEnv(false)
  if (!env || !env.plan) throw new Error('运行环境未就绪，无法安装插件')
  const { nodeCmd, dshBin } = env.plan
  if (!fs.existsSync(dshBin)) throw new Error('DSH 入口不存在：' + dshBin)
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(nodeCmd, [dshBin, 'plugin', '--profile', PROFILE_NAME, ...args], {
        cwd: profileDir(),
        env: Object.assign({}, process.env, { DSH_HOME: HOME }),
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

/** 安装 dshmarket：npm 校验 → dsh plugin add → 校验 profile → 重启服务生效。 */
async function install() {
  if (state.busy) return { ok: false, error: '已有插件操作正在进行' }
  state.busy = 'installing'
  state.error = ''
  try {
    const before = installed()
    if (before.installed && before.bundle) {
      state.busy = ''
      return { ok: true, already: true, version: before.version }
    }
    const verified = await verifyNpmPackage(PLUGIN_NAME)
    log(`installing ${PLUGIN_NAME}@${verified.version}（npm 官方源校验通过）…`)
    // -w：profile 目录本身是一个 pnpm workspace 根（pnpm-workspace.yaml），
    // 新版本 pnpm 拒绝在 workspace 根加依赖，除非显式 -w/--workspace-root。
    await runCli(['add', `${PLUGIN_NAME}@${verified.version}`, '-w'])
    const after = installed()
    if (!after.installed || !after.bundle) {
      throw new Error('安装后 profile 未正确记录该插件（dependencies/bundles 缺一）')
    }
    state.lastChange = `已安装 ${PLUGIN_NAME}@${after.version}`
    log(`installed ${PLUGIN_NAME}@${after.version}`)
    state.busy = ''
    return { ok: true, version: after.version }
  } catch (e) {
    state.error = (e && e.message) || String(e)
    state.busy = ''
    log('install failed: ' + state.error)
    return { ok: false, error: state.error }
  }
}

/** 卸载 dshmarket：dsh plugin remove → 校验 profile 已移除 → 重启服务生效。 */
async function uninstall() {
  if (state.busy) return { ok: false, error: '已有插件操作正在进行' }
  state.busy = 'uninstalling'
  state.error = ''
  try {
    const before = installed()
    if (!before.installed && !before.bundle) {
      state.busy = ''
      return { ok: true, already: true }
    }
    await runCli(['remove', PLUGIN_NAME, '-w'])
    const after = installed()
    if (after.installed || after.bundle) {
      throw new Error('卸载后 profile 仍记录该插件')
    }
    state.lastChange = `已卸载 ${PLUGIN_NAME}`
    log(`uninstalled ${PLUGIN_NAME}`)
    state.busy = ''
    return { ok: true }
  } catch (e) {
    state.error = (e && e.message) || String(e)
    state.busy = ''
    log('uninstall failed: ' + state.error)
    return { ok: false, error: state.error }
  }
}

module.exports = {
  initMarket,
  getState,
  installed,
  install,
  uninstall,
  verifyNpmPackage,
  // 纯函数（测试用）
  pluginStateOf,
  verifyNpmManifestShape,
  PLUGIN_NAME,
  PROFILE_NAME,
  NPM_REGISTRY_ORIGIN,
}
