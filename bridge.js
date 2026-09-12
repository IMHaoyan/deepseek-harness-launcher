// bridge.js — 远程连接（DSH Bridge Next 插件）
// 定位：只负责「把随启动器分发的 DSH Bridge Next 装进 DSH 的 web profile」这一件事，
// 与 market.js 同构：不做目录浏览、不维护安装回执，状态永远以 profile 的 package.json 为准。
//
// 机制：完全复用 DSH 官方 CLI 语义 —— `dsh plugin --profile web add <file:tgz>` /
// `... remove <包名>`。该命令在 profile 目录执行 pnpm，并把声明了 `dsh.bundle.patch`
// 的依赖自动写进 `dsh.profile.bundles`（reconcilePlugins）。
//
// 为什么用随包 tgz 而不是源码 link：
//   - 插件未发布 npm，上游多包 devDeps 存在版本漂移（typecheck 在 0.1.5-rc.1 上已失败），
//     终端用户机器上现场构建不可复现；启动器只分发「已构建产物」。
//   - tarball 用 file: 方式由 pnpm 装进 profile（内容快照，源码目录移动/删除无影响）。
//
// 安全/稳健：
//   - payload 经 SHA256 校验（version.json 声明）；
//   - 安装前校验 tgz 内的 package.json 身份（包名 + 版本 + dsh.bundle.patch + dsh.client 均合法）；
//   - 安装后二次校验 profile（dependencies + bundles 缺一即失败）；
//   - 版本变化或依赖被改指到别处时，先 remove 再 add，不覆盖式乱写。
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { spawn } = require('child_process')

const PLUGIN_NAME = '@agents-anywhere/dsh-bridge-next'
const PROFILE_NAME = 'web'
const BUNDLE_PATCH = './cordis.patch.yml'
const PROFILE_MANIFEST_MAX_BYTES = 1 * 1024 * 1024
const CLI_TIMEOUT_MS = 15 * 60 * 1000 // 首次安装要拉依赖树，给足时间
const MAX_CLI_OUTPUT_BYTES = 64 * 1024
const MAX_TARBALL_BYTES = 32 * 1024 * 1024

let HOME = ''
let envDetect = null
let payloadRoot = ''
let payload = null // { version, sha256, tgzPath, pkg }
let payloadError = ''
let logFn = () => {}

const state = {
  installed: false,
  version: '',
  bundle: false,
  spec: '',
  busy: '', // '' | 'installing' | 'uninstalling'
  error: '',
  lastChange: '',
}

function initBridge(opts = {}) {
  HOME = opts.home || ''
  envDetect = opts.envDetect || null
  payloadRoot = opts.payloadRoot || ''
  logFn = opts.log || (() => {})
  loadPayload()
}

function log(message) {
  try { logFn('[bridge] ' + message) } catch { /* noop */ }
}

// ---------- payload（随启动器分发的已构建 tgz） ----------

/** 读取 payload 目录：version.json 声明版本与 SHA256，tgz 是构建产物。只读、失败只记账不抛。 */
function loadPayload() {
  payload = null
  payloadError = ''
  if (!payloadRoot) { payloadError = 'payload 目录未配置'; return }
  try {
    const metaPath = path.join(payloadRoot, 'version.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    if (!meta || typeof meta.version !== 'string' || !meta.version) throw new Error('version.json 缺少 version')
    if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(meta.sha256)) throw new Error('version.json 缺少合法 sha256')
    const tgzName = (typeof meta.tarball === 'string' && meta.tarball) ? meta.tarball : 'bridge-next.tgz'
    const tgzPath = path.join(payloadRoot, tgzName)
    const st = fs.statSync(tgzPath)
    if (!st.isFile() || st.size === 0 || st.size > MAX_TARBALL_BYTES) throw new Error('payload tgz 不存在或大小异常')
    const pkg = readPackageFromTarball(tgzPath)
    verifyPluginManifest(pkg, { version: meta.version })
    payload = { version: meta.version, sha256: meta.sha256, tgzPath, pkg }
  } catch (e) {
    payloadError = (e && e.message) || String(e)
    log('payload 不可用：' + payloadError)
  }
}

function payloadVersion() {
  return payload ? payload.version : ''
}

function payloadInstalledVersion() {
  return (payload && payload.pkg && payload.pkg.version) || ''
}

/** 校验 tgz 的 SHA256；返回 true/false（失败只记账）。 */
function verifyPayload() {
  if (!payload) return false
  try {
    const buf = fs.readFileSync(payload.tgzPath)
    const actual = crypto.createHash('sha256').update(buf).digest('hex')
    if (actual !== payload.sha256) {
      payloadError = 'payload 校验失败（SHA256 不匹配）'
      log(payloadError)
      return false
    }
    return true
  } catch (e) {
    payloadError = 'payload 读取失败：' + ((e && e.message) || String(e))
    log(payloadError)
    return false
  }
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

/** 纯函数：从 profile manifest 判定桥接插件是否已安装并启用。 */
function pluginStateOf(manifest, name = PLUGIN_NAME) {
  if (!manifest || typeof manifest !== 'object') return { installed: false, version: '', bundle: false, spec: '' }
  const deps = (manifest.dependencies && typeof manifest.dependencies === 'object') ? manifest.dependencies : {}
  const spec = typeof deps[name] === 'string' ? deps[name] : ''
  const bundle = bundlesOf(manifest).includes(name)
  return { installed: !!spec, version: spec, bundle, spec }
}

function installed() {
  return pluginStateOf(readProfileManifest())
}

/** 读 profile 里已物化安装的插件版本（node_modules 里的 package.json）；读不到返回 ''。 */
function readInstalledPackageVersion() {
  try {
    const p = path.join(profileDir(), 'node_modules', ...PLUGIN_NAME.split('/'), 'package.json')
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
    return (pkg && typeof pkg.version === 'string') ? pkg.version : ''
  } catch { return '' }
}

function expectedSpec() {
  // pnpm 的 file: 规格统一用正斜杠（Windows 下反斜杠会解析失败）
  return payload ? ('file:' + payload.tgzPath.replace(/\\/gu, '/')) : ''
}

/** 纯函数：去掉 file:/link: 前缀后取规格里的目标名（tgz 文件名 / 目录名）。 */
function specBaseName(spec) {
  return path.basename(String(spec || '').replace(/^file:/u, '').replace(/^link:/u, '').replace(/[\\/]+$/u, ''))
}

/** 纯函数：profile 里的状态是否已经是「本 payload 装的」。 */
function satisfied(cur, want) {
  if (!cur || !cur.installed || !cur.bundle) return false
  if (!want || !want.spec) return false
  const ref = String(cur.spec || '')
  if (!ref.startsWith('file:') && !ref.startsWith('link:')) return false
  return specBaseName(ref) === specBaseName(want.spec)
}

function getState() {
  const cur = installed()
  state.installed = cur.installed && cur.bundle
  state.version = cur.version
  state.bundle = cur.bundle
  state.spec = cur.spec
  const materialized = readInstalledPackageVersion()
  // 已装但与随包 payload 版本不一致 → 控制台提示可更新
  const outdated = state.installed && !!payload && materialized !== '' && materialized !== payloadInstalledVersion()
  return {
    installed: state.installed,
    version: state.version,
    installedPackageVersion: materialized,
    bundle: state.bundle,
    spec: state.spec,
    busy: state.busy,
    error: state.error,
    lastChange: state.lastChange,
    plugin: PLUGIN_NAME,
    profile: PROFILE_NAME,
    payloadVersion: payloadVersion(),
    payloadPackageVersion: payloadInstalledVersion(),
    payloadReady: !!payload,
    payloadError,
    outdated,
  }
}

// ---------- tgz 内 package.json 身份校验 ----------

/** 读取 tar 的定长字段（ascii，NUL 截断）。 */
function tarString(buf, offset, length) {
  return buf.toString('ascii', offset, offset + length).replace(/\0.*$/su, '').trim()
}

/**
 * 从 tgz 中提取 package/package.json 并校验插件身份。
 * 只做最小 tar 解析（npm pack 产物固定为 ustar + 512 对齐），支持 GNU longname。
 * @returns {{name: string, version: string, dsh: object}}
 */
function readPackageFromTarball(tgzPath, { maxBytes = MAX_TARBALL_BYTES } = {}) {
  const raw = fs.readFileSync(tgzPath)
  if (raw.length === 0 || raw.length > maxBytes) throw new Error('tarball 大小异常')
  const tar = zlib.gunzipSync(raw)
  let offset = 0
  let pendingLongName = ''
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    if (header.every((b) => b === 0)) break
    const type = String.fromCharCode(header[156])
    const sizeField = tarString(header, 124, 12)
    const size = sizeField ? parseInt(sizeField, 8) : 0
    if (!Number.isInteger(size) || size < 0 || size > tar.length) throw new Error('tar 条目尺寸异常')
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (type === 'L') { pendingLongName = body.toString('utf8').replace(/\0.*$/su, ''); continue }
    const name = pendingLongName || tarString(header, 0, 100)
    pendingLongName = ''
    if (name === 'package/package.json' || name === './package/package.json') {
      const pkg = JSON.parse(body.toString('utf8'))
      verifyPluginManifest(pkg)
      return pkg
    }
  }
  throw new Error('tarball 内缺少 package/package.json')
}

/** 纯函数：校验插件 manifest 身份（包名 / 版本 / bundle patch / client 声明）。 */
function verifyPluginManifest(pkg, expected = {}) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('插件 manifest 非法')
  if (pkg.name !== PLUGIN_NAME) throw new Error('插件包身份不符：' + String(pkg.name))
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(pkg.version)) throw new Error('插件版本号不合法：' + String(pkg.version))
  if (expected.version && expected.version !== pkg.version) throw new Error(`插件版本与 payload 声明不一致（${pkg.version} ≠ ${expected.version}）`)
  const dsh = pkg.dsh
  if (!dsh || typeof dsh !== 'object') throw new Error('插件缺少 dsh 声明')
  const patch = dsh.bundle && dsh.bundle.patch
  if (typeof patch !== 'string' || patch !== BUNDLE_PATCH) throw new Error('插件缺少合法的 dsh.bundle.patch')
  if (!dsh.client || typeof dsh.client !== 'object' || dsh.client.platform !== 'web') throw new Error('插件缺少合法的 dsh.client 声明')
  return { name: pkg.name, version: pkg.version }
}

// ---------- dsh plugin CLI（与 market.js 同一条链路） ----------

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
  if (!envDetect) throw new Error('bridge: envDetect 未初始化')
  const env = await envDetect.detectEnv(false)
  if (!env || !env.plan) throw new Error('运行环境未就绪，无法安装远程连接插件')
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

/** 纯函数：判断是否需要安装 —— want.spec 为空（payload 不可用）时永不自动动 profile。 */
function needsInstall(cur, want) {
  if (!want || !want.spec) return false
  return !satisfied(cur, want)
}

/**
 * 安装（幂等）：校验 payload → 必要时 remove 旧版本 → dsh plugin add → 校验 profile。
 * @param {{force?: boolean}} opts force=true 时忽略「已满足」直接重装
 */
async function install(opts = {}) {
  if (state.busy) return { ok: false, error: '已有插件操作正在进行' }
  state.busy = 'installing'
  state.error = ''
  try {
    if (!payload) throw new Error('远程连接插件 payload 不可用：' + (payloadError || '未知原因'))
    if (!verifyPayload()) throw new Error(payloadError || 'payload 校验失败')
    const want = { version: payload.version, spec: expectedSpec() }
    const before = installed()
    if (!opts.force && !needsInstall(before, want)) {
      state.busy = ''
      return { ok: true, already: true, version: payload.version }
    }
    // 旧版本/旧路径：先移除，避免同一依赖残留旧 spec
    if (before.installed) {
      log('移除旧版本：' + before.version)
      await runCli(['remove', PLUGIN_NAME, '-w'])
    }
    log(`安装 ${PLUGIN_NAME}@${payload.version}（payload 校验通过）…`)
    await runCli(['add', want.spec, '-w'])
    const after = installed()
    if (!after.installed || !after.bundle) {
      throw new Error('安装后 profile 未正确记录该插件（dependencies/bundles 缺一）')
    }
    state.lastChange = `已安装远程连接插件 v${payload.version}`
    log('installed ' + payload.version)
    state.busy = ''
    return { ok: true, version: payload.version }
  } catch (e) {
    state.error = (e && e.message) || String(e)
    state.busy = ''
    log('install failed: ' + state.error)
    return { ok: false, error: state.error }
  }
}

/** 卸载：dsh plugin remove → 校验 profile 已移除。 */
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
    if (after.installed || after.bundle) throw new Error('卸载后 profile 仍记录该插件')
    state.lastChange = '已卸载远程连接插件'
    log('uninstalled')
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
  initBridge,
  getState,
  installed,
  install,
  uninstall,
  verifyPayload,
  payloadVersion,
  // 纯函数（测试用）
  pluginStateOf,
  needsInstall,
  satisfied,
  verifyPluginManifest,
  readPackageFromTarball,
  pnpmReady,
  PLUGIN_NAME,
  PROFILE_NAME,
  BUNDLE_PATCH,
}





