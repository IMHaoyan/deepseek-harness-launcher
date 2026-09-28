// dsh-plugin-compat.js — 升级 DSH 前的只读兼容性预判（不写任何状态）。
//
// 为什么要有它：DSH 在「安装插件」和「profile 启动」两处都按插件声明的 peer 做**精确版本**门禁
// （见 @deepseek-ai/dsh-app-boot 的 evaluatePluginCompatibility）。跨 minor 升级会让一批只声明
// ^0.1.x 的插件在升级后静默失效 —— bundle 被 skipping、行被 disabling，而服务本身一切正常，
// dshl 的健康检查与崩溃判定一个信号都拿不到（2026-09-28 实测：0.1.7-rc.1 → 0.2.0-rc.1 让 7 项失效）。
//
// 判定规则与 DSH 保持一致，否则会出现"预判说兼容、升级后被拒"这种文案与真实动作不符：
//   - 只看 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 两个命名空间下的 peer；
//   - semver.satisfies(目标版本, range, { includePrerelease: true })；
//   - workspace:* / ^ / ~ 视为"跟随运行时版本"（等价于直接满足）。
//
// 三类来源必须都扫（本次排查的教训）：只扫 dependencies 会漏掉 panel-mcp-rider /
// panel-mcp-unreal-mcp —— 它们由 cordis.patch.yml 的 insert 行按包名引用，而那个包
// （@deepseek-ai/dsh-mcp-client）是别的插件的传递依赖，根本不在 dependencies 里。
//
// 内置 bundle 要排除：bundle 的解析顺序是"安装树优先"，它们随 dsh 一起换，用本地旧副本的 peer
// 去判定会产出假警报。来源（profile / 安装树）恰好能把这件事分辨清楚。
//
// fail-closed：目标版本非法、profile 读不到、某个插件 manifest 解析不出来 —— 一律进 unknown，
// 界面按"未能确认"呈现，绝不把拿不准当成兼容。
//
// 豁免也算数：DSH 的判据是"不兼容**且**未豁免才拒绝"，所以 profile 的 compatibility.json 里
// 已授权的精确版本豁免必须从"会失效"清单里扣掉（readProfileExemptions）。
//
// 噪音抑制（实测教训）：补丁文件的 `name:` 不一定是包引用 —— 配置里的模型名（gpt-6-luna、
// kimi-k3-x）与未安装的插件名都在同一个键上。所以只有 dependencies / bundles 这两个权威来源
// 解析不到时才算"未能确认"；只来自补丁且解析不到的名字直接忽略。
'use strict'

const fs = require('fs')
const path = require('path')
const semver = require('semver')
const pluginSwitch = require('./plugin-switch')

const DSH_PEER_PREFIX = '@deepseek-ai/dsh'
const WORKSPACE_RANGES = new Set(['workspace:*', 'workspace:^', 'workspace:~'])
/** 合法的 npm 包名（含 scope）——用来挡住补丁文件里被误当成包名的键值。 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** DSH 的门禁只检查这两个命名空间下的 peer（与 dsh-app-boot 的规则一致）。 */
function isDshPeer(name) {
  const key = String(name || '')
  return key === DSH_PEER_PREFIX || key.startsWith(DSH_PEER_PREFIX + '-')
}

/**
 * 一个插件的 peer 声明在目标 DSH 版本下满不满足（纯函数）。
 * @param {object} manifest 插件自己的 package.json
 * @param {string} targetVersion 目标 dsh 版本
 * @returns {{compatible:boolean, peers:Array<{name:string,range:string}>}} peers = 不满足的那些
 */
function evaluateManifestPeers(manifest, targetVersion) {
  const deps = manifest && manifest.peerDependencies
  if (!deps || typeof deps !== 'object') return { compatible: true, peers: [] }
  const peers = []
  for (const [name, range] of Object.entries(deps)) {
    if (!isDshPeer(name)) continue
    if (typeof range !== 'string' || range.trim() === '') { peers.push({ name, range: String(range) }); continue }
    const requirement = WORKSPACE_RANGES.has(range.trim()) ? targetVersion : range
    if (!semver.valid(targetVersion) || !semver.satisfies(targetVersion, requirement, { includePrerelease: true })) {
      peers.push({ name, range })
    }
  }
  return { compatible: peers.length === 0, peers }
}

/**
 * 三类来源的并集（dependencies / profile bundles / cordis.patch.yml 的 insert 行）。
 * 同一个包出现在多处时合并来源，界面只提醒一次。
 * @returns {Array<{name:string, sources:string[]}>}
 */
function collectTargets(input = {}) {
  const out = new Map()
  const add = (name, source) => {
    const key = String(name || '')
    if (!PACKAGE_NAME_RE.test(key)) return
    if (!out.has(key)) out.set(key, { name: key, sources: [] })
    const item = out.get(key)
    if (!item.sources.includes(source)) item.sources.push(source)
  }
  for (const name of Object.keys(input.dependencies || {})) add(name, 'dep')
  for (const name of (Array.isArray(input.bundles) ? input.bundles : [])) add(name, 'bundle')
  let patchNames = []
  try { patchNames = pluginSwitch.parsePatchRows(String(input.patchText || '')).names } catch { patchNames = [] }
  for (const name of patchNames) add(name, 'patch')
  return [...out.values()]
}

/**
 * 从 profile 目录读三类来源。读不到 profile（没有 package.json）返回 null —— 调用方按 fail-closed 处理。
 * @param {string} profileDir 例如 <DSH_HOME>/profiles/web
 */
function readProfileTargets(profileDir) {
  const dir = String(profileDir || '')
  if (!dir) return null
  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { return null }
  let patchText = ''
  try { patchText = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8') } catch { /* 没有用户层补丁 */ }
  const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || []
  return collectTargets({ dependencies: manifest.dependencies, bundles, patchText })
}

/**
 * 读 profile 的精确版本豁免（compatibility.json）。DSH 的判据是"不兼容**且**未豁免才拒绝"，
 * 所以预判必须把豁免算进去 —— 否则给某个插件授权过豁免之后，每次检查更新都会继续报它，
 * 那就成了"界面文案与真实动作不符"。
 * 文件缺失/损坏一律给空表：与 DSH 一致（坏文件不授权任何东西，也不阻断启动）。
 * @returns {Record<string, string[]>} `包名@版本` → 允许的精确 dsh 版本列表
 */
function readProfileExemptions(profileDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(profileDir || ''), 'compatibility.json'), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [key, versions] of Object.entries(raw)) {
      if (typeof key !== 'string' || !Array.isArray(versions)) continue
      const exact = versions.filter((v) => typeof v === 'string' && semver.valid(v) !== null)
      if (exact.length) out[key] = exact
    }
    return out
  } catch { return {} }
}

/** 该 包@版本 是否已被豁免到目标版本（纯函数）。 */
function isExempted(exemptions, key, targetVersion) {
  if (!exemptions || typeof exemptions !== 'object') return false
  const list = exemptions[key]
  return Array.isArray(list) && list.includes(targetVersion)
}

/**
 * 从 dsh 的可执行入口反推它所在安装树的 node_modules。
 * 内置 bundle 由这里解析出来（"安装树优先"是 app-boot 的契约），据此把它们排除出预判。
 * @returns {string} 安装树的 node_modules 绝对路径；推不出来时给空串
 */
function modulesDirFromDshBin(binPath) {
  // 贪心匹配到**最后**一个 node_modules，并原样保留输入的分隔符风格
  // （不能用 path.sep 重新拼：那会把 POSIX 路径改写成反斜杠）
  const matched = /^(.*[\\/]node_modules)(?:[\\/]|$)/u.exec(String(binPath || ''))
  return matched ? matched[1] : ''
}

/**
 * dsh 安装树里所有该找的 node_modules。
 * 第二层是必须的：npm 不总把 @deepseek-ai/* 提升到顶层，内置 bundle（dsh-base / dsh-web-app …）
 * 实际住在 <top>/@deepseek-ai/dsh/node_modules 下 —— 少这一层会把它们误判成"解析不到"。
 * @returns {string[]}
 */
function installModulesDirsFromDshBin(binPath) {
  const top = modulesDirFromDshBin(binPath)
  if (!top) return []
  const dirs = [top]
  const appDir = path.join(top, '@deepseek-ai', 'dsh', 'node_modules')
  try { if (fs.statSync(appDir).isDirectory()) dirs.push(appDir) } catch { /* 布局不同就只留顶层 */ }
  return dirs
}

/**
 * 造一个 manifest 读取器：先 profile 的 node_modules，再 dsh 安装树的 node_modules。
 * @returns {(name:string) => ({manifest:object, from:'profile'|'install'}|undefined)}
 */
function makeManifestReader(input = {}) {
  const bases = []
  if (input.profileDir) bases.push({ dir: path.join(String(input.profileDir), 'node_modules'), from: 'profile' })
  for (const dir of (input.installModulesDirs || [])) {
    if (dir) bases.push({ dir: String(dir), from: 'install' })
  }
  return function readManifest(name) {
    const key = String(name || '')
    if (!PACKAGE_NAME_RE.test(key)) return undefined
    const parts = key.split('/')
    for (const base of bases) {
      const file = path.join(base.dir, ...parts, 'package.json')
      try {
        if (!fs.statSync(file).isFile()) continue
        return { manifest: JSON.parse(fs.readFileSync(file, 'utf8')), from: base.from }
      } catch { /* 换下一个 base */ }
    }
    return undefined
  }
}

/**
 * 判定一组目标在目标版本下的处境（纯函数，readManifest 可注入）。
 * 解析不出来的进 unknown（fail-closed：绝不当作兼容）；解析自安装树的按内置 bundle 跳过，
 * 它们随 dsh 一起换版本，用本地旧副本判定会假报。
 * @returns {{targetVersion:string, incompatible:Array, unknown:Array, skippedInBox:string[]}}
 */
function judgeTargets(input = {}) {
  const targetVersion = String(input.targetVersion || '')
  const readManifest = typeof input.readManifest === 'function' ? input.readManifest : () => undefined
  const exemptions = input.exemptions || {}
  const incompatible = []
  const unknown = []
  const skippedInBox = []
  const exempted = []
  const skippedUnresolved = []
  for (const target of (input.targets || [])) {
    // 读取器抛错也只让这一个目标变成"拿不准"：一个坏 manifest 不能把整轮判定带崩（fail-closed）
    let found
    try { found = readManifest(target.name) } catch { found = undefined }
    if (!found || !found.manifest || typeof found.manifest !== 'object') {
      // 只出现在补丁里的名字解析不到 ⇒ 它压根不是包引用。补丁里的 `name:` 也可能是配置项
      // （实测：模型名 gpt-6-luna / kimi-k3-x、未安装的 dsh-better-sidebar 都在这里），
      // 把这些报成"未能确认"会淹没真信号。dependencies / bundles 是权威来源，那两个才 fail-closed。
      const onlyFromPatch = (target.sources || []).length > 0 && (target.sources || []).every((s) => s === 'patch')
      if (onlyFromPatch) { skippedUnresolved.push(target.name); continue }
      unknown.push({ name: target.name, sources: target.sources || [] })
      continue
    }
    if (found.from === 'install') { skippedInBox.push(target.name); continue }
    const version = String(found.manifest.version || '')
    const key = target.name + '@' + version
    if (isExempted(exemptions, key, targetVersion)) { exempted.push(key); continue }
    const verdict = evaluateManifestPeers(found.manifest, targetVersion)
    if (verdict.compatible) continue
    incompatible.push({
      name: target.name,
      version,
      sources: target.sources || [],
      peers: verdict.peers,
    })
  }
  return { targetVersion, incompatible, unknown, skippedInBox, exempted, skippedUnresolved }
}

/**
 * 组合入口：读 profile、解析各插件、按目标版本判定。
 * @param {{profileDir:string, installModulesDirs?:string[], targetVersion:string}} input
 * @returns {{ok:true, targetVersion:string, incompatible:Array, unknown:Array, skippedInBox:string[], checked:number}
 *          | {ok:false, reason:'invalid-target'|'profile-unreadable', targetVersion:string}}
 */
function checkProfileCompat(input = {}) {
  const targetVersion = String(input.targetVersion || '')
  if (!semver.valid(targetVersion)) return { ok: false, reason: 'invalid-target', targetVersion }
  const targets = readProfileTargets(input.profileDir)
  if (targets === null) return { ok: false, reason: 'profile-unreadable', targetVersion }
  const judged = judgeTargets({
    targets,
    targetVersion,
    readManifest: makeManifestReader(input),
    exemptions: input.exemptions || readProfileExemptions(input.profileDir),
  })
  return Object.assign({ ok: true, checked: targets.length }, judged)
}

module.exports = {
  DSH_PEER_PREFIX,
  isDshPeer,
  evaluateManifestPeers,
  collectTargets,
  readProfileTargets,
  readProfileExemptions,
  isExempted,
  modulesDirFromDshBin,
  installModulesDirsFromDshBin,
  makeManifestReader,
  judgeTargets,
  checkProfileCompat,
}
