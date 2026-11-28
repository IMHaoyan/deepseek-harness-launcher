// tests/loading-texts.test.js — 状态说明页文案表必须覆盖主进程用到的所有 reason（node --test）
//
// 漏一个键就会 fallback 到 TEXTS.start：页面显示「正在启动 DeepSeek Harness 服务…」，
// 与真实动作不符（插件市场变更 / 健康回退都踩过这个坑），而且按钮语义也跟着错。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const loadingSrc = fs.readFileSync(path.join(root, 'ui-src', 'loading.js'), 'utf8')
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

function textsKeys() {
  const body = loadingSrc.slice(loadingSrc.indexOf('const TEXTS = {'), loadingSrc.indexOf('const triedAuth'))
  return new Set([...body.matchAll(/^  ([A-Za-z][A-Za-z0-9]*): \{$/gm)].map((m) => m[1]))
}

// 主进程真正会传给说明页的 reason：webLoadTabs('x') / loadWebTabs('x') / loadingReason: 'x'
// + reasonForPhase() 按服务阶段推导出来的那几个
function usedReasons() {
  const used = new Set()
  for (const file of ['main.js', 'dsh-update.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    // 两个调用名不同：main.js 是 webLoadTabs('x')，dsh-update.js 是 loadWebTabs('x')
    for (const m of src.matchAll(/webLoadTabs\('([^']+)'\)|loadWebTabs\('([^']+)'\)/g)) used.add(m[1] || m[2])
    for (const m of src.matchAll(/loadingReason: '([^']+)'/g)) used.add(m[1])
  }
  const tail = mainSrc.slice(mainSrc.indexOf('function reasonForPhase('))
  const body = tail.slice(0, tail.indexOf('\n}'))
  for (const m of body.matchAll(/return '([A-Za-z]+)'/g)) used.add(m[1])
  return used
}

// 端口冲突页的按钮语义：文案必须等于真实动作。
// 历史问题：没有建议端口时按钮写「打开 DSHL 控制台（更换端口）」，点击发的却是 fixPane（重载本页 →
// 主进程顺带重跑 handleStart 重新探测端口），说的和做的不是一回事。
test('端口冲突页：按钮文案等于真实动作（无可换端口时就是就地重试）', () => {
  // 只认代码里的字符串字面量（注释里会引用旧文案作说明，不该把它算进来）
  assert.ok(!loadingSrc.includes("'打开 DSHL 控制台（更换端口）'"), '不该再承诺打开控制台：说明页没有这条权限，按钮也不做这件事')
  assert.match(loadingSrc, /suggest \?[^\n]*: '重新检测端口并重试'/, '有建议端口 → 换端口启动；没有 → 重新检测端口并重试')
  assert.match(loadingSrc, /if \(reason === 'blocked' && suggest\) window\.browserBridge\.send\('blockSwitch'/, '有建议端口必须走 blockSwitch（真的换端口）')
  assert.match(loadingSrc, /else window\.browserBridge\.send\('fixPane'/, '没有建议端口走 fixPane（重新探测端口 + 重试启动 + 刷新本页）')
})

test('说明页文案表覆盖所有用到的 reason（不许 fallback 成"正在启动"）', () => {
  const keys = textsKeys()
  const missing = [...usedReasons()].filter((r) => !keys.has(r)).sort()
  assert.deepEqual(missing, [], '缺少说明页文案：' + missing.join(', '))
})

test('进行中状态延迟放出兜底按钮；需要用户介入的状态立刻显示', () => {
  const busySrc = loadingSrc.slice(loadingSrc.indexOf('const BUSY_REVEAL_MS'), loadingSrc.indexOf('const revealMs'))
  const busy = new Set([...busySrc.matchAll(/([A-Za-z][A-Za-z0-9]*): \d+/g)].map((m) => m[1]))
  const keys = textsKeys()
  for (const r of busy) assert.ok(keys.has(r), 'BUSY_REVEAL_MS 里的 ' + r + ' 不在文案表里')
  for (const r of ['start', 'restart', 'restartManual', 'update', 'plugin', 'recovery']) {
    assert.ok(busy.has(r), r + ' 属于"进行中"，兜底按钮应当延迟出现')
  }
  for (const r of ['offline', 'blocked', 'failed', 'auth']) {
    assert.ok(!busy.has(r), r + ' 需要用户介入，按钮必须立刻可见')
  }
})

// 等待预期必须报实测口径：同一份 lifecycle.jsonl 里，9 月 spawn→端口就绪中位 4~5s，
// 11 月已经涨到中位 16.0s、p90 23.7s（插件从 ~60 条长到 155 条，模块图变大是主因：
// CPU profile 里 75% 的采样停在 ESM 解析/编译上）。旧文案的「8~15 秒」比实测中位还快一倍，
// 用户按 15 秒预期等 20 秒就会以为卡住了。重启页（restartManual）覆盖"停旧服务 → 新进程就绪"，
// 与冷启动是同一段耗时，两处报同一个口径。
test('等待文案报实测口径（冷启动与重启都是 10~25 秒），静态首帧、脚本与 wwwroot 三处同源', () => {
  const html = fs.readFileSync(path.join(root, 'ui-src', 'loading.html'), 'utf8')
  const builtJs = fs.readFileSync(path.join(root, 'wwwroot', 'loading.js'), 'utf8')
  const builtHtml = fs.readFileSync(path.join(root, 'wwwroot', 'loading.html'), 'utf8')

  assert.match(loadingSrc, /start: \{[\s\S]*?sub: '[^']*10~25 秒/, 'start（冷启动）应报 10~25 秒')
  assert.match(loadingSrc, /restartManual: \{[\s\S]*?sub: '[^']*10~25 秒/, 'restartManual（重启）应报 10~25 秒')
  assert.ok(html.includes('10~25 秒'), 'ui-src/loading.html 的静态首帧应报 10~25 秒（脚本执行前就显示这句）')
  // 旧口径必须三处一起退场：漏一处就是"同一件事在不同时刻说成两样"
  for (const [name, src] of [['ui-src/loading.js', loadingSrc], ['ui-src/loading.html', html], ['wwwroot/loading.js', builtJs], ['wwwroot/loading.html', builtHtml]]) {
    for (const stale of ['3~15 秒', '8~15 秒', '7~10 秒']) assert.ok(!src.includes(stale), name + ' 不该再留旧口径 ' + stale)
  }
  // wwwroot 是构建产物：没同步就是线上还显示旧文案
  assert.ok(builtJs.includes('10~25 秒'), 'wwwroot/loading.js 未同步：请执行 npm run build:assets')
  assert.ok(builtHtml.includes('id="sub2"'), 'wwwroot/loading.html 未同步：请执行 npm run build:assets')

  // 重启页的两行结构：第二行独立成段（不在"进入。"中间折行），已等待秒数跟在最后一行
  assert.ok(html.includes('id="sub2"'), 'ui-src/loading.html 要有第二行容器 #sub2')
  assert.match(loadingSrc, /sub2: '就绪后窗口会自动刷新进入。'/, '重启页第二行应放在 sub2 字段里')
  assert.match(loadingSrc, /renderSub\('（已等待 ' \+ sec \+ ' 秒）'\)/, '已等待秒数要跟在最后一行（走 renderSub）')
})

// 2026-11-26 实测：DSH 0.2.3 的匿名首页是「Connect to this Host / 连接到此 Host + 配对此设备」
// 的完整 HTML 文档，正文远超 300 字，也不含旧版裸 401 的 'authentication required'/'unauthorized'。
// 按内文识别因此 100% 漏判 —— 页面就停在 Host 登录页，用户只能自己去点「申请配对」。
// 判据改成会话 cookie 的真实认证状态：401 才算凭据页，200 才算页面真的能用。
test('凭据页判据走会话 cookie 探针（不再读页面正文）；自管服务未就绪时先显示 authWait', () => {
  assert.match(mainSrc, /async function sessionNeedsAuth\(ses\)/, '要有会话级探针')
  assert.match(mainSrc, /const res = await ses\.fetch\(WEB_URL, \{ method: 'GET', cache: 'no-store' \}\)/,
    '探针必须用窗口会话（自带 cookie）请求首页')
  assert.match(mainSrc, /if \(res\.status === 401\) return true/, '只有 401 才算凭据页')
  assert.match(mainSrc, /return res\.ok \? false : null/, '非 401 的异常状态返回 null，不据此改状态')
  assert.match(mainSrc, /void sessionNeedsAuth\(wc\.session\)/, 'did-finish-load 必须用探针判定')
  const authBlock = mainSrc.slice(mainSrc.indexOf('void sessionNeedsAuth'), mainSrc.indexOf('// 失败页兜底'))
  assert.ok(authBlock.length > 200, '要能切到 did-finish-load 的鉴权兜底块')
  assert.ok(!authBlock.includes('executeJavaScript'), '鉴权兜底不再读页面正文（新登录页正文对旧判据完全不可见）')
  assert.ok(!authBlock.includes('innerText'), '鉴权兜底不再读 innerText')
  assert.match(mainSrc, /loadingUrl\('authWait'/, '自管服务未拿到 token 时先显示登录验证页')
  assert.ok(textsKeys().has('authWait'), 'authWait 必须有文案，不能 fallback 成“正在启动”')
  assert.match(loadingSrc, /authWait: \{[\s\S]*?正在完成登录验证/)
})
