// tests/bridge-patch.test.js — 「手机连接」npm 版的运行时补丁
//
// dshl 不再随包分发手机连接，改成 npm 安装；npm 2.0.2 的三个上游问题由 dshl 在
// 「安装/更新后」与「每次启动服务前」幂等打补丁修复。这里用真实模块 + 临时 profile 目录锁：
//   ① 四个补丁都生效（入口 → 设置左栏直接铺开 / 嵌套弹层可关 / 进程查询空输出容错）；
//   ② 幂等：第二次不再改文件；
//   ③ 旧 payload 缓存（bridge-payloads）不碰，交给迁移逻辑；
//   ④ 没有安装时安静跳过。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bridgePatch = require('../bridge-patch')

const CLIENT_FIXTURE = `'use strict'
var react = { useState: function (v) { return [v, function () {}] }, useCallback: function (f) { return f } }
var react_jsx_runtime = { jsx: function () {}, jsxs: function () {}, Fragment: 'Fragment' }
var _deepseek_ai_dsh_client_ui_primitives = { Modal: function () {}, Button: function () {} }
var entry_module_css_default = { dialogContent: 'd' }
var services = { slots: { inject: function () {}, register: function () {} } }
function apply(ctx) {
  ctx.effect(() => services.slots.inject("sidebar.footer.action", () => services.slots.register({ name: "sidebar.footer.action" }, ConnectionEntry)), "agentsAnywhereOnboarding.sidebar");
}
function ConnectionEntry({ wide, host, t, renderTrigger }) {
			const [open, setOpen] = (0, react.useState)(false);
	const close = (0, react.useCallback)(() => {
				if (document.querySelectorAll("[role=\\"dialog\\"]").length > 1) return;
		setOpen(false)
	}, [])
	const panel = [(0, react_jsx_runtime.jsx)("div", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose: close,
				children: null
			})][0]
	return panel
}
`

const HOST_FIXTURE = `'use strict'
function windowsProcesses(stdout) {
	const result = JSON.parse(stdout.replace(/^\\uFEFF/, "").trim());
	return Array.isArray(result) ? result : []
}
module.exports = { windowsProcesses }
`

function makeProfile({ client = CLIENT_FIXTURE, host = HOST_FIXTURE } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bridge-patch-'))
  const dir = path.join(home, 'node_modules', '@agents-anywhere', 'dsh-bridge-next')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@agents-anywhere/dsh-bridge-next', version: '2.0.2' }))
  if (client !== null) fs.writeFileSync(path.join(dir, 'lib', 'client.js'), client)
  if (host !== null) fs.writeFileSync(path.join(dir, 'lib', 'index.js'), host)
  return home
}

test('第一次运行：入口/页面形态/嵌套弹层/进程查询四个补丁全部生效', () => {
  const profileDir = makeProfile()
  try {
    const logs = []
    const result = bridgePatch.apply({ profileDir, log: (line) => logs.push(line) })
    assert.equal(result.ok, true)
    assert.equal(result.version, '2.0.2')
    assert.deepEqual(result.applied.slice().sort(), [
      'empty-process-query',
      'inline-panel',
      'inline-panel-modal',
      'nested-dialog-close',
      'settings-entry-page',
    ].sort())
    const dir = bridgePatch.packageDir(profileDir)
    const client = fs.readFileSync(path.join(dir, 'lib', 'client.js'), 'utf8')
    const host = fs.readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8')
    assert.ok(client.includes('services.slots.inject("settings.section"'), '入口应改为设置左栏')
    assert.ok(client.includes('id: "agents-anywhere"'))
    assert.ok(client.includes('label: () => t("手机连接")'))
    assert.ok(client.includes('page: true'), '设置页里直接铺开面板')
    assert.ok(client.includes('function ConnectionPagePanel('))
    assert.ok(!client.includes('document.querySelectorAll("[role=\\"dialog\\"]").length > 1'))
    assert.ok(client.includes('嵌套在设置弹层里时也允许关闭'))
    assert.ok(host.includes('outputText === "" ? [] : JSON.parse(outputText)'), '空输出按空列表处理')
    assert.ok(logs.some((line) => line.includes('已打补丁')), logs.join(' | '))
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
})

test('幂等：第二次运行不再改文件', () => {
  const profileDir = makeProfile()
  try {
    assert.equal(bridgePatch.apply({ profileDir }).ok, true)
    const dir = bridgePatch.packageDir(profileDir)
    const before = fs.readFileSync(path.join(dir, 'lib', 'client.js'), 'utf8')
    const second = bridgePatch.apply({ profileDir })
    assert.deepEqual(second.applied, [])
    assert.equal(fs.readFileSync(path.join(dir, 'lib', 'client.js'), 'utf8'), before)
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
})

test('没装插件：安静跳过，不抛错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bridge-patch-none-'))
  try {
    const result = bridgePatch.apply({ profileDir: home })
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, [])
    assert.ok(result.skipped.includes('未安装'))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('旧 payload 缓存（bridge-payloads）：不往缓存里写，交给迁移逻辑', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bridge-patch-payload-'))
  const profileDir = path.join(root, 'bridge-payloads', 'profile')
  const dir = path.join(profileDir, 'node_modules', '@agents-anywhere', 'dsh-bridge-next')
  try {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@agents-anywhere/dsh-bridge-next', version: '2.0.0-dev.11' }))
    fs.writeFileSync(path.join(dir, 'lib', 'client.js'), CLIENT_FIXTURE)
    const result = bridgePatch.apply({ profileDir })
    assert.equal(result.applied.length, 0)
    assert.ok(result.skipped.some((line) => line.includes('旧 payload 缓存')))
    assert.equal(fs.readFileSync(path.join(dir, 'lib', 'client.js'), 'utf8'), CLIENT_FIXTURE, '缓存内容必须原样保留')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('上游结构变化（找不到锚点）：只记日志、保留原文件', () => {
  const profileDir = makeProfile({ client: 'module.exports = 1\n', host: 'module.exports = 2\n' })
  try {
    const result = bridgePatch.apply({ profileDir })
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, [])
    assert.ok(result.skipped.some((line) => line.includes('入口锚点未找到')), result.skipped.join(' | '))
    assert.ok(result.skipped.some((line) => line.includes('进程查询锚点未找到')), result.skipped.join(' | '))
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true })
  }
})
