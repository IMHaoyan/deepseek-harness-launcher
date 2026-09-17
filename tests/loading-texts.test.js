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

// 等待预期必须报实测口径：DSH 冷启动 spawn→端口就绪实测 7.6~12s（lifecycle.jsonl 200 次样本中位 7.8s），
// 旧文案的「3~15 秒」下界比实测最快还快一倍，用户按 3 秒预期等 10 秒就会以为卡住了。
// 重启页（restartManual）只覆盖"停旧服务 → 新进程就绪"这一段，实测近期 12 次 3.1~3.7s，所以口径比冷启动短。
test('等待文案报实测口径（冷启动 8~15 秒 / 重启 4~8 秒），静态首帧、脚本与 wwwroot 三处同源', () => {
  const html = fs.readFileSync(path.join(root, 'ui-src', 'loading.html'), 'utf8')
  const builtJs = fs.readFileSync(path.join(root, 'wwwroot', 'loading.js'), 'utf8')
  const builtHtml = fs.readFileSync(path.join(root, 'wwwroot', 'loading.html'), 'utf8')

  assert.match(loadingSrc, /start: \{[\s\S]*?sub: '[^']*8~15 秒/, 'start（冷启动）应报 8~15 秒')
  assert.match(loadingSrc, /restartManual: \{[\s\S]*?sub: '[^']*4~8 秒/, 'restartManual（重启）应报 4~8 秒')
  assert.ok(html.includes('8~15 秒'), 'ui-src/loading.html 的静态首帧应报 8~15 秒（脚本执行前就显示这句）')
  // 旧口径必须三处一起退场：漏一处就是"同一件事在不同时刻说成两样"
  for (const [name, src] of [['ui-src/loading.js', loadingSrc], ['ui-src/loading.html', html], ['wwwroot/loading.js', builtJs], ['wwwroot/loading.html', builtHtml]]) {
    assert.ok(!src.includes('3~15 秒'), name + ' 不该再留旧口径 3~15 秒')
  }
  // wwwroot 是构建产物：没同步就是线上还显示旧文案
  assert.ok(builtJs.includes('4~8 秒'), 'wwwroot/loading.js 未同步：请执行 npm run build:assets')
  assert.ok(builtHtml.includes('id="sub2"'), 'wwwroot/loading.html 未同步：请执行 npm run build:assets')

  // 重启页的两行结构：第二行独立成段（不在"进入。"中间折行），已等待秒数跟在最后一行
  assert.ok(html.includes('id="sub2"'), 'ui-src/loading.html 要有第二行容器 #sub2')
  assert.match(loadingSrc, /sub2: '就绪后窗口会自动刷新进入。'/, '重启页第二行应放在 sub2 字段里')
  assert.match(loadingSrc, /renderSub\('（已等待 ' \+ sec \+ ' 秒）'\)/, '已等待秒数要跟在最后一行（走 renderSub）')
})
