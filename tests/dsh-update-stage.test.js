// tests/dsh-update-stage.test.js — 预装（staging）与改名切换
// 覆盖三块：
//   1) 纯函数判定（路径规划 / 预装树准入 / 中断事务收场 / 过期暂存清理）
//   2) 真实目录演练：改名顶上 + 退回（不依赖 npm，用假包目录）
//   3) 中断事务的三条收场分支：补完 / 退回 / 无需修复
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dshUpdater = require('../dsh-update')

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-stage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// 造一棵假的 @deepseek-ai/dsh 包目录：package.json（名字/版本/bin）+ bin.js（--version 打印版本）
function makePkg(dir, version, binRel = 'lib/bin.js') {
  const binAbs = path.join(dir, binRel)
  fs.mkdirSync(path.dirname(binAbs), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
    bin: { dsh: binRel },
  }))
  fs.writeFileSync(binAbs, 'console.log(' + JSON.stringify(version) + ')\n')
}

function readVersion(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version } catch { return '' }
}

function installDirOf(prefix) {
  return path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
}

// ---------- 1) 纯函数 ----------

test('npmPrefixOf：从包目录反推 npm 前缀（暂存目录与全局根同卷的依据）', () => {
  assert.equal(dshUpdater.npmPrefixOf(installDirOf('C:\\npm')), 'C:\\npm')
  assert.equal(dshUpdater.npmPrefixOf('/usr/local/lib/node_modules/@deepseek-ai/dsh'), '/usr/local/lib')
  // 形态不符（不是 node_modules 下的一级包）→ 空串：宁可不预装，也不猜一个可能跨卷的暂存位
  assert.equal(dshUpdater.npmPrefixOf('C:\\somewhere\\@deepseek-ai\\dsh'), '')
  assert.equal(dshUpdater.npmPrefixOf(''), '')
})

test('planSwapPaths：暂存与备份都落在同一前缀下，且按版本号确定性命名', () => {
  const installDir = installDirOf('C:\\npm')
  const p = dshUpdater.planSwapPaths({ installDir, version: '0.2.0' })
  assert.equal(p.prefix, 'C:\\npm')
  assert.equal(p.stageRoot, path.join('C:\\npm', '.dshl-stage'))
  assert.equal(p.stagePrefix, path.join('C:\\npm', '.dshl-stage', '0.2.0'))
  assert.equal(p.stagePkg, path.join('C:\\npm', '.dshl-stage', '0.2.0', 'node_modules', '@deepseek-ai', 'dsh'))
  // 必须确定性：事务里记的备份路径与实际改名路径要一致，崩溃恢复才找得到旧树
  assert.equal(p.backupDir, path.join('C:\\npm', '.dshl-stage', 'old-0.2.0'))
  assert.deepEqual(dshUpdater.planSwapPaths({ installDir, version: '0.2.0' }), p)
  assert.equal(dshUpdater.stageRootOf(installDir), p.stageRoot)
  // 非 semver 版本号（'latest' / 空）不能用来命名暂存目录
  assert.equal(dshUpdater.planSwapPaths({ installDir, version: 'latest' }), null)
  assert.equal(dshUpdater.planSwapPaths({ installDir: 'C:\\x', version: '0.2.0' }), null)
})

test('decideStagedInstall：只有版本对得上、测得通、bin 布局没变才允许顶上', () => {
  const base = {
    targetVersion: '0.2.0',
    installDirExists: true,
    stagedPkgExists: true,
    stagedVersion: '0.2.0',
    probeVersion: '0.2.0',
    stagedBinLayout: 'dsh=lib/bin.js',
    installedBinLayout: 'dsh=lib/bin.js',
  }
  const d = (patch) => dshUpdater.decideStagedInstall(Object.assign({}, base, patch))
  assert.equal(d({}).action, 'use')
  assert.equal(d({ installDirExists: false }).reason, 'no-install-dir')
  assert.equal(d({ stagedPkgExists: false }).reason, 'staging-incomplete')
  assert.equal(d({ stagedVersion: '0.1.9' }).reason, 'staged-version-mismatch')
  assert.equal(d({ probeVersion: '' }).reason, 'probe-failed')
  assert.equal(d({ probeVersion: '0.1.9' }).reason, 'probe-failed')
  // bin 入口布局变了就不能整目录顶上（线上 .bin shim 指向包内相对路径）
  assert.equal(d({ stagedBinLayout: 'dsh=bin/dsh.mjs' }).reason, 'bin-layout-changed')
  // 读不到线上布局时不据此拒绝（宁可放行，也别因为读不到就永远不预装）
  assert.equal(d({ installedBinLayout: '' }).action, 'use')
  assert.equal(d({ targetVersion: '' }).reason, 'no-target')
})

test('decideSwapRecovery：按文件系统事实决定补完 / 退回 / 无需修复 / 只能重装', () => {
  const d = (patch) => dshUpdater.decideSwapRecovery(Object.assign({
    target: '0.2.0',
    installVersion: '',
    backupExists: false,
    stagedPkgExists: false,
    stagedVersion: '',
    probeVersion: '',
  }, patch))
  assert.equal(d({ installVersion: '0.2.0' }).action, 'done')
  assert.equal(d({ backupExists: true, stagedPkgExists: true, stagedVersion: '0.2.0', probeVersion: '0.2.0' }).action, 'complete')
  assert.equal(d({ backupExists: true, stagedPkgExists: true, stagedVersion: '0.2.0', probeVersion: '' }).action, 'restore')
  assert.equal(d({ backupExists: true, installVersion: '' }).action, 'restore')
  // 安装目录完好（只是还没换）→ 别乱动，也别谎称修复
  assert.equal(d({ installVersion: '0.1.0' }).action, 'intact')
  // 目录没了又没有备份 → 改名救不了，只能重装
  assert.equal(d({}).action, 'fallback')
})

test('staleStageEntries：只清版本号目录与 old-/rejected- 备份，别的一律不碰', () => {
  const names = ['0.1.0', '0.2.0', 'old-1', 'rejected-2', '.git', 'notes.txt', '']
  assert.deepEqual(dshUpdater.staleStageEntries(names, '0.2.0'), ['0.1.0', 'old-1', 'rejected-2'])
  assert.deepEqual(dshUpdater.staleStageEntries(names, ''), ['0.1.0', '0.2.0', 'old-1', 'rejected-2'])
  assert.deepEqual(dshUpdater.staleStageEntries([], '0.2.0'), [])
})

// ---------- 2) 真实目录演练：顶上 + 退回 ----------

test('改名切换：预装树顶上、旧树完整进备份、事务先落盘；退回后旧树回原位', async (t) => {
  const root = tmpRoot(t)
  const prefix = path.join(root, 'npm')
  const installDir = installDirOf(prefix)
  const version = '0.2.0'
  const paths = dshUpdater.planSwapPaths({ installDir, version })
  makePkg(installDir, '0.1.0')
  makePkg(paths.stagePkg, version)
  fs.writeFileSync(path.join(installDir, 'old-only.txt'), 'old')
  fs.writeFileSync(path.join(paths.stagePkg, 'new-only.txt'), 'new')
  const statePath = path.join(root, 'tx.json')
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'latest' }, statePath, log: () => {} })

  const sw = await dshUpdater.swapStagedInto({
    nodeBin: process.execPath,
    installDir,
    version,
    from: '0.1.0',
    info: { version, installDir, stagePkg: paths.stagePkg, stageRoot: paths.stageRoot, stagePrefix: paths.stagePrefix },
  })
  assert.equal(sw.ok, true, '切换应成功')
  assert.equal(readVersion(installDir), version, '安装目录应是新树')
  assert.ok(fs.existsSync(path.join(installDir, 'new-only.txt')))
  assert.ok(!fs.existsSync(path.join(installDir, 'old-only.txt')), '新树里不该有旧文件残留')
  assert.ok(fs.existsSync(path.join(paths.backupDir, 'old-only.txt')), '旧树应完整躺在备份目录里')
  assert.ok(fs.existsSync(statePath), '切换前必须落事务：崩在两次改名之间时靠它恢复')

  const rb = await dshUpdater.restoreSwap(sw, process.execPath)
  assert.equal(rb.ok, true, '退回应成功')
  assert.equal(rb.version, '0.1.0')
  assert.equal(readVersion(installDir), '0.1.0', '安装目录应回到旧树')
  assert.ok(fs.existsSync(path.join(installDir, 'old-only.txt')))
  assert.ok(!fs.existsSync(path.join(installDir, 'new-only.txt')))
})

test('没有预装树（用户点得太快）时切换被拒，不碰安装目录', async (t) => {
  const root = tmpRoot(t)
  const installDir = installDirOf(path.join(root, 'npm'))
  makePkg(installDir, '0.1.0')
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'latest' }, statePath: path.join(root, 'tx.json'), log: () => {} })
  const sw = await dshUpdater.swapStagedInto({ nodeBin: process.execPath, installDir, version: '0.2.0' })
  assert.equal(sw.ok, false)
  assert.equal(sw.reason, 'no-staged-tree')
  assert.equal(readVersion(installDir), '0.1.0', '安装目录必须原样不动')
})

// ---------- 3) 中断事务的三条收场分支 ----------

function initWithSwap(t, root, tx) {
  const statePath = path.join(root, 'tx.json')
  fs.writeFileSync(statePath, JSON.stringify(tx))
  dshUpdater.initDshUpdater({
    Config: { dshChannel: 'latest' },
    statePath,
    log: () => {},
    notify: () => {},
    // 只注入探测：切换收场不需要 envInstall（能就地救回来就不走重装）
    envDetect: { detectEnv: async () => ({ plan: { nodeCmd: process.execPath } }) },
  })
  return statePath
}

test('崩在两次改名之间：旧树已让位、预装树可用 → 补完切换并清场', async (t) => {
  const root = tmpRoot(t)
  const installDir = installDirOf(path.join(root, 'npm'))
  const version = '0.2.0'
  const paths = dshUpdater.planSwapPaths({ installDir, version })
  makePkg(paths.backupDir, '0.1.0') // 旧树已让位（安装目录不存在）
  makePkg(paths.stagePkg, version)
  const statePath = initWithSwap(t, root, {
    kind: 'global', from: '0.1.0', to: version, phase: 'start', swap: true,
    installDir, stagePkg: paths.stagePkg, stagePrefix: paths.stagePrefix, backupDir: paths.backupDir,
  })

  const r = await dshUpdater.recoverInterruptedUpdate()
  assert.equal(r.recovered, true)
  assert.equal(r.mode, 'swap-completed')
  assert.equal(readVersion(installDir), version, '安装目录应补完为新版')
  assert.ok(!fs.existsSync(statePath), '收场后事务应清掉')
  assert.ok(!fs.existsSync(paths.backupDir), '旧树备份应被清理（已不是当前版本）')
})

test('预装树不可用 → 退回旧树，安装目录不能空着', async (t) => {
  const root = tmpRoot(t)
  const installDir = installDirOf(path.join(root, 'npm'))
  const target = '0.2.0'
  const paths = dshUpdater.planSwapPaths({ installDir, version: target })
  makePkg(paths.backupDir, '0.1.0')
  makePkg(paths.stagePkg, '0.3.0') // 预装树版本对不上 → 不可用
  const statePath = initWithSwap(t, root, {
    kind: 'global', from: '0.1.0', to: target, phase: 'start', swap: true,
    installDir, stagePkg: paths.stagePkg, stagePrefix: paths.stagePrefix, backupDir: paths.backupDir,
  })

  const r = await dshUpdater.recoverInterruptedUpdate()
  assert.equal(r.recovered, false)
  assert.equal(r.reason, 'rolled-back')
  assert.equal(readVersion(installDir), '0.1.0', '旧树应改名回原位')
  assert.ok(!fs.existsSync(statePath), '收场后事务应清掉')
})

test('切换还没开始（安装目录完好）→ 不动安装目录，只清事务', async (t) => {
  const root = tmpRoot(t)
  const installDir = installDirOf(path.join(root, 'npm'))
  const target = '0.2.0'
  const paths = dshUpdater.planSwapPaths({ installDir, version: target })
  makePkg(installDir, '0.1.0')
  const statePath = initWithSwap(t, root, {
    kind: 'global', from: '0.1.0', to: target, phase: 'start', swap: true,
    installDir, stagePkg: paths.stagePkg, stagePrefix: paths.stagePrefix, backupDir: paths.backupDir,
  })

  const r = await dshUpdater.recoverInterruptedUpdate()
  assert.equal(r.reason, 'swap-not-started')
  assert.equal(readVersion(installDir), '0.1.0')
  assert.ok(!fs.existsSync(statePath))
})

test('没有事务文件 / 非 start 阶段：一律不动作（原有语义不变）', async (t) => {
  const root = tmpRoot(t)
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'latest' }, statePath: path.join(root, 'none.json'), log: () => {}, notify: () => {} })
  assert.deepEqual(await dshUpdater.recoverInterruptedUpdate(), { recovered: false, reason: 'no-pending' })
})

// ---------- 4) 源选择：--prefer-offline 只能加给"钉死版本的安装"，不能加给 npm view ----------

test('--prefer-offline 只用于钉死版本的安装：npm view 必须走网络（否则检测永远读到旧的最新版）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dsh-update.js'), 'utf8')
  const viewArgs = /const args = \['view'[^\]]*\]/.exec(src)
  assert.ok(viewArgs, '应能找到 npm view 的参数构造')
  assert.ok(!/prefer-offline/.test(viewArgs[0]), 'npm view 不能带 --prefer-offline')
  const installArgs = /const args = \['install', '-g', '--prefix', globalRoot[^\]]*\]/.exec(src)
  assert.ok(installArgs, '应能找到全局安装的参数构造')
  assert.match(installArgs[0], /--prefer-offline/, '全局安装应带 --prefer-offline')
})
