'use strict'

// 全部 IO 经模拟 runExec + 广播注入；不读写真实注册表、不启动安装器。
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseUserPathQuery, planUserPath, readUserPath, addToUserPath } = require('../env-install')._userPath

const snapshot = (value, type = 'REG_EXPAND_SZ') => ({ ok: true, type, value })
const output = (value, type = 'REG_EXPAND_SZ', name = 'Path') => `\r\nHKEY_CURRENT_USER\\Environment\r\n    ${name}    ${type}    ${value}\r\n\r\n`
const result = (value, type) => ({ stdout: output(value, type), stderr: '' })
function simulation(replies, env = {}) {
  const calls = [], logs = [], events = []
  let broadcasts = 0
  return {
    calls, logs, events,
    job: { logLine: (line) => { logs.push(line); events.push('log') } },
    deps: {
      isWin: true, env,
      runExec: async (cmd, args, opts) => {
        assert.equal(cmd, 'reg')
        calls.push({ cmd, args, opts }); events.push(args[0])
        assert.ok(replies.length, '未规划的 IO，禁止落到真实执行')
        const reply = replies.shift()
        if (reply instanceof Error) throw reply
        return reply
      },
      broadcastEnvironmentChange: () => { broadcasts++; events.push('broadcast') },
    },
    get broadcasts() { return broadcasts },
  }
}

for (const type of ['REG_SZ', 'REG_EXPAND_SZ']) {
  test(`解析 ${type}：精确保留空串、空白、空段、变量与引号`, () => {
    for (const value of ['', ' ', '    ', '; C:\\Old ;;;"%AppData%\\npm";  ', 'C:\\用户\\工具;D:\\Öld']) {
      assert.deepEqual(parseUserPathQuery(output(value, type)), snapshot(value, type))
    }
    assert.deepEqual(parseUserPathQuery(output('C:\\Old', type, 'pAtH')), snapshot('C:\\Old', type))
  })
  test(`${type} 追加/置前仅拼接新目录，旧字符串及新目录顺序不变`, () => {
    const old = '; C:\\Old ;;;"%AppData%\\npm";  ;'
    const dirs = ['C:\\New', 'D:\\Tool']
    assert.deepEqual(planUserPath(snapshot(old, type), dirs), {
      status: 'planned', type, added: dirs, value: old + ';C:\\New;D:\\Tool',
    })
    assert.equal(planUserPath(snapshot(old, type), dirs, { prepend: true }).value, 'C:\\New;D:\\Tool;' + old)
    assert.equal(planUserPath(snapshot('', type), dirs).value, dirs.join(';'))
  })
  test(`${type} 写入保留类型和值，三次查询及读回后广播`, async () => {
    const old = '; C:\\Old ;;  '
    const expected = 'C:\\New;D:\\Tool;' + old
    const sim = simulation([result(old, type), result(old, type), { stdout: '', stderr: '' }, result(expected, type)])
    const out = await addToUserPath(sim.job, ['C:\\New', 'D:\\Tool'], { prepend: true }, sim.deps)
    assert.equal(out.status, 'updated')
    assert.deepEqual(sim.calls.map((c) => c.args[0]), ['query', 'query', 'add', 'query'])
    assert.deepEqual(sim.calls[2].args, ['add', 'HKCU\\Environment', '/v', 'Path', '/t', type, '/d', expected, '/f'])
    assert.equal(sim.broadcasts, 1)
    assert.equal(sim.events.at(-1), 'broadcast')
    assert.match(sim.logs.at(-1), /已更新并读回确认/)
  })
}

test('成功输出但缺值、格式歧义、不同键、重复行、不支持类型均不可信', () => {
  const invalid = [
    '', '\r\nHKEY_CURRENT_USER\\Environment\r\n',
    output('C:\\Old').replace('Path', 'OtherPath'),
    output('C:\\Old', 'REG_MULTI_SZ'),
    output('').replace('REG_EXPAND_SZ    ', 'REG_EXPAND_SZ'),
    output('C:\\Old').replace('    Path', '  Path'),
    output('C:\\Old').replace('HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE'),
    output('C:\\Old') + '    Path    REG_SZ    C:\\Other\r\n',
    output('C:\\Old\nC:\\Second'), output('C:\\Old\0'), output('C:\\损坏\uFFFD'),
  ]
  for (const text of invalid) assert.equal(parseUserPathQuery(text).ok, false, JSON.stringify(text))
})

test('路径比较使用 Windows 规则：大小写、斜杠、尾斜杠、引号、dot、UNC 与去重', () => {
  const old = ' "C:/Tools/./bin/" ;\\\\Server\\Share\\Tool\\;C:\\Else'
  const out = planUserPath(snapshot(old), ['c:\\tools\\bin', '\\\\server\\share\\tool', 'D:\\New', 'd:/new/'])
  assert.deepEqual(out.added, ['D:\\New'])
  assert.equal(out.value, old + ';D:\\New')
})

test('变量只在 REG_EXPAND_SZ 中用于比较，不展开写入；名称不区分大小写', () => {
  const old = '"%AppData%\\npm";%ROOT%\\bin'
  const env = { APPDATA: 'C:\\User\\Roaming', ROOT: '%BASE%', BASE: 'D:\\Tools' }
  const dirs = ['C:\\User\\Roaming\\npm', 'D:\\Tools\\bin', 'E:\\New']
  const expanded = planUserPath(snapshot(old), dirs, {}, env)
  assert.deepEqual(expanded.added, ['E:\\New'])
  assert.equal(expanded.value, old + ';E:\\New')
  assert.deepEqual(planUserPath(snapshot(old, 'REG_SZ'), dirs, {}, env).added, dirs)
})

test('未知/循环变量不能被 .. normalize 为已存在目录', () => {
  const old = 'C:\\%UNKNOWN%\\..\\Tools;%LOOP%\\bin;%BROKEN'
  const dirs = ['C:\\Tools', 'D:\\bin']
  const out = planUserPath(snapshot(old), dirs, {}, { LOOP: '%LOOP%' })
  assert.deepEqual(out.added, dirs)
  assert.equal(out.value, old + ';' + dirs.join(';'))
})

test('只接受绝对目录，非法输入导致整次规划跳过且不修改旧值', () => {
  for (const dir of ['', '.', 'node', 'C:relative', '\\root-relative', '%APPDATA%\\npm', 'C:\\bad;D:\\inject', '"C:\\Quoted"', 'C:\\bad\n', null]) {
    assert.deepEqual(planUserPath(snapshot('C:\\Old'), ['D:\\Good', dir]), { status: 'skipped', reason: 'invalid-directory' })
  }
  for (const bad of [{ ok: false }, snapshot('C:\\Old', 'REG_BINARY'), snapshot('C:\\Old\n')]) {
    assert.equal(planUserPath(bad, ['D:\\Good']).status, 'skipped')
  }
})

test('普通查询失败包括缺值消息始终 fail-closed，不猜本地化错误', async () => {
  for (const message of ['ERROR: The system was unable to find the specified registry key or value.', '错误: 系统找不到指定的注册表项或值。', 'Access denied', 'timeout']) {
    const sim = simulation([new Error(message)])
    assert.equal((await readUserPath(sim.deps)).ok, false)
    const second = simulation([new Error(message)])
    assert.equal((await addToUserPath(second.job, ['C:\\New'], {}, second.deps)).status, 'skipped')
    assert.equal(second.calls.length, 1)
    assert.equal(second.broadcasts, 0)
  }
})

test('查询成功却无可解析值/有 stderr 时跳过，绝不 add', async () => {
  for (const response of [{ stdout: '', stderr: '' }, { stdout: output('C:\\Old'), stderr: 'warning' }]) {
    const sim = simulation([response])
    assert.equal((await addToUserPath(sim.job, ['C:\\New'], {}, sim.deps)).status, 'skipped')
    assert.equal(sim.calls.length, 1)
    assert.equal(sim.broadcasts, 0)
  }
})

test('已包含目录不写、不广播；prepend 不重排已有条目', async () => {
  const old = ';C:\\Else;;"C:\\New\\"; '
  const sim = simulation([result(old)])
  const out = await addToUserPath(sim.job, ['c:/new'], { prepend: true }, sim.deps)
  assert.equal(out.status, 'unchanged')
  assert.equal(out.value, old)
  assert.equal(sim.calls.length, 1)
  assert.equal(sim.broadcasts, 0)
})

test('写前重读失败/值冲突/类型冲突均明确 skipped 且不写', async () => {
  for (const [reply, reason] of [
    [new Error('timeout'), 'prewrite-read-failed'], [{ stdout: '', stderr: '' }, 'prewrite-read-failed'],
    [result('C:\\Other'), 'conflict'], [result('C:\\Old', 'REG_SZ'), 'conflict'],
    [result('C:\\Old '), 'conflict'],
  ]) {
    const sim = simulation([result('C:\\Old'), reply])
    assert.deepEqual(await addToUserPath(sim.job, ['D:\\New'], {}, sim.deps), { status: 'skipped', reason })
    assert.deepEqual(sim.calls.map((c) => c.args[0]), ['query', 'query'])
    assert.equal(sim.broadcasts, 0)
  }
})

test('写入失败向安装任务抛出：不成功、不广播、不尝试回滚', async () => {
  const sim = simulation([result('C:\\Old'), result('C:\\Old'), new Error('write denied')])
  await assert.rejects(addToUserPath(sim.job, ['D:\\New'], {}, sim.deps), /write denied/)
  assert.deepEqual(sim.calls.map((c) => c.args[0]), ['query', 'query', 'add'])
  assert.equal(sim.broadcasts, 0)
  assert.ok(!sim.logs.some((line) => /已更新/.test(line)))
})

test('写后读失败/输出不可信/值或类型冲突抛错，不覆盖回滚外部新值', async () => {
  for (const reply of [new Error('timeout'), { stdout: '', stderr: '' }, result('C:\\ExternalNewValue'), result('C:\\Old;D:\\New', 'REG_SZ'), result('C:\\Old;D:\\New ')]) {
    const sim = simulation([result('C:\\Old'), result('C:\\Old'), { stdout: '', stderr: '' }, reply])
    await assert.rejects(addToUserPath(sim.job, ['D:\\New'], {}, sim.deps), /写后验证失败/)
    assert.deepEqual(sim.calls.map((c) => c.args[0]), ['query', 'query', 'add', 'query'])
    assert.equal(sim.broadcasts, 0)
    assert.ok(!sim.logs.some((line) => /已更新/.test(line)))
  }
})

test('精确空值可写，空白值不当空串且原样保留', async () => {
  for (const old of ['', '    ']) {
    const next = old ? old + ';C:\\New' : 'C:\\New'
    const sim = simulation([result(old, 'REG_SZ'), result(old, 'REG_SZ'), { stdout: '', stderr: '' }, result(next, 'REG_SZ')])
    assert.equal((await addToUserPath(sim.job, ['C:\\New'], {}, sim.deps)).value, next)
    assert.equal(sim.broadcasts, 1)
  }
})

test('非 Windows 和显式测试跳过无需查询', async () => {
  for (const override of [{ isWin: false }, { env: { DSHL_SKIP_PATH: '1' } }]) {
    const sim = simulation([])
    Object.assign(sim.deps, override)
    assert.equal((await addToUserPath(sim.job, ['C:\\New'], {}, sim.deps)).status, 'skipped')
    assert.equal(sim.calls.length, 0)
  }
})
