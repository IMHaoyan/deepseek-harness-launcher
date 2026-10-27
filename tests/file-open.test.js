// tests/file-open.test.js — 「Ctrl+点击文件链接 → 用系统默认程序打开」的参数归一化契约
//
// 背景（2026-10-27）：DSH 的 Markdown 文件链接是 `<button title="<路径>">`，普通点击只在右侧栏
// 预览；用户要求按 Ctrl/Cmd+点击时交给 Windows 默认程序（exe 直接运行）。点击捕获在
// browser-preload.js（隔离世界），本模块只做"路径能不能打开"的纯判定，方便单测。
//
// 三条边界：① 只接受本地绝对路径（相对路径无法可靠解析，宁可不打开）；
//           ② file: URL 可以还原；③ 控制字符/超长/空路径一律拒绝。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fileOpen = require('../file-open')

test('Windows 绝对路径：盘符 + 正/反斜杠都接受', () => {
  for (const path of [
    'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dist\\dshl-1.4.13-alpha.1.exe',
    'C:/Users/gonghaoyan/Desktop/dshl/dist/dshl-1.4.13-alpha.1.exe',
    'd:\\projects\\a.txt',
  ]) {
    const request = fileOpen.classifyOpenRequest({ path }, 'win32')
    assert.equal(request.ok, true, path)
    assert.equal(request.path, path)
    assert.equal(request.mode, 'open')
  }
})

test('UNC 路径接受；相对路径/裸文件名/空值拒绝', () => {
  assert.equal(fileOpen.classifyOpenRequest({ path: '\\\\server\\share\\a.txt' }, 'win32').ok, true)
  for (const path of ['dist\\dshl.exe', 'dshl.exe', '', '   ', '..\\a.txt', '/tmp/a.txt']) {
    const request = fileOpen.classifyOpenRequest({ path }, 'win32')
    assert.equal(request.ok, false, JSON.stringify(path))
    assert.ok(request.error, '拒绝要带理由')
  }
})

test('POSIX 平台：接受 /Users/... 绝对路径（dshl 的 macOS 构建）', () => {
  const request = fileOpen.classifyOpenRequest({ path: '/Users/gonghaoyan/Downloads/a.txt' }, 'darwin')
  assert.equal(request.ok, true)
  assert.equal(fileOpen.classifyOpenRequest({ path: '~/Downloads/a.txt' }, 'darwin').ok, false)
})

test('file: URL 还原成路径；非 file: 协议按普通字符串继续校验', () => {
  assert.equal(
    fileOpen.classifyOpenRequest({ path: 'file:///C:/Users/me/a.exe' }, 'win32').path,
    'C:/Users/me/a.exe',
  )
  assert.equal(fileOpen.classifyOpenRequest({ path: 'https://example.com/a.exe' }, 'win32').ok, false)
})

test('mode：只认 open / reveal，其它值回落 open', () => {
  assert.equal(fileOpen.classifyOpenRequest({ path: 'C:\\a.exe', mode: 'reveal' }, 'win32').mode, 'reveal')
  assert.equal(fileOpen.classifyOpenRequest({ path: 'C:\\a.exe', mode: 'delete' }, 'win32').mode, 'open')
  assert.equal(fileOpen.classifyOpenRequest({ path: 'C:\\a.exe' }, 'win32').mode, 'open')
})

test('畸形入参不抛错：null / 非对象 / 非字符串 path / 控制字符 / 超长', () => {
  for (const payload of [null, undefined, 42, 'C:\\a.exe', [], {}, { path: 42 }]) {
    assert.doesNotThrow(() => fileOpen.classifyOpenRequest(payload, 'win32'))
    assert.equal(fileOpen.classifyOpenRequest(payload, 'win32').ok, false)
  }
  assert.equal(fileOpen.classifyOpenRequest({ path: 'C:\\a\u0000b.exe' }, 'win32').ok, false)
  assert.equal(
    fileOpen.classifyOpenRequest({ path: 'C:\\' + 'a'.repeat(fileOpen.MAX_PATH_LENGTH) }, 'win32').ok,
    false,
  )
})
