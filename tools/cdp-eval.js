// cdp-eval.js — 通过 Chrome DevTools Protocol 对某 target 执行 JS（验证/点击用）
// 用法：node tools/cdp-eval.js <wsUrl> <js>
'use strict'
const WebSocket = require('ws')

const [, , wsUrl, jsRaw] = process.argv
if (!wsUrl || !jsRaw) { console.error('usage: node cdp-eval.js <wsUrl> <js>'); process.exit(2) }
const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 })
let id = 0
const pending = new Map()
function call(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
ws.on('open', async () => {
  try {
    await call('Runtime.enable', {})
    const r = await call('Runtime.evaluate', { expression: jsRaw, returnByValue: true, awaitPromise: true })
    console.log(JSON.stringify(r.result && r.result.result ? r.result.result : r, null, 2))
    process.exit(0)
  } catch (e) {
    console.error('ERR: ' + e.message)
    process.exit(1)
  }
})
ws.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id) }
})
ws.on('error', (e) => { console.error('WS ERR: ' + e.message); process.exit(1) })
setTimeout(() => { console.error('TIMEOUT'); process.exit(1) }, 15000)
