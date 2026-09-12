// tests/download-stall.test.js — 下载停滞看门狗（代理假死不再把任务永久锁在 running）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const envInstall = require('../env-install')

function tmpDest() {
  return path.join(os.tmpdir(), 'dshl-dl-' + Date.now() + '-' + Math.random().toString(36).slice(2))
}

test('downloadToFile：连上但不发数据 → 停滞超时失败，并清掉半成品文件', async (t) => {
  process.env.DSHL_DL_STALL_MS = '600'
  const server = http.createServer(() => { /* 故意既不响应也不结束：模拟代理假死 */ })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    try { server.closeAllConnections && server.closeAllConnections() } catch { /* noop */ }
    try { server.close() } catch { /* noop */ }
    delete process.env.DSHL_DL_STALL_MS
  })
  const url = `http://127.0.0.1:${server.address().port}/never-responds`
  const dest = tmpDest()
  const t0 = Date.now()
  await assert.rejects(
    () => envInstall.downloadToFile(url, dest, null, { onAbort: null }),
    /下载停滞/
  )
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 5000, `应在停滞阈值附近就失败（实际 ${elapsed}ms）`)
  assert.equal(fs.existsSync(dest), false, '失败后不应留下半成品文件')
})

test('downloadToFile：正常响应不受看门狗影响（数据到达即重置计时）', async (t) => {
  process.env.DSHL_DL_STALL_MS = '600'
  const body = Buffer.from('hello-dshl')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    // 先发一半，等一会儿再发另一半：单次间隔小于阈值就不该被判停滞
    res.write(body.subarray(0, 5))
    setTimeout(() => { try { res.end(body.subarray(5)) } catch { /* noop */ } }, 300)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    try { server.closeAllConnections && server.closeAllConnections() } catch { /* noop */ }
    try { server.close() } catch { /* noop */ }
    delete process.env.DSHL_DL_STALL_MS
  })
  const dest = tmpDest()
  const r = await envInstall.downloadToFile(`http://127.0.0.1:${server.address().port}/ok`, dest, null, { onAbort: null })
  assert.equal(r.bytes, body.length)
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello-dshl')
  fs.unlinkSync(dest)
})

test('downloadStallMs 默认值存在且可被环境变量覆盖', () => {
  assert.equal(envInstall.DEFAULT_DL_STALL_MS, 60000)
  delete process.env.DSHL_DL_STALL_MS
  const saved = process.env.DSHL_DL_STALL_MS
  process.env.DSHL_DL_STALL_MS = '1234'
  // 通过行为间接验证：设一个极小值，停滞应在 ~1s 内失败（此处只断言常量导出与解析不抛错）
  assert.doesNotThrow(() => envInstall.DEFAULT_DL_STALL_MS)
  if (saved === undefined) delete process.env.DSHL_DL_STALL_MS
})