// tests/bridge-auto-deps.test.js — 入口 import 却本地找不到时的补装计划
//
// 背景：payload 的 lib/index.js 会 import 一些 manifest 里根本没声明的包
// （@deepseek-ai/dsh-session-title / dsh-llm / dsh-session）。镜像现在按入口 import 补齐，
// 但有些机器上这些包可能哪儿都没有 —— 这时按"与 dsh 同版本号体系"补装，
// 其余不猜版本、留给启动前自检点名。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bridge = require('../bridge')

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-auto-deps-'))
}

/** 隔离 %APPDATA%，避免本机真实 npm 安装让"找不到"的断言失效。 */
function neutralizeInstallTree() {
  const prev = process.env.APPDATA
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-empty-appdata-'))
  process.env.APPDATA = empty
  bridge.cacheInstallModulesDirs({})
  return () => {
    if (prev === undefined) delete process.env.APPDATA
    else process.env.APPDATA = prev
    fs.rmSync(empty, { recursive: true, force: true })
  }
}

function makePayloadDir(root, entryCode) {
  const dir = path.join(root, 'payload')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: bridge.PLUGIN_NAME, version: '1.0.0', main: './lib/index.js', dependencies: { qrcode: '1.5.4' },
  }))
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), entryCode)
  return dir
}

test('autoInstallPlan：只补 @deepseek-ai/dsh*，版本取 dsh 版本；其余不猜版本', () => {
  const plan = bridge.autoInstallPlan(
    ['@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-llm', 'left-pad', '@deepseek-ai/cordis'],
    '0.2.0-rc.2',
  )
  assert.deepEqual(plan.extra, {
    '@deepseek-ai/dsh-session-title': '0.2.0-rc.2',
    '@deepseek-ai/dsh-llm': '0.2.0-rc.2',
  })
  assert.deepEqual(plan.skipped, ['left-pad', '@deepseek-ai/cordis'])
})

test('autoInstallPlan：dsh 版本非法时一律不补（不猜版本）', () => {
  for (const bad of ['', 'latest', 'not-a-version', null, undefined]) {
    const plan = bridge.autoInstallPlan(['@deepseek-ai/dsh-session'], bad)
    assert.deepEqual(plan.extra, {}, '奇怪版本号下不能凭猜补装：' + String(bad))
    assert.deepEqual(plan.skipped, ['@deepseek-ai/dsh-session'])
  }
  assert.deepEqual(bridge.autoInstallPlan([], '0.2.0-rc.2'), { extra: {}, skipped: [] })
})

test('missingEntryImports：入口 import 且哪儿都没有的才是缺口', () => {
  const root = tmpRoot()
  const restore = neutralizeInstallTree()
  try {
    const home = path.join(root, 'home')
    bridge.initBridge({ home, envDetect: null, payloadRoot: '', log: () => {} })
    const dir = makePayloadDir(root, [
      'import { foldSessionTitle } from "@deepseek-ai/dsh-session-title";',
      'import { readFile } from "node:fs/promises";',
      'import "./local.js";',
    ].join('\n'))
    assert.deepEqual(bridge.missingEntryImports(dir), ['@deepseek-ai/dsh-session-title'])

    // 放进 payload 自己的 node_modules 之后就不再算缺口
    const installed = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-session-title')
    fs.mkdirSync(installed, { recursive: true })
    fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-title', version: '0.2.0-rc.2' }))
    assert.deepEqual(bridge.missingEntryImports(dir), [])
    assert.deepEqual(bridge.missingEntryImports(''), [], '空目录不抛错')
  } finally {
    restore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('主流程接线：启动前自愈里会算补装计划、失败不阻断启动', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8')
  const body = src.slice(src.indexOf('async function ensureRuntimeDeps'))
  const fn = body.slice(0, body.indexOf('\n}\n'))
  assert.match(fn, /autoInstallPlan\(missingEntryImports\(dir\)/, '要按入口缺口算计划')
  assert.match(fn, /await installPayloadDependencies\(plan\.extra\)/, '额外依赖要进同一次安装')
  assert.match(fn, /运行时依赖准备失败（不阻断启动）/, '安装失败只记账')
  const installAt = fn.indexOf('await installPayloadDependencies(plan.extra)')
  assert.ok(installAt > 0, '额外依赖要进同一次安装')
  assert.ok(fn.lastIndexOf('repairPayloadScopeMirror(dir)') > installAt, '装完要再刷一次镜像（新装的包也要进镜像）')
})
