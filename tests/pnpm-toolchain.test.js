'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const envDetect = require('../env-detect')
const envInstall = require('../env-install')
const market = require('../market')

test('normalizeInstallItems：安装 Node/DSH 自动带 pnpm，单装 pnpm 不额外安装 Node', () => {
  assert.deepEqual(envInstall.normalizeInstallItems(['plugin']), ['plugin'])
  assert.deepEqual(envInstall.normalizeInstallItems(['dsh']), ['dsh', 'pnpm'])
  assert.deepEqual(envInstall.normalizeInstallItems(['node']), ['node', 'pnpm'])
  assert.deepEqual(envInstall.normalizeInstallItems(['pnpm']), ['pnpm'])
  assert.deepEqual(envInstall.normalizeInstallItems(['node', 'dsh']), ['node', 'dsh', 'pnpm'])
})

test('buildStages：pnpm 阶段排在 Node 之后、DSH 之前', () => {
  const ids = envInstall.buildStages(['node', 'pnpm', 'dsh']).map((s) => s.id)
  assert.deepEqual(ids, ['node-dl', 'node-ex', 'pnpm', 'dsh-npm', 'dsh-verify'])
  assert.deepEqual(envInstall.buildStages(['plugin']).map((s) => s.id), ['plugin'])
})

test('classifyPnpmCommand：识别 Corepack / npm 全局 / 普通 PATH', () => {
  assert.equal(envDetect.classifyPnpmCommand('C:\\Program Files\\nodejs\\pnpm.cmd', '@ECHO off\r\nnode corepack\\dist\\pnpm.js %*'), 'corepack')
  const npmRoot = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '/usr/local'
  assert.equal(envDetect.classifyPnpmCommand(path.join(npmRoot, 'pnpm.cmd'), '@ECHO off\r\nnode pnpm.cjs %*'), 'npm-global')
  assert.equal(envDetect.classifyPnpmCommand(path.join(os.tmpdir(), 'pnpm.cmd'), '@ECHO off\r\necho 1.0.0'), 'path')
})

test('parsePnpmVersion：从 --version 输出提取版本', () => {
  assert.equal(envDetect.parsePnpmVersion('11.8.0\n'), '11.8.0')
  assert.equal(envDetect.parsePnpmVersion('v11.8.0'), '11.8.0')
  assert.equal(envDetect.parsePnpmVersion(''), '')
})

test('detectPnpm：PATH 上的 pnpm 版本与期望一致时返回 ok', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-pnpm-detect-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'pnpm.cmd'), '@echo off\r\necho 11.8.0\r\n')
  } else {
    const shim = path.join(dir, 'pnpm')
    fs.writeFileSync(shim, '#!/bin/sh\necho 11.8.0\n', { mode: 0o700 })
  }
  const savedPath = process.env.PATH
  process.env.PATH = dir + path.delimiter + (savedPath || '')
  t.after(() => { process.env.PATH = savedPath })
  const got = await envDetect.detectPnpm({ expectedVersion: '11.8.0' })
  assert.equal(got.status, 'ok')
  assert.equal(got.version, '11.8.0')
  assert.equal(path.basename(got.path).toLowerCase(), process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  assert.ok(got.path.toLowerCase().includes('dshl-pnpm-detect-'))
})

test('market.pnpmReady：仅 pnpm status=ok 时放行', () => {
  assert.equal(market.pnpmReady({ pnpm: { status: 'ok' } }), true)
  assert.equal(market.pnpmReady({ pnpm: { status: 'mismatch' } }), false)
  assert.equal(market.pnpmReady({}), false)
})
