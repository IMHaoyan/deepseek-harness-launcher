// tests/node-upgrade.test.js — Node.js 目标版本升到 24 LTS + 旧版 Node 升级链路的回归护栏
//
// 背景：dshl 的内置 Node 目标从 22 升到 24，并且旧用户不再被"拒绝、让用户自己处理"，
// 而是走官方 MSI 的原生 major upgrade（或用户级 zip 目录替换）。这条链有四段，任何一段断掉
// 都会让用户点了「升级到 Node.js 24 LTS」却没反应、或把环境停在半截：
//   ① 探测侧（env-detect.js）：DEFAULT_NODE_MAJOR=24；decideNodeUpgrade 只对"dshl 管得住的那份 Node"给建议
//   ② 安装侧（env-install.js）：显式升级语义 upgrade-msi / upgrade-user；MSI 升级失败绝不回退用户级 zip
//   ③ 主进程（main.js）：旧默认值 22 的一次性配置迁移、升级前停稳服务、失败/取消后恢复服务（fail-closed）
//   ④ 渲染层（ui-src/app.js + wwwroot/app.js）：升级卡片、确认对话框、payload、错误呈现，两份产物同步
//
// 这里只做纯函数断言 + 源码结构性断言：不启动安装器、不读真实注册表、不联网。
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const envDetect = require('../env-detect')
const envInstall = require('../env-install')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const normalizeEol = (s) => s.replace(/\r\n?/g, '\n')

const mainJs = read('main.js')
const envDetectSrc = read('env-detect.js')
const envInstallSrc = read('env-install.js')
const fetchDistSrc = read('tools/fetch-node-dist.mjs')
const appJs = read('ui-src/app.js')
const builtAppJs = read('wwwroot/app.js')
const indexHtml = read('ui-src/index.html')
const builtIndexHtml = read('wwwroot/index.html')

// 取 [startMarker, endMarker) 之间的源码。放在测试里调用：找不到边界时算测试失败，而不是整文件加载失败。
function sliceBetween(src, startMarker, endMarker, label) {
  const at = src.indexOf(startMarker)
  assert.ok(at >= 0, `源码里找不到：${label || startMarker}`)
  const end = src.indexOf(endMarker, at + startMarker.length)
  assert.ok(end > at, `源码里找不到 ${label || startMarker} 的结束边界`)
  return src.slice(at, end)
}

// envSummary 消费的最小报告形状（字段与 env-detect.js buildReport 返回的一致）
function makeReport(nodeUpgrade) {
  const report = {
    ready: true,
    engineRange: envDetect.DEFAULT_ENGINE_RANGE,
    node: {
      status: 'ok',
      version: '22.23.2',
      path: 'C:\\Program Files\\nodejs\\node.exe',
      source: 'msi',
    },
    dsh: {
      status: 'ok',
      kind: 'global',
      version: '0.1.5-rc.2',
      built: true,
      dir: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh',
      root: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
    },
    pnpm: { status: 'ok', version: '11.8.0', path: 'C:\\Program Files\\nodejs\\pnpm.cmd', expectedVersion: envDetect.DEFAULT_PNPM_VERSION },
    pnpmReady: true,
    source: { found: false, built: false, dir: null, version: '' },
    plugin: { status: 'ok', path: 'C:\\Users\\tester\\.dsh\\plugins\\dsh-notify\\dsh-notify.mjs' },
    issues: [],
    plan: { spawn: {} },
    npmPrefix: null,
    legacyNode: null,
    at: 1,
  }
  if (nodeUpgrade !== undefined) report.nodeUpgrade = nodeUpgrade
  return report
}

// ---------- A. 探测侧：目标大版本 + decideNodeUpgrade 纯函数 ----------

test('DEFAULT_NODE_MAJOR 是 26（Node.js 26 = 当前 Active LTS）', () => {
  assert.equal(envDetect.DEFAULT_NODE_MAJOR, 26)
})

test('decideNodeUpgrade：win32 + 旧版官方 MSI → mode=msi（官方 MSI 原生 major upgrade）', () => {
  const r = envDetect.decideNodeUpgrade({
    platform: 'win32',
    installedMsi: { version: '22.23.2', installPath: 'C:\\Program Files\\nodejs\\' },
    node: { status: 'ok', version: '22.23.2', path: 'C:\\Program Files\\nodejs\\node.exe' },
    versionManager: '',
  })
  assert.deepEqual(r, {
    mode: 'msi',
    from: '22.23.2',
    targetMajor: 26,
    range: envDetect.DEFAULT_ENGINE_RANGE,
    dir: 'C:\\Program Files\\nodejs\\',
    reason: 'msi-older-major',
  })
})

test('decideNodeUpgrade：已是目标大版本或更高 → null（不动机器上残留的旧 MSI）', () => {
  const msi26 = { version: '26.13.1', installPath: 'C:\\Program Files\\nodejs\\' }
  assert.equal(envDetect.decideNodeUpgrade({
    platform: 'win32',
    installedMsi: msi26,
    node: { status: 'ok', version: '26.13.1', path: 'C:\\Program Files\\nodejs\\node.exe' },
    versionManager: '',
  }), null)
  // 生效的 node 已是 26.x：机器上残留的旧 MSI 也不碰（不是"有旧就升"）
  assert.equal(envDetect.decideNodeUpgrade({
    platform: 'win32',
    installedMsi: { version: '22.23.2', installPath: 'C:\\Program Files\\nodejs\\' },
    node: { status: 'ok', version: '26.12.1', path: 'C:\\Program Files\\nodejs\\node.exe' },
    versionManager: '',
  }), null)
})

test('decideNodeUpgrade：版本管理器在场 / 非 Windows → 一律 null（不侵入、不争 PATH）', () => {
  const msi22 = { version: '22.23.2', installPath: 'C:\\Program Files\\nodejs\\' }
  assert.equal(envDetect.decideNodeUpgrade({
    platform: 'win32',
    installedMsi: msi22,
    node: { status: 'ok', version: '22.23.2' },
    versionManager: 'nvm',
  }), null)
  assert.equal(envDetect.decideNodeUpgrade({
    platform: 'linux',
    installedMsi: msi22,
    node: { status: 'ok', version: '22.23.2' },
    versionManager: '',
  }), null)
})

test('decideNodeUpgrade：无 MSI、用户级目录里那份正是生效版本 → mode=user（zip 目录替换）', () => {
  const r = envDetect.decideNodeUpgrade({
    platform: 'win32',
    installedMsi: null,
    userNode: { exists: true, version: '22.23.2', dir: 'C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs' },
    node: { status: 'ok', version: '22.23.2' },
    versionManager: '',
  })
  assert.deepEqual(r, {
    mode: 'user',
    from: '22.23.2',
    targetMajor: 26,
    range: envDetect.DEFAULT_ENGINE_RANGE,
    dir: 'C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs',
    reason: 'user-level-older-major',
  })
})

test('decideNodeUpgrade：用户级目录版本与生效版本对不上 → null（不能证明生效的就是它）', () => {
  assert.equal(envDetect.decideNodeUpgrade({
    platform: 'win32',
    installedMsi: null,
    userNode: { exists: true, version: '22.23.2', dir: 'C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs' },
    node: { status: 'ok', version: '22.19.0' },
    versionManager: '',
  }), null)
})

test('decideNodeUpgrade：能解析出生效路径时以路径为准（同版本不同目录不误报）', () => {
  const userDir = 'C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs'
  const base = {
    platform: 'win32',
    installedMsi: null,
    userNode: { exists: true, version: '22.23.2', dir: userDir + '\\' },
    node: { status: 'ok', version: '22.23.2' },
    versionManager: '',
  }
  // PATH 上生效的是另一份同版本 Node（如 Program Files）：升级用户级目录不会改变生效版本 → 不提示
  assert.equal(envDetect.decideNodeUpgrade({ ...base, activePath: 'C:\\Program Files\\nodejs\\node.exe' }), null)
  // 生效路径就在用户级目录里 → 路径证据成立
  const r = envDetect.decideNodeUpgrade({ ...base, activePath: userDir + '\\node.exe' })
  assert.equal(r.mode, 'user')
  assert.equal(r.from, '22.23.2')
})

// 2026-11-22 现场：最新 DSH 的 engines 是 ^24.22.3 || >=26.13.1，本机 24.16.0。
// 旧逻辑只看大版本（24 >= 24）→ 直接 null，环境页不给任何升级入口，用户被卡死。
const NEW_RANGE = '^24.22.3 || >=26.13.1'

test('decideNodeUpgrade：旧大版本（24.16.0）→ 升级入口；26.x 补丁不足 → msi-below-engines', () => {
  const oldMajor = envDetect.decideNodeUpgrade({
    platform: 'win32',
    range: NEW_RANGE,
    installedMsi: { version: '24.16.0', installPath: 'C:\\Program Files\\nodejs\\' },
    node: { status: 'tooOld', version: '24.16.0', path: 'C:\\Program Files\\nodejs\\node.exe' },
    versionManager: '',
  })
  assert.equal(oldMajor.mode, 'msi')
  assert.equal(oldMajor.reason, 'msi-older-major')
  assert.equal(oldMajor.from, '24.16.0')
  assert.equal(oldMajor.targetMajor, 26)
  assert.equal(oldMajor.range, NEW_RANGE)
  // 大版本已达标但补丁不够（26.10 < 26.13.1）：同主版本补丁升级
  const patch = envDetect.decideNodeUpgrade({
    platform: 'win32',
    range: NEW_RANGE,
    installedMsi: { version: '26.10.0', installPath: 'C:\\Program Files\\nodejs\\' },
    node: { status: 'tooOld', version: '26.10.0', path: 'C:\\Program Files\\nodejs\\node.exe' },
    versionManager: '',
  })
  assert.equal(patch.mode, 'msi')
  assert.equal(patch.reason, 'msi-below-engines')
})

test('decideNodeUpgrade：已满足目标大版本与 engines → null（不为版本差异反复提示）', () => {
  assert.equal(envDetect.decideNodeUpgrade({
    platform: 'win32',
    range: NEW_RANGE,
    installedMsi: { version: '26.13.1', installPath: 'C:\\Program Files\\nodejs\\' },
    node: { status: 'ok', version: '26.13.1', path: 'C:\\Program Files\\nodejs\\node.exe' },
    versionManager: '',
  }), null)
  // 生效的 node 满足要求：机器上残留的旧 MSI 也不碰
  assert.equal(envDetect.decideNodeUpgrade({
    platform: 'win32',
    range: NEW_RANGE,
    installedMsi: { version: '22.23.2', installPath: 'C:\\Program Files\\nodejs\\' },
    node: { status: 'ok', version: '26.13.1', path: 'C:\\Program Files\\nodejs\\node.exe' },
    versionManager: '',
  }), null)
})

test('decideNodeUpgrade：用户级旧大版本 → mode=user；26.x 补丁不足 → user-level-below-engines', () => {
  const userDir = 'C:\\Users\\tester\\AppData\\Local\\Programs\\nodejs'
  const oldMajor = envDetect.decideNodeUpgrade({
    platform: 'win32',
    range: NEW_RANGE,
    installedMsi: null,
    userNode: { exists: true, version: '24.16.0', dir: userDir },
    node: { status: 'tooOld', version: '24.16.0' },
    activePath: userDir + '\\node.exe',
    versionManager: '',
  })
  assert.equal(oldMajor.mode, 'user')
  assert.equal(oldMajor.reason, 'user-level-older-major')
  const patch = envDetect.decideNodeUpgrade({
    platform: 'win32',
    range: NEW_RANGE,
    installedMsi: null,
    userNode: { exists: true, version: '26.10.0', dir: userDir },
    node: { status: 'tooOld', version: '26.10.0' },
    activePath: userDir + '\\node.exe',
    versionManager: '',
  })
  assert.equal(patch.mode, 'user')
  assert.equal(patch.reason, 'user-level-below-engines')
  assert.equal(patch.range, NEW_RANGE)
})

test('engineRangeFor：目标版本要求更高时采用目标 engines；陈旧目标不生效', () => {
  const installed = { version: '0.2.2-rc.5', engines: '^22.19.0 || >=24.0.0' }
  const target = { version: '0.2.3-alpha.2', range: NEW_RANGE }
  assert.equal(envDetect.engineRangeFor(installed, target), NEW_RANGE,
    '回滚后仍要按目标版本判 Node，否则永远不出现升级入口')
  // 已装上目标版本：已安装的 engines 本身就是目标要求
  assert.equal(envDetect.engineRangeFor({ version: '0.2.3-alpha.2', engines: NEW_RANGE }, target), NEW_RANGE)
  // 已安装版本比目标还新（切渠道/降级后的陈旧要求）→ 回退到已安装的 engines
  assert.equal(envDetect.engineRangeFor({ version: '0.2.4', engines: '>=26' }, target), '>=26')
  assert.equal(envDetect.engineRangeFor(installed, null), installed.engines)
  // 就绪判定仍用已安装 DSH 的 engines（否则回滚后环境会被误判未就绪）；
  // 目标要求只进 upgradeRange，用于升级建议与安装验收。
  assert.match(envDetectSrc, /const range = \(dsh && dsh\.engines\) \|\| DEFAULT_ENGINE_RANGE/)
  assert.match(envDetectSrc, /const upgradeRange = engineRangeFor\(dsh\)/)
  assert.match(envDetectSrc, /targetEngineRange: upgradeRange/)
  assert.doesNotMatch(envDetectSrc, /detectNode\(upgradeRange\)/, '不能让目标要求把当前可用环境判成未就绪')
})

test('targetNodeBlockOf：24.14.1 + 目标 26 → major-below-target（停服前拦截的依据）', () => {
  const dshUpdate = require('../dsh-update')
  const blocked = dshUpdate.targetNodeBlockOf({
    nodeVersion: '24.14.1',
    targetMajor: 26,
    engines: NEW_RANGE,
  })
  assert.equal(blocked.reason, 'major-below-target')
  assert.equal(blocked.nodeVersion, '24.14.1')
})

test('targetNodeBlockOf：26.x 补丁不足 → engines-unsatisfied；26.13.1 → null', () => {
  const dshUpdate = require('../dsh-update')
  assert.equal(dshUpdate.targetNodeBlockOf({
    nodeVersion: '26.10.0',
    targetMajor: 26,
    engines: NEW_RANGE,
  }).reason, 'engines-unsatisfied')
  assert.equal(dshUpdate.targetNodeBlockOf({
    nodeVersion: '26.13.1',
    targetMajor: 26,
    engines: NEW_RANGE,
  }), null)
  // 读不到版本也要拦住（不能把"未知"当合格）
  assert.equal(dshUpdate.targetNodeBlockOf({ nodeVersion: '', targetMajor: 26, engines: '' }).reason, 'node-version-unknown')
})

// ---------- B. 安装侧：decideNodeInstallPlan 的显式升级语义 ----------

test('decideNodeInstallPlan（显式升级）：旧 MSI → upgrade-msi，已达标 → reuse/already-target', () => {
  assert.deepEqual(
    envInstall.decideNodeInstallPlan({ upgrade: true, installedMsi: { version: '22.23.2' } }),
    { action: 'upgrade-msi', reason: 'upgrade-msi', from: '22.23.2', targetMajor: envDetect.DEFAULT_NODE_MAJOR, range: envDetect.DEFAULT_ENGINE_RANGE },
  )
  const done = envInstall.decideNodeInstallPlan({ upgrade: true, installedMsi: { version: '26.13.1' } })
  assert.equal(done.action, 'reuse')
  assert.equal(done.reason, 'already-target')
  assert.equal(done.version, '26.13.1')
  // 24.x 即使满足旧 engines，也不再是目标大版本 → 必须升级
  const old = envInstall.decideNodeInstallPlan({ upgrade: true, installedMsi: { version: '24.22.1' } })
  assert.equal(old.action, 'upgrade-msi')
})

test('decideNodeInstallPlan（显式升级）：无 MSI 但用户级安装旧 → upgrade-user', () => {
  assert.deepEqual(
    envInstall.decideNodeInstallPlan({ upgrade: true, userNode: { exists: true, version: '22.23.2', dir: 'D:\\nodejs' } }),
    { action: 'upgrade-user', reason: 'upgrade-user', from: '22.23.2', targetMajor: envDetect.DEFAULT_NODE_MAJOR, range: envDetect.DEFAULT_ENGINE_RANGE },
  )
})

test('decideNodeInstallPlan（显式升级）：没有可管理的 Node → refuse / no-managed-node', () => {
  const r = envInstall.decideNodeInstallPlan({ upgrade: true })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'no-managed-node')
  assert.equal(r.targetMajor, envDetect.DEFAULT_NODE_MAJOR)
})

test('decideNodeInstallPlan（显式升级）：版本管理器在场 → refuse / upgrade-version-manager', () => {
  const r = envInstall.decideNodeInstallPlan({ upgrade: true, installedMsi: { version: '22.23.2' }, versionManager: 'nvm' })
  assert.equal(r.action, 'refuse')
  assert.equal(r.reason, 'upgrade-version-manager')
  assert.equal(r.versionManager, 'nvm')
})

test('decideNodeInstallPlan（显式升级）：同主版本补丁不足必须升级，不能误判 already-target', () => {
  const need = envInstall.decideNodeInstallPlan({ upgrade: true, range: NEW_RANGE, installedMsi: { version: '26.10.0' } })
  assert.equal(need.action, 'upgrade-msi')
  assert.equal(need.from, '26.10.0')
  // 大版本+engines 都达标才算 reuse
  const done = envInstall.decideNodeInstallPlan({ upgrade: true, range: NEW_RANGE, installedMsi: { version: '26.13.1' } })
  assert.equal(done.action, 'reuse')
  assert.equal(done.reason, 'already-target')
})

test('decideNodeInstallPlan（自动）：MSI 不满足 engines → upgrade-msi（同主版本也要升）', () => {
  const r = envInstall.decideNodeInstallPlan({
    range: NEW_RANGE,
    installedMsi: { version: '24.16.0' },
    msiUsable: true,
    nodeOk: false,
    nodeVersion: '24.16.0',
  })
  assert.equal(r.action, 'upgrade-msi')
  assert.equal(r.reason, 'msi-too-old')
})

test('decideUserNodeReuse：复用判据同样按 DSH engines（24.16.0 不满足 ^24.22.3 不能复用）', () => {
  assert.equal(envInstall.decideUserNodeReuse({ exists: true, version: '24.16.0', range: NEW_RANGE }).reuse, false)
  assert.equal(envInstall.decideUserNodeReuse({ exists: true, version: '24.22.3', range: NEW_RANGE }).reuse, true)
})

test('pickBundledNodeFile：只挑满足 engines 的最高补丁版；不满足返回 null（触发联网选版本）', () => {
  const names = [
    'node-v24.22.1-x64.msi', 'node-v24.22.3-x64.msi', 'node-v24.22.3-x64.msi.sha256', 'node-v24.10.0-x64.msi',
  ]
  assert.equal(envInstall.pickBundledNodeFile(names, 'msi', NEW_RANGE, 24).ver, '24.22.3')
  // 只有旧内置包时不能拿来充数：必须让调用方走联网，否则会重复装同一个不合格版本
  assert.equal(envInstall.pickBundledNodeFile(['node-v24.22.1-x64.msi'], 'msi', NEW_RANGE, 24), null)
  assert.equal(envInstall.pickBundledNodeFile(['node-v24.22.1-win-x64.zip'], 'zip', NEW_RANGE, 24), null)
  // 字符串排序陷阱：24.22.10 必须排在 24.22.9 之前
  assert.equal(envInstall.pickBundledNodeFile(['node-v24.22.9-x64.msi', 'node-v24.22.10-x64.msi'], 'msi', NEW_RANGE, 24).ver, '24.22.10')
  // 其他大版本不混进来
  assert.equal(envInstall.pickBundledNodeFile(['node-v26.13.1-x64.msi'], 'msi', NEW_RANGE, 24), null)
})

test('接线：主进程把 DSH 的 engines 范围带给安装侧（缺省时才用 DSHL 默认范围）', () => {
  assert.match(mainJs, /const engineRange = envReport && \(envReport\.targetEngineRange \|\| envReport\.engineRange\)/,
    'main.js 的 envInstall 入口必须注入 engineRange（优先目标要求）')
  assert.match(envDetectSrc, /decideNodeUpgrade\(\{[^}]*range:\s*upgradeRange/s,
    'env-detect buildReport 必须把目标要求（upgradeRange）传给 decideNodeUpgrade')
  assert.match(envInstallSrc, /const engineRange = \(job\.opts && job\.opts\.engineRange\) \|\| envDetect\.DEFAULT_ENGINE_RANGE/,
    'env-install 的安装决策必须使用目标 DSH 的 engines 范围')
})

test('msiUsableOf：只判"能执行"，版本太旧不算 broken（否则自动升级会被拒绝）', () => {
  assert.equal(envInstall.msiUsableOf({ exists: true, version: '24.16.0' }), true, '同主版本但补丁不足 → 可执行，应走升级')
  assert.equal(envInstall.msiUsableOf({ exists: true, version: '22.23.2' }), true, '旧大版本 → 可执行，应走升级')
  assert.equal(envInstall.msiUsableOf({ exists: false, version: '' }), false, '文件不在 → 产品坏了')
  assert.equal(envInstall.msiUsableOf({ exists: true, version: '' }), false, '读不出版本 → 不能复用')
})

test('verifyUpgradedNode：实探版本必须更高、主版本达标、满足 engines（不轻信退出码/注册表）', () => {
  const v = (o) => envInstall.verifyUpgradedNode(o)
  assert.equal(v({ probed: '24.22.3', from: '24.16.0', targetMajor: 24, range: NEW_RANGE }).ok, true)
  assert.equal(v({ probed: '26.13.1', from: '24.16.0', targetMajor: 24, range: NEW_RANGE }).ok, true)
  // 22 → 24 的升级请求如果实际还停在 22，不能报成功
  assert.equal(v({ probed: '22.23.2', from: '22.23.2', targetMajor: 24, range: '^22.19.0 || >=24.0.0' }).reason, 'not-newer')
  // 主版本没到目标 LTS
  assert.equal(v({ probed: '23.11.1', from: '22.23.2', targetMajor: 24, range: '>=22' }).reason, 'major-below-target')
  // 同主版本但补丁不够（24.22.1 不满足 ^24.22.3）
  assert.equal(v({ probed: '24.22.1', from: '24.16.0', targetMajor: 24, range: NEW_RANGE }).reason, 'engines-unsatisfied')
  // 读不出版本 → 失败（注册表版本不能顶替实探）
  assert.equal(v({ probed: '', from: '24.16.0', targetMajor: 24, range: NEW_RANGE }).reason, 'version-unreadable')
})

test('接线：升级验收走 verifyUpgradedNode + 实探 nodeBin，且 msiUsable 不再按 engines 判', () => {
  assert.match(envInstallSrc, /verifyUpgradedNode\(\{ probed, from: plan\.from, targetMajor: plan\.targetMajor, range: engineRange \}\)/,
    'MSI 升级验收必须把实探版本交给 verifyUpgradedNode')
  assert.match(envInstallSrc, /probeUserNodeVersion\(nodeBin, job\)/, 'MSI 升级后要实探刚装好的 node.exe')
  assert.match(envInstallSrc, /verifyUpgradedNode\(\{ probed: afterVersion, from: plan\.from/, '用户级升级同样走统一验收')
  assert.doesNotMatch(envInstallSrc, /msiUsable = installedMsi[\s\S]{0,200}decideUserNodeReuse/, 'msiUsable 不能按 engines 判（版本太旧会误判成产品坏了）')
})

// ---------- C. envSummary 透传：渲染层只消费事实、不重算 ----------
test('envSummary：nodeUpgrade 原样透出（同一份事实对象）；报告缺该字段时回落 null', () => {
  const up = { mode: 'msi', from: '22.23.2', targetMajor: 24, dir: 'C:\\Program Files\\nodejs\\', reason: 'msi-older-major' }
  assert.strictEqual(envDetect.envSummary(makeReport(up)).nodeUpgrade, up, '环境页升级卡片的唯一输入必须原样透出')
  assert.equal(envDetect.envSummary(makeReport(undefined)).nodeUpgrade, null, '旧报告没有该字段 → null（不出现升级卡片）')
  assert.equal(envDetect.envSummary(makeReport(null)).nodeUpgrade, null)
  assert.equal(envDetect.envSummary(null), null)
})

// ---------- D. 版本漂移护栏：内置包 / 两处 Config 默认值必须与 DEFAULT_NODE_MAJOR 同源 ----------

test('版本漂移护栏：内置 Node 发行包的大版本与 DEFAULT_NODE_MAJOR 一致', () => {
  const m = /const\s+version\s*=\s*args\[0\]\s*\|\|\s*'([^']+)'/.exec(fetchDistSrc)
  assert.ok(m, 'tools/fetch-node-dist.mjs 里找不到默认版本常量')
  const version = m[1]
  assert.match(version, /^\d+\.\d+\.\d+$/, '内置包默认版本应是完整 semver：' + version)
  assert.equal(Number(version.split('.')[0]), envDetect.DEFAULT_NODE_MAJOR,
    `内置包 v${version} 与 DEFAULT_NODE_MAJOR=${envDetect.DEFAULT_NODE_MAJOR} 漂移`)
})

test('版本漂移护栏：main.js / env-install.js 的 Config 默认 nodeMajor 都引用 DEFAULT_NODE_MAJOR（不写死 22）', () => {
  for (const [name, src] of [['main.js', mainJs], ['env-install.js', envInstallSrc]]) {
    assert.match(src, /nodeMajor:\s*envDetect\.DEFAULT_NODE_MAJOR/,
      `${name} 的 Config 默认值必须引用 envDetect.DEFAULT_NODE_MAJOR`)
    assert.doesNotMatch(src, /nodeMajor:\s*22\b/, `${name} 不能把默认值写回 22`)
  }
})

// ---------- E. 接线护栏：主进程配置迁移 / 停服恢复 / 安装分支 / 渲染层 ----------

test('main.js：旧默认值（< 目标大版本）做一次性配置迁移，并在 loadConfig 里立刻落盘', () => {
  assert.match(mainJs, /Number\(cfg\.nodeMajor\) < targetNodeMajor/, '要识别小于目标大版本的旧默认值（22/24）')
  assert.match(mainJs, /String\(Config\.nodeMajorMigratedTo \|\| ''\) !== String\(targetNodeMajor\)/,
    '每个目标大版本只迁移一次（尊重用户显式值）')
  assert.match(mainJs, /Config\.nodeMajorMigratedTo = String\(targetNodeMajor\)/, '迁移后要落标记')
  assert.match(mainJs, /configMigrationPending = true/, '要记下"待落盘"状态')
  const loadConfigBody = sliceBetween(mainJs, 'function loadConfig()', 'function mergeConfigFromDisk', 'loadConfig')
  assert.match(loadConfigBody, /if \(configMigrationPending\)/, 'loadConfig 要消费迁移标记')
  assert.match(loadConfigBody, /saveConfig\(\)/, '迁移标记要立刻落盘，避免下次启动又按旧默认值判断一遍')
})

test('main.js resetDefaults：nodeMajor 回到 DEFAULT_NODE_MAJOR（并同步迁移标记）', () => {
  const body = sliceBetween(mainJs, "case 'resetDefaults': {", "case '", 'resetDefaults 分支')
  assert.match(body, /Config\.nodeMajor = envDetect\.DEFAULT_NODE_MAJOR/, '重置默认不能把 nodeMajor 留回 22')
  assert.match(body, /Config\.nodeMajorMigratedTo = String\(envDetect\.DEFAULT_NODE_MAJOR\)/, '重置后也要有迁移标记')
})

test('main.js envInstall：「升级 Node.js」先停稳服务，失败/取消后由 onFail 恢复（fail-closed）', () => {
  const envInstallCase = sliceBetween(mainJs, "case 'envInstall':", "case 'envCancel'", 'envInstall 分支')
  assert.match(envInstallCase, /opts\.nodeUpgrade === true/, '只有显式升级才走"先停服务"流程')
  assert.match(envInstallCase, /nodeUpgradeRestartPending = true/, '停服务前先记账（失败后要负责拉回来）')
  assert.match(envInstallCase, /await stopServer\(\)/, '升级前必须停服务：旧 node.exe 占用会让 major upgrade 失败')
  assert.match(envInstallCase, /服务未能确认停止/, '停止无法确认就一个字节都不改（fail-closed）')
  assert.match(envInstallCase, /envInstall\.startInstall\(items, opts\)/, 'opts 原样透传给安装引擎')

  const onFailBody = sliceBetween(mainJs, 'onFail: () => {', '\n  })\n}', 'initInstaller onFail')
  assert.match(onFailBody, /nodeUpgradeRestartPending/, 'onFail 只处理"停过服务"的升级任务')
  assert.match(onFailBody, /refreshEnv\(true\)/, '恢复前先强制重探环境')
  assert.match(onFailBody, /handleStart\(\)/, '环境就绪且服务没在跑 → 必须把服务拉回来')
})

test('main.js envInstall onDone：Node 升级成功后复检"被 Node 拦下"的 DSH 更新状态', () => {
  const onDoneBody = sliceBetween(mainJs, 'onDone: () => {', 'onFail: () => {', 'initInstaller onDone')
  assert.match(onDoneBody, /afterEnvInstallDone\(envInstall\.getJob\(\)\)/,
    'onDone 只做接线，实际收尾放在可测试的顶层函数里（见 tests/env-install-done.test.js）')
  const body = sliceBetween(mainJs, 'async function afterEnvInstallDone', 'function initEnvRuntime', 'afterEnvInstallDone')
  assert.match(body, /jobItems\.includes\('node'\)/, '只有确实装了 Node 才复检，插件安装不该多一次网络检查')
  assert.match(body, /dshNow\.nodeBlocked/, '只复检"因 Node 要求被拦"的错误态')
  assert.match(body, /dshUpdater\.checkOnce\('manual', true\)\.catch\(/,
    '复检必须接住 rejection（否则界面停在旧结论）')
  assert.ok(body.indexOf('await refreshEnv(true)') < body.indexOf("jobItems.includes('node')"),
    '必须先刷新环境（看到新 Node）再判断要不要复检')
})

test('渲染层：nodeBlocked 按钮文案与真实动作一致（打开运行环境，而非直接升级）', () => {
  const block = sliceBetween(appJs, '} else if (u.nodeBlocked) {', '} else {', 'nodeBlocked 按钮分支')
  assert.match(block, /btn\.textContent = '打开运行环境'/, '按钮应如实说明是跳转，不是直接升级')
  assert.doesNotMatch(block, /btn\.textContent = '先升级 Node\.js'/, '不能承诺一个点击并不会执行的动作')
  assert.match(block, /打开运行环境页升级 Node\.js/, 'tooltip 要说明真正的升级动作在环境页')
  assert.match(block, /u\.nodeUpgradeAvailable/, '只有环境页真有升级入口时才给跳转按钮')
  const clickBlock = sliceBetween(appJs, "$('btnDshUpdateNow').addEventListener", '\n});', 'DSH 更新按钮点击处理')
  assert.match(clickBlock, /u\.nodeBlocked && u\.nodeUpgradeAvailable/, '没有入口时不能跳到空页面')
})

test('更新窗口：被 Node 拦下时有直达运行环境页的出口（只放行固定页面）', () => {
  const updateJs = read('ui-src/update.js')
  assert.match(updateJs, /s\.nodeBlocked && s\.nodeUpgradeAvailable/, '失败详情里要识别 Node 拦截，且只在有入口时给下一步')
  assert.match(updateJs, /cmd\('openEnvPage'\)/, '按钮要真的触发跳转命令')
  const updateCmd = sliceBetween(mainJs, "ipcMain.handle('update:cmd'", 'ipcMain.handle(', 'update:cmd 分支')
  assert.match(updateCmd, /case 'openEnvPage'/, '主进程要放行这个固定动作')
  assert.match(updateCmd, /showConsolePage\('env'\)/, '只打开运行环境页，不接受任意页面参数')
  assert.match(mainJs, /nodeUpgradeAvailable: !!\(envReport && envReport\.nodeUpgrade\)/,
    '快照要把"环境页是否有 Node 升级入口"如实带给渲染层')
})

test('env-install.js：MSI 升级带 upgradeFrom，并按实探版本 + engines 验收（不轻信退出码）', () => {
  assert.match(envInstallSrc, /plan\.action === 'install-msi' \|\| plan\.action === 'upgrade-msi'/, '要区分首次安装与升级')
  assert.match(envInstallSrc, /upgradeFrom: plan\.from/, '升级要把已安装版本交给 installNodeViaMsi')
  assert.match(envInstallSrc, /verifyUpgradedNode\(\{ probed, from: plan\.from/,
    '装完要按实探 node.exe 版本验收（严格更高 + 主版本 + engines），注册表/退出码不算数')
  assert.match(envInstallSrc, /官方 MSI major upgrade/, '日志要如实说明走的是 major upgrade')
})

test('env-install.js：用户级 zip 升级走 force + keepBackupWithGlobals，并按实探版本验收', () => {
  const seg = sliceBetween(envInstallSrc, "} else if (plan.action === 'upgrade-user') {", '} else {', 'upgrade-user 分支')
  assert.match(seg, /force: true/, '升级要强制替换目录（不复用旧版本）')
  assert.match(seg, /keepBackupWithGlobals: true/, '旧目录里有用户全局包时要保留备份（data-safety）')
  assert.match(seg, /verifyUpgradedNode\(\{ probed: afterVersion, from: plan\.from/, '替换后要按实探版本验收')
  // installNodeUserLevel 必须真的消费这两个开关，否则传了也白传
  assert.match(envInstallSrc, /opts\.keepBackupWithGlobals/, 'installNodeUserLevel 要读 keepBackupWithGlobals')
  assert.match(envInstallSrc, /const force = opts\.force === true/, 'installNodeUserLevel 要读 force')
})

test('env-install.js：MSI 升级失败只报错，不回退用户级 zip（旧 MSI 会遮蔽，装了等于没装）', () => {
  const seg = sliceBetween(envInstallSrc, '} else if (isUpgrade) {', '} else {', 'isUpgrade 失败分支')
  assert.match(seg, /throw new Error/, '升级失败要抛错（任务状态 failed）')
  assert.match(seg, /旧版本/, '错误信息要说清旧版本仍在原位、环境未被改动')
  assert.doesNotMatch(seg, /installNodeUserLevel/, '升级失败分支绝不能回退用户级安装')
})

test('env-install.js：失败/取消统一走 onFail 回调（显式升级停过服务，必须通知上层恢复）', () => {
  assert.match(envInstallSrc, /onFailFn\(job\)/, 'catch 分支要调用失败回调')
  assert.match(envInstallSrc, /typeof opts\.onFail === 'function'/, 'initInstaller 要能接收 onFail')
})

test('ui-src/app.js 与 wwwroot/app.js：升级入口四段齐全，且两份产物完全同步', () => {
  assert.equal(normalizeEol(builtAppJs), normalizeEol(appJs), 'wwwroot/app.js 未同步：先跑 npm run build:assets')

  for (const [name, src] of [['ui-src/app.js', appJs], ['wwwroot/app.js', builtAppJs]]) {
    // ① 卡片：只在主进程探测给出 nodeUpgrade 时出现，文案按 mode 区分
    assert.match(src, /if \(env\.nodeUpgrade\)/, `${name} 缺升级卡片条件（事实只来自主进程）`)
    assert.match(src, /name: 'Node\.js 升级'/, `${name} 缺升级卡片`)
    assert.match(src, /badge: 'warn'/, `${name} 升级卡片应是 warn 级`)
    assert.match(src, /esc\(up\.from\)/, `${name} 版本文本必须经 esc() 转义`)
    assert.match(src, /esc\(up\.dir\)/, `${name} 路径文本必须经 esc() 转义`)
    // ② 按钮与动作标记；点击先确认代价（停服务 / msi 需管理员授权 / 失败自动恢复）
    assert.match(src, /data-env-act="upgrade-node"/, `${name} 缺升级按钮动作标记`)
    assert.match(src, /confirmDialog\(/, `${name} 点击升级必须先确认`)
    assert.match(src, /升级 Node\.js 到 \$\{targetMajor\} LTS？/, `${name} 确认框标题要与目标版本一致`)
    assert.match(src, /需一次管理员授权/, `${name} msi 模式要点明需要管理员授权`)
    // ③ payload：只声明"升级 Node"，mode（msi / user）由主进程探测
    assert.match(src, /cmd\('envInstall', \{ items: \['node'\], forceNodeInstall: true, nodeUpgrade: true \}\)/,
      `${name} 的升级 payload 与后端约定不一致`)
    // ④ 启动失败要让用户看到 error（不能点了没反应）
    assert.match(src, /r\.ok === false/, `${name} 要处理启动失败回执`)
    assert.match(src, /showConsoleToast/, `${name} 失败时要把 error 呈现给用户`)
    // ⑤ 安装进行中同时禁用迁移与升级两个入口（querySelectorAll：卡片会重建、可能并存）
    assert.match(src, /querySelectorAll\([^)]*migrate-msi[^)]*upgrade-node[^)]*\)/,
      `${name} 的安装中禁用必须同时覆盖 migrate-msi 与 upgrade-node 两张卡`)
  }
})

// 探测侧 envSummary 的接线也在这条链上：报告必须带 nodeUpgrade 事实（避免只改了渲染层）
test('env-detect.js：报告与 envSummary 都带 nodeUpgrade（链路第一段不断）', () => {
  assert.match(envDetectSrc, /const nodeUpgrade =[^\n]*decideNodeUpgrade\(/, 'buildReport 要调用 decideNodeUpgrade 得到事实')
  assert.match(envDetectSrc, /nodeUpgrade,/, '报告要带 nodeUpgrade 字段')
  assert.match(envDetectSrc, /nodeUpgrade: report\.nodeUpgrade \|\| null/, 'envSummary 要透出 nodeUpgrade')
  assert.match(envDetectSrc, /decideNodeUpgrade,/, 'decideNodeUpgrade 要对外导出（可测试）')
})

// 首页（通用页）状态卡上的第二个入口：Node 22 用户不会主动进运行环境页，首页要有可见但不吵的入口。
test('首页状态卡：Node.js 升级行只在有事实时出现，且与运行环境页共用同一个升级入口', () => {
  for (const [name, html] of [['ui-src/index.html', indexHtml], ['wwwroot/index.html', builtIndexHtml]]) {
    assert.match(html, /id="nodeUpgradeRow"/, `${name} 缺首页 Node.js 升级行容器`)
    assert.match(html, /id="btnNodeUpgrade"/, `${name} 缺首页升级按钮`)
    assert.match(html, /id="nodeUpgradeVersion"/, `${name} 缺首页当前版本展示`)
    // 默认隐藏：没有可升级事实时不能占版面（不是常驻设置项）
    assert.match(html, /class="row version-row hidden" id="nodeUpgradeRow"/, `${name} 的升级行必须默认隐藏`)
    // 与状态卡其他版本行同一种形态（能复用既有样式，不新造警示卡）
    assert.ok(html.includes('id="statusCard"'), `${name} 缺状态卡容器`)
  }
  assert.ok(!builtIndexHtml.includes('__WHALE_PATH__'), 'wwwroot/index.html 的鲸鱼路径占位符必须已被内联')

  // 渲染：只在 nodeUpgrade 存在时去掉 hidden；按钮文案/提示跟 mode 走
  assert.match(appJs, /const row = \$\('nodeUpgradeRow'\)/, '渲染层要更新首页升级行')
  assert.match(appJs, /row\.classList\.(remove|add)\('hidden'\)/, '渲染层要切换首页行的显隐')
  assert.match(appJs, /可升级到 Node\.js \$\{targetMajor\} LTS/, '首页提示要带上目标版本')
  assert.match(appJs, /免管理员授权/, 'user 模式要说明免管理员授权')
  // 共用入口：两张入口不能各写一套确认/payload（否则文案与行为会漂移）
  assert.match(appJs, /async function startNodeUpgrade\(\)/, '升级入口要收敛成一个函数')
  assert.match(appJs, /=== 'upgrade-node'[\s\S]{0,300}await startNodeUpgrade\(\)/, '运行环境页的升级卡应调用共用入口')
  assert.match(appJs, /\$\('btnNodeUpgrade'\)\.addEventListener\('click', \(\) => void startNodeUpgrade\(\)\)/, '首页按钮要绑定同一个入口')
  // 动作启动后要切到运行环境页看进度/日志/重试（首页没有任务视图，不能点了没反馈）
  assert.match(sliceBetween(appJs, 'async function startNodeUpgrade() {', 'function renderEnvSummary(env)', 'startNodeUpgrade'),
    /showPage\('env'\)/, '升级任务启动后要跳到运行环境页，保证有可见进度与结果')
  // 安装进行中两个入口一起进忙态
  assert.match(appJs, /const homeUpBtn = \$\('btnNodeUpgrade'\)/, '任务进行中首页按钮也要禁用')
  assert.match(appJs, /homeUpBtn\.disabled = running/, '任务进行中首页按钮要进忙态')
})

// ---------- F. Node 25/26 不再内置 Corepack：MSI 升级后必须清掉失效的旧 pnpm shim ----------
//
// 2026-11-22 实测：Node 24 → 26 的 MSI major upgrade 留下了 2026-09 生成的
// C:\Program Files\nodejs\pnpm.cmd（内容指向 node_modules\corepack\dist\pnpm.js），
// 但 Node 26 不再内置 corepack，该目标已不存在；它排在 PATH 前面，导致 pnpm 变成
// "存在但读不到版本"，全局 pnpm 11.8.0 永远轮不到。
test('env-install：清理旧版 Corepack 的 pnpm shim（只删 corepack 且目标已不存在的）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-corepack-'))
  const logLines = []
  const job = { logLine: (m) => logLines.push(String(m)) }
  try {
    const shim = (name) => path.join(dir, name)
    fs.writeFileSync(shim('pnpm.cmd'), '@IF EXIST "%~dp0\node.exe" (\r\n  "%~dp0\node.exe"  "%~dp0\node_modules\corepack\dist\pnpm.js" %*\r\n)\r\n')
    fs.writeFileSync(shim('pnpm'), '#!/bin/sh\nexec node "$basedir/node_modules/corepack/dist/pnpm.js" "$@"\n')
    fs.writeFileSync(shim('pnpm.ps1'), '# corepack shim\n')
    // 非 corepack 的 shim（例如 npm 全局安装的同名命令）不能被误删
    fs.writeFileSync(shim('yarn.cmd'), '@echo off\r\nyarn %*\r\n')
    const removed = envInstall.cleanupStaleCorepackPnpmShims(job, dir)
    assert.deepEqual(removed.sort(), ['pnpm', 'pnpm.cmd', 'pnpm.ps1'].sort())
    for (const n of ['pnpm', 'pnpm.cmd', 'pnpm.ps1']) assert.equal(fs.existsSync(shim(n)), false, `${n} 应被删除`)
    assert.equal(fs.existsSync(shim('yarn.cmd')), true, '非 corepack shim 不能动')
    assert.ok(logLines.some((l) => l.includes('已清理旧版 Corepack')), '清理要留日志：' + logLines.join(' | '))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('env-install：Corepack 仍在时保留 shim；非 corepack 的同名命令也不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-corepack-'))
  try {
    fs.mkdirSync(path.join(dir, 'node_modules', 'corepack', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', 'corepack', 'dist', 'pnpm.js'), '// corepack\n')
    fs.writeFileSync(path.join(dir, 'pnpm.cmd'), '"%~dp0\node.exe" "%~dp0\node_modules\corepack\dist\pnpm.js" %*\r\n')
    let removed = envInstall.cleanupStaleCorepackPnpmShims({ logLine: () => {} }, dir)
    assert.deepEqual(removed, [], 'Corepack 目标存在时不能删 shim')

    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true })
    fs.writeFileSync(path.join(dir, 'pnpm.cmd'), '@echo off\r\npnpm-real %*\r\n')
    removed = envInstall.cleanupStaleCorepackPnpmShims({ logLine: () => {} }, dir)
    assert.deepEqual(removed, [], '内容不是 corepack 的 pnpm 命令不能删')
    assert.equal(fs.existsSync(path.join(dir, 'pnpm.cmd')), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('env-install：MSI 安装脚本在同一次提权里清理旧 Corepack 的 pnpm shim', () => {
  const body = sliceBetween(envInstallSrc, 'async function runElevatedMsi', '// ---------- 各阶段实现', 'runElevatedMsi')
  assert.match(body, /node_modules.+corepack.+dist.+pnpm\.js/, '要先判断 corepack 目标是否真的不存在')
  assert.match(body, /Remove-Item -LiteralPath \$f/, '在提权进程内删除残留 shim（Program Files 需要管理员）')
  assert.match(body, /ExitCode -eq 0 -or \$p\.ExitCode -eq 3010/, 'MSI 成功（含需重启）才清理')
  assert.match(body, /-match 'corepack'/, '只删内容确实是 corepack shim 的文件')
  const msiBody = sliceBetween(envInstallSrc, 'async function installNodeViaMsi', '// 清理旧版 Corepack', 'installNodeViaMsi')
  assert.match(msiBody, /cleanupStaleCorepackPnpmShims\(job, dir\)/, '安装流程也要在非提权场景下幂等清理一次')
})
