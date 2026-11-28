// tests/dsh-update-occupancy.test.js — 安装目录占用（Windows 文件锁）的识别与清理编排（node --test）
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const dshUpdater = require('../dsh-update')

const src = readFileSync(join(__dirname, '..', 'dsh-update.js'), 'utf8')
const mainSrc = readFileSync(join(__dirname, '..', 'main.js'), 'utf8')
const termSrc = readFileSync(join(__dirname, '..', 'service-termination.js'), 'utf8')

// path.resolve 会把正斜杠归一成 Windows 分隔符，测试数据不必写反斜杠
const INSTALL = 'C:/Users/me/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'

test('pickInstallDirProcesses：只挑可执行文件落在安装目录内的进程', () => {
  const list = [
    { pid: 9516, name: 'dsh-cua-windows.exe', exe: INSTALL + '/node_modules/@deepseek-ai/dsh-cua-windows/native/bin/win-x64/dsh-cua-windows.exe' },
    { pid: 100, name: 'node.exe', exe: 'C:/Program Files/nodejs/node.exe' },
    { pid: 101, name: 'other.exe', exe: INSTALL + '-other/tool.exe' },
    { pid: process.pid, name: 'self.exe', exe: INSTALL + '/self.exe' },
    { pid: 0, name: 'bad.exe', exe: INSTALL + '/bad.exe' },
    { pid: 102, name: '', exe: INSTALL.toUpperCase() + '/UPPER.EXE' },
  ]
  const picked = dshUpdater.pickInstallDirProcesses(list, INSTALL)
  assert.deepEqual(picked.map((p) => p.pid), [9516, 102], '目录内 + 大小写不同都算；兄弟目录/自己/非法 PID 不算')
  assert.equal(picked[0].name, 'dsh-cua-windows.exe')
  assert.equal(picked[1].name, 'UPPER.EXE', '没有名字时用 exe 文件名')
})

test('pickInstallDirProcesses：容忍尾部分隔符与空输入', () => {
  const list = [{ pid: 1, name: 'a', exe: INSTALL + '/x/a.exe' }]
  assert.equal(dshUpdater.pickInstallDirProcesses(list, INSTALL + '/').length, 1)
  assert.deepEqual(dshUpdater.pickInstallDirProcesses(list, ''), [])
  // 空 installDir 不能被 path.resolve 当成当前目录（否则会误杀工作目录下的进程）
  const cwdItem = [{ pid: 7, name: 'cwd.exe', exe: process.cwd() + '/cwd.exe' }]
  assert.deepEqual(dshUpdater.pickInstallDirProcesses(cwdItem, ''), [])
  assert.deepEqual(dshUpdater.pickInstallDirProcesses(null, INSTALL), [])
  assert.deepEqual(dshUpdater.pickInstallDirProcesses(list, '/tmp/elsewhere'), [])
})

test('isBusyFailure：EBUSY/EPERM 是占用，ETARGET 不是（换源救不了文件锁）', () => {
  const ebusy = {
    ok: false,
    stderr: 'npm error code EBUSY\nnpm error syscall rename\nnpm error errno -4082\nnpm error EBUSY: resource busy or locked, rename ...win-x64',
    error: 'npm 退出码 4294963214',
  }
  assert.equal(dshUpdater.isBusyFailure(ebusy), true)
  assert.equal(dshUpdater.isBusyFailure({ ok: false, stderr: '', error: 'EPERM: operation not permitted, rename ...' }), true)
  assert.equal(dshUpdater.isBusyFailure({ ok: false, stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for x@1', error: 'npm 退出码 1' }), false)
  assert.equal(dshUpdater.isBusyFailure({ ok: true, stderr: 'EBUSY' }), false)
  assert.equal(dshUpdater.isBusyFailure(null), false)
})

test('busyHoldersText：把占用者带进文案，最多四个', () => {
  assert.match(dshUpdater.busyHoldersText([]), /无法定位/u)
  const text = dshUpdater.busyHoldersText([
    { pid: 9516, name: 'dsh-cua-windows.exe' },
    { pid: 2, name: 'node.exe' },
  ])
  assert.match(text, /dsh-cua-windows\.exe\(PID 9516\)/u)
  assert.match(text, /node\.exe\(PID 2\)/u)
  const many = [1, 2, 3, 4, 5].map((pid) => ({ pid, name: 'p' + pid }))
  assert.equal((dshUpdater.busyHoldersText(many).match(/PID/g) || []).length, 4)
})

test('更新流程接线：先清占用再改名；占用类失败不再退 npm、不再换源', () => {
  const upd = src.slice(src.indexOf('async function updateNow('), src.indexOf('module.exports ='))
  assert.match(upd, /clearHolders\(installDir\)/u, '停服后要清安装目录')
  assert.ok(upd.indexOf('clearHolders(installDir)') < upd.indexOf('swapStagedInto('), '清理必须早于改名切换')
  assert.match(upd, /startsWith\('install-dir-busy'\)/u, '占用失败要单独成类')
  assert.ok(upd.indexOf("startsWith('install-dir-busy')") < upd.indexOf('const r = await runGlobalUpdate('), '占用失败不许再退 npm')
  assert.match(upd, /已取消升级/u)
  assert.match(src, /if \(isBusyFailure\(r\)\) \{[\s\S]{0,200}busy: true/u, 'npm 安装遇占用要直接收场')
  assert.match(src, /install-dir-busy: '/u, '改名失败要按占用分类')
  assert.ok(!src.includes('回退官方源重试'), '源顺序是「记住的源 → 其余源」，没有固定“官方回退”')
})

test('主进程接线：停止确认用有界宽限，不再 0ms 判端口', () => {
  assert.match(termSrc, /timeoutMs = 2000/u, '宽限默认值放在终止模块里')
  const uses = mainSrc.match(/waitPortClosed\(portOpen\)/g) || []
  assert.equal(uses.length, 2, 'claimed 与 launchSig 两处停止复核都要给宽限')
  assert.match(mainSrc, /require\('\.\/service-termination'\)/u)
})

test('clearInstallDirHolders：目录不存在时不需要杀任何进程', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows 有文件锁语义')
  const r = await dshUpdater.clearInstallDirHolders('C:/definitely-not-a-real-install-dir-xyz')
  assert.equal(r.ok, true)
  assert.deepEqual(r.killed, [])
})
