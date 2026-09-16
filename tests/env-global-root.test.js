// tests/env-global-root.test.js — 回归：npm 全局根不等于 %APPDATA%\npm 时，已装的 DSH 必须仍被发现
//
// 背景（v1.4.4 用户反馈）：
//   dshl 曾用官方 Node **zip** 发行包把 Node 装到用户级目录，而 zip 版 Node 的 npm 没有 MSI/官方安装器
//   那份 `prefix=${APPDATA}\npm` 的 npmrc，npm 内建默认前缀就是 **node.exe 所在目录**。于是：
//     安装侧 resolveGlobalRoot() 问 `npm config get prefix` → %LOCALAPPDATA%\Programs\nodejs
//       → npm i -g --prefix <nodeDir> 装到 <nodeDir>\node_modules\@deepseek-ai\dsh，dsh-verify 用同一个
//         prefix 复验 → 任务 done；
//     探测侧 env-detect 只扫 %APPDATA%\npm、%ProgramData%\npm → 什么都找不到
//       → ready=false + "未检测到 DeepSeek Harness"（安装完成却环境未就绪，自相矛盾）。
// 现在 Node 默认改用官方 MSI（自带那份 npmrc，全局包落在 %APPDATA%\npm），但**存量机器**上仍会有这种
// 用户级布局，zip 兜底路径也会产生同样的布局 —— 所以两边都必须对得上：装到哪儿就要能找着哪儿。
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const envDetect = require('../env-detect')

// npm run 会把 npm_config_* 注入子进程环境，其中 npm_config_prefix 会盖掉 npmrc 里的 prefix，
// 让"问 npm 要全局根"这一步直接读到本机真实的 %APPDATA%\npm —— 沙箱必须把这些也一起按住。
const ENV_KEYS = ['APPDATA', 'ProgramData', 'LOCALAPPDATA', 'DSHL_USER_NODE_DIR', 'DSHL_NPM_GLOBAL_ROOT', 'DSHL_FRESH_TEST', 'npm_config_prefix', 'npm_config_global_prefix']

// 隔离沙箱：AppData / HOME / 自装 Node 目录全部指向临时目录，
// 避免本机真实的 %APPDATA%\npm（开发机上确实装着 DSH）把结论"喂"成通过。
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-global-root-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
  const dirs = {
    base,
    home: path.join(base, 'home', '.dsh'),
    appData: path.join(base, 'appdata'),
    localAppData: path.join(base, 'localappdata'),
    programData: path.join(base, 'programdata'),
  }
  for (const d of [dirs.home, dirs.appData, dirs.localAppData, dirs.programData]) fs.mkdirSync(d, { recursive: true })
  process.env.APPDATA = dirs.appData
  process.env.ProgramData = dirs.programData
  process.env.LOCALAPPDATA = dirs.localAppData
  delete process.env.DSHL_FRESH_TEST
  delete process.env.DSHL_NPM_GLOBAL_ROOT
  delete process.env.npm_config_prefix
  delete process.env.npm_config_global_prefix
  return dirs
}

// dshl 一键安装的用户级 Node 落位（官方 zip 解压后 node.exe 就在这一层）
function makeUserNodeDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
  try { fs.linkSync(process.execPath, bin) } catch { fs.copyFileSync(process.execPath, bin) }
  return dir
}

// "npm i -g --prefix <prefix> 之后"的真实布局：<prefix>/node_modules/@deepseek-ai/dsh + lib/bin.js
function makeGlobalDsh(prefix, version) {
  const dir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
    bin: { dsh: 'lib/bin.js' },
    engines: { node: envDetect.DEFAULT_ENGINE_RANGE },
  }))
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '// fake dsh bin\n')
  return dir
}

function initDetect(home, Config) {
  envDetect.initEnv({
    realHome: home,
    Config: { harnessRoot: '', nodePath: '', pnpmVersion: '11.8.0', ...Config },
    log: () => {},
  })
}

test('npm 全局根 = 自装 Node 目录（官方 zip 版 Node）时，装在那儿的 DSH 必须被发现', async (t) => {
  const sb = sandbox(t)
  const nodeDir = path.join(sb.localAppData, 'Programs', 'nodejs')
  makeUserNodeDir(nodeDir)
  process.env.DSHL_USER_NODE_DIR = nodeDir // 与 env-install.userNodeDir() 的落位一致
  const dshDir = makeGlobalDsh(nodeDir, '0.1.5-rc.2')

  initDetect(sb.home, {})
  const report = await envDetect.detectEnv(true)

  const hit = [report.dsh, ...report.alternatives].find((e) => e.dir === dshDir)
  assert.ok(hit, '必须发现 <nodeDir>\\node_modules 下的全局 DSH（%APPDATA%\\npm 下什么都没有）')
  assert.equal(hit.kind, 'global')
  assert.equal(hit.version, '0.1.5-rc.2')
  assert.ok(!report.issues.includes('未检测到 DeepSeek Harness'), '不得再报"未检测到 DeepSeek Harness"')
  assert.equal(report.dsh.built, true)
  assert.equal(report.ready, true, '装好了就该就绪（这条断言就是当年那句自相矛盾）')
})

test('安装侧记账的 npm 全局根（自定义 .npmrc prefix）同样要被扫到', async (t) => {
  const sb = sandbox(t)
  const custom = path.join(sb.base, 'npm-global') // 既不是 %APPDATA%\npm，也不是 Node 目录
  const dshDir = makeGlobalDsh(custom, '0.2.0')
  process.env.DSHL_USER_NODE_DIR = path.join(sb.localAppData, 'Programs', 'nodejs')

  initDetect(sb.home, { npmGlobalRoot: custom })
  const report = await envDetect.detectEnv(true)

  const hit = [report.dsh, ...report.alternatives].find((e) => e.dir === dshDir)
  assert.ok(hit, 'Config.npmGlobalRoot 指向的根必须被扫到（安装侧就装在那儿）')
  assert.equal(hit.kind, 'global')
  assert.equal(hit.root, custom, '条目要带上它所在的 npm 前缀，便于诊断与更新锚定')
})

test('globalPrefixes：优先级 = 记账根 > 自装 Node 目录 > %APPDATA%\\npm；空值/相对路径不参与', (t) => {
  const sb = sandbox(t)
  const nodeDir = path.join(sb.localAppData, 'Programs', 'nodejs')
  const custom = path.join(sb.base, 'npm-global')
  process.env.DSHL_USER_NODE_DIR = nodeDir

  initDetect(sb.home, { npmGlobalRoot: custom, nodePath: 'node-relative-not-a-path' })
  const prefixes = envDetect.globalPrefixes()
  const lower = prefixes.map((p) => p.toLowerCase())

  assert.equal(prefixes[0], custom, '安装侧记账的实际前缀最优先')
  assert.ok(lower.includes(nodeDir.toLowerCase()), '自装 Node 目录要在候选里（npm 内建前缀 = node 目录）')
  const appDataNpm = path.join(sb.appData, 'npm').toLowerCase()
  assert.ok(lower.indexOf(nodeDir.toLowerCase()) < lower.indexOf(appDataNpm), '生效前缀要排在"默认值猜测"之前')
  assert.equal(new Set(lower).size, prefixes.length, '候选要去重')
  assert.ok(!lower.some((p) => p.includes('node-relative-not-a-path')), '相对路径不是可靠的全局根，不参与')
})

test('无论如何都找不到时：报告照常返回，并带上查过的 npm 全局根（不抛异常）', async (t) => {
  const sb = sandbox(t)
  process.env.DSHL_USER_NODE_DIR = path.join(sb.localAppData, 'Programs', 'nodejs')

  initDetect(sb.home, {})
  const report = await envDetect.detectEnv(true)

  assert.equal(report.dsh.status, 'missing',
    `沙箱里不该找到任何 DSH，但找到了 ${report.dsh.kind} @ ${report.dsh.dir}`)
  assert.ok(report.issues.some((s) => s.startsWith('未检测到 DeepSeek Harness')), '仍要报"未检测到 DeepSeek Harness"')
  assert.equal(report.ready, false)
})

test('全新机模拟（DSHL_FRESH_TEST）：自装 Node 目录里的全局 DSH 也要认', async (t) => {
  const sb = sandbox(t)
  const nodeDir = path.join(sb.localAppData, 'Programs', 'nodejs')
  makeUserNodeDir(nodeDir)
  process.env.DSHL_USER_NODE_DIR = nodeDir
  process.env.DSHL_FRESH_TEST = '1' // 只认 dshl 自装物：这里没有 DSHL_NPM_GLOBAL_ROOT 覆盖
  const dshDir = makeGlobalDsh(nodeDir, '0.1.5-rc.2')

  initDetect(sb.home, {})
  const report = await envDetect.detectEnv(true)

  const hit = [report.dsh, ...report.alternatives].find((e) => e.dir === dshDir)
  assert.ok(hit, '全新机模拟下，自装 Node 目录里的 DSH 也必须被发现（否则演示脚本靠 DSHL_NPM_GLOBAL_ROOT 掩盖了同一类问题）')
  assert.equal(hit.kind, 'global')
})

test('全新机模拟（DSHL_FRESH_TEST）：官方 MSI 的落点（%APPDATA%\\npm）也要认', async (t) => {
  // 现在 Node 默认用官方 MSI 安装，它自带 npmrc → DSH 落在 npm 默认全局根 %APPDATA%\npm。
  // 全新机模拟必须认这个落点，否则"新机器装完却报未检测到"会以另一种形式回来。
  const sb = sandbox(t)
  process.env.DSHL_FRESH_TEST = '1'
  const npmDefault = path.join(sb.appData, 'npm')
  const dshDir = makeGlobalDsh(npmDefault, '0.1.5-rc.2')

  initDetect(sb.home, {})
  const report = await envDetect.detectEnv(true)

  const hit = [report.dsh, ...report.alternatives].find((e) => e.dir === dshDir)
  assert.ok(hit, '全新机模拟下，%APPDATA%\\npm 里的全局 DSH 必须被发现')
  assert.equal(hit.kind, 'global')
  assert.equal(hit.root, npmDefault)
})

test('resolveGlobalRoot：已生效的全局安装优先——装到哪儿就更新哪儿，不按 npm 前缀另起一份', async (t) => {
  const sb = sandbox(t)
  const nodeDir = path.join(sb.localAppData, 'Programs', 'nodejs')
  makeUserNodeDir(nodeDir)
  process.env.DSHL_USER_NODE_DIR = nodeDir
  makeGlobalDsh(nodeDir, '0.1.5-rc.2')

  initDetect(sb.home, {})
  await envDetect.detectEnv(true) // 先探测：安装/更新都以"当前生效的那一份"为锚

  const envInstall = require('../env-install')
  envInstall.initInstaller({ HOME: sb.home, Config: { npmGlobalRoot: '' }, log: () => {} })
  const nodeBin = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node')
  const root = await envInstall.resolveGlobalRoot(nodeBin)

  assert.equal(root, nodeDir, '全局根要锚定到在用的那份 DSH 的前缀（否则会装出第二份，PATH 上到底哪份生效就说不清了）')
})

test('尾查：候选根全都没命中时，问 npm 自己的 prefix 也能把 DSH 找回来', async (t) => {
  const sb = sandbox(t)
  const custom = path.join(sb.base, 'elsewhere-npm-prefix') // 老版本装的、没记账、也不在任何候选根里
  const dshDir = makeGlobalDsh(custom, '0.1.5-rc.2')
  process.env.DSHL_USER_NODE_DIR = path.join(sb.localAppData, 'Programs', 'nodejs')
  process.env.npm_config_prefix = custom // 让 npm 报出这个前缀（等价于自定义 .npmrc 里的 prefix）

  initDetect(sb.home, {})
  const report = await envDetect.detectEnv(true)

  const hit = [report.dsh, ...report.alternatives].find((e) => e.dir === dshDir)
  assert.ok(hit, '尾查必须问 npm 的 prefix，并据此找回 DSH')
  assert.equal(hit.kind, 'global')
  assert.equal(report.dsh.built, true)
  assert.ok(!report.issues.includes('未检测到 DeepSeek Harness'))
})

test('rememberGlobalRoot：实际用的前缀记账进 Config 并落盘；值没变不重复写，空值不覆盖', (t) => {
  const sb = sandbox(t)
  const envInstall = require('../env-install')
  const Config = { npmGlobalRoot: '' }
  let saves = 0
  envInstall.initInstaller({ HOME: sb.home, Config, log: () => {}, saveConfig: () => { saves++ } })
  const prefix = path.join(sb.localAppData, 'Programs', 'nodejs')

  envInstall.rememberGlobalRoot(prefix)
  assert.equal(Config.npmGlobalRoot, prefix, '记账值要被探测侧（globalPrefixes）读到')
  assert.equal(saves, 1, '记账后要落盘，否则重启启动器就丢了')

  envInstall.rememberGlobalRoot(prefix)
  assert.equal(saves, 1, '同一个前缀不重复写盘')

  envInstall.rememberGlobalRoot('')
  assert.equal(Config.npmGlobalRoot, prefix, '空值不得覆盖已有记账')
  assert.equal(saves, 1)
})

// ---------- 换 Node 会整目录替换：目录里的全局包必须记在账上 ----------

test('nodeReplacePlan：Node 目录里有全局 DSH 时自动带上 dsh（换 Node 不会把它换没了）', (t) => {
  const sb = sandbox(t)
  const nodeDir = path.join(sb.localAppData, 'Programs', 'nodejs')
  makeUserNodeDir(nodeDir)
  process.env.DSHL_USER_NODE_DIR = nodeDir
  makeGlobalDsh(nodeDir, '0.1.5-rc.2')
  // 目录里还有别人装的全局包（不迁移，但必须如实说出来）
  fs.mkdirSync(path.join(nodeDir, 'node_modules', 'clopo'), { recursive: true })
  fs.mkdirSync(path.join(nodeDir, 'node_modules', '@scope', 'cli'), { recursive: true })

  const envInstall = require('../env-install')
  const plan = envInstall.nodeReplacePlan(['node', 'pnpm'])

  assert.deepEqual(plan.list, ['node', 'pnpm', 'dsh'], '要有 dsh 阶段，否则换完 Node 又报未检测到')
  assert.equal(plan.dshInNodeDir, true)
  assert.equal(plan.nodeDir, nodeDir)
  assert.deepEqual(plan.otherGlobals.sort(), ['@scope/cli', 'clopo'], '其他会被一并删除的全局包要能列出来')

  const nothing = envInstall.nodeReplacePlan(['dsh'])
  assert.deepEqual(nothing.list, ['dsh'], '不装 Node 就不涉及目录替换，不加项')
})

test('nodeReplacePlan：Node 目录里没有全局 DSH 时不动安装项', (t) => {
  const sb = sandbox(t)
  const nodeDir = path.join(sb.localAppData, 'Programs', 'nodejs')
  makeUserNodeDir(nodeDir)
  process.env.DSHL_USER_NODE_DIR = nodeDir
  fs.mkdirSync(path.join(nodeDir, 'node_modules', 'clopo'), { recursive: true })

  const envInstall = require('../env-install')
  const plan = envInstall.nodeReplacePlan(['node', 'pnpm'])
  assert.deepEqual(plan.list, ['node', 'pnpm'])
  assert.equal(plan.dshInNodeDir, false)
  assert.deepEqual(plan.otherGlobals, ['clopo'], '仍然要如实列出会被删除的全局包')
})

// ---------- 落点自检：独立于记账值，确认探测侧找得回来 ----------

test('checkLandingFindable：Node 目录落点与默认全局根放行，说明不了的落点要记警告', async (t) => {
  const sb = sandbox(t)
  const envInstall = require('../env-install')
  envInstall.initInstaller({ HOME: sb.home, Config: { npmGlobalRoot: '' }, log: () => {} })
  const lines = []
  const job = { logLine: (l) => lines.push(l) }

  const nodeDir = path.join(sb.localAppData, 'Programs', 'nodejs')
  makeUserNodeDir(nodeDir)
  await envInstall.checkLandingFindable(job, 'global', nodeDir, null)
  assert.deepEqual(lines, [], '落点是 Node 安装目录（npm 内建前缀）→ 探测侧有对应候选，不该报')

  await envInstall.checkLandingFindable(job, 'global', path.join(sb.appData, 'npm'), null)
  assert.deepEqual(lines, [], '落点是 %APPDATA%\\npm 这个默认根 → 同样不该报')

  await envInstall.checkLandingFindable(job, 'global', path.join(sb.base, 'nowhere-global'), null)
  assert.equal(lines.length, 1, '三条判据都不成立时必须留下警告（这正是当年那次事故的形态）')
  assert.ok(lines[0].startsWith('警告：安装落点不在环境探测的候选根内'), lines[0])

  lines.length = 0
  await envInstall.checkLandingFindable(job, 'managed', path.join(sb.base, 'nowhere-managed'), null)
  assert.deepEqual(lines, [], '托管形态由 managedDshDir() 覆盖，不参与这条自检')
})
