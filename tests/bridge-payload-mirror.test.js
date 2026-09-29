// tests/bridge-payload-mirror.test.js — payload 的解析镜像：位置、稳定性、缺口可见
//
// 背景（2026-09-29 实测）：payload 以 `link:` 装在启动器缓存目录（内容寻址），它 import 的
// @deepseek-ai/* 只能靠两类来源解析 —— ① payload 旁边的 `node_modules` 镜像（本文件钉的就是它）；
// ② DSH 宿主的 runtime resolution（"安装树 + 已加载 bundle 的依赖闭包"）。
// ② 随 dsh 版本变：0.1.7-rc.2 上 bridge 直接 `failed to import`（服务照常起、插件页一直"重启后生效"）。
// 所以镜像必须（a）待在对的位置、（b）指向真实物理目录而不是共享 fallback 里的 junction、
// （c）解析不到的包要点名，别让宿主在启动时只回一句 `failed to import`。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bridge = require('../bridge')

const NAME = bridge.PLUGIN_NAME

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bridge-mirror-'))
}

/**
 * 造一份真实形态的 payload：
 *   <key>/bridge-next.tgz          ← link: 指向的"目录"（末段仍叫 .tgz）
 *   <key>/bridge-next.tgz/lib/…    ← 入口产物
 *   <key>/bridge-next.tgz/node_modules → <key>/deps/node_modules 的 junction（pnpm 装的 4 个运行时依赖）
 */
function makePayload(home, opts = {}) {
  const keyDir = path.join(home, 'dshl', 'bridge-payloads', '2.0.0-dev.9-deadbeefcafe')
  const depsModules = path.join(keyDir, 'deps', 'node_modules')
  const linkDir = path.join(keyDir, 'bridge-next.tgz')
  fs.mkdirSync(depsModules, { recursive: true })
  fs.mkdirSync(path.join(linkDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(linkDir, 'package.json'), JSON.stringify({
    name: NAME,
    version: '2.0.0-dev.9',
    main: './lib/index.js',
    dependencies: { qrcode: '1.5.4' },
    peerDependencies: Object.assign({ '@deepseek-ai/cordis': '4.0.2', react: '^18.3.1' }, opts.peers || {}),
  }, null, 2))
  fs.writeFileSync(path.join(linkDir, 'lib', 'index.js'), 'export const name = "x"\n')
  fs.symlinkSync(depsModules, path.join(linkDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  return { linkDir, depsModules, keyDir }
}

/** DSH 注入包住在 $DSH_HOME/profiles/node_modules/@deepseek-ai（共享 fallback，本身也常是 junction）。 */
function makeInjectedScope(home, scopeName) {
  const dir = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', scopeName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + scopeName, version: '4.0.4' }))
  return dir
}

test('entryFileOf：默认 ./lib/index.js，绝对路径/上跳路径 fail-closed', () => {
  assert.equal(bridge.entryFileOf({}), 'lib/index.js')
  assert.equal(bridge.entryFileOf({ main: './lib/main.js' }), 'lib/main.js')
  assert.equal(bridge.entryFileOf({ main: 'lib\\main.js' }), 'lib/main.js')
  assert.equal(bridge.entryFileOf({ main: '../evil.js' }), '')
  assert.equal(bridge.entryFileOf({ main: '/abs/evil.js' }), '')
  assert.equal(bridge.entryFileOf({ main: 'C:/abs/evil.js' }), '')
  assert.equal(bridge.entryFileOf({ main: '   ' }), 'lib/index.js')
})

test('解析镜像：落在 payload 旁边的 node_modules，且不碰 payload 自己的 deps junction', () => {
  const root = tmpRoot()
  try {
    const home = path.join(root, 'home')
    const { linkDir, keyDir } = makePayload(home)
    const injected = makeInjectedScope(home, 'cordis')
    bridge.initBridge({ home, payloadRoot: '', log: () => {} })

    const result = bridge.repairPayloadScopeMirror(linkDir)
    assert.deepEqual(result.mirrored.filter((n) => n.startsWith('@deepseek-ai/')), ['@deepseek-ai/cordis'])

    // ① 镜像在 payload 旁边（Node 从 <key>/bridge-next.tgz/lib/ 往上走一层就能解析到）
    const mirrored = path.join(keyDir, 'node_modules', '@deepseek-ai', 'cordis', 'package.json')
    assert.equal(fs.statSync(mirrored).isFile(), true, '镜像没建在 payload 旁边')
    assert.equal(fs.realpathSync(mirrored), fs.realpathSync(path.join(injected, 'package.json')))
    // ② payload 自己的 node_modules 仍是 deps 的 junction（镜像不去动它）
    assert.equal(fs.lstatSync(path.join(linkDir, 'node_modules')).isSymbolicLink(), true, 'deps junction 被改动了')
    // ③ 幂等
    assert.deepEqual(bridge.repairPayloadScopeMirror(linkDir).missing, result.missing)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('解析镜像：写真实路径 —— 共享 fallback 里的 junction 事后失效也不影响 payload', () => {
  const root = tmpRoot()
  try {
    const home = path.join(root, 'home')
    const { linkDir, keyDir } = makePayload(home)
    // 模拟 DSH 维护的共享 fallback：profiles/node_modules/@deepseek-ai/x 是指向别处的 junction
    const physical = path.join(home, 'store', 'cordis-real')
    fs.mkdirSync(physical, { recursive: true })
    fs.writeFileSync(path.join(physical, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.4' }))
    const fallbackDir = path.join(home, 'profiles', 'node_modules', '@deepseek-ai')
    fs.mkdirSync(fallbackDir, { recursive: true })
    fs.symlinkSync(physical, path.join(fallbackDir, 'cordis'), process.platform === 'win32' ? 'junction' : 'dir')
    bridge.initBridge({ home, payloadRoot: '', log: () => {} })
    bridge.repairPayloadScopeMirror(linkDir)

    // 事后把 fallback 那个 junction 删掉（DSH 升级/清理的常见后果）
    fs.unlinkSync(path.join(fallbackDir, 'cordis'))
    assert.equal(
      fs.statSync(path.join(keyDir, 'node_modules', '@deepseek-ai', 'cordis', 'package.json')).isFile(),
      true,
      '镜像指向了 fallback 的 junction，fallback 一变就悬空',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('解析镜像：解析不到的包点名上报（这正是启动时 failed to import 的候选）', () => {
  const root = tmpRoot()
  try {
    const home = path.join(root, 'home')
    const { linkDir } = makePayload(home)
    makeInjectedScope(home, 'cordis')
    bridge.initBridge({ home, payloadRoot: '', log: () => {} })

    const result = bridge.repairPayloadScopeMirror(linkDir)
    assert.ok(result.missing.includes('react'), 'peer 解析不到要出现在 missing 里')
    assert.ok(result.missing.includes('qrcode'), 'dependencies 解析不到同样要报')
    assert.ok(!result.missing.includes('@deepseek-ai/cordis'), '能镜像的不该被报成缺口')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('解析镜像：profile 侧缺件时从 dsh 安装树补上（这就是"装了却 failed to import"的修复）', () => {
  const root = tmpRoot()
  try {
    const home = path.join(root, 'home')
    // 这个 peer 只存在于下面的"安装树"里：profile 与共享 fallback 都没有它
    const { linkDir, keyDir } = makePayload(home, { peers: { '@deepseek-ai/dsh-session-title': '>=0.1.5-rc.1' } })
    // 只在 dsh 安装树里放这个包：profile 与共享 fallback 都没有它
    const tree = path.join(root, 'install', 'node_modules')
    const appModules = path.join(tree, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session-title')
    fs.mkdirSync(appModules, { recursive: true })
    fs.writeFileSync(path.join(appModules, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-title', version: '0.2.0-rc.2' }))
    fs.mkdirSync(path.join(tree, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    const dshBin = path.join(tree, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    fs.writeFileSync(dshBin, '')

    bridge.initBridge({ home, payloadRoot: '', log: () => {} })
    assert.equal(bridge.repairPayloadScopeMirror(linkDir).missing.includes('@deepseek-ai/dsh-session-title'), true,
      '还不知道安装树时，它应当算缺件')

    assert.ok(bridge.cacheInstallModulesDirs({ plan: { dshBin } }).length > 0, '安装树来源要能推导出来')
    const after = bridge.repairPayloadScopeMirror(linkDir)
    assert.equal(after.missing.includes('@deepseek-ai/dsh-session-title'), false, '安装树里有的包不该再算缺件')
    assert.equal(
      fs.statSync(path.join(keyDir, 'node_modules', '@deepseek-ai', 'dsh-session-title', 'package.json')).isFile(),
      true,
      '镜像里应当补上这个 junction',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('解析镜像：入口是 shim 时也能靠 env 的 dsh.dir 找到安装树（14178 那台机器的布局）', () => {
  const root = tmpRoot()
  try {
    const home = path.join(root, 'home')
    const { linkDir, keyDir } = makePayload(home, { peers: { '@deepseek-ai/dsh-session-title': '>=0.1.5-rc.1' } })
    // npm 全局装的形态：包嵌在 <prefix>\node_modules\@deepseek-ai\dsh\node_modules 下
    const prefix = path.join(root, 'npm')
    const dshDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    const nested = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-session-title')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-title', version: '0.2.0-rc.2' }))
    // 入口是 shim（自身不在 node_modules 里，往上也没有 node_modules\@deepseek-ai）：
    // 从它反推不出任何东西 —— 这正是 dshl 托管 dsh 时的形态。
    const shimBin = path.join(root, 'shim', 'bin', 'dsh.cmd')
    fs.mkdirSync(path.dirname(shimBin), { recursive: true })
    fs.writeFileSync(shimBin, '')

    bridge.initBridge({ home, payloadRoot: '', log: () => {} })
    assert.equal(bridge.repairPayloadScopeMirror(linkDir).missing.includes('@deepseek-ai/dsh-session-title'), true,
      '还没有安装树来源时应当算缺件')

    const dirs = bridge.cacheInstallModulesDirs({ plan: { dshBin: shimBin }, dsh: { dir: dshDir, root: prefix } })
    assert.ok(dirs.length > 0, 'shim 入口下也要能从 dsh.dir/dsh.root 推出安装树来源')
    assert.equal(bridge.repairPayloadScopeMirror(linkDir).missing.includes('@deepseek-ai/dsh-session-title'), false,
      '安装树里有的包不该再算缺件')
    assert.equal(
      fs.statSync(path.join(keyDir, 'node_modules', '@deepseek-ai', 'dsh-session-title', 'package.json')).isFile(),
      true,
      '镜像里应当补上这个 junction',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('entryImportSpecifiers：只认入口真正 import 的裸包（相对路径 / node: 不算）', () => {
  const root = tmpRoot()
  try {
    const home = path.join(root, 'home')
    const { linkDir } = makePayload(home)
    fs.writeFileSync(path.join(linkDir, 'lib', 'index.js'), [
      'import { Service } from "@deepseek-ai/cordis";',
      'import "./local.js";',
      'import { readFile } from "node:fs/promises";',
      'import z from "@deepseek-ai/schemastery";',
    ].join('\n'))
    assert.deepEqual(bridge.entryImportSpecifiers(linkDir).sort(), ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'])
    assert.deepEqual(bridge.entryImportSpecifiers(path.join(root, 'nope')), [], '读不到入口时返回空数组，不抛错')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('解析镜像：manifest 读不到时只记账、不上抛（不阻断启动）', () => {
  const root = tmpRoot()
  try {
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const broken = path.join(root, 'no-manifest')
    fs.mkdirSync(broken, { recursive: true })
    bridge.initBridge({ home, payloadRoot: '', log: () => {} })
    const result = bridge.repairPayloadScopeMirror(broken)
    assert.equal(result.mirrored.length, 0)
    assert.ok(result.error, '失败原因要留在返回值里，便于日志与诊断')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
