// tests/feedback-pack.test.js — 反馈正文的折叠与分片（飞书自定义机器人有长度上限，超了会被截断）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const pack = require('../feedback-pack')

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')

const stamp = (t) => `[2026-09-21T18:39:${String(t).padStart(2, '0')}.610+08:00]`

test('compactLog：连续重复行折叠成 ×N，并带上首末时间戳', () => {
  const log = [
    `${stamp(1)} starting DSH web`,
    `${stamp(2)} Error: connect ECONNREFUSED 127.0.0.1:3080`,
    `${stamp(3)} Error: connect ECONNREFUSED 127.0.0.1:3080`,
    `${stamp(4)} Error: connect ECONNREFUSED 127.0.0.1:3080`,
    `${stamp(5)} done`,
  ].join('\n')
  const out = pack.compactLog(log)
  const lines = out.split('\n')
  assert.equal(lines.length, 3, '三行重复应折成一行')
  assert.equal(lines[0], `${stamp(1)} starting DSH web`, '单次出现的行必须原样保留（时间戳不动）')
  assert.equal(lines[1], 'Error: connect ECONNREFUSED 127.0.0.1:3080  … ×3（2026-09-21T18:39:02.610+08:00 → 2026-09-21T18:39:04.610+08:00）')
  assert.equal(lines[2], `${stamp(5)} done`)
})

test('compactLog：没有时间戳前缀的日志同样折叠（老日志、DSH 原始输出）', () => {
  const out = pack.compactLog(['boom', 'boom', 'boom', 'ok'].join('\n'))
  assert.deepEqual(out.split('\n'), ['boom  … ×3', 'ok'])
})

test('compactLog：不折叠空行，也不把不同内容混在一起', () => {
  const out = pack.compactLog(['a', '', '', 'a', 'b'].join('\n'))
  assert.deepEqual(out.split('\n'), ['a', '', '', 'a', 'b'])
})

test('compactLog：真实形态的日志显著变短（这是它能解决截断的原因）', () => {
  // 真实反馈日志的形态：一轮一轮的重试，每轮里同一句错误重复十几遍
  const lines = []
  for (let round = 0; round < 12; round++) {
    lines.push(`${stamp(round)} starting DSH web`)
    for (let k = 0; k < 18; k++) lines.push(`${stamp(round)} Error: connect ECONNREFUSED 127.0.0.1:3080`)
    lines.push(`${stamp(round)} plugin tree failed to load: cannot find package '@deepseek-ai/dsh-typert-protocol'`)
  }
  const raw = lines.join('\n')
  const out = pack.compactLog(raw)
  assert.ok(out.length * 4 < raw.length, `折叠后应至少缩小到 1/4：raw=${raw.length} out=${out.length}`)
  assert.match(out, /… ×18/, '每轮那 18 条重复必须折成一行')
  assert.ok(out.includes('plugin tree failed to load'), '根因行不能被丢掉')
  assert.equal(out.split('\n').length, 36, '12 轮 × 3 行')
})

test('clampChunkChars：夹到合法区间，非法值回落默认', () => {
  assert.equal(pack.clampChunkChars(undefined), pack.DEFAULT_CHUNK_CHARS)
  assert.equal(pack.clampChunkChars(0), pack.DEFAULT_CHUNK_CHARS)
  assert.equal(pack.clampChunkChars('abc'), pack.DEFAULT_CHUNK_CHARS)
  assert.equal(pack.clampChunkChars(10), pack.MIN_CHUNK_CHARS)
  assert.equal(pack.clampChunkChars(999999), pack.MAX_CHUNK_CHARS)
  assert.equal(pack.clampChunkChars(6000), 6000)
})

test('splitForFeishu：短正文原样一块；长正文按行切且每块不超限', () => {
  assert.deepEqual(pack.splitForFeishu('short', 2000), ['short'])

  const text = Array.from({ length: 200 }, (_, i) => `line-${i} ${'x'.repeat(50)}`).join('\n')
  const chunks = pack.splitForFeishu(text, 2000)
  assert.ok(chunks.length > 1, '应切多块')
  const limit = 2000 - pack.PREFIX_RESERVE
  for (const c of chunks) assert.ok(c.length <= limit, `每块必须 ≤ ${limit}，实际 ${c.length}`)
  assert.equal(chunks.join('\n'), text, '拼回去必须与原文一致（不丢字符、不额外加换行）')
})

test('splitForFeishu：单行超限时硬切，不产生超限块', () => {
  const huge = 'y'.repeat(5000)
  const chunks = pack.splitForFeishu(huge, 1000)
  const limit = 1000 - pack.PREFIX_RESERVE
  assert.ok(chunks.length >= 5)
  for (const c of chunks) assert.ok(c.length <= limit)
  assert.equal(chunks.join(''), huge)
})

async function sendWithStub (text, opts = {}) {
  const calls = []
  const sleeps = []
  const errors = opts.errors ? [...opts.errors] : []
  const result = await pack.sendChunked({
    text,
    maxChars: opts.maxChars || 1000,
    sleep: async (ms) => { sleeps.push(ms) },
    delayMs: 400,
    retries: opts.retries === undefined ? 2 : opts.retries,
    sendOne: async (chunk) => {
      calls.push(chunk)
      const next = errors.shift()
      if (next) throw Object.assign(new Error(next.message), { retryable: !!next.retryable })
      return true
    },
  })
  return { calls, sleeps, result }
}

test('sendChunked：单块不加前缀，直接一条发出', async () => {
  const { calls, sleeps, result } = await sendWithStub('hello')
  assert.deepEqual(calls, ['hello'])
  assert.equal(result.chunks, 1)
  assert.equal(result.sent, 1)
  assert.deepEqual(sleeps, [], '单块不需要节流')
})

test('sendChunked：多块带 [i/N] 前缀、串行节流', async () => {
  const text = Array.from({ length: 120 }, (_, i) => `line-${i} ${'z'.repeat(60)}`).join('\n')
  const { calls, sleeps, result } = await sendWithStub(text, { maxChars: 1000 })
  assert.ok(result.chunks > 2, `应切多块，实际 ${result.chunks}`)
  assert.equal(calls.length, result.chunks)
  assert.match(calls[0], /^\[1\/\d+\] /u, '多块时每条都要带编号')
  assert.match(calls[calls.length - 1], new RegExp(`^\\[${result.chunks}/${result.chunks}\\] `, 'u'))
  assert.equal(sleeps.length, result.chunks - 1, '块之间要有节流间隔')
})

test('sendChunked：限流类错误退避重试后成功', async () => {
  const text = Array.from({ length: 60 }, (_, i) => `l${i} ${'q'.repeat(60)}`).join('\n')
  const { calls, sleeps, result } = await sendWithStub(text, {
    maxChars: 1200,
    errors: [{ message: 'too many request', retryable: true }],
  })
  assert.equal(result.sent, result.chunks, '全部发出')
  assert.ok(sleeps.includes(400), '第一次退避应为 delayMs')
  assert.ok(calls.length > result.chunks, '有一次重试')
})

test('sendChunked：不可重试的失败立刻抛出，并写明第几条 / 前几条已发出', async () => {
  const text = Array.from({ length: 60 }, (_, i) => `l${i} ${'q'.repeat(60)}`).join('\n')
  await assert.rejects(
    () => sendWithStub(text, { maxChars: 1200, errors: [null, { message: 'webhook 失效' }] }),
    (err) => {
      assert.match(err.message, /^第 2\/\d+ 条发送失败：webhook 失效（前 1 条已发出）$/u)
      assert.equal(err.sent, 1)
      assert.equal(err.chunk, 2)
      assert.equal(err.retryable, false)
      return true
    },
  )
})

test('sendChunked：可重试但一直失败 → 用完重试次数后报错', async () => {
  const text = Array.from({ length: 60 }, (_, i) => `l${i} ${'q'.repeat(60)}`).join('\n')
  await assert.rejects(
    () => sendWithStub(text, {
      maxChars: 1200,
      retries: 2,
      errors: [{ message: 'HTTP 429', retryable: true }, { message: 'HTTP 429', retryable: true }, { message: 'HTTP 429', retryable: true }],
    }),
    /第 1\/\d+ 条发送失败：HTTP 429/u,
  )
})

test('接线：折叠与分片必须真的用在反馈路径上（别只写模块不用）', () => {
  const main = read('main.js')
  assert.match(main, /const \{ compactLog, sendChunked, clampChunkChars \} = require\('\.\/feedback-pack'\)/, '必须引入 feedback-pack')
  assert.match(main, /compactLog\(tailOf\(TRAY_LOG/, 'dshl.log 必须折叠后再入正文')
  assert.match(main, /compactLog\(tailOf\(ERR_LOG/, 'server.err.log 必须折叠后再入正文')
  assert.match(main, /sendChunked\(\{ text: pack\.body, maxChars, sendOne/, '发送必须走分片发送器')
  assert.doesNotMatch(main, /trimUtf8\(/, '旧的按字节截断单条消息的路径必须移除（它会丢尾部）')
  assert.match(main, /retryable/, '限流错误必须标记 retryable，供退避重试判定')
  // 未折叠原文另存一份，保留"完整版在本地"的承诺
  assert.match(main, /\.full\.md/, '必须另存未折叠原文供排查')
  // 打包清单：漏了它打包后 require 会失败（verify 也会拦）
  const pkgJson = JSON.parse(read('package.json'))
  assert.ok(pkgJson.build.files.includes('feedback-pack.js'), 'feedback-pack.js 必须在 build.files 里')
  // 单条上限可调（作者按飞书实测上限调，界面无入口）
  assert.match(main, /Config\.feedbackChunkChars/, '单条上限必须可配置')
})
