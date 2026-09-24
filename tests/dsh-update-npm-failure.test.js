// tests/dsh-update-npm-failure.test.js — npm 失败诊断与"安装期间让路"（node --test）
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const dshUpdater = require('../dsh-update')

const root = join(__dirname, '..')
const src = readFileSync(join(root, 'dsh-update.js'), 'utf8')
const mainSrc = readFileSync(join(root, 'main.js'), 'utf8')

test('tail：折叠空白、只保留末尾、容忍空值', () => {
  assert.equal(dshUpdater.tail('a\n\n  b   c '), 'a b c')
  assert.equal(dshUpdater.tail(''), '')
  assert.equal(dshUpdater.tail(null), '')
  const long = 'x'.repeat(500)
  const out = dshUpdater.tail(long, 100)
  assert.equal(out.length, 101, '省略号 + 末尾 100 字符')
  assert.ok(out.startsWith('…'))
  assert.equal(out.slice(1), long.slice(-100))
})

test('npm 失败要留下 stderr 尾部（并过 redact），不能只记退出码', () => {
  assert.ok(src.includes("const { redact } = require('./redact')"), '日志要过 redact')
  assert.ok(src.includes('redact(tail(stderr))'), '要把 stderr 末尾记进日志')
  assert.ok(src.includes('if (error) logNpmFailure(args, error, stderr)'), '退出码非 0 时要记')
  assert.ok(src.includes("logNpmFailure(args, err.message, stderr)"), 'spawn 自身报错时也要记')
})

test('安装类调用标成 mutation；只读调用撞上安装立刻让路（busy），不去抢同一份缓存', () => {
  const marks = src.split('\n').filter((line) => line.includes('runNpm(') && line.includes('mutation: true'))
  assert.equal(marks.length, 3, '三处会写盘的调用要标记：全局安装、预装、缓存预热（注释里的说明不算）')
  assert.ok(src.includes('if (!mutation && npmMutations > 0)'), '只读调用在有安装跑时直接返回')
  assert.ok(src.includes("busy: true, error: 'npm 忙（正在安装），本轮跳过'"), 'busy 是明确返回，不算失败')
})

test('npm 忙不算检查失败：保持 idle，不弹错误态', () => {
  assert.ok(src.includes('if (r.busy) { lastFetchBusy = true'), '取版本时识别 busy')
  assert.ok(src.includes("log('dsh-update: 有 npm 安装在跑，本轮检查跳过（不算失败）')"), '要留一条可解释的日志')
  assert.ok(src.includes("setState({ status: 'idle' })"), 'busy 时回落 idle')
})

test('Defender 排除项要覆盖 npm 共享缓存目录', () => {
  assert.ok(mainSrc.includes("'npm-cache'"), '缓存目录没排除时，实时扫描会让安装即刻失败')
  assert.match(mainSrc, /path\.join\(os\.homedir\(\), '\.npm'\)/, 'HOME 下的另一种默认缓存位置也要覆盖')
})
