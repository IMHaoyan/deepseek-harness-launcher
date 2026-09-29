// tests/bridge-peer-compat.test.js — 随包 bridge-next payload 必须能通过 dsh 的插件兼容闸（node --test）
// 背景：dsh 0.1.7-rc.1 起，dsh-app-boot 会按「runtime 版本是否满足插件的 @deepseek-ai/dsh* peer 范围」
// 决定是否跳过整个 bundle；payload 曾把 @deepseek-ai/dsh-typert-protocol 精确钉成 0.1.5-rc.1，
// 于是在 0.1.7-rc.1 上启动即被跳过（插件页却显示「重启后生效」）。本测试钉住修复后的契约。
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const semver = require('semver')

const root = join(__dirname, '..')
const assetsDir = join(root, 'assets', 'bridge-next')
const tgzPath = join(assetsDir, 'bridge-next.tgz')
const meta = JSON.parse(readFileSync(join(assetsDir, 'version.json'), 'utf8'))
const pkg = JSON.parse(execFileSync('tar', ['-xOf', tgzPath, 'package/package.json'], { encoding: 'utf8' }))
const dshPeers = Object.entries(pkg.peerDependencies || {}).filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))

test('随包 payload 与 version.json 一致（sha256 + 版本 + bundle patch 都在）', () => {
  const actual = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
  assert.equal(actual, meta.sha256, 'assets/bridge-next 的 tgz 与 version.json 的 sha256 不一致')
  assert.equal(pkg.name, meta.package.name, 'package.version/name 与 version.json 不一致')
  assert.equal(pkg.version, meta.version, 'payload 版本与 version.json 不一致（改了 tgz 必须同步 version.json）')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml', 'bundle patch 声明缺失 → DSH 启动会 ENOENT')
  const entries = execFileSync('tar', ['-tzf', tgzPath], { encoding: 'utf8' })
  assert.ok(entries.includes('package/cordis.patch.yml'), 'tgz 内缺少 cordis.patch.yml')
})

test('payload 的 dsh peer 范围能通过兼容闸：0.1.5 ~ 0.1.9 全放行', () => {
  assert.ok(dshPeers.length > 0, 'payload 没有声明任何 @deepseek-ai/dsh* peer')
  for (const runtime of ['0.1.5-rc.1', '0.1.7-alpha.2', '0.1.7-rc.1', '0.1.9']) {
    for (const [name, range] of dshPeers) {
      assert.ok(semver.satisfies(runtime, range, { includePrerelease: true }),
        `${name} 的 peer 范围 ${range} 不满足 dsh ${runtime} —— 该 dsh 上整个 bundle 会被跳过`)
    }
  }
})

test('payload 的 dsh peer 没有上界：dsh 进新 minor/新主版本也不会被闸拦下（免得每次升级都要重打补丁）', () => {
  // 2026-09-29 改：原先 `<0.2.0` 的上界让 dsh 一进新 minor 就被整条跳过（0.2.0-rc.2 实测复现），
  // 于是每次 dsh 升级都要重打 patch-bridge-peer-compat 并抬一次 payload 版本。现在无上界。
  for (const runtime of ['0.2.0-rc.1', '0.2.0-rc.2', '0.3.0', '1.0.0', '2.0.0-rc.1']) {
    for (const [name, range] of dshPeers) {
      assert.ok(semver.satisfies(runtime, range, { includePrerelease: true }),
        `${name} 的 peer 范围 ${range} 不满足 dsh ${runtime} —— 又要重打补丁了`)
    }
  }
  for (const [, range] of dshPeers) {
    assert.doesNotMatch(range, /<\s*\d/u, `peer 范围 ${range} 又有上界了：dsh 一升 minor 就会被跳过`)
  }
})

test('payload 的 peer 仍有下限：远古版本照旧拒绝（放宽不等于什么都不管）', () => {
  for (const [name, range] of dshPeers) {
    assert.ok(!semver.satisfies('0.1.0', range, { includePrerelease: true }),
      `${name} 的范围 ${range} 连 dsh 0.1.0 都放行 —— 下限被改没了`)
  }
})
