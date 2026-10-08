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
/** 精确版本（只接受完整 semver，含预发布/构建后缀）——版本号会被原样拼进 `pkg@版本`。 */
const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
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
    s = { installed: false, version: '', bundle: false, busy: '', error: '', lastChange: '', lastChangeAt: 0 }
    states.set(name, s)
  }
  return s
}

/**
 * 记一条「动作回执」（卡片上那行 ✓）：只有成功才写，并且**必须带上时刻**。
 * 为什么带时刻：回执是"刚刚发生了什么"，不是状态 —— 生效之后、或超过保质期之后它就该退场
 * （清理见 clearLastChanges / expireLastChanges；保质期策略在 main.js 的 LAST_CHANGE_TTL_MS）。
 */
function noteLastChange(name, text) {
  const s = stateOf(name)
  s.lastChange = String(text || '')
  s.lastChangeAt = Date.now()
}

/**
 * 清掉所有插件的动作回执（**生效即过期**）：变更真正生效（服务重启成功）后调用 ——
 * 那一刻起版本号与状态胶囊已经表达了真实状态，回执再留着就是僵尸文案。
 * @returns {number} 清掉的条数
 */
function clearLastChanges() {
  let n = 0
  for (const s of states.values()) {
    if (!s.lastChange) continue
    s.lastChange = ''
    s.lastChangeAt = 0
    n++
  }
  return n
}

/**
 * 清掉超过 maxAgeMs 的动作回执（**超时兜底**）：给"改完一直没重启"的机器收尾。
 * 没写时刻的老回执不动它：宁可多显示一会儿，也不误删一条来源不明的文案。
 * @returns {number} 清掉的条数
 */
function expireLastChanges(maxAgeMs) {
  const ttl = Number(maxAgeMs)
  if (!Number.isFinite(ttl) || ttl <= 0) return 0
  const now = Date.now()
  let n = 0
  for (const s of states.values()) {
    if (!s.lastChange) continue
    const at = Number(s.lastChangeAt)
    if (Number.isFinite(at) && at > 0 && now - at >= ttl) {
      s.lastChange = ''
      s.lastChangeAt = 0
      n++
    }
  }
  return n
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
    lastChangeAt: s.lastChangeAt,
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

/**
 * npm manifest 校验：name 一致 + **精确**版本 + 合法 dsh.bundle.patch 形状。
 *
 * 「精确」= 只接受 `X.Y.Z` 或带预发布/构建后缀的完整 semver，拒绝 `^1.0.0` / `~1.0.0` / `1.0`
 * 这类范围和缺段写法，也拒绝 `latest` 这种 dist-tag 名 —— 安装时我们把版本号原样拼进 `pkg@版本`，
 * 范围写进来会让「装的是哪一版」变得不可预测。
 *
 * 为什么不再要求「稳定版」：上游只发预发布版的插件（如 dsh-mcp-lens 至今只有 0.1.0-rc.9，
 * npm 的 latest 也指向它）会因此连版本查询都失败，既装不了也判不了可更新，还每次刷新刷一条日志。
 * 精确性才是这里要守的契约；是否适合默认代装由注册表（autoInstall）决定，不由版本号后缀决定。
 */
function verifyNpmManifestShape(manifest, expectedName) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('npm manifest is invalid')
  }
  if (manifest.name !== expectedName) throw new Error('npm 包身份不一致')
  const version = manifest.version
  if (typeof version !== 'string' || !EXACT_VERSION_PATTERN.test(version)) {
    throw new Error('npm 未提供精确的版本号')
  }
  // 顺手把这份 manifest 的 peer 声明带出去：DSH 的安装门禁就是按它判的，卡片上的
  // 「会不会被门禁拒绝」预判要用同一份数据 —— 另起一次 npm 查询会引入"查的和装的不一致"的窗口。
  // 只做形状收敛（对象 + 字符串值），是不是 DSH 命名空间由判定方（dsh-plugin-compat）说了算。
  const rawPeers = manifest.peerDependencies
  const peerDependencies = (rawPeers && typeof rawPeers === 'object' && !Array.isArray(rawPeers))
    ? Object.fromEntries(Object.entries(rawPeers).filter(([, range]) => typeof range === 'string'))
    : {}
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
  return { name: expectedName, version, peerDependencies }
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

// pnpm 11 起默认带 24h「新版本观察期」（minimumReleaseAge 默认 1440 分钟），而且它在每次
// add/remove/install 前校验**整份** lockfile：只要里面有一个「发布不足 24h 且未被
// minimumReleaseAgeExclude 放行」的条目，任何操作都会被整体拒绝
// （ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION）。这条失败与「装哪个插件」无关，所以它的表现是
// 「所有插件一起装失败」。处理方式对齐 dshmarket（它的 #39）：
//   - 默认**不关策略**：pnpm 自己会把点名安装的新鲜版本写进 minimumReleaseAgeExclude
//     （"Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml"），lockfile 保持合规，
//     别的工具（DSH 内置市场、终端里的 pnpm、IDE）不会被这次安装连坐；
//   - 只有真的被整体拒绝时，才用一次性放行重试一次 —— 那次重试**不写**放行记录，所以它只能
//     当兜底，不能当默认路径（否则 lockfile 会长期处于「绕过了策略」的状态）。
const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'
// 判定「24h 观察期拒绝整份 lockfile」的标记：错误码可能被尾部截断，后两句是 pnpm 稳定打印的。
const RELEASE_AGE_MARKERS = [
  'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
  'failed supply-chain policy check',
  'bypassed the policy locally',
  // pnpm 11.8 的 remove 路径没有 wire 观察期处理器：只要树里存在任何新鲜条目就直接硬失败，
  // 连"违规的是谁"都不打印（2026-09-20 实测：同一棵树 add 会自愈写 minimumReleaseAgeExclude、
  // remove 报这个码）。它同样属于「被 24h 观察期拒绝」，放行一次即可通过；
  // 不认这个码的话，卸载路径的兜底重试永远不会触发，用户只会看到一句 pnpm 内部错误。
  'ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED',
]

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

/** 只在 add/remove 时注入一次放行参数；其它子命令原样透传。只用于命中判定后的那一次重试。 */
function withReleaseAgeOverride(args) {
  const list = Array.isArray(args) ? args : []
  const command = list[0]
  if (command !== 'add' && command !== 'remove') return list
  if (list.includes(RELEASE_AGE_OVERRIDE)) return list
  return [command, RELEASE_AGE_OVERRIDE, ...list.slice(1)]
}

/** 这次失败是不是「24h 观察期拒绝整份 lockfile」。 */
function releaseAgeViolation(output) {
  const text = String(output == null ? '' : output)
  return RELEASE_AGE_MARKERS.some((marker) => text.includes(marker))
}

/**
 * 从 pnpm 的判定里抠出被拒条目（名字 + 发布时间）。
 * pnpm 打印的是 `<name>@<version> was published at <ISO>, within the minimumReleaseAge cutoff (<ISO>)`；
 * 面板据此按本地时间告诉用户「什么时候自动恢复」，而不是笼统说一句「稍后再试」。
 */
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

/** 全部条目满 24h 后策略自动放行：取最晚的发布时间 + 24h（本地时间由界面负责展示）。 */
function releaseAgeRecoversAt(entries) {
  const times = (Array.isArray(entries) ? entries : [])
    .map((e) => Date.parse(e && e.publishedAt))
    .filter((t) => Number.isFinite(t))
  if (!times.length) return ''
  return new Date(Math.max(...times) + 24 * 60 * 60 * 1000).toISOString()
}

/**
 * DSH 的「版本门禁」拒绝：`Plugin <包>@<版本> is incompatible with dsh <版本>: peerDependencies {…}`。
 *
 * 安装前（`dsh plugin add`）与启动时（bundle 被跳过）都会打印这句，措辞一致；区别只在前面那截
 * （`dsh: installation rejected: …` / `dsh: skipping profile bundle "…": …`）。所以这里只认中间那句，
 * 两种来源都能抠出同一对「包@版本 + dsh 版本」——授权按钮要用它拼出 dsh 自己的 allow-version 命令。
 *
 * 抠不出包名/版本时返回 packageName:''：提示条仍能说出"被门禁拒绝"，但不会给出假的授权动作。
 * 完全不是门禁（例如 pnpm 的 24h 观察期、EPERM）一律返回 null，交给别的分类。
 * @returns {{packageName:string, version:string, dshVersion:string, exemptionActive:boolean}|null}
 */
function parseVersionGate(output) {
  const text = String(output == null ? '' : output)
  const m = /Plugin\s+(\S+)\s+is incompatible with dsh\s+([^\s:]+)/u.exec(text)
  const exemption = /Exact-version exemption:\s*(not active|active)/u.exec(text)
  if (!m && !exemption) return null
  let packageName = ''
  let version = ''
  if (m) {
    // 包名可能带 scope（@scope/name@1.2.3）：按**最后一个** @ 切，不要把 scope 的 @ 当成版本分隔符
    const at = m[1].lastIndexOf('@')
    if (at > 0 && at < m[1].length - 1) {
      packageName = m[1].slice(0, at)
      version = m[1].slice(at + 1)
    }
  }
  return {
    packageName,
    version,
    dshVersion: m ? m[2] : '',
    exemptionActive: exemption ? exemption[1] === 'active' : false,
  }
}

/**
 * 版本门禁失败的归类：**结构化事实 → 一类解释**。
 *
 * 为什么要单独一个函数：这条失败有两个来源 —— ① 安装真的被 DSH 拒了（classifyEnvFailure 解析 stderr）；
 * ② 装之前就预判出会被拒（默认代装/批量安装的预判，拿的是 npm manifest 的 peer）。
 * 两条路必须给出**同一份文案**（否则同一个原因在提示条上会有两种说法），所以文案只在这里定义一处。
 * recoverable:false 是刻意的：普通重试不会变好，必须先授权 —— 界面据此给「授权并重试」而不是「重试」。
 * @param {{packageName?:string, version?:string, dshVersion?:string, exemptionActive?:boolean}} gate
 */
function versionGateFailure(gate) {
  const g = gate || {}
  const packageName = String(g.packageName || '')
  const version = String(g.version || '')
  const pair = packageName && version ? packageName + '@' + version : ''
  const runtime = g.dshVersion || '当前版本'
  return {
    kind: 'version-gate',
    title: '插件声明的 dsh 版本范围不含当前 dsh',
    reason: pair
      ? 'DSH 在安装前按插件声明的 peer 做精确版本门禁：' + pair + ' 声明支持的 dsh 版本里没有 ' + runtime
        + '，所以整条拒绝（没装任何东西）。这是作者声明的兼容边界，不是安装坏了；'
        + '要装就得为「这一对精确版本」授权（接受崩溃/数据损坏风险），只有你能拍板。'
      : 'DSH 拒绝了这次安装：插件声明的 dsh peer 不含当前 dsh（' + runtime + '）。',
    entries: [],
    recoversAt: '',
    recoverable: false,
    gate: {
      packageName,
      version,
      dshVersion: String(g.dshVersion || ''),
      exemptionActive: !!g.exemptionActive,
    },
  }
}

/**
 * 环境级失败分类：这些原因与「装哪个插件」无关，同一批安装会一起中。
 * 面板据此把 N 条一模一样的「操作失败」收敛成一条解释 —— 文案只在这里定义一处。
 */
function classifyEnvFailure(output) {
  const text = String(output == null ? '' : output)
  const empty = { kind: '', title: '', reason: '', entries: [], recoversAt: '', recoverable: false }
  // 版本门禁放在最前：它的输出最长、最容易被后面的宽松标记误判，而且它是唯一一类
  // 「重试不会变好、必须先授权」的失败 —— recoverable:false 是刻意的，不能让提示条给出
  // 一个点了还会同样失败的「重试」按钮。
  const gate = parseVersionGate(text)
  if (gate) return versionGateFailure(gate)
  if (releaseAgeViolation(text)) {
    const entries = parseReleaseAgeEntries(text)
    return {
      kind: 'release-age',
      title: 'pnpm 的 24h「新版本观察期」拒绝了 profile 的锁文件',
      reason: 'profile 里有 ' + (entries.length ? entries.length + ' 个' : '若干') + '依赖是发布不足 24 小时的新版本，'
        + 'pnpm 在每次安装前都会校验整份锁文件，所以这一批插件会一起失败（与插件本身无关）。',
      entries,
      recoversAt: releaseAgeRecoversAt(entries),
      recoverable: true, // 可以原样重试：条目过期后自然通过
    }
  }
  if (/ERR_PNPM_EPERM|EPERM: operation not permitted|EBUSY|resource busy/iu.test(text)) {
    return {
      kind: 'locked',
      title: 'profile 里的文件被别的进程占用',
      reason: '有进程正握着 profile 的 node_modules（常见于 DSH 还没完全退出、或杀软正在扫描），pnpm 改不了依赖树。等 DSH 完全退出后重试即可。',
      entries: [], recoversAt: '', recoverable: true,
    }
  }
  if (/HTTP 429/u.test(text)) {
    return {
      kind: 'rate-limit',
      title: 'npm 源限流（HTTP 429）',
      reason: '安装前的包身份校验被 npm 官方源限流了，与插件无关；稍后重试即可。',
      entries: [], recoversAt: '', recoverable: true,
    }
  }
  if (/ERR_PNPM_NO_MATCHING_VERSION/u.test(text)) {
    return {
      kind: 'registry-missing',
      title: '当前 npm 源里找不到要装的精确版本',
      reason: 'pnpm 在配置的源上找不到该版本（镜像同步滞后时常见）。可在运行环境页换源，或稍后重试。',
      entries: [], recoversAt: '', recoverable: true,
    }
  }
  if (/pnpm 未就绪|未检测到 pnpm|运行环境未就绪/u.test(text)) {
    return {
      kind: 'env',
      title: 'pnpm 运行环境未就绪',
      reason: '启动器没检测到可用的 pnpm，插件安装无法进行；先到「运行环境」页安装/修复 pnpm。',
      entries: [], recoversAt: '', recoverable: false,
    }
  }
  return empty
}

/** 跑一次 `dsh plugin`（不注入任何放行参数），失败时把完整输出挂在 error 上供上层分类。 */
async function runCliOnce(args) {
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
      else {
        const err = new Error('dsh plugin 退出码 ' + code + (output ? '：' + output.slice(-400) : ''))
        err.exitCode = code
        err.output = output // 完整输出：分类 / 抠条目都靠它（错误文案里只留尾部 400 字）
        reject(err)
      }
    })
  })
}

/**
 * add/remove 的统一入口：**先按策略默认跑**，只有被 24h 观察期整体拒绝时才用一次性放行重试一次。
 * 成功后回传 releaseAge（被拒条目 + 是否走了重试），界面据此解释「为什么别的工具这几天用不了」。
 */
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
      const r = await runCliOnce(withReleaseAgeOverride(list))
      return Object.assign({}, r, { releaseAge: { entries, retried: true } })
    } catch (e2) {
      const err = new Error(((e2 && e2.message) || String(e2)) + '（已用一次性放行重试过一次）')
      err.exitCode = e2 && e2.exitCode
      err.output = (e2 && e2.output) || ''
      throw err
    }
  }
}

// ---------- 精确版本豁免（把门禁放行交给 dsh 自己做） ----------

/**
 * 为「一个精确的 包@版本 + 一个精确的 dsh 版本」授予门禁豁免。
 *
 * 为什么由 dsh 自己写：放行记录是 profile 目录下的 `compatibility.json`，那是 DSH 的授权账本 ——
 * `dsh plugin allow-version` 会自己校验参数形状、自己校验 `--dsh-version` 必须等于**运行中**的 dsh、
 * 自己加文件锁做原子写。DSHL 自己改那个文件就等于绕过了这套校验，所以这里只做"把这个动作交给它"。
 *
 * 参数一律先做形状收敛（fail-closed）：包名/版本不合法就不发命令 —— 版本号是要被原样拼进
 * `包@版本` 的，范围或 dist-tag 混进来会让"授权了哪一版"变得不可预测。
 * 授权只覆盖这一对精确版本：dsh 升级、或插件再发新版，都要重新授权（DSH 的模型如此，不是这里的选择）。
 * @returns {Promise<{ok:true, output:string}|{ok:false, error:string, output?:string}>}
 */
async function allowVersionExemption(packageName, version, dshVersion) {
  const pkg = String(packageName == null ? '' : packageName)
  const ver = String(version == null ? '' : version)
  const runtime = String(dshVersion == null ? '' : dshVersion)
  if (!NPM_PACKAGE_PATTERN.test(pkg)) return { ok: false, error: 'npm 包名格式不合法：' + pkg }
  if (!EXACT_VERSION_PATTERN.test(ver)) return { ok: false, error: '插件版本必须是精确版本：' + ver }
  if (!EXACT_VERSION_PATTERN.test(runtime)) return { ok: false, error: 'dsh 版本必须是精确版本：' + runtime }
  try {
    const r = await runCliOnce(['allow-version', pkg + '@' + ver, '--dsh-version', runtime, '--accept-risk'])
    return { ok: true, output: (r && r.output) || '' }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), output: (e && e.output) || '' }
  }
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
    // 24h 观察期由 runCli 统一处理：先按策略默认跑，被整体拒绝时才一次性放行重试。
    const cli = await runCli(['add', pkg + '@' + verified.version, '-w'])
    const after = pluginStateOf(readProfileManifest(), pkg)
    if (!after.installed || !after.bundle) {
      throw new Error('安装后 profile 未正确记录该插件（dependencies/bundles 缺一）')
    }
    noteLastChange(pkg, '已安装 ' + pkg + '@' + after.version)
    log('installed ' + pkg + '@' + after.version)
    s.busy = ''
    return { ok: true, version: after.version, releaseAge: (cli && cli.releaseAge) || null }
  } catch (e) {
    s.error = (e && e.message) || String(e)
    s.busy = ''
    log('install failed: ' + pkg + '：' + s.error)
    const env = classifyEnvFailure((e && e.output) || s.error)
    return { ok: false, error: s.error, env: env.kind ? env : null }
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
    noteLastChange(pkg, '已卸载 ' + pkg)
    log('uninstalled ' + pkg)
    s.busy = ''
    return { ok: true }
  } catch (e) {
    s.error = (e && e.message) || String(e)
    s.busy = ''
    log('uninstall failed: ' + pkg + '：' + s.error)
    const env = classifyEnvFailure((e && e.output) || s.error)
    return { ok: false, error: s.error, env: env.kind ? env : null }
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
  allowVersionExemption,
  // 动作回执的生命周期（生效即清 / 超时兜底，策略在 main.js）
  noteLastChange,
  clearLastChanges,
  expireLastChanges,
  stateOf, // 测试用：进程内瞬时状态（含 lastChange/lastChangeAt）
  installedPackageVersion,
  verifyNpmPackage,
  // 纯函数（测试用）
  pluginStateOf,
  verifyNpmManifestShape,
  parseVersionGate,
  versionGateFailure,
  pnpmReady,
  withReleaseAgeOverride,
  releaseAgeViolation,
  parseReleaseAgeEntries,
  releaseAgeRecoversAt,
  classifyEnvFailure,
  RELEASE_AGE_OVERRIDE,
  PLUGIN_NAME,
  PROFILE_NAME,
  NPM_REGISTRY_ORIGIN,
}
