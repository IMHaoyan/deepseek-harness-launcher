// tests/bridge-import-check.test.js — 启动前 import 自检：把 DSH 吞掉的"failed to import"真实原因带回来
//
// 背景：2026-09-29 那台新机器上，插件行进了组合树但导入失败，DSH 只打一句
//   agents-anywhere-bridge-next (@agents-anywhere/dsh-bridge-next): failed to import
// 没有原因、没有栈，只能人工在那台机器上复现。本自检用**运行中的 Node** 试一次 import，
// 把真正报错（缺包 / 缺命名导出 / 语法）写进启动器日志与插件卡片。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bridge = require('../bridge')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-import-check-'))
}

/** 造一个最小可自检的 payload 目录（manifest + 入口）。 */
function makePayloadDir(root, entryCode, { main = './lib/index.js' } = {}) {
  const dir = path.join(root, 'payload')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: bridge.PLUGIN_NAME, version: '1.0.0', main }))
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), entryCode)
  return dir
}

/** 假 envDetect：把自检用的 Node 钉成当前进程的 Node（测试才算可控）。 */
function fakeEnv(nodeCmd = process.execPath) {
  return { detectEnv: async () => ({ plan: { nodeCmd } }) }
}

test('importCheckArgs：`-e` 内联脚本 + 入口 URL，不留临时文件', () => {
  const args = bridge.importCheckArgs('file:///x/lib/index.js')
  assert.equal(args[0], '--input-type=module')
  assert.equal(args[1], '-e')
  assert.match(args[2], /import\(process\.argv\[1\]\)/)
  assert.match(args[2], /console\.error/)
  assert.equal(args[3], 'file:///x/lib/index.js')
})

test('importCheckResult：只留第一条有信息量的行，退出码 0 就是通过', () => {
  assert.deepEqual(bridge.importCheckResult(0, '随便什么噪声'), { ok: true, error: '' })
  const noisy = [
    'node:internal/modules/esm/resolve:264',
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-session-title' imported from /x/lib/index.js",
    '    at Module._resolveFilename (node:internal/modules/esm/loader:xxx)',
  ].join('\n')
  const r = bridge.importCheckResult(1, noisy)
  assert.equal(r.ok, false)
  assert.match(r.error, /Cannot find package '@deepseek-ai\/dsh-session-title'/)
  assert.doesNotMatch(r.error, /at Module\._resolveFilename/)
  // 完全没有可识别的行时也不能编造：给出退出码
  assert.match(bridge.importCheckResult(3, '').error, /退出码 3/)
})

test('自检通过：入口能 import（用真实 Node 跑一次）', async () => {
  const root = tmpRoot()
  try {
    bridge.initBridge({ home: root, envDetect: fakeEnv(), payloadRoot: '', log: () => {} })
    const dir = makePayloadDir(root, 'export const name = "ok"\nexport function apply() {}\n')
    const r = await bridge.importCheckPayload(dir)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.error, '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('自检失败：入口抛错时把真实报错带回来（这正是 DSH 会吞掉的那句）', async () => {
  const root = tmpRoot()
  try {
    bridge.initBridge({ home: root, envDetect: fakeEnv(), payloadRoot: '', log: () => {} })
    const dir = makePayloadDir(root, 'throw new Error("boom-from-entry")\n')
    const r = await bridge.importCheckPayload(dir)
    assert.equal(r.ok, false)
    assert.match(r.error, /boom-from-entry/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('自检失败：入口文件缺失时也能给出可读原因（不抛错）', async () => {
  const root = tmpRoot()
  try {
    bridge.initBridge({ home: root, envDetect: fakeEnv(), payloadRoot: '', log: () => {} })
    const dir = makePayloadDir(root, 'export const name = "x"\n', { main: './lib/missing.js' })
    const r = await bridge.importCheckPayload(dir)
    assert.equal(r.ok, false)
    assert.ok(r.error.length > 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('没探测到 Node / manifest 读不到：只回可读原因，不上抛', async () => {
  const root = tmpRoot()
  try {
    bridge.initBridge({ home: root, envDetect: fakeEnv(''), payloadRoot: '', log: () => {} })
    const dir = makePayloadDir(root, 'export const name = "x"\n')
    assert.match((await bridge.importCheckPayload(dir)).error, /未检测到可用的 Node/)
    assert.match((await bridge.importCheckPayload(path.join(root, 'nope'))).error, /读不到 payload manifest/)
    bridge.initBridge({ home: root, envDetect: null, payloadRoot: '', log: () => {} })
    assert.match((await bridge.importCheckPayload(dir)).error, /envDetect 未初始化/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
