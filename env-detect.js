// env-detect.js — 环境探测：Node.js / pnpm 运行时 / DSH 安装形态（源码、全局、npx 缓存、托管）/ 通知插件
//
// 探测结果被 startServer 直接消费（plan.spawn 参数），也供控制台"运行环境"页展示。
// 优先级（第一个可用者胜出）：
//   Node：Config.nodePath → PATH node → 用户级目录（%LOCALAPPDATA%\Programs\nodejs）→ 托管目录 → macOS 常见路径
//   DSH ：显式/默认源码仓库（E:\deepseek-harness、~/deepseek-harness）→ 全局 npm 根 → 托管目录 → npx 缓存
//         全局 npm 根按"安装侧记账值 → 生效 Node 目录 → %APPDATA%\npm 等默认值"取候选，
//         都没命中时再问一次 npm 自己的 prefix（详见 globalPrefixes / readNpmPrefix）
//   pnpm：PATH 上最终生效的 pnpm（Corepack / npm 全局 / 其他 PATH 安装）
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const semver = require('semver')
const { execFile } = require('child_process')

// DSH 仓库 engines：node ^22.19.0 || >=24.0.0；已安装的 DSH 包自带 engines.node 时以它为准
const DEFAULT_ENGINE_RANGE = '^22.19.0 || >=24.0.0'
const DEFAULT_PNPM_VERSION = '11.8.0'
const CACHE_MS = 30000

const IS_WIN = process.platform === 'win32'

let HOME = path.join(os.homedir(), '.dsh') // 始终为真实用户 HOME（安装物/插件都落在真实 HOME）
// npmGlobalRoot：安装侧（env-install.resolveGlobalRoot）记账的"实际使用的 npm 前缀"。
// 它是探测与安装之间唯一的事实源——不记账就只能靠 %APPDATA%\npm 这类默认值猜，一旦猜错就是
// "安装完成却报未检测到 DSH"（zip 版 Node 的 npm 内建前缀 = node.exe 所在目录，见 globalPrefixes）。
let Config = { harnessRoot: '', nodePath: '', dshVersion: 'latest', pnpmVersion: DEFAULT_PNPM_VERSION, nodeMajor: 22, npmGlobalRoot: '' }
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

function runText(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout) => {
        resolve(err ? '' : String(stdout || '').trim())
      })
    } catch { resolve('') }
  })
}

// 查找 PATH 上所有同名可执行文件；Windows 使用 where.exe，POSIX 使用 which -a。
async function executableCandidates(name) {
  const finder = IS_WIN ? 'where.exe' : 'which'
  const args = IS_WIN ? [name] : ['-a', name]
  const out = await runText(finder, args)
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

// Windows 上命令实际优先由 .cmd/.exe/.bat 提供；POSIX 取第一个。
function preferredPnpmCandidate(candidates) {
  if (!candidates.length) return ''
  if (!IS_WIN) return candidates[0]
  return candidates.find((p) => /\.(cmd|exe|bat)$/i.test(p)) || candidates[0]
}

function readTextSafe(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

// 判断 PATH 上这个 pnpm 的来源：Corepack shim / npm 全局 / 其他 PATH 安装。
function classifyPnpmCommand(file, content) {
  if (String(content || '').toLowerCase().includes('corepack')) return 'corepack'
  const normalized = path.resolve(file || '').toLowerCase()
  const roots = []
  if (IS_WIN) {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm'))
    if (process.env.ProgramData) roots.push(path.join(process.env.ProgramData, 'npm'))
  } else {
    roots.push('/usr/local', '/usr/lib')
  }
  const inRoot = roots.some((root) => {
    const r = path.resolve(root).toLowerCase()
    return normalized === r || normalized.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
  })
  return inRoot ? 'npm-global' : 'path'
}

function parsePnpmVersion(output) {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(output || ''))
  return match ? match[1] : ''
}

async function readEffectivePnpmVersion() {
  const output = IS_WIN
    ? await runText('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'])
    : await runText('pnpm', ['--version'])
  return parsePnpmVersion(output)
}

// 探测 PATH 上最终生效的 pnpm，并给出路径/版本/来源；不修改任何环境。
async function detectPnpm(options = {}) {
  const expectedVersion = options.expectedVersion || Config.pnpmVersion || DEFAULT_PNPM_VERSION
  const candidates = await executableCandidates('pnpm')
  const pnpmPath = preferredPnpmCandidate(candidates)
  const version = await readEffectivePnpmVersion()
  const source = pnpmPath ? classifyPnpmCommand(pnpmPath, readTextSafe(pnpmPath)) : ''
  if (!pnpmPath && !version) {
    return { status: 'missing', version: '', path: '', source: '', expectedVersion, detail: '未检测到 pnpm' }
  }
  const status = version && version === expectedVersion ? 'ok' : version ? 'mismatch' : 'missing'
  const detail = status === 'ok'
    ? (source === 'corepack' ? 'Corepack 管理' : source === 'npm-global' ? 'npm 全局安装' : 'PATH 安装')
    : version
      ? `当前 v${version}，期望 v${expectedVersion}`
      : 'pnpm 存在但无法读取版本'
  return { status, version, path: pnpmPath, source, expectedVersion, detail }
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

// 从已安装包目录反推 npm 前缀：<prefix>/node_modules/@deepseek-ai/dsh → <prefix>；形态不符返回 ''。
// 安装/更新用它与探测结果对齐（"装到哪儿就更新哪儿"），避免出现两份 DSH。
function npmPrefixOf(installDir) {
  const dir = String(installDir || '')
  if (!dir) return ''
  const scopeDir = path.dirname(dir) // <prefix>/node_modules/@deepseek-ai（作用域目录还要再上一层）
  const nmDir = path.dirname(scopeDir) // <prefix>/node_modules
  return path.basename(nmDir) === 'node_modules' ? path.dirname(nmDir) : ''
}

function defaultSourceRoot() {
  if (IS_WIN) return 'E:\\deepseek-harness'
  return path.join(os.homedir(), 'deepseek-harness')
}

// 生效 Node 可能落位的目录（dshl 自装用户级目录 / 旧版托管目录 / 显式配置的 nodePath 目录）。
// 它们同时可能是"npm 全局根"：npm 内建默认前缀就是 node.exe 所在目录，官方 zip 发行版没有
// MSI 那份 `prefix=${APPDATA}\npm` 的 npmrc —— dshl 一键安装用的正是内置 zip。见 globalPrefixes。
function nodeDirs() {
  const dirs = []
  if (Config.nodePath && path.isAbsolute(Config.nodePath)) dirs.push(path.dirname(Config.nodePath))
  const un = userNodeDir()
  if (un) dirs.push(un)
  const base = managedNodeDir()
  try {
    for (const d of fs.readdirSync(base)) dirs.push(path.join(base, d))
  } catch { /* 无托管 Node */ }
  return dirs
}

// npm 全局前缀候选（按优先级，返回前缀本身、不含 node_modules）：
//   1) DSHL_NPM_GLOBAL_ROOT：测试/隔离覆盖，与安装侧 resolveGlobalRoot 同源
//   2) Config.npmGlobalRoot：安装侧记账的"上次实际使用的 npm 前缀"（唯一事实源）
//   3) 生效 Node 目录：npm 内建默认前缀 = node.exe 所在目录（官方 zip 版 Node 没有
//      `prefix=${APPDATA}\npm` 覆盖）→ DSH 落在 <nodeDir>\node_modules\@deepseek-ai\dsh
//   4) %APPDATA%\npm / %ProgramData%\npm 等默认值：MSI/官方安装器的默认全局根
// 只认默认值就会漏掉 3) 这类机器：安装报 done、探测却报"未检测到 DeepSeek Harness"（v1.4.4 反馈）。
// 候选全都没命中时，buildReport 还会问一次 npm 自己的 prefix（readNpmPrefix）兜底。
function globalPrefixes() {
  const roots = []
  const push = (dir) => {
    if (typeof dir !== 'string') return
    const d = dir.trim()
    if (d) roots.push(d)
  }
  push(process.env.DSHL_NPM_GLOBAL_ROOT)
  push(Config.npmGlobalRoot)
  for (const d of nodeDirs()) push(d)
  if (IS_WIN) {
    if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm'))
    if (process.env.ProgramData) push(path.join(process.env.ProgramData, 'npm'))
  } else {
    push('/usr/local')
    push('/usr/lib')
    push(path.join(os.homedir(), '.npm-global'))
    push('/opt/homebrew')
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    try {
      for (const v of fs.readdirSync(nvmDir)) push(path.join(nvmDir, v))
    } catch { /* no nvm */ }
    const voltaDir = path.join(os.homedir(), '.volta', 'tools', 'image', 'node')
    try {
      for (const v of fs.readdirSync(voltaDir)) push(path.join(voltaDir, v))
    } catch { /* no volta */ }
  }
  const seen = new Set()
  const out = []
  for (const r of roots) {
    const key = path.resolve(r).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
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
    // 全新机模拟：无视系统级安装（源码仓库/全局/npx 缓存），只认 dshl 自装物：
    //   托管目录；自装 Node 目录（npm 内建前缀就是它）；DSHL_NPM_GLOBAL_ROOT 覆盖；
    //   npm 默认全局根（%APPDATA%\npm）—— 官方 MSI 现在就装到这儿，它同样是"dshl 自装物"；
    //   以及安装侧记账的前缀。
    const dirs = nodeDirs()
    if (process.env.DSHL_NPM_GLOBAL_ROOT) dirs.push(process.env.DSHL_NPM_GLOBAL_ROOT)
    if (IS_WIN && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
    if (Config.npmGlobalRoot) dirs.push(Config.npmGlobalRoot)
    for (const prefix of dirs) {
      const dir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
      if (!fs.existsSync(path.join(dir, 'package.json'))) continue
      const e = readDshAt(dir)
      if (e && e.built) entries.push({ kind: 'global', root: prefix, ...e })
    }
    const dir = path.join(managedDshDir(), 'node_modules', '@deepseek-ai', 'dsh')
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const e = readDshAt(dir)
      if (e && e.built) entries.push({ kind: 'managed', ...e })
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
  // 2) 全局 npm 目录（前缀候选见 globalPrefixes；条目记下 prefix 供诊断与更新锚定）
  for (const prefix of globalPrefixes()) {
    const dir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    const e = readDshAt(dir)
    if (e && e.built) entries.push({ kind: 'global', root: prefix, ...e })
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

// 自装 Node 目录的"旧布局"事实：dshl 曾用官方 zip 把 Node 装到用户级目录，全局包（含 DSH）也跟着
// 落在那个目录里。官方 MSI 成为默认安装方式之后，这类机器需要一个**显式**迁移入口（提示，不静默
// 改环境）：报告里先把这个事实带出来，UI/诊断据此提示"迁移到官方安装（只迁移 DSH）"。
function legacyUserNodeLayout() {
  const dir = userNodeDir()
  if (!dir) return null
  const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  const e = readDshAt(pkgDir)
  if (!e) return null
  const globals = []
  const nm = path.join(dir, 'node_modules')
  try {
    for (const ent of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === '.bin') continue
      if (!ent.name.startsWith('@')) { globals.push(ent.name); continue }
      try {
        for (const s of fs.readdirSync(path.join(nm, ent.name))) globals.push(ent.name + '/' + s)
      } catch { /* 读不到这个 scope 就跳过 */ }
    }
  } catch { /* 目录读不到就当作没有其他全局包 */ }
  return {
    dir,
    version: e.version || '',
    built: e.built,
    // 排除 DSH 自己那份与 Node 发行版自带的包（npm/corepack）：UI 里那句"N 个全局包"指的是用户自己装的
    otherGlobals: globals.filter((g) => g !== '@deepseek-ai/dsh' && g !== 'npm' && g !== 'corepack'),
  }
}

function detectPlugin() {
  const p = pluginPath()
  if (fs.existsSync(p)) return { status: 'ok', path: p }
  return { status: 'missing', path: p }
}

// ---------- 探测：npm 自己的全局前缀（安装侧落包的唯一依据） ----------

let npmPrefixMemo = { key: '\u0000', value: '' } // 记忆"这个 node + 这套 npm 配置"的答案，避免周期性检测反复起进程

// npm 的答案会随这几项变化（npm_config_prefix 等环境变量优先级高于 npmrc），缓存键必须带上它们，
// 否则环境一变（换 Node、改 .npmrc、父进程注入 npm_config_*）就会拿着旧答案去找
function npmPrefixEnvKey() {
  return [
    process.env.APPDATA || '',
    process.env.ProgramData || '',
    process.env.USERPROFILE || process.env.HOME || '',
    process.env.npm_config_prefix || '',
    process.env.npm_config_userconfig || '',
    process.env.npm_config_globalconfig || '',
  ].join('\u0000')
}

// 归一化 `npm config get prefix` 的输出：必须是非空绝对路径，否则按"没拿到"处理（fail-closed）
function normalizeNpmPrefix(text) {
  const s = String(text || '').trim().replace(/^"(.*)"$/, '$1').trim()
  if (!s || !/[/\\]/.test(s)) return ''
  return path.isAbsolute(s) ? s : ''
}

// 问 npm 要它的全局前缀 —— 安装侧 resolveGlobalRoot 用的就是这个答案，探测侧问同一个问题才叫同源。
// 只在其它形态都没找到"已构建"的 DSH 时才调用：正常机器上一次都不会跑。
async function readNpmPrefix(nodeBin) {
  const key = String(nodeBin || 'node') + '\u0001' + npmPrefixEnvKey()
  if (npmPrefixMemo.key === key) return npmPrefixMemo.value
  let value = ''
  if (nodeBin && path.isAbsolute(nodeBin)) {
    const cli = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (fs.existsSync(cli)) value = normalizeNpmPrefix(await runNode(nodeBin, [cli, 'config', 'get', 'prefix'], 20000))
  }
  if (!value) {
    // 回退到 PATH 上的 npm（Windows 上 npm 是 .cmd，必须经 cmd.exe 调用）
    value = normalizeNpmPrefix(IS_WIN
      ? await runText('cmd.exe', ['/d', '/s', '/c', 'npm config get prefix'], 20000)
      : await runText('npm', ['config', 'get', 'prefix'], 20000))
  }
  npmPrefixMemo = { key, value }
  return value
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
  const range = (dsh && dsh.engines) || DEFAULT_ENGINE_RANGE
  const node = await detectNode(range)
  // 尾查（只在一个"能跑的安装"都没找到时执行）：问 npm 它真正的全局前缀，再按它找一次。
  // 探测与安装必须同源——安装侧就是 `npm i -g --prefix <resolveGlobalRoot()>` 落的包；
  // 光凭 %APPDATA%\npm 这类默认值去猜，会漏掉 zip 版 Node（内建前缀 = node.exe 所在目录）
  // 与自定义 .npmrc prefix 的机器，表现为"安装报完成、探测报未检测到 DeepSeek Harness"。
  let npmPrefix = ''
  if (!dsh || !dsh.built) {
    npmPrefix = await readNpmPrefix(node && node.status === 'ok' ? node.path : null)
    if (npmPrefix) {
      const dir = path.join(npmPrefix, 'node_modules', '@deepseek-ai', 'dsh')
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        const e = readDshAt(dir)
        if (e && e.built) {
          dsh = { kind: 'global', root: npmPrefix, ...e }
          entries.push(dsh)
        }
      }
    }
  }
  const dshAlternatives = entries.filter((e) => e !== dsh)
  const plugin = detectPlugin()
  const pnpm = await detectPnpm({ expectedVersion: Config.pnpmVersion || DEFAULT_PNPM_VERSION })

  const issues = []
  if (node.status === 'missing') issues.push('未检测到 Node.js 运行时')
  else if (node.status === 'tooOld') issues.push(`Node.js 版本过低：${node.version || '未知'}（DSH 需要 ${range}）`)
  if (sourceEntry && !sourceEntry.built) {
    issues.push('检测到源码版 DeepSeek Harness，但尚未构建（缺少 apps/cli/lib/bin.js，需在仓库运行 pnpm install && pnpm run build）')
  }
  if (!dsh || !dsh.built) {
    if (!sourceEntry) {
      // 带上"查过的 npm 全局根"：用户看到这条时，终端里的 dsh 往往还是能用的，
      // 有这条线索才能一眼看出两边说的不是同一个目录（v1.4.4 反馈的现场就是这个）
      issues.push(npmPrefix ? `未检测到 DeepSeek Harness（已查 npm 全局根：${npmPrefix}）` : '未检测到 DeepSeek Harness')
    }
  }
  if (dsh && dsh.built && sourceEntry && !sourceEntry.built) {
    const label = dsh.kind === 'managed' ? '托管安装' : dsh.kind === 'global' ? '全局 npm 安装' : 'npx 缓存'
    issues.push(`当前将使用${label}的 DSH（v${dsh.version || '?'}），源码版构建完成后自动优先使用源码版`)
  }
  if (pnpm.status === 'missing') issues.push('未检测到 pnpm（dsh plugin / 插件市场需要）')
  else if (pnpm.status === 'mismatch') issues.push(`pnpm 版本不匹配：当前 v${pnpm.version}，期望 v${pnpm.expectedVersion}（dsh plugin / 插件市场使用）`)
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
      root: dsh.root || null, // 全局安装所在的 npm 前缀（诊断/更新锚定用；非全局形态为 null）
      binPath: dsh.binPath,
      built: !!dsh.built,
      engines: dsh.engines,
    } : { status: 'missing', kind: 'none', version: '', dir: null, root: null, binPath: null, built: false },
    source: { found: !!sourceEntry, built: !!(sourceEntry && sourceEntry.built), dir: (sourceEntry && sourceEntry.dir) || null, version: (sourceEntry && sourceEntry.version) || '' },
    pnpm,
    pnpmReady: pnpm.status === 'ok',
    plugin,
    alternatives: dshAlternatives.map((e) => ({ kind: e.kind, version: e.version || '', dir: e.dir })),
    plan,
    issues,
    npmPrefix: npmPrefix || null, // 尾查问到的 npm 全局前缀（诊断线索；未触发尾查时为 null）
    legacyNode: legacyUserNodeLayout(), // 旧布局事实（用户级 Node 目录里还装着全局 DSH）→ 迁移入口的输入
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

// 控制台展示用摘要（含路径，供 UI 展示；避免暴露过多内部结构）
function envSummary(report) {
  if (!report) return null
  return {
    ready: !!report.plan,
    engineRange: report.engineRange,
    node: { status: report.node.status, version: report.node.version, path: report.node.path, source: report.node.source },
    dsh: { status: report.dsh.status, kind: report.dsh.kind, version: report.dsh.version, built: report.dsh.built, dir: report.dsh.dir, root: report.dsh.root || null },
    pnpm: report.pnpm,
    pnpmReady: !!report.pnpmReady,
    source: report.source,
    plugin: { status: report.plugin.status, path: report.plugin.path },
    issues: report.issues,
    // 诊断线索：尾查问到的 npm 全局前缀（"装着却找不到"类反馈的关键证据，常规路径为 null）
    npmPrefix: report.npmPrefix || null,
    // 旧布局事实（用户级 Node 目录里还装着全局 DSH）：非 null 时 UI 应给出"迁移到官方安装"入口
    legacyNode: report.legacyNode || null,
  }
}

// 最近一次成功探测的报告（同步取用；env-install 用它把更新/重装锚定到"当前生效的那一份"）
function cachedReport() {
  return cache.report || null
}

module.exports = {
  DEFAULT_ENGINE_RANGE,
  DEFAULT_PNPM_VERSION,
  initEnv,
  detectEnv,
  cachedReport,
  envSummary,
  detectPnpm,
  classifyPnpmCommand,
  parsePnpmVersion,
  globalPrefixes,
  npmPrefixOf,
  legacyUserNodeLayout,
  readNpmPrefix,
  normalizeNpmPrefix,
  runtimeBase,
  managedNodeDir,
  managedDshDir,
  userNodeDir,
  pluginPath,
}
