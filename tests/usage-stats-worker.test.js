// tests/usage-stats-worker.test.js — 统计接收端的字段白名单与鉴权（纯函数层）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const workerUrl = pathToFileURL(path.join(__dirname, '..', 'stats', 'worker.mjs')).href

test('接收端只接受固定 5 字段，多一个字段也拒绝', async () => {
  const { validateReport } = await import(workerUrl)
  const good = {
    dshlVersion: '1.4.15',
    dshlChannel: 'latest',
    dshVersion: '0.2.2-rc.2',
    dshChannel: 'alpha',
    windowsVersion: 'Windows 11 23H2',
  }
  assert.deepEqual(validateReport(good), good)
  assert.equal(validateReport({ ...good, installId: 'abc' }), null)
  assert.equal(validateReport({ ...good, dshVersion: undefined }), null)
  assert.equal(validateReport({ ...good, windowsVersion: 'x'.repeat(49) }), null)
  assert.equal(validateReport({ ...good, dshVersion: '有中文' }), null)
  assert.equal(validateReport(null), null)
  assert.equal(validateReport([]), null)
})

test('接收端不读取来源 IP：报告处理只依赖请求体', async () => {
  const raw = require('node:fs').readFileSync(path.join(__dirname, '..', 'stats', 'worker.mjs'), 'utf8')
  // 只检查代码行：注释里说明"不读取"不算读取
  const code = raw.split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join('\n')
  assert.doesNotMatch(code, /cf-connecting-ip|request\.cf/i)
  assert.doesNotMatch(code, /INSERT INTO .*ip/i)
})
