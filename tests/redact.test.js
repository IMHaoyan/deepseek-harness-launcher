// tests/redact.test.js — 脱敏纯函数测试（node --test）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { redact } = require('../redact')

test('sk- 风格 key 脱敏', () => {
  assert.equal(redact('sk-abcdefghijklmnopqrstuvwxyz123456'), 'sk-***')
  assert.equal(redact('key=sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0'), 'key=sk-***')
  assert.equal(redact('before sk-abcd1234efgh5678ijkl9012mnop3456 after'), 'before sk-*** after')
})

test('短 sk- 前缀（非 key）不误伤', () => {
  assert.equal(redact('sk-abc'), 'sk-abc')
})

test('长 hex 脱敏', () => {
  assert.equal(redact('sha 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), 'sha ***')
})

test('短 hex（色值/短 id）不误伤', () => {
  assert.equal(redact('#aabbcc uuid=12345678'), '#aabbcc uuid=12345678')
})

test('长 base64 脱敏（要求大小写+数字混合，避免误伤纯小写长标识）', () => {
  const b64 = 'Abc123Def456Ghi789Jkl012Mno345Pqr678Stu901Vwx234Yz56789012'
  assert.equal(redact(`t=${b64}`), 't=***')
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  // 整个 JWT 应被替换（头段/payload/签名都不得残留）
  assert.ok(!redact(jwt).includes('SflKxwRJSMeKKF'))
  assert.ok(!redact(jwt).includes('eyJhbGciOiJIUzI1NiJ9'))
})

test('32 字符级别的短密钥也要脱敏（原阈值 40 会漏）', () => {
  assert.equal(redact('token=QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph'), 'token=***')
  assert.ok(!redact('NETEASE_AUTH_KEY: 571ff5a1b2c3d4e5f60718293a4b5c6g').includes('571ff5a1'))
})

test('不误伤：Windows 路径 / 文件 URL / URL 路径段', () => {
  const cases = [
    'at FileSettingsProvider.parse (file:///C:/Users/gonghaoyan/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh-settings-file/lib/index.js:211:42)',
    'path=C:\\Users\\gonghaoyan\\AppData\\Local\\Programs\\nodejs\\node.exe',
    'https://ai.leihuo.netease.com/v1/chat/completions',
  ]
  for (const c of cases) assert.equal(redact(c), c, '不应改动：' + c)
})

test('多值 Cookie 与 token scheme 鉴权头整段脱敏', () => {
  const cookie = 'Cookie: a=b; sessionid=abcdefghijklmnop'
  assert.ok(!redact(cookie).includes('abcdefghijklmnop'))
  const auth = 'Authorization: token glpat-abcdefghijklmnopqrst'
  assert.equal(redact(auth), 'Authorization: ***')
})

test('URL 内联凭据脱敏', () => {
  assert.equal(redact('https://user:pass@example.com/api'), 'https://***@example.com/api')
})

test('授权头脱敏', () => {
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop'), 'Authorization: ***')
  assert.equal(redact('authorization= Bearer_abcdefghijklmnop'), 'authorization= ***')
  assert.equal(redact('cookie: session=abc'), 'cookie: ***')
  assert.equal(redact('x-api-key=abcdef'), 'x-api-key=***')
  // bearer/basic 前缀连同 token 整段替换
  assert.equal(redact('Authorization: bearer abcdefghijklmnop123456'), 'Authorization: ***')
})

test('bearer 内联 token 脱敏', () => {
  assert.equal(redact('Authorization: bearer abcdefghijklmnop123456'), 'Authorization: ***')
  assert.equal(redact('Bearer abcdefghijklmnop123456 rest'), 'Bearer *** rest')
})

test('敏感 query 值脱敏', () => {
  assert.equal(redact('http://h/p?token=abc123&x=1'), 'http://h/p?token=***&x=1')
  assert.equal(redact('?key=abcdef&api_key=xyz'), '?key=***&api_key=***')
  assert.equal(redact('?sig=abc&code=xyz'), '?sig=***&code=***')
})

test('普通文本不受影响', () => {
  const t = 'elapsed=123ms port=3080 version=1.2.3 path=C:\\Users\\me\\out.txt hex=deadbeef url=https://api.deepseek.com/user/balance'
  assert.equal(redact(t), t)
})

test('DSH 启动地址里的一次性 launch token 必须脱敏（server.out.log 会原样落盘）', () => {
  const line = 'dsh web: http://127.0.0.1:4399/?token=IIHjtfAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abc'
  const out = redact(line)
  assert.ok(!out.includes('IIHjtfAbCdEfGhIjKlMnOpQrStUvWxYz'), 'token 值不得保留')
  assert.ok(out.includes('token=***'), '应替换为 token=***')
  assert.ok(out.includes('http://127.0.0.1:4399/'), '地址其余部分保留')
})

test('非字符串原样返回', () => {
  assert.equal(redact(null), null)
  assert.equal(redact(''), '')
})
