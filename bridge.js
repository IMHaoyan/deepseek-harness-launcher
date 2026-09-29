// bridge.js — 远程连接（DSH Bridge Next 插件）
// 定位：只负责「把随启动器分发的 DSH Bridge Next 装进 DSH 的 web profile」这一件事，
// 与 market.js 同构：不做目录浏览、不维护安装回执，状态永远以 profile 的 package.json 为准。
//
// 机制：完全复用 DSH 官方 CLI 语义 —— `dsh plugin --profile web add <link:dir>` /
// `... remove <包名>`。该命令在 profile 目录执行 pnpm，并把声明了 `dsh.bundle.patch`
// 的依赖自动写进 `dsh.profile.bundles`（reconcilePlugins）。
//
// 为什么先把随包 tgz 解到启动器缓存，再以 link: 安装：
//   - 插件未发布 npm，上游多包 devDeps 存在版本漂移（typecheck 在 0.1.5-rc.1 上已失败），
//     终端用户机器上现场构建不可复现；启动器只分发「已构建产物」。
//   - file: 依赖会被 pnpm 在每次 profile 变更时重新 import；Windows 下若 DSH 正在运行，
//     重命名 stage 覆盖正式目录会 EPERM，pnpm 的删除回退可能只删掉部分文件（本仓库事故）。
//   - link: 依赖是稳定目录的符号链接，市场在 DSH 运行中装别的插件时不会重写目标内容。
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
const { pathToFileURL } = require('url')
const pluginCompat = require('./dsh-plugin-compat')

const PLUGIN_NAME = '@agents-anywhere/dsh-bridge-next'
const PROFILE_NAME = 'web'
const BUNDLE_PATCH = './cordis.patch.yml'
// pnpm 11 起默认带 24h「新版本观察期」：它在每次 add/remove/install 前校验整份 lockfile，
// lockfile 里只要有一个刚发布不久且未放行的版本，任何操作都会在动手前被整体拒绝
// （ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION）。处理方式与 market.js 一致：
//   - 默认不关策略，让 pnpm 自己把新鲜版本写进 minimumReleaseAgeExclude（lockfile 保持合规）；
//   - 只有真的被整体拒绝时，才用一次性放行重试一次（重试不写放行记录，只能当兜底）。
const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'
const RELEASE_AGE_MARKERS = [
  'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
  'failed supply-chain policy check',
  'bypassed the policy locally',
  // 见 market.js 同名常量：pnpm 11.8 的 remove 路径缺观察期处理器，硬失败时打的就是这个码
  'ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED',
]
const PROFILE_MANIFEST_MAX_BYTES = 1 * 1024 * 1024
const CLI_TIMEOUT_MS = 15 * 60 * 1000 // 首次安装要拉依赖树，给足时间
const MAX_CLI_OUTPUT_BYTES = 64 * 1024
const MAX_TARBALL_BYTES = 32 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024
// 末段保持 bridge-next.tgz：兼容 1.4.0 已安装实例的 satisfied()（它只比较 spec 基名）。
const PAYLOAD_LINK_BASENAME = 'bridge-next.tgz'

let HOME = ''
let envDetect = null
let payloadRoot = ''
let payload = null // { version, sha256, tgzPath, pkg, linkDir }
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
    payload = { version: meta.version, sha256: meta.sha256, tgzPath, pkg, linkDir: payloadLinkDir(meta.version, meta.sha256) }
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

function payloadLinkDir(version, sha256) {
  const key = `${version}-${String(sha256).slice(0, 12)}`.replace(/[^A-Za-z0-9._-]/gu, '_')
  return path.join(HOME, 'dshl', 'bridge-payloads', key, PAYLOAD_LINK_BASENAME)
}

/** 纯函数：从 manifest 取入口产物相对路径（默认 ./lib/index.js）；非法路径 fail-closed 返回空串。 */
function entryFileOf(pkg) {
  const raw = (pkg && typeof pkg.main === 'string' && pkg.main.trim()) ? pkg.main.trim() : './lib/index.js'
  const rel = raw.replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/u.test(rel)) return ''
  if (rel.split('/').some((part) => !part || part === '.' || part === '..')) return ''
  return rel
}

function isMaterializedPayloadValid(dir) {
  if (!payload || !dir) return false
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    verifyPluginManifest(pkg, { version: payload.version })
    const st = fs.statSync(path.join(dir, BUNDLE_PATCH.replace(/^\.\//u, '')))
    if (!st.isFile()) return false
    // 入口产物也要在。package.json + cordis.patch.yml 齐全、lib/index.js 缺失时，
    // DSH 只会在 stderr 打一行 `failed to import`（服务照常就绪），用户侧看到的却是
    // 「插件市场说已安装、重启后生效，重启永远不生效」（2026-09-29 实测事故）。
    const entry = entryFileOf(pkg)
    if (!entry) return false
    return fs.statSync(path.join(dir, entry)).isFile()
  } catch { return false }
}

function ensureJunction(link, target) {
  try {
    const st = fs.lstatSync(link)
    if (!st.isSymbolicLink()) return
    let cur = ''
    try { cur = path.resolve(fs.realpathSync(link)) } catch { /* 悬空链接：下面删掉重建 */ }
    if (cur === path.resolve(target)) return
    fs.unlinkSync(link)
  } catch { /* 不存在：下面创建 */ }
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

// dsh 安装树里的 node_modules：payload 的 peer 全是 dsh 自己的包，profile 里缺/悬空时这里一定有。
// 由 env 探测缓存（resolveFallbackPackage 是同步的，不能现探）；探测失败就退回原来的两个来源。
let installModulesDirs = []

/**
 * 从 dsh 入口反推安装树的 node_modules，兼容两种布局：
 *   - npm 全局装：<prefix>\node_modules\@deepseek-ai\dsh\lib\bin.js（交给 dsh-plugin-compat 的推导）
 *   - 启动器自带 runtime：<install>\resources\runtime\cli\bin\dsh.cmd —— 入口自己不在 node_modules 里，
 *     包在 <…>\cli\node_modules，所以要**从入口往上找**最近的 node_modules\@deepseek-ai。
 * 少了后一种，镜像的第三个来源在启动器托管安装上恒为空 —— 而那正是"profile 侧缺件就再无兜底"的场景。
 */
function deriveInstallModulesDirs(dshBin) {
  const dirs = pluginCompat.installModulesDirsFromDshBin(dshBin)
  if (dirs.length > 0) return dirs
  let dir = path.dirname(String(dshBin || ''))
  for (let i = 0; i < 6 && dir && path.dirname(dir) !== dir; i += 1) {
    const nm = path.join(dir, 'node_modules')
    try {
      if (fs.statSync(path.join(nm, '@deepseek-ai')).isDirectory()) {
        const out = [nm]
        const appDir = path.join(nm, '@deepseek-ai', 'dsh', 'node_modules')
        try { if (fs.statSync(appDir).isDirectory()) out.push(appDir) } catch { /* 布局不同就只留顶层 */ }
        return out
      }
    } catch { /* 继续往上 */ }
    dir = path.dirname(dir)
  }
  return []
}

/**
 * 安装树候选目录（**纯函数**，便于测试与日志）：不依赖任何单一线索，把所有已知布局都列出来。
 *
 * 为什么不能只信 env：`plan.dshBin` 可能是 shim（启动器托管的 dsh 入口在 `…\resources\runtime\cli\bin\`，
 * 自己不在 node_modules 里）；`dsh.dir/dsh.root` 在不同机器上也可能指向别的安装。而 14178 那台机器实测
 * 出问题的包就躺在 **npm 默认全局前缀**下：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*`。
 * 所以：env 线索 + npm 前缀（显式给的、以及 %APPDATA%\npm 这个 Windows 默认值）全都作为候选，
 * 用的时候逐个 stat 校验，命中即用。
 */
function installTreeCandidates(env) {
  const out = new Set()
  const add = (dir) => { if (dir) out.add(dir) }
  const dshBin = env && env.plan && env.plan.dshBin
  for (const dir of deriveInstallModulesDirs(dshBin)) add(dir)
  const dshDir = env && env.dsh && env.dsh.dir // <prefix>\node_modules\@deepseek-ai\dsh
  if (dshDir) {
    add(path.join(dshDir, 'node_modules')) // dsh 自己那份（嵌套依赖：dsh-session-title 等）
    add(path.dirname(path.dirname(dshDir))) // <prefix>\node_modules
  }
  const dshRoot = env && env.dsh && env.dsh.root // env 报告里的 npm 前缀
  if (dshRoot) add(path.join(dshRoot, 'node_modules'))
  const npmPrefix = env && env.npmPrefix // 有的机器上只给了这个
  if (npmPrefix) add(path.join(npmPrefix, 'node_modules'))
  const appData = process.env.APPDATA || '' // Windows 上 npm 的默认全局前缀
  if (appData) {
    add(path.join(appData, 'npm', 'node_modules'))
    // 很多包不落在顶层，而是嵌在 dsh 自己的 node_modules 下（14178 那台就是这样）
    add(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  }
  return [...out]
}

/** 缓存安装树来源；探测失败就退回原来的两个来源。 */
function cacheInstallModulesDirs(env) {
  try {
    installModulesDirs = installTreeCandidates(env).filter((d) => {
      try { return fs.statSync(d).isDirectory() } catch { return false }
    })
  } catch { installModulesDirs = [] }
  return installModulesDirs
}

function resolveFallbackPackage(name) {
  const roots = []
  // DSH 注入包在 profiles/node_modules 里由 DSH 自己维护，比 profile 依赖树稳定；
  // 市场操作会剪掉 profile/node_modules，因此 @deepseek-ai/* 必须先查共享 fallback。
  if (String(name).startsWith('@deepseek-ai/')) roots.push(path.join(HOME, 'profiles', 'node_modules'))
  roots.push(path.join(profileDir(), 'node_modules'), path.join(HOME, 'profiles', 'node_modules'))
  // 最后再看 dsh 安装树：2026-09-29 实测，另一台机器上 profile 侧缺件导致 payload `failed to import`，
  // 而同一个包在安装树里是齐的 —— 少这个来源就只能等宿主兜底，兜不住就是"装了永远不生效"。
  roots.push(...installModulesDirs)
  for (const root of [...new Set(roots)]) {
    const dir = path.join(root, ...name.split('/'))
    try {
      if (fs.statSync(path.join(dir, 'package.json')).isFile()) return dir
    } catch { /* 继续找下一个 root */ }
  }
  return ''
}

/**
 * 纯函数：payload 入口文件里真正 import 的裸包名（相对路径/node: 前缀不算）。
 * 用来把"镜像缺口"日志收敛到**真正会让导入失败**的那几个 —— 声明的依赖/peer 里
 * 有些（react、@dataiku/uv…）宿主半边根本不 import，报出来只会误导。
 */
function entryImportSpecifiers(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const entry = entryFileOf(pkg)
    if (!entry) return []
    const code = fs.readFileSync(path.join(dir, entry), 'utf8')
    const out = new Set()
    for (const m of code.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gmu)) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
      out.add(spec)
    }
    return [...out]
  } catch { return [] }
}

/**
 * Node 从真实路径解析 ESM 依赖；缓存目录在 profile 外，父链里没有
 * $DSH_HOME/profiles/node_modules，所以把 Bridge 的直接依赖/peer 以 junction
 * 合并进缓存目录**旁边**的 node_modules（payload 自己那个 node_modules 是 deps 的 junction，
 * 里面只有 4 个运行时依赖）。镜像地址必须写真实路径：共享 fallback 里那些 @deepseek-ai/*
 * 本身也是 junction，DSH 升级/清理会重新指向甚至删掉它们，镜像跟着悬空就等于没镜像
 * ——宿主兜底又随 dsh 版本变（0.1.7-rc.2 上 bridge 就是这样 `failed to import` 的）。
 * @returns {{mirrored:string[], missing:string[]}} missing = 声明了却哪个 fallback 都解析不到的包
 */
function ensurePayloadRuntimeDeps(target) {
  const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
  const names = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ])
  // DSH runtime 注入的 @deepseek-ai/* 不一定写在 peerDependencies；
  // 把共享 fallback scope 整组镜像进来，避免宿主启动时才逐个 ENOENT。
  const injectedScope = path.join(HOME, 'profiles', 'node_modules', '@deepseek-ai')
  try {
    for (const entry of fs.readdirSync(injectedScope, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) names.add('@deepseek-ai/' + entry.name)
    }
  } catch { /* 没有共享 fallback 时按声明的依赖处理 */ }
  const modulesDir = path.join(path.dirname(target), 'node_modules')
  try {
    const st = fs.lstatSync(modulesDir)
    if (st.isSymbolicLink()) fs.unlinkSync(modulesDir)
  } catch { /* 不存在 */ }
  fs.mkdirSync(modulesDir, { recursive: true })
  const mirrored = []
  const missing = []
  for (const name of names) {
    const found = resolveFallbackPackage(name)
    if (!found) { missing.push(name); continue }
    let real = found
    try { real = fs.realpathSync(found) } catch { /* 悬空来源：按原路径建，下一次启动会重试 */ }
    ensureJunction(path.join(modulesDir, ...name.split('/')), real)
    mirrored.push(name)
  }
  return { mirrored, missing }
}

/**
 * 幂等重建 payload 自己的解析镜像（见 ensurePayloadRuntimeDeps）。失败只记账、不上抛：
 * 镜像缺失时插件仍可能被宿主兜住，真正"没起来"由启动后的激活信号负责暴露。
 * 解析不到的包必须点名写日志：它们正是启动时 `failed to import` 的候选，
 * 而 DSH 只会回一句 `failed to import`，不告诉你缺的是哪个模块。
 */
function repairPayloadScopeMirror(target) {
  try {
    const result = ensurePayloadRuntimeDeps(target)
    // 只报"入口真正 import、而且哪个来源都找不到"的那些包：其余（react、@dataiku/uv 之类）
    // 宿主半边不 import，报出来只会把真正的缺口淹掉。
    const needed = new Set(entryImportSpecifiers(target))
    const fatal = result.missing.filter((name) => needed.has(name))
    if (fatal.length > 0) {
      // 一条日志把"缺什么"和"查过哪儿"都说清：否则只能靠人再到那台机器上复现
      log('payload 解析镜像缺件（这些包 import 不到，插件启动时会 failed to import）：' + fatal.join('、')
        + '；已查来源：' + (installModulesDirs.length ? installModulesDirs.join(' | ') : '（安装树未探测到，仅 profile 侧）'))
    }
    return result
  } catch (e) {
    log('payload 解析镜像修复失败（不阻断启动）：' + ((e && e.message) || String(e)))
    return { mirrored: [], missing: [], error: (e && e.message) || String(e) }
  }
}

/**
 * Windows 上杀毒/索引器短暂持有目录句柄时，rename 会偶发 EPERM/EACCES/EBUSY。
 * 这是瞬时锁，不是目标状态；有限重试后仍失败才向上抛，避免把偶发锁变成发布阻塞。
 */
function renameWithRetrySync(from, to) {
  const retryable = new Set(['EPERM', 'EACCES', 'EBUSY'])
  let last
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      last = err
      if (!retryable.has(err && err.code)) throw err
      const waitMs = 25 * (attempt + 1)
      const sab = new SharedArrayBuffer(4)
      Atomics.wait(new Int32Array(sab), 0, 0, waitMs)
    }
  }
  throw last
}

/** 把已验证的 tgz 解到内容寻址缓存目录；link: 让 pnpm 永不原地重写该目录。 */
function materializePayload() {
  if (!payload) throw new Error('远程连接插件 payload 不可用：' + (payloadError || '未知原因'))
  const target = payload.linkDir
  if (isMaterializedPayloadValid(target)) {
    ensurePayloadRuntimeDeps(target)
    return target
  }
  const parent = path.dirname(target)
  fs.mkdirSync(parent, { recursive: true })
  const tmp = fs.mkdtempSync(path.join(parent, '.tmp-'))
  try {
    extractPackageFromTarball(payload.tgzPath, tmp)
    if (!isMaterializedPayloadValid(tmp)) throw new Error('payload 解包后缺少 package.json 或 cordis.patch.yml')
    if (fs.existsSync(target)) {
      if (isMaterializedPayloadValid(target)) return target
      fs.rmSync(target, { recursive: true, force: true })
    }
    renameWithRetrySync(tmp, target)
    ensurePayloadRuntimeDeps(target)
    return target
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
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

/**
 * 读 profile 里已物化安装的插件状态（node_modules 里的 package.json）。
 * patchReady 检查 manifest 声明的 bundle patch 是否真的落盘：pnpm 中断或原子替换失败时，
 * package.json / lib 可能还在，但 cordis.patch.yml 缺失；DSH 启动会直接 ENOENT。
 * 读取失败一律按未就绪处理，避免把残缺安装误判成可用。
 */
function readMaterializedPackageState() {
  const packageDir = path.join(profileDir(), 'node_modules', ...PLUGIN_NAME.split('/'))
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    const version = (pkg && typeof pkg.version === 'string') ? pkg.version : ''
    const declared = pkg && pkg.dsh && pkg.dsh.bundle ? pkg.dsh.bundle.patch : ''
    let patchReady = false
    if (declared === BUNDLE_PATCH) {
      try {
        const st = fs.statSync(path.join(packageDir, BUNDLE_PATCH.replace(/^\.\//u, '')))
        patchReady = st.isFile()
      } catch { /* 缺文件/读不到都按未就绪 */ }
    }
    return { version, patchReady }
  } catch { return { version: '', patchReady: false } }
}

function readInstalledPackageVersion() {
  return readMaterializedPackageState().version
}

function expectedSpec() {
  // pnpm 的 link: 规格统一用正斜杠（Windows 下反斜杠会解析失败）
  return payload ? ('link:' + payload.linkDir.replace(/\\/gu, '/')) : ''
}

/** 纯函数：去掉 file:/link: 前缀后取规格里的目标名（tgz 文件名 / 目录名）。 */
function specBaseName(spec) {
  return path.basename(String(spec || '').replace(/^file:/u, '').replace(/^link:/u, '').replace(/[\\/]+$/u, ''))
}

function normalizeSpec(spec) {
  return String(spec || '').replace(/\\/gu, '/')
}

function sameSpec(a, b) {
  return normalizeSpec(a) === normalizeSpec(b)
}

/**
 * 纯函数：profile 里的状态是否已经是「本 payload 装的」。
 * materializedVersion 是 node_modules 里实际物化的版本：payload 升版时 tgz 文件名不变
 * （file: 规格相同），只有它能区分「老构建」和「新 payload」，否则老构建会一直留在 profile 里。
 */
function satisfied(cur, want, materializedVersion = '') {
  if (!cur || !cur.installed || !cur.bundle) return false
  if (!want || !want.spec) return false
  const ref = String(cur.spec || '')
  if (!ref.startsWith('file:') && !ref.startsWith('link:')) return false
  if (specBaseName(ref) !== specBaseName(want.spec)) return false
  if (!want.version) return true
  return materializedVersion === want.version
}

function getState() {
  const cur = installed()
  state.installed = cur.installed && cur.bundle
  state.version = cur.version
  state.bundle = cur.bundle
  state.spec = cur.spec
  const materialized = readMaterializedPackageState()
  const want = payload ? { version: payloadInstalledVersion(), spec: expectedSpec() } : null
  const specMatchesPayload = state.installed && !!want && sameSpec(state.spec, want.spec)
    && satisfied(cur, want, materialized.version)
  // 已装但版本/patch/规格与随包 payload 不一致 → 控制台提示可更新/修复
  const outdated = state.installed && !!payload
    && (!materialized.patchReady || materialized.version === '' || materialized.version !== payloadInstalledVersion() || !specMatchesPayload)
  return {
    installed: state.installed,
    version: state.version,
    installedPackageVersion: materialized.version,
    materializedPatchReady: materialized.patchReady,
    specMatchesPayload,
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

/** 把 tar 内的 package/... 路径规范化成安全相对路径；拒绝绝对路径和 ..。 */
function normalizePackageEntryName(name) {
  const raw = String(name || '').replace(/\\/gu, '/').replace(/^\.\//u, '')
  const prefix = 'package/'
  if (!raw.startsWith(prefix)) throw new Error('tar 条目不在 package/ 下：' + raw)
  const rel = raw.slice(prefix.length)
  if (!rel) return ''
  if (rel.startsWith('/') || /^[A-Za-z]:/u.test(rel)) throw new Error('tar 条目路径非法：' + raw)
  const parts = rel.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('tar 条目路径非法：' + raw)
  }
  return parts.join(path.sep)
}

/** 解出 npm pack 的 package/ 内容；只接受普通文件，拒绝链接条目。 */
function extractPackageFromTarball(tgzPath, destDir) {
  const raw = fs.readFileSync(tgzPath)
  if (raw.length === 0 || raw.length > MAX_TARBALL_BYTES) throw new Error('tarball 大小异常')
  const tar = zlib.gunzipSync(raw, { maxOutputLength: MAX_EXTRACTED_BYTES })
  const root = path.resolve(destDir)
  const rootPrefix = root + path.sep
  let offset = 0
  let pendingLongName = ''
  let extractedBytes = 0
  let sawPackageJson = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    if (header.every((b) => b === 0)) break
    const type = String.fromCharCode(header[156])
    const sizeField = tarString(header, 124, 12)
    const size = sizeField ? parseInt(sizeField, 8) : 0
    if (!Number.isInteger(size) || size < 0 || offset + size > tar.length) throw new Error('tar 条目尺寸异常')
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (type === 'L') { pendingLongName = body.toString('utf8').replace(/\0.*$/su, ''); continue }
    const name = pendingLongName || tarString(header, 0, 100)
    pendingLongName = ''
    if (type === 'x' || type === 'g' || type === '5') continue
    if (type !== '0' && type !== '\0' && type !== '') throw new Error('tar 包含不支持条目：' + name)
    const rel = normalizePackageEntryName(name)
    if (!rel) continue
    extractedBytes += body.length
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('payload 解包后超过大小上限')
    const out = path.resolve(root, rel)
    if (!out.startsWith(rootPrefix)) throw new Error('tar 条目路径越界：' + name)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, body)
    if (path.basename(rel) === 'package.json' && path.dirname(rel) === '.') sawPackageJson = true
    const modeField = tarString(header, 100, 8)
    const mode = modeField ? parseInt(modeField, 8) : 0
    if (process.platform !== 'win32' && Number.isInteger(mode) && mode > 0) {
      try { fs.chmodSync(out, mode & 0o777) } catch { /* noop */ }
    }
  }
  if (!sawPackageJson) throw new Error('tarball 内缺少 package/package.json')
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

/** 只在 add/remove 时注入一次放行参数；其它子命令原样透传。只用于命中判定后的那一次重试。 */
function withReleaseAgeOverride(args) {
  const list = Array.isArray(args) ? args : []
  const command = list[0]
  if (command !== 'add' && command !== 'remove') return list
  if (list.includes(RELEASE_AGE_OVERRIDE)) return list
  return [command, RELEASE_AGE_OVERRIDE, ...list.slice(1)]
}

/** 这次失败是不是「24h 观察期拒绝整份 lockfile」（判定口径与 market.js 一致）。 */
function releaseAgeViolation(output) {
  const text = String(output == null ? '' : output)
  return RELEASE_AGE_MARKERS.some((marker) => text.includes(marker))
}

/** 从 pnpm 的判定里抠出被拒条目（名字 + 发布时间），供控制台按本地时间解释「何时自动恢复」。 */
function parseReleaseAgeEntries(output) {
  const text = String(output == null ? '' : output)
  const out = []
  const re = /^\s*(\S+) was published at ([^,\s]+), within the minimumReleaseAge cutoff/gmu
  let m = re.exec(text)
  while (m !== null) {
    if (!out.some((e) => e.name === m[1])) out.push({ name: m[1], publishedAt: m[2] })
    m = re.exec(text)
  }
  return out
}

function captureProcess(child, label) {
  return new Promise((resolve, reject) => {
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
      else {
        const err = new Error(label + ' 退出码 ' + code + (output ? '：' + output.slice(-400) : ''))
        err.exitCode = code
        err.output = output // 完整输出：分类 / 抠条目都靠它（错误文案里只留尾部 400 字）
        reject(err)
      }
    })
  })
}

/** 跑一次 `dsh plugin`（不注入任何放行参数）。 */
async function runCliOnce(args) {
  if (!envDetect) throw new Error('bridge: envDetect 未初始化')
  const env = await envDetect.detectEnv(false)
  if (!env || !env.plan) throw new Error('运行环境未就绪，无法安装远程连接插件')
  cacheInstallModulesDirs(env) // 解析镜像的第三个来源：dsh 安装树
  if (!pnpmReady(env)) {
    const detail = env.pnpm ? (env.pnpm.detail || '未就绪') : '未检测到 pnpm'
    throw new Error('pnpm 未就绪：' + detail + '。请先在运行环境页安装/修复 pnpm。')
  }
  const { nodeCmd, dshBin } = env.plan
  if (!fs.existsSync(dshBin)) throw new Error('DSH 入口不存在：' + dshBin)
  const nodeDir = nodeCmd.includes(path.sep) || nodeCmd.includes('/') ? path.dirname(nodeCmd) : ''
  const pnpmDir = env.pnpm && env.pnpm.path ? path.dirname(env.pnpm.path) : ''
  let child
  try {
    child = spawn(nodeCmd, [dshBin, 'plugin', '--profile', PROFILE_NAME, ...args], {
      cwd: profileDir(),
      env: withToolchainPath(Object.assign({}, process.env, { DSH_HOME: HOME }), [nodeDir, pnpmDir]),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) { throw e }
  return captureProcess(child, 'dsh plugin')
}

/** add/remove 的统一入口：先按策略默认跑，被 24h 观察期整体拒绝时才一次性放行重试一次。 */
async function runCli(args) {
  const list = Array.isArray(args) ? args : []
  try {
    return await runCliOnce(list)
  } catch (e) {
    if (!releaseAgeViolation(e && e.output)) throw e
    const entries = parseReleaseAgeEntries(e && e.output)
    log('pnpm 的 24h 新版本观察期拒绝了整份 lockfile（' + entries.length + ' 个条目）：'
      + (list[0] || '') + ' —— 一次性放行后重试')
    try {
      return await runCliOnce(withReleaseAgeOverride(list))
    } catch (e2) {
      const err = new Error(((e2 && e2.message) || String(e2)) + '（已用一次性放行重试过一次）')
      err.exitCode = e2 && e2.exitCode
      err.output = (e2 && e2.output) || ''
      throw err
    }
  }
}

function resolvePnpmScript(pnpmCmd) {
  const lower = String(pnpmCmd || '').toLowerCase()
  if (lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs')) return pnpmCmd
  const dir = path.dirname(pnpmCmd || '')
  const candidates = [
    path.join(dir, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
    path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || ''
}

async function runPnpm(args, cwd) {
  if (!envDetect) throw new Error('bridge: envDetect 未初始化')
  const env = await envDetect.detectEnv(false)
  if (!env || !env.plan) throw new Error('运行环境未就绪，无法准备远程连接插件依赖')
  cacheInstallModulesDirs(env)
  if (!pnpmReady(env)) {
    const detail = env.pnpm ? (env.pnpm.detail || '未就绪') : '未检测到 pnpm'
    throw new Error('pnpm 未就绪：' + detail + '。请先在运行环境页安装/修复 pnpm。')
  }
  const pnpmCmd = env.pnpm && env.pnpm.path
  if (!pnpmCmd || !fs.existsSync(pnpmCmd)) throw new Error('pnpm 入口不存在：' + (pnpmCmd || '(空)'))
  const nodeCmd = env.plan.nodeCmd
  const pnpmScript = resolvePnpmScript(pnpmCmd)
  if (!pnpmScript) throw new Error('无法定位 pnpm 脚本入口：' + pnpmCmd)
  const nodeDir = nodeCmd.includes(path.sep) || nodeCmd.includes('/') ? path.dirname(nodeCmd) : ''
  const pnpmDir = path.dirname(pnpmCmd)
  let child
  try {
    child = spawn(nodeCmd, [pnpmScript, ...args], {
      cwd,
      env: withToolchainPath(Object.assign({}, process.env, { DSH_HOME: HOME }), [nodeDir, pnpmDir]),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) { throw e }
  return captureProcess(child, 'pnpm')
}

function directDependencyNames() {
  return payload && payload.pkg && payload.pkg.dependencies && typeof payload.pkg.dependencies === 'object'
    ? Object.keys(payload.pkg.dependencies)
    : []
}

function directDependencyReady(dir, name) {
  const roots = [path.join(dir, 'node_modules'), path.join(path.dirname(dir), 'node_modules')]
  for (const root of roots) {
    try {
      if (fs.statSync(path.join(root, ...name.split('/'), 'package.json')).isFile()) return true
    } catch { /* 继续找下一个 root */ }
  }
  return false
}

/** link: 不会让 pnpm 安装被链接包自己的 dependencies；在不可变缓存里单独准备它们。 */
async function installPayloadDependencies() {
  if (!payload) return
  const dir = payload.linkDir
  const missing = directDependencyNames().filter((name) => !directDependencyReady(dir, name))
  if (missing.length === 0) return
  log('准备远程连接插件依赖：' + missing.join('、'))
  const depsDir = path.join(path.dirname(dir), 'deps')
  const modulesDir = path.join(depsDir, 'node_modules')
  const localModules = path.join(dir, 'node_modules')
  fs.mkdirSync(depsDir, { recursive: true })
  fs.writeFileSync(path.join(depsDir, 'package.json'), JSON.stringify({
    name: 'dsh-bridge-next-deps',
    private: true,
    dependencies: payload.pkg.dependencies || {},
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(depsDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await runPnpm([
    'install',
    '--prod',
    '--ignore-scripts',
    '--config.auto-install-peers=false',
    '--config.minimumReleaseAge=0',
    '--config.node-linker=hoisted',
  ], depsDir)
  const stillMissing = directDependencyNames().filter((name) => !fs.existsSync(path.join(modulesDir, ...name.split('/'), 'package.json')))
  if (stillMissing.length > 0) throw new Error('远程连接插件依赖安装不完整：' + stillMissing.join('、'))
  try {
    const st = fs.lstatSync(localModules)
    if (st.isSymbolicLink() && path.resolve(fs.realpathSync(localModules)) === path.resolve(modulesDir)) return
  } catch { /* 不存在：下面创建 */ }
  try { fs.rmSync(localModules, { recursive: true, force: true }) } catch { /* noop */ }
  ensureJunction(localModules, modulesDir)
}

/** 启动前自愈：重建被市场操作剪掉/悬空的 runtime dependency junction，并把解析缺口写进日志。 */
async function ensureRuntimeDeps() {
  if (!payload) return false
  // 先把 dsh 安装树记下来再建镜像：profile 侧缺件时它是唯一还找得到的来源
  try { cacheInstallModulesDirs(await envDetect.detectEnv(false)) } catch { /* 探测失败就退回原来源 */ }
  const dir = materializePayload()
  repairPayloadScopeMirror(dir) // 只报"入口真正 import 却找不到"的包，避免把宿主不 import 的依赖误报成缺口
  await installPayloadDependencies()
  return true
}

// ---------- 启动前 import 自检 ----------

/** 自检子进程的上限：比 CLI 短得多（这里只是 import 一个已经躺在磁盘上的模块）。 */
const IMPORT_CHECK_TIMEOUT_MS = 60 * 1000

/**
 * 纯函数：自检用的 node 参数。用 `-e` 直接在命令行里跑，不留临时文件；
 * 失败时把栈打到 stderr —— DSH 那句 `failed to import` 后面什么都没有。
 * @param {string} entryUrl payload 入口的 file:// URL
 * @returns {string[]}
 */
function importCheckArgs(entryUrl) {
  return [
    '--input-type=module',
    '-e',
    'import(process.argv[1]).then(()=>process.exit(0)).catch((e)=>{console.error(String((e&&(e.stack||e.message))||e));process.exit(1)})',
    entryUrl,
  ]
}

/**
 * 纯函数：把自检子进程的结果翻成 `{ ok, error }`。
 * 只留第一条有信息量的行（`Cannot find package …` / `does not provide an export named …` /
 * `SyntaxError …`），别把整段栈塞进卡片。
 */
function importCheckResult(code, output) {
  if (code === 0) return { ok: true, error: '' }
  const lines = String(output == null ? '' : output).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const informative = lines.find((l) => /(Error|Cannot find|does not provide|ERR_[A-Z_]+|not defined)/u.test(l))
  return { ok: false, error: informative || lines[0] || ('自检进程退出码 ' + code) }
}

/**
 * 用**运行中的 Node** 试着 import payload 入口（与 DSH 启动时的解析环境一致：cwd 在 payload 目录，
 * 依赖走 payload 旁边的镜像）。
 *
 * 只读、失败只记账不抛。调用方负责把结果写进日志/卡片；失败绝不阻断服务启动。
 * @param {string} [target] 要自检的 payload 目录；默认取当前 payload 的 link: 目录（测试可直接传目录）
 * @returns {Promise<{ok:boolean, error:string}>}
 */
async function importCheckPayload(target) {
  const dir = target || (payload && payload.linkDir) || ''
  if (!dir) return { ok: false, error: payloadError || 'payload 不可用' }
  if (!envDetect) return { ok: false, error: 'envDetect 未初始化' }
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch (e) {
    return { ok: false, error: '读不到 payload manifest：' + ((e && e.message) || String(e)) }
  }
  const entry = entryFileOf(pkg)
  if (!entry) return { ok: false, error: 'payload manifest 的入口路径非法' }
  let nodeCmd = ''
  try {
    const env = await envDetect.detectEnv(false)
    nodeCmd = (env && env.plan && env.plan.nodeCmd) || ''
  } catch (e) {
    return { ok: false, error: '探测运行环境失败：' + ((e && e.message) || String(e)) }
  }
  if (!nodeCmd) return { ok: false, error: '未检测到可用的 Node，无法自检' }
  const entryUrl = pathToFileURL(path.join(dir, entry)).href
  let child
  try {
    child = spawn(nodeCmd, importCheckArgs(entryUrl), { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    return { ok: false, error: '自检进程无法启动：' + ((e && e.message) || String(e)) }
  }
  const killer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, IMPORT_CHECK_TIMEOUT_MS)
  try {
    const r = await captureProcess(child, 'payload import 自检')
    return importCheckResult(r.code, r.output)
  } catch (e) {
    return importCheckResult(e && e.exitCode, (e && e.output) || (e && e.message))
  } finally {
    clearTimeout(killer)
  }
}

// ---------- 安装 / 卸载 ----------

/** 纯函数：判断是否需要安装 —— want.spec 为空（payload 不可用）时永不自动动 profile。 */
function needsInstall(cur, want, materializedVersion = '') {
  if (!want || !want.spec) return false
  return !satisfied(cur, want, materializedVersion)
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
    // 建镜像前先记下 dsh 安装树（profile 侧缺件时它是最后的来源）
    try { cacheInstallModulesDirs(await envDetect.detectEnv(false)) } catch { /* 退回原来源 */ }
    materializePayload()
    await installPayloadDependencies()
    const want = { version: payload.version, spec: expectedSpec() }
    const before = installed()
    const materialized = readMaterializedPackageState()
    if (!opts.force && materialized.patchReady && sameSpec(before.spec, want.spec) && !needsInstall(before, want, materialized.version)) {
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
    if (!readMaterializedPackageState().patchReady) {
      throw new Error('安装后插件缺少 dsh.bundle.patch 文件')
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
  withReleaseAgeOverride,
  releaseAgeViolation,
  parseReleaseAgeEntries,
  satisfied,
  verifyPluginManifest,
  entryFileOf,
  repairPayloadScopeMirror,
  cacheInstallModulesDirs,
  installTreeCandidates,
  entryImportSpecifiers,
  importCheckPayload,
  importCheckArgs,
  importCheckResult,
  readPackageFromTarball,
  readMaterializedPackageState,
  materializePayload,
  ensureRuntimeDeps,
  expectedSpec,
  sameSpec,
  pnpmReady,
  PLUGIN_NAME,
  PROFILE_NAME,
  BUNDLE_PATCH,
}





