// tests/desktop-shell.test.js — 桌面壳桥的纯函数与安装树识别（不启动 Electron）
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const shell = require('../desktop-shell')

test('platform 映射：win32→windows / darwin→macos / 其它→linux（DSH 的 platform 名）', () => {
  assert.equal(shell.shortcutPlatformName('win32'), 'windows')
  assert.equal(shell.shortcutPlatformName('darwin'), 'macos')
  assert.equal(shell.shortcutPlatformName('linux'), 'linux')
  assert.equal(shell.shortcutPlatformName(undefined), 'linux')
})

test('修饰键自身不转发（与 DSH 的 DOM 适配器一致）', () => {
  for (const code of ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']) {
    assert.equal(shell.isModifierOnlyCode(code), true, code)
  }
  for (const code of ['KeyB', 'Backslash', 'F5', 'Digit1', 'Control', 'ShiftLeft2']) {
    assert.equal(shell.isModifierOnlyCode(code), false, code)
  }
})

test('normalizeForwardInput：只认 keyDown + 有效 code + 已就绪 revision', () => {
  const base = { type: 'keyDown', code: 'KeyB', control: true, alt: false, shift: false, meta: false, isAutoRepeat: false }
  assert.deepEqual(shell.normalizeForwardInput(base, 'rev-1'), {
    kind: 'keyboard',
    revision: 'rev-1',
    code: 'KeyB',
    control: true,
    alt: false,
    shift: false,
    meta: false,
    repeat: false,
  })

  assert.equal(shell.normalizeForwardInput({ ...base, type: 'keyUp' }, 'rev-1'), null, 'keyUp 不转发')
  assert.equal(shell.normalizeForwardInput({ ...base, code: '' }, 'rev-1'), null, '空 code 不转发')
  assert.equal(shell.normalizeForwardInput({ ...base, code: 'Unidentified' }, 'rev-1'), null, 'Unidentified 不转发')
  assert.equal(shell.normalizeForwardInput({ ...base, code: 'ControlLeft' }, 'rev-1'), null, '修饰键不转发')
  assert.equal(shell.normalizeForwardInput(base, ''), null, 'revision 未就绪不转发')
  assert.equal(shell.normalizeForwardInput(base, 123), null, 'revision 必须是字符串')
  assert.equal(shell.normalizeForwardInput(null, 'rev-1'), null, '空 input 不转发')
  assert.equal(shell.normalizeForwardInput({ ...base, isAutoRepeat: true }, 'rev-1').repeat, true, '长按标记要透传')
})

test('preloadConfig：开关 + 桥就绪 + 登录辅助已加载 三者齐备才 enabled（fail-closed）', () => {
  assert.deepEqual(shell.preloadConfig({ enabled: true, ready: true, loginReady: true, host: '127.0.0.1', port: 3080, platform: 'win32' }), {
    enabled: true,
    host: '127.0.0.1',
    port: 3080,
    platform: 'win32',
  })
  assert.equal(shell.preloadConfig({ enabled: true, ready: false, loginReady: true }).enabled, false, '桥未就绪不能启用')
  assert.equal(shell.preloadConfig({ enabled: false, ready: true, loginReady: true }).enabled, false, '开关关闭不能启用')
  assert.equal(shell.preloadConfig({ enabled: true, ready: true, loginReady: false }).enabled, false, '登录辅助未被当前服务加载时不能启用（否则登录退化）')
  assert.equal(shell.preloadConfig({ enabled: true, ready: true }).enabled, false, '缺 loginReady 必须按未就绪处理')
  assert.equal(shell.preloadConfig({}).enabled, false)
  assert.equal(shell.preloadConfig(null).enabled, false)
  // 缺省字段回安全默认值，preload 不会拿到 undefined 去做 location 比较
  assert.deepEqual(shell.preloadConfig({ enabled: false }), { enabled: false, host: '127.0.0.1', port: 3080, platform: 'win32' })
})

test('resolveProtocolCandidates：全局嵌套 / 提升布局 / 源码仓库三种形态都给出候选', () => {
  const candidates = shell.resolveProtocolCandidates({
    dshBin: path.join('C:\\npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    harnessRoot: path.join('E:\\deepseek-harness'),
  })
  assert.ok(candidates.length >= 3, '三种布局都要有候选')
  assert.ok(candidates[0].includes(path.join('@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-shortcuts', 'lib', 'protocol.js')), '首选全局嵌套布局')
  assert.ok(candidates.some((p) => p.includes(path.join('packages', 'client', 'shortcuts', 'lib', 'protocol.js'))), '源码布局')
  assert.equal(new Set(candidates).size, candidates.length, '候选不能重复')
  assert.ok(candidates.every((p) => path.isAbsolute(p)), '候选必须是绝对路径')
  assert.deepEqual(shell.resolveProtocolCandidates({}), [], '没有布局信息时返回空（调用方按失败处理）')
})

/** 在一个临时目录里造出 DSH 安装树，验证 inspectProtocol 的入口/版本判定。 */
function fixture(t, { dshVersion = '0.2.1-rc.3', shortcutsVersion = '0.2.1-rc.3', protocol = 'export const ShortcutPersistence = class {}\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-shell-'))
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } })
  const dshRoot = path.join(root, 'dsh')
  const pkgRoot = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-client-shortcuts')
  fs.mkdirSync(path.join(pkgRoot, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVersion }))
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-shortcuts', version: shortcutsVersion }))
  fs.writeFileSync(path.join(pkgRoot, 'lib', 'protocol.js'), protocol)
  return { dshBin: path.join(dshRoot, 'lib', 'bin.js'), dshRoot }
}

test('inspectProtocol：版本一致接受；不一致/缺文件 fail-closed', (t) => {
  const ok = fixture(t)
  const accepted = shell.inspectProtocol(shell.resolveProtocolCandidates({ dshBin: ok.dshBin }), ok.dshRoot)
  assert.equal(accepted.ok, true)
  assert.equal(accepted.version, '0.2.1-rc.3')
  assert.equal(accepted.dshVersion, '0.2.1-rc.3')

  const mismatch = fixture(t, { dshVersion: '0.2.1-rc.3', shortcutsVersion: '0.2.1-rc.4' })
  const rejected = shell.inspectProtocol(shell.resolveProtocolCandidates({ dshBin: mismatch.dshBin }), mismatch.dshRoot)
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /版本不一致/u, '版本漂移必须拒绝启用桌面壳')

  assert.equal(shell.inspectProtocol([], '').ok, false, '没有候选路径 = 失败')
})

test('inspectProtocol：没有 dsh 版本信息时只告警不拒绝（源码布局）', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-shell-src-'))
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } })
  const pkgRoot = path.join(root, 'packages', 'client', 'shortcuts')
  fs.mkdirSync(path.join(pkgRoot, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-shortcuts', version: '0.2.1-rc.3' }))
  fs.writeFileSync(path.join(pkgRoot, 'lib', 'protocol.js'), 'export const ShortcutPersistence = class {}\n')
  const result = shell.inspectProtocol(shell.resolveProtocolCandidates({ harnessRoot: root }), '')
  assert.equal(result.ok, true)
  assert.equal(result.version, '0.2.1-rc.3')
})
