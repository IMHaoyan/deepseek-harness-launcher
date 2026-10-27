// tests/desktop-signin.test.js — 登录授权页辅助 bundle：payload 完整性、安装判定、Host 插件边界
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const signin = require('../desktop-signin')

const root = path.resolve(__dirname, '..')
const PAYLOAD = path.join(root, 'assets', 'dshl-desktop-signin')
const PKG = signin.PKG_NAME

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-signin-'))
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* noop */ } })
  return home
}

test('随包 payload 完整：身份/版本/bundle patch/入口都在', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PAYLOAD, 'package.json'), 'utf8'))
  assert.equal(pkg.name, PKG)
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/u, '版本要参与 link: 目录戳名')
  assert.equal(typeof pkg.dsh.bundle.patch, 'string')
  assert.ok(fs.existsSync(path.join(PAYLOAD, pkg.dsh.bundle.patch)), 'bundle patch 必须存在')
  assert.ok(fs.existsSync(path.join(PAYLOAD, pkg.main)), '入口必须存在')

  const patch = fs.readFileSync(path.join(PAYLOAD, pkg.dsh.bundle.patch), 'utf8')
  assert.match(patch, new RegExp('insert:[\\s\\S]*name: ' + PKG), 'patch 必须 insert 自己')
})

test('Host 插件边界：只在壳就绪标记存在时打开授权页，且只处理 waiting-browser', () => {
  const source = fs.readFileSync(path.join(PAYLOAD, 'lib', 'index.js'), 'utf8')
  assert.match(source, /export const inject = \['deepseekAccount'\]/u, '必须依赖账号服务')
  assert.match(source, /desktop-shell\.active/u, '必须认 DSHL 写的就绪标记（web runtime 时严格 no-op）')
  assert.match(source, /waiting-browser/u, '只处理等待浏览器阶段')
  assert.match(source, /url\.protocol !== 'https:'/u, '只放行 https（或回环 http）')
  assert.match(source, /deepseekAccount\.watch\(/u, '订阅 Host 账号状态流')
  assert.doesNotMatch(source, /shell\.openExternal|window\.open/u, '这是 Host 进程，不能拿渲染层 API 顶替')
})

test('pluginSatisfied：依赖 spec / bundles / 磁盘包版本三者同时对齐才算装好', () => {
  const spec = 'link:C:/Users/x/.dsh/dshl/desktop-signin/1.0.0'
  const manifest = {
    dependencies: { [PKG]: spec },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', PKG] } },
  }
  const pkg = { name: PKG, version: '1.0.0' }
  assert.equal(signin.pluginSatisfied({ manifest, spec, version: '1.0.0', materializedPackage: pkg }), true)
  assert.equal(signin.pluginSatisfied({ manifest, spec, version: '1.0.1', materializedPackage: pkg }), false, 'payload 升级后要重装')
  assert.equal(signin.pluginSatisfied({ manifest, spec, version: '1.0.0', materializedPackage: { ...pkg, version: '0.9.0' } }), false, '磁盘包版本不符')
  assert.equal(signin.pluginSatisfied({ manifest, spec, version: '1.0.0', materializedPackage: undefined }), false, '没装到 node_modules')
  assert.equal(signin.pluginSatisfied({ manifest: { ...manifest, dependencies: {} }, spec, version: '1.0.0', materializedPackage: pkg }), false, '依赖缺失')
  assert.equal(signin.pluginSatisfied({ manifest: { ...manifest, dsh: { profile: { bundles: [] } } }, spec, version: '1.0.0', materializedPackage: pkg }), false, 'bundles 未登记')
  assert.equal(signin.pluginSatisfied({ manifest, spec: 'link:C:/other', version: '1.0.0', materializedPackage: pkg }), false, '指向别的目录')
  assert.equal(signin.pluginSatisfied({ manifest: null, spec, version: '1.0.0', materializedPackage: pkg }), false, 'manifest 读不到')
})

test('normalizeSpec：正反斜杠、尾斜杠、盘符大小写不参与比较', () => {
  assert.equal(signin.normalizeSpec('link:C:\\Users\\X\\a\\'), 'link:c:/users/x/a')
  assert.equal(signin.normalizeSpec('link:C:/Users/X/a'), 'link:c:/users/x/a')
  assert.equal(signin.normalizeSpec(null), '')
})

test('expectedSpec：link: 目标在本机 dshl 缓存目录、版本戳、正斜杠', (t) => {
  const home = tempHome(t)
  signin.init({ home, payloadRoot: PAYLOAD, log: () => {} })
  const spec = signin.expectedSpec()
  assert.match(spec, /^link:/u)
  assert.ok(!spec.includes('\\'), 'pnpm 的 link: 规格必须用正斜杠')
  assert.ok(spec.includes('/dshl/desktop-signin/'), '缓存在 <DSH_HOME>/dshl/desktop-signin 下')
  assert.ok(spec.endsWith('/1.0.0'), '目录带 payload 版本戳')
  assert.equal(signin.payloadVersion(), '1.0.0')
})

test('ensure：profile 缺失时只返回失败，不抛异常（登录降级为复制链接）', async (t) => {
  const home = tempHome(t)
  signin.init({ home, payloadRoot: PAYLOAD, log: () => {} })
  const result = await signin.ensure()
  assert.equal(result.ok, false)
  assert.ok(result.error, '失败要带原因供日志')
  assert.match(result.error, /profile/u)
  const state = signin.getState()
  assert.equal(state.installed, false)
  assert.equal(state.payload.error, '')
})

test('ensure：payload 不可用时直接失败，不尝试安装', async (t) => {
  const home = tempHome(t)
  signin.init({ home, payloadRoot: path.join(home, 'nope'), log: () => {} })
  const result = await signin.ensure()
  assert.equal(result.ok, false)
  assert.match(result.error, /身份不符|payload/u, '失败要能定位到 payload 不可用')
})

test('windowsTicksToUnixMs：FILETIME 转 Unix 毫秒；非法输入回 0', () => {
  // 2026-01-01T00:00:00Z = 1767225600000；对应 FILETIME ticks = (unixMs + epochDiff) * 10000
  const unixMs = 1767225600000
  const ticks = String((unixMs + 11644473600000) * 10000)
  assert.equal(signin.windowsTicksToUnixMs(ticks), unixMs)
  assert.equal(signin.windowsTicksToUnixMs(0), 0)
  assert.equal(signin.windowsTicksToUnixMs(-5), 0)
  assert.equal(signin.windowsTicksToUnixMs('abc'), 0)
  assert.equal(signin.windowsTicksToUnixMs(undefined), 0)
})

test('helperLoadedByService：自管=已加载；adopted 服务启动晚于安装才算加载', () => {
  const installed = 1000
  assert.equal(signin.helperLoadedByService({ platform: 'win32', owned: true }), true, '自管服务启动前就装好了')
  assert.equal(signin.helperLoadedByService({ platform: 'win32', owned: false, serviceStartedAtMs: 2000, installedAtMs: installed }), true, '服务启动晚于安装 → 启动时 bundle 已在')
  assert.equal(signin.helperLoadedByService({ platform: 'win32', owned: false, serviceStartedAtMs: 500, installedAtMs: installed }), false, '服务启动早于安装 → 旧进程没加载过')
  assert.equal(signin.helperLoadedByService({ platform: 'win32', owned: false, installedAtMs: installed }), false, '拿不到启动时刻 → fail-closed')
  assert.equal(signin.helperLoadedByService({ platform: 'linux', owned: false, serviceStartedAtMs: 2000, installedAtMs: installed }), false, '非 Windows 的 ticks 不可比 → fail-closed')
  assert.equal(signin.helperLoadedByService(null), false)
})

test('安装记账：state.json 落盘/读取/版本与时刻；损坏时回退 0', (t) => {
  const home = tempHome(t)
  signin.init({ home, payloadRoot: PAYLOAD, log: () => {} })
  const stateFile = path.join(home, 'dshl', 'desktop-signin', 'state.json')
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify({ version: '1.0.0', spec: signin.expectedSpec(), installedAt: '2026-01-02T03:04:05.000Z' }))
  const state = signin.readInstallState()
  assert.equal(state.version, '1.0.0')
  assert.equal(state.installedAtMs, Date.parse('2026-01-02T03:04:05.000Z'))
  const snapshot = signin.getState()
  assert.equal(snapshot.installedAtMs, Date.parse('2026-01-02T03:04:05.000Z'))
  assert.equal(snapshot.statePath, stateFile)
  fs.writeFileSync(stateFile, '{broken')
  assert.equal(signin.readInstallState(), null, '损坏的记账不能参与判断')
})
