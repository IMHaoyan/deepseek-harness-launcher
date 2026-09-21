// tests/log-stamp.test.js — 子进程日志落盘的时间戳（server.err/out.log 的"这条错误几点发生"）
//
// 背景：2026-09-20 排查"设备昨晚几点掉线"时，这两份日志没有时间戳，错误无法定位到时刻。
// 边界：只给**落盘文件**打戳，内存证据（errTail / 当前环节）保持原始行不变。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { formatStamp, createStampWriter } = require('../log-stamp')

const AT = new Date(2026, 8, 20, 21, 20, 31, 7) // 本地时间 2026-09-20 21:20:31.007
const PREFIX = formatStamp(AT)

test('formatStamp：本地时间 + 时区偏移，毫秒补齐三位', () => {
  // 偏移量随机器时区变化，所以只断言形状与本地时间部分（不写死 +08:00）
  assert.match(PREFIX, /^\[2026-09-20T21:20:31\.007[+-]\d{2}:\d{2}\]$/u)
})

test('createStampWriter：每行一个戳，跨块的半行等到换行才落', () => {
  const lines = []
  const writer = createStampWriter((text) => lines.push(text), { now: () => AT })

  writer.write('first line\nsecond')
  assert.deepEqual(lines, [`${PREFIX} first line\n`], '半行不能提前落盘（否则一行会被戳成两行）')

  writer.write(' line\n')
  assert.deepEqual(lines, [`${PREFIX} first line\n`, `${PREFIX} second line\n`])

  writer.flush()
  assert.equal(lines.length, 2, '没有半行时 flush 不该多产出一行')
})

test('createStampWriter：一次多行各自带戳（不是只戳第一行）', () => {
  const lines = []
  const writer = createStampWriter((text) => lines.push(text), { now: () => AT })
  writer.write('a\nb\nc\n')
  assert.deepEqual(lines, [`${PREFIX} a\n`, `${PREFIX} b\n`, `${PREFIX} c\n`])
})

test('createStampWriter：末尾半行在 flush 时补上（子进程可能没打最后一个换行）', () => {
  const lines = []
  const writer = createStampWriter((text) => lines.push(text), { now: () => AT })
  writer.write('no trailing newline')
  assert.deepEqual(lines, [], '还没换行就先攒着')
  writer.flush()
  assert.deepEqual(lines, [`${PREFIX} no trailing newline\n`])
  writer.flush()
  assert.equal(lines.length, 1, 'flush 幂等：没有残留就不再产出')
})

test('createStampWriter：一直不换行的超长输出不会把内存憋住', () => {
  const lines = []
  const writer = createStampWriter((text) => lines.push(text), { now: () => AT, pendingMax: 16 })
  writer.write('x'.repeat(40))
  assert.equal(lines.length, 1, '超过 pendingMax 就先落一行')
  assert.match(lines[0], new RegExp(`^\\${PREFIX.slice(0, 1)}[^\\]]+\\] x{40}\\n$`, 'u'))
  writer.flush()
  assert.equal(lines.length, 1, '缓冲区已清空')
})

test('createStampWriter：Buffer 输入与非字符串输入都能落盘', () => {
  const lines = []
  const writer = createStampWriter((text) => lines.push(text), { now: () => AT })
  writer.write(Buffer.from('from buffer\n', 'utf8'))
  writer.write(undefined)
  writer.write(123)
  writer.flush()
  assert.deepEqual(lines, [`${PREFIX} from buffer\n`, `${PREFIX} 123\n`])
})

test('createStampWriter：落盘回调抛错不会冒泡（日志失败不该影响服务）', () => {
  const writer = createStampWriter(() => { throw new Error('disk full') }, { now: () => AT })
  assert.doesNotThrow(() => { writer.write('x\n'); writer.flush() })
})
