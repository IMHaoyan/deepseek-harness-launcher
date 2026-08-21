// env-detect.js — 环境探测：Node.js 运行时 / DSH 安装形态（源码、全局、npx 缓存、托管）/ 通知插件
//
// 探测结果被 startServer 直接消费（plan.spawn 参数），也供面板"运行环境"页展示。
// 优先级（第一个可用者胜出）：
//   Node：Config.nodePath → PATH node → 用户级目录（%LOCALAPPDATA%\Programs\nodejs）→ 托管目录 → macOS 常见路径
//   DSH ：显式/默认源码仓库（E:\deepseek-harness、~/deepseek-harness）→ 全局 npm 目录 → 托管目录 → npx 缓存
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const semver = require('semver')
const { execFile } = require('child_process')

// DSH 仓库 engines：node ^22.19.0 || >=24.0.0；已安装的 DSH 包自带 engines.node 时以它为准
const DEFAULT_ENGINE_RANGE = '^22.19.0 || >=24.0.0'
const CACHE_MS = 30000

const IS_WIN = process.platform === 'win32'

let HOME = path.join(os.homedir(), '.dsh') // 始终为真实用户 HOME（安装物/插件都落在真实 HOME）
let Config = { harnessRoot: '', nodePath: '', dshVersion: '0.1.0-rc.6', nodeMajor: 22 }
let logFn = () => {}
let FRESH_TEST = false // DSHL_FRESH_TEST=1：模拟全新机器（无视系统级 node/源码仓库/全局/npx 缓存，只认托管安装）

function initEnv(opts = {}) {
  if (opts.realHome) HOME = opts.realHome
  if (opts.Config) Config = opts.Config
  if (opts.log) logFn = opts.log
  FRESH_TEST = process.env.DSHL_FRESH_TEST === '1'
}

function log(message) {
  try { logFn('[env] ' + message) } catch { /* noop */ }
}

function runtimeBase() {
  return path.join(HOME, 'dshl-runtime')
}

function managedNodeDir() {
  return path.join(runtimeBase(), 'node')
}

// 用户级 Node 安装目录（dshl 一键安装落位；与 env-install.userNodeDir 保持一致）
function userNodeDir() {
  if (process.env.DSHL_USER_NODE_DIR) return process.env.DSHL_USER_NODE_DIR
  if (!IS_WIN) return null
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'Programs', 'nodejs')
}

function managedDshDir() {
  return path.join(runtimeBase(), 'dsh')
}

function pluginPath() {
  return path.join(HOME, 'plugins', 'dsh-notify', 'dsh-notify.mjs')
}

// ---------- 通用工具 ----------

function runNode(c, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(c, args, { windowsHide: true, timeout }, (err, stdout) => {
        if (err) return resolve(null)
        const out = String(stdout || '').trim()
        resolve(out)
      })
    } catch { resolve(null) }
  })
}

function readDshPackage(pkgFile) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    if (!pkg || pkg.name !== '@deepseek-ai/dsh') return null
    return pkg
  } catch { return null }
}

// 读取某目录下已安装的 @deepseek-ai/dsh 包：{ dir, version, engines, binPath, built }
function readDshAt(dir) {
  try {
    const pkg = readDshPackage(path.join(dir, 'package.json'))
    if (!pkg) return null
    const binPath = path.join(dir, 'lib', 'bin.js')
    return {
      dir,
      version: pkg.version || '',
      engines: pkg.engines && typeof pkg.engines.node === 'string' ? pkg.engines.node : null,
      binPath,
      built: fs.existsSync(binPath),
    }
  } catch { return null }
}

function defaultSourceRoot() {
  if (IS_WIN) return 'E:\\deepseek-harness'
  return path.join(os.homedir(), 'deepseek-harness')
}

function globalRoots() {
  const roots = []
  if (process.env.DSHL_NPM_GLOBAL_ROOT) {
    roots.push(path.join(process.env.DSHL_NPM_GLOBAL_ROOT, 'node_modules')) // 测试/演示覆盖
  }
  if (IS_WIN) {
    roots.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules'))
    roots.push(path.join(process.env.ProgramData || '', 'npm', 'node_modules'))
  } else {
    roots.push('/usr/local/lib/node_modules')
    roots.push('/usr/lib/node_modules')
    roots.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'))
    roots.push('/opt/homebrew/lib/node_modules')
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    try {
      for (const v of fs.readdirSync(nvmDir)) roots.push(path.join(nvmDir, v, 'lib', 'node_modules'))
    } catch { /* no nvm */ }
    const voltaDir = path.join(os.homedir(), '.volta', 'tools', 'image', 'node')
    try {
      for (const v of fs.readdirSync(voltaDir)) roots.push(path.join(voltaDir, v, 'lib', 'node_modules'))
    } catch { /* no volta */ }
  }
  return roots
}

function npxCacheRoots() {
  const roots = []
  if (IS_WIN) {
    roots.push(path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'))
  }
  roots.push(path.join(os.homedir(), '.npm', '_npx'))
  return roots
}

function nodeCandidates() {
  const list = []
  if (!FRESH_TEST && Config.nodePath) list.push({ path: Config.nodePath, source: 'config' })
  if (!FRESH_TEST) list.push({ path: 'node', source: 'system' })
  // 用户级 Node（dshl 一键安装落位；PATH 广播后系统候选也能命中，这里兜底 dshl 自身进程）
  const un = userNodeDir()
  if (un) {
    const bin = path.join(un, IS_WIN ? 'node.exe' : 'node')
    if (fs.existsSync(bin)) list.push({ path: bin, source: 'user' })
  }
  // 托管 Node（旧版 dshl 落位；版本目录名即版本号，取满足范围的最新版；具体版本由探测确认）
  try {
    const base = managedNodeDir()
    const dirs = fs.readdirSync(base)
      .map((d) => d.replace(/^v/, ''))
      .sort((a, b) => semver.rcompare(a, b))
    for (const d of dirs) {
      const bin = path.join(base, d, IS_WIN ? 'node.exe' : 'node')
      if (fs.existsSync(bin)) list.push({ path: bin, source: 'managed' })
    }
  } catch { /* 无托管 Node */ }
  if (!FRESH_TEST && !IS_WIN) {
    const home = os.homedir()
    for (const p of [
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
      '/opt/homebrew/opt/node/bin/node',
      '/usr/local/opt/node/bin/node',
      path.join(home, '.volta', 'bin', 'node'),
      path.join(home, '.n', 'bin', 'node'),
      path.join(home, '.nvm', 'current', 'bin', 'node'),
    ]) list.push({ path: p, source: 'system' })
  }
  return list
}

// ---------- 探测：Node ----------

async function detectNode(range) {
  const candidates = nodeCandidates()
  let best = null // 已发现的最高版本（用于 tooOld 提示）
  let firstMissingExplicit = null
  for (const c of candidates) {
    const v = await runNode(c.path, ['-v'])
    if (v === null) {
      if (c.source === 'config') firstMissingExplicit = c.path
      continue
    }
    const clean = v.replace(/^v/, '')
    if (!best || semver.gt(clean, best.version)) best = { path: c.path, version: clean, source: c.source }
    if (semver.satisfies(clean, range, { includePrerelease: true })) {
      return { status: 'ok', path: c.path, version: clean, source: c.source }
    }
  }
  if (firstMissingExplicit) return { status: 'missing', path: firstMissingExplicit, version: null, detail: '配置的 nodePath 不可用' }
  if (best) return { status: 'tooOld', path: best.path, version: best.version, source: best.source, detail: `需要 ${range}` }
  return { status: 'missing', path: null, version: null }
}

// ---------- 探测：DSH（四种形态） ----------

function detectDshEntries() {
  const entries = [] // { kind, ...readDshAt, built }，按优先级排列
  let sourceFound = false
  if (FRESH_TEST) {
    // 全新机模拟：无视系统级安装（源码仓库/全局/npx 缓存），只认 dshl 自装物
    // （托管目录；DSHL_NPM_GLOBAL_ROOT 覆盖时一并识别——安装完成后即可被发现）
    const dir = path.join(managedDshDir(), 'node_modules', '@deepseek-ai', 'dsh')
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const e = readDshAt(dir)
      if (e && e.built) entries.push({ kind: 'managed', ...e })
    }
    const override = process.env.DSHL_NPM_GLOBAL_ROOT
    if (override) {
      const dir2 = path.join(override, 'node_modules', '@deepseek-ai', 'dsh')
      if (fs.existsSync(path.join(dir2, 'package.json'))) {
        const e2 = readDshAt(dir2)
        if (e2 && e2.built) entries.push({ kind: 'global', ...e2 })
      }
    }
    return { entries, sourceFound }
  }
  // 1) 源码仓库（显式配置 + 默认路径）
  const roots = []
  if (Config.harnessRoot) roots.push(Config.harnessRoot)
  roots.push(defaultSourceRoot())
  for (const root of [...new Set(roots)]) {
    if (!fs.existsSync(root)) {
      if (root === Config.harnessRoot) log('configured harness root not found: ' + root)
      continue
    }
    sourceFound = true
    const cliDir = path.join(root, 'apps', 'cli')
    const e = readDshAt(cliDir)
    if (e) {
      entries.push({ kind: 'source', ...e })
    } else {
      // 仓库存在但 apps/cli 缺失/未构建
      entries.push({ kind: 'source', dir: root, version: '', engines: null, binPath: path.join(cliDir, 'lib', 'bin.js'), built: false })
    }
  }
  // 2) 全局 npm 目录
  for (const root of globalRoots()) {
    const dir = path.join(root, '@deepseek-ai', 'dsh')
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    const e = readDshAt(dir)
    if (e && e.built) entries.push({ kind: 'global', ...e })
  }
  // 3) 托管目录（旧版 dshl 一键安装落位；同样由 npm 安装，优先于 npx 缓存）
  {
    const dir = path.join(managedDshDir(), 'node_modules', '@deepseek-ai', 'dsh')
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const e = readDshAt(dir)
      if (e && e.built) entries.push({ kind: 'managed', ...e })
    }
  }
  // 4) npx 缓存（多个 hash 目录取最高版本）
  const npxEntries = []
  for (const base of npxCacheRoots()) {
    let subs = []
    try { subs = fs.readdirSync(base) } catch { continue }
    for (const sub of subs) {
      const dir = path.join(base, sub, 'node_modules', '@deepseek-ai', 'dsh')
      if (!fs.existsSync(path.join(dir, 'package.json'))) continue
      const e = readDshAt(dir)
      if (e && e.built) npxEntries.push({ kind: 'npx', ...e })
    }
  }
  if (npxEntries.length) {
    npxEntries.sort((a, b) => semver.rcompare(a.version || '0.0.0', b.version || '0.0.0'))
    entries.push(npxEntries[0])
  }
  return { entries, sourceFound }
}

function detectPlugin() {
  const p = pluginPath()
  if (fs.existsSync(p)) return { status: 'ok', path: p }
  return { status: 'missing', path: p }
}

function buildPlan(node, dsh) {
  if (!dsh || !dsh.built) return null
  if (!node || node.status !== 'ok') return null
  return {
    nodeCmd: node.path,
    dshBin: dsh.binPath,
    kind: dsh.kind,
    // 源码版沿用历史行为：以仓库根为工作目录（原实现 cwd=harnessRoot）；其余形态用包目录
    cwd: dsh.kind === 'source' ? path.resolve(dsh.dir, '..', '..') : path.dirname(dsh.dir),
    dshVersion: dsh.version,
  }
}

async function buildReport() {
  const { entries } = detectDshEntries()
  const sourceEntry = entries.find((e) => e.kind === 'source') || null
  // 选中：按优先级取第一个"已构建"的安装；源码存在但未构建时不占用名额，可回退到其他形态
  let dsh = entries.find((e) => e.built) || null
  if (!dsh && sourceEntry) dsh = sourceEntry // 只有未构建的源码 → 以 unbuilt 状态呈现
  const dshAlternatives = entries.filter((e) => e !== dsh)
  const range = (dsh && dsh.engines) || DEFAULT_ENGINE_RANGE
  const node = await detectNode(range)
  const plugin = detectPlugin()

  const issues = []
  if (node.status === 'missing') issues.push('未检测到 Node.js 运行时')
  else if (node.status === 'tooOld') issues.push(`Node.js 版本过低：${node.version || '未知'}（DSH 需要 ${range}）`)
  if (sourceEntry && !sourceEntry.built) {
    issues.push('检测到源码版 DeepSeek Harness，但尚未构建（缺少 apps/cli/lib/bin.js，需在仓库运行 pnpm install && pnpm run build）')
  }
  if (!dsh || !dsh.built) {
    if (!sourceEntry) issues.push('未检测到 DeepSeek Harness')
  }
  if (dsh && dsh.built && sourceEntry && !sourceEntry.built) {
    const label = dsh.kind === 'managed' ? '托管安装' : dsh.kind === 'global' ? '全局 npm 安装' : 'npx 缓存'
    issues.push(`当前将使用${label}的 DSH（v${dsh.version || '?'}），源码版构建完成后自动优先使用源码版`)
  }
  if (plugin.status === 'missing') issues.push('通知插件缺失（会话完成/提问将无法弹出托盘通知）')
  if (dsh && dsh.built && (dsh.kind === 'managed' || dsh.kind === 'npx')) {
    issues.push(`检测到 ${dsh.kind === 'managed' ? '托管' : 'npx'} 形态的 DSH（v${dsh.version || '?'}），将自动迁移到全局 npm 安装（迁移失败不影响当前使用）`)
  }

  const plan = buildPlan(node, dsh)
  return {
    ready: !!plan,
    engineRange: range,
    node,
    dsh: dsh ? {
      status: dsh.built ? 'ok' : 'unbuilt',
      kind: dsh.kind,
      version: dsh.version || '',
      dir: dsh.dir,
      binPath: dsh.binPath,
      built: !!dsh.built,
      engines: dsh.engines,
    } : { status: 'missing', kind: 'none', version: '', dir: null, binPath: null, built: false },
    source: { found: !!sourceEntry, built: !!(sourceEntry && sourceEntry.built), dir: (sourceEntry && sourceEntry.dir) || null, version: (sourceEntry && sourceEntry.version) || '' },
    plugin,
    alternatives: dshAlternatives.map((e) => ({ kind: e.kind, version: e.version || '', dir: e.dir })),
    plan,
    issues,
    at: Date.now(),
  }
}

// ---------- 对外 ----------

let detectSeq = 0 // 每次实际探测的序号：晚发起的探测优先级更高
let cache = { at: 0, seq: 0, report: null }
let inFlight = null // 非强制检测共享同一个在途 Promise，避免 onTick 每 2s 堆积并发探测

async function detectEnv(force = false) {
  if (!force && cache.report && Date.now() - cache.at < CACHE_MS) return cache.report
  if (!force && inFlight) return inFlight
  const mySeq = ++detectSeq
  const run = async () => {
    try {
      const report = await buildReport()
      // 仅当没有更晚发起的探测抢先落缓存时才写入，防止安装期间的旧探测覆盖安装完成后的新结果
      if (mySeq >= cache.seq) cache = { at: Date.now(), seq: mySeq, report }
      return report
    } finally {
      if (!force) inFlight = null
    }
  }
  if (force) return run()
  inFlight = run()
  return inFlight
}

// 面板展示用摘要（含路径，供 UI 展示；避免暴露过多内部结构）
function envSummary(report) {
  if (!report) return null
  return {
    ready: !!report.plan,
    engineRange: report.engineRange,
    node: { status: report.node.status, version: report.node.version, path: report.node.path, source: report.node.source },
    dsh: { status: report.dsh.status, kind: report.dsh.kind, version: report.dsh.version, built: report.dsh.built, dir: report.dsh.dir },
    source: report.source,
    plugin: { status: report.plugin.status, path: report.plugin.path },
    issues: report.issues,
  }
}

module.exports = {
  DEFAULT_ENGINE_RANGE,
  initEnv,
  detectEnv,
  envSummary,
  runtimeBase,
  managedNodeDir,
  managedDshDir,
  userNodeDir,
  pluginPath,
}
