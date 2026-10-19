// tests/recovery-wiring.test.js — 启动失败恢复界面的接线护栏（node --test）
//
// 对应的是一次真实缺口：boot-failure.js 早就在分类失败（kind/target），但那份结果只喂了通知里
// 的一句 reason 与"要不要提前停重试"的判定 —— 用户面对的状态页永远只有一个「启动服务」按钮，
// 对一个插件树挂掉的服务，点下去必然还是同样的失败。
//
// 这些断言防的是**改回去**，逐条对应一个会导致"说的和做的不一样"的退化：
//   ① 分类结果不进 state → 控制台永远看不到是哪个包坏了；
//   ② 新 reason 没接进 reasonForPhase → 新文案表成了死代码；
//   ③ plan 没随 URL 下发 → 页面拿不到动作，退回写死的「启动服务」；
//   ④ 按钮不走 repairBoot → 文案承诺"禁用 X"，实际做的却是重载本页（本仓库踩过这个坑）；
//   ⑤ 确认框默认焦点不在「取消」→ 回车就把用户的 profile 改了；
//   ⑥ 凭据不是一次性 / 不绑定失败签名 → 陈旧页面可以对已经变化的目标动手；
//   ⑦ 写后不回读 → 命令退出码 0 但状态没变，界面照样报成功；
//   ⑧ recovery-plan.js 没进打包清单 → 打包后 require 失败（只有装机版才会暴露）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const main = read('main.js')
const trust = read('trust.js')
const loading = read('ui-src/loading.js')
const builtLoading = read('wwwroot/loading.js')
const app = read('ui-src/app.js')
const planSrc = read('recovery-plan.js')
const inventory = read('plugin-inventory.js')
const pkg = JSON.parse(read('package.json'))

/** 取 main.js 里一个函数的函数体（到下一个行首 `}` 为止，够用且不依赖解析器）。 */
function body(fnName) {
  const at = main.indexOf(`function ${fnName}(`)
  assert.ok(at >= 0, `main.js 里找不到 function ${fnName}(`)
  const rest = main.slice(at)
  const end = rest.indexOf('\n}')
  return rest.slice(0, end)
}

// ---------- ① 分类结果必须到得了界面 ----------
test('stateJson 下发完整分类（kind/target/reason/count），而不只是 kind', () => {
  assert.match(main, /function bootFailureState\(\)/, '必须有取分类结果的单一入口')
  const state = body('stateJson')
  assert.match(state, /bootFailure: bootFailureState\(\)/, 'state 必须带 bootFailure')
  const bf = body('bootFailureState')
  for (const key of ['kind', 'target', 'reason', 'line', 'count']) {
    assert.ok(bf.includes(key + ':'), `bootFailure 缺字段 ${key}（target 是"该修哪个插件"的唯一依据）`)
  }
  // 多插件失败：targets 是"还有谁坏了"的唯一来源，界面靠它说明"别以为修完这一个就好了"
  assert.match(bf, /targets: Array\.isArray\(info\.targets\) \? info\.targets\.slice\(0, 8\)\.map\(String\) : \[\]/,
    'targets 必须透传且有上限（兜底分类对象没有这个字段，必须容错）')
  // stateJson 会被 broadcastState 高频调用 → 这里不能做 IO
  assert.ok(!/recoveryCapabilities\(\)/.test(state), 'stateJson 里不许现算能力面（那是文件 IO，会拖垮状态推送）')
  // 控制台恢复页要消费它（否则又是"下发了没人用"的死数据）
  assert.match(app, /state\.bootFailure/, '控制台恢复页应消费 bootFailure')
})

// ---------- ② 新 reason 必须真的被用上 ----------
test('reasonForPhase 按恢复判定返回新 reason，且判在通用 failed/offline 之前', () => {
  const r = body('reasonForPhase')
  for (const [scenario, reason] of [['plugin', 'pluginFailed'], ['settings', 'settingsInvalid'], ['env', 'envMissing'], ['unknown', 'bootUnknown']]) {
    assert.match(r, new RegExp(`scenario === '${scenario}'\\) return '${reason}'`), `${scenario} → ${reason} 的映射不见了`)
  }
  // 顺序：分类判定必须在 failed/offline 之前，否则永远走不到
  assert.ok(r.indexOf("return 'pluginFailed'") < r.indexOf("return 'failed'"), '分类必须判在通用 failed 之前')
  assert.ok(r.indexOf("return 'pluginFailed'") < r.indexOf("return 'offline'"), '分类必须判在通用 offline 之前')
  // 端口/凭据两类仍享有最高优先级（单一来源，不许被分类抢走）
  assert.ok(r.indexOf("return 'blocked'") < r.indexOf("return 'pluginFailed'"))
  assert.ok(r.indexOf("return 'auth'") < r.indexOf("return 'pluginFailed'"))
})

test('说明页文案表覆盖新 reason（否则 fallback 成"正在启动…"，与真实动作不符）', () => {
  const bodySrc = loading.slice(loading.indexOf('const TEXTS = {'), loading.indexOf('const triedAuth'))
  const keys = new Set([...bodySrc.matchAll(/^  ([A-Za-z][A-Za-z0-9]*): \{$/gm)].map((m) => m[1]))
  for (const r of ['pluginFailed', 'settingsInvalid', 'envMissing', 'bootUnknown']) {
    assert.ok(keys.has(r), `说明页缺少 ${r} 的文案`)
  }
  // 需要用户介入的状态必须立刻给按钮，不能等 15 秒
  const busy = loading.slice(loading.indexOf('const BUSY_REVEAL_MS'), loading.indexOf('const revealMs'))
  for (const r of ['pluginFailed', 'settingsInvalid', 'envMissing', 'bootUnknown']) {
    assert.ok(!busy.includes(r + ':'), `${r} 需要用户介入，不该进 BUSY_REVEAL_MS`)
  }
})

// ---------- ③ plan 必须随 URL 一起下发 ----------
test('plan 随说明页 URL 下发，且长度有上限（detail 里可能是整行插件树报错）', () => {
  assert.match(main, /function loadingParams\(\)[\s\S]{0,400}?recoveryPlanNow\(\)/, 'loadingParams 必须把判定结果带上')
  assert.match(main, /if \(extra && extra\.plan && extra\.plan\.reason\) q \+= '&plan='/, 'loadingUrl 必须序列化 plan')
  assert.match(main, /JSON\.stringify\(extra\.plan\)\.slice\(0, 1500\)/, 'plan 必须有长度上限')
})

// ---------- ④ 按钮文案 = 真实动作 ----------
test('有判定结果时，说明页主按钮发的是 repairBoot + 那个动作本身，不回落到 fixPane', () => {
  const at = loading.indexOf("document.getElementById('btnReload').addEventListener")
  assert.ok(at >= 0, '找不到主按钮的监听')
  const handler = loading.slice(at, loading.indexOf('btnAlt.addEventListener'))
  assert.match(handler, /if \(planAction\)/, '必须先判有没有主进程给的判定')
  assert.match(handler, /send\('repairBoot', \{ action: planAction \}\)/, '按钮必须发它承诺的那个动作')
  // 关键顺序：planAction 分支必须 return，不许掉进下面的 fixPane 兜底
  const planBranch = handler.slice(handler.indexOf('if (planAction)'), handler.indexOf("if (reason === 'blocked'"))
  assert.match(planBranch, /return/, 'planAction 分支必须提前返回，否则会同时发两个命令')
  assert.ok(handler.indexOf('if (planAction)') < handler.indexOf("send('fixPane'"), 'repairBoot 必须判在 fixPane 之前')
  // 文案来自主进程的同一个对象，页面不自己编
  assert.match(loading, /btnEl\.textContent = planLabel \|\| t\.btn/, '按钮文案必须优先用 plan 给的 label')
})

test('构建产物与源同步（wwwroot 是打包真正读的那份）', () => {
  assert.match(builtLoading, /send\('repairBoot'/, 'wwwroot/loading.js 未同步：请执行 npm run build:assets')
  assert.match(builtLoading, /pluginFailed:/, 'wwwroot/loading.js 未同步：请执行 npm run build:assets')
})

test('只有"确实是恢复界面"的那几个 reason 才采纳 plan（进行中的页面不能被上一次失败顶掉文案）', () => {
  // 主进程的 loadingParams() 对 plugin / recovery / update 这些"进行中"的页面也会附带 plan
  // （lastBootFailureInfo 还留着上一次的失败）。不加这道闸，"正在应用插件变更…"会被渲染成
  // 上一次失败的标题——正是"文案与真实动作不符"。
  assert.match(loading, /const PLAN_REASONS = new Set\(\['pluginFailed', 'settingsInvalid', 'envMissing', 'bootUnknown'\]\)/,
    '必须显式列出采纳 plan 的 reason')
  assert.match(loading, /if \(PLAN_REASONS\.has\(reason\)\) \{[\s\S]{0,200}?JSON\.parse\(raw\)/,
    'plan 的解析必须在 reason 闸之内')
  const at = loading.indexOf('if (PLAN_REASONS.has(reason))')
  const guard = loading.slice(at, loading.indexOf('const planAction'))
  assert.match(guard, /plan = JSON\.parse\(raw\)/, 'plan 只能在闸内赋值')
  // 集合本身恰好是这四个：多一个就是把"进行中"的页面也交出去了
  const setLine = loading.slice(loading.indexOf('const PLAN_REASONS'), loading.indexOf('\n', loading.indexOf('const PLAN_REASONS')))
  const listed = [...setLine.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(listed, ['bootUnknown', 'envMissing', 'pluginFailed', 'settingsInvalid'])
})

// ---------- ⑤ 确认框 fail-closed ----------
test('恢复动作的原生确认框：默认焦点与 Esc 都落在「取消」，回车不执行任何写操作', () => {
  const c = body('confirmBootRepair')
  assert.match(c, /defaultId: 1/, '默认按钮必须是「取消」（index 1）')
  assert.match(c, /cancelId: 1/, 'Esc 必须等价于「取消」')
  assert.match(c, /noLink: true/, '不许出现"不再询问"这类勾选')
  assert.match(c, /catch[\s\S]{0,200}?return false/, '弹不出确认框就不得执行（fail-closed）')
  // 语气跟着可逆性走：只有不可逆的卸载用 warning
  const spec = body('repairConfirmSpec')
  assert.match(spec, /action === 'uninstall-plugin'[\s\S]{0,300}?type: 'warning'/, '卸载是不可逆动作，语气应为 warning')
  assert.match(spec, /action === 'disable-plugin'[\s\S]{0,300}?type: 'question'/, '禁用是可逆动作，语气应为 question 而不是警告')
})

// ---------- ⑥ 凭据一次性 + 绑定世界状态 ----------
test('凭据先核销再校验，且绑定世界状态指纹（陈旧页面不能对已变化的目标动手）', () => {
  const e = body('executeRepair')
  const del = e.indexOf('repairPreviews.delete(previewId)')
  const get = e.indexOf('repairPreviews.get(previewId)')
  assert.ok(get >= 0 && del > get, '必须先取再删')
  const afterDelete = e.slice(del)
  assert.match(afterDelete, /if \(!preview\)/, '删掉之后才判空 —— 顺序反了就不是一次性')
  assert.match(e, /preview\.expiresAt <= Date\.now\(\)/, '必须校验 TTL')
  assert.match(e, /preview\.binding !== bindingFor\(preview\.action, preview\.slotId, preview\.targets\)/,
    '必须用**现算**的绑定值比对（且两侧走同一个函数，否则口径会漂）')
  const p = body('previewBootRepair')
  assert.match(p, /if \(!plan\.primary \|\| plan\.primary\.id !== actionId\)/, '签发凭据前必须确认这个动作此刻仍然成立')
  assert.match(p, /stale: true/, '状态已变化要明确告诉界面刷新，而不是静默失败')
  assert.match(main, /REPAIR_PREVIEW_TTL_MS = 5 \* 60 \* 1000/, '凭据要有明确 TTL')
})

test('回退类凭据绑槽的 snapshotId（槽被重新捕获过就作废），插件类绑失败签名', () => {
  const b = body('restoreBinding')
  assert.match(b, /health\.listSlots\(\)\.find\(\(s\) => s\.slotId === slotId && s\.valid\)/,
    '绑定必须**绕过缓存**直接读 health.listSlots()：用 5 秒缓存会让两次比较落在同一份陈旧快照上')
  assert.ok(!/recoveryCheckpoints\(\)/.test(b), '绑定不许走带缓存的列表（那样等于没校验）')
  assert.match(b, /slot\.slotId \+ ':' \+ \(\(slot\.meta && slot\.meta\.snapshotId\) \|\| ''\)/, '绑定值必须含 snapshotId')
  assert.match(b, /if \(!slot\) return ''/, '槽没了要返回空串 → 与存档值必不等 → 判 stale')
  assert.match(b, /catch \(e\) \{\s*\n\s*log\(/, '读失败要降级成空串并记日志，不能抛给调用方')
  // snapshotId 必须真的从 health 的 meta 里取出来，否则绑的是一个不存在的字段
  assert.match(main, /snapshotId: s\.meta \? String\(s\.meta\.snapshotId \|\| ''\) : ''/, 'recoveryCheckpoints 必须透出 snapshotId')
  const f = body('bindingFor')
  assert.match(f, /actionId === 'restore-checkpoint'[\s\S]{0,80}?'restore:' \+ restoreBinding\(slotId\)/, '回退走 snapshot 绑定')
  assert.match(f, /'failure:' \+ failureBinding\(\)/, '其余走失败签名绑定')
  // 插件动作还要把**整批包名**绑进去：按钮上写着"禁用这 3 个"，预览到执行之间清单变了就得作废。
  // 只绑失败签名不够 —— 同一种失败换个批次规模，签名可以不变而作用域已经不同。
  assert.match(f, /Array\.isArray\(targets\)[\s\S]{0,80}?\.sort\(\)\.join\(','\)/, '批次要排序后进绑定（顺序不该影响指纹）')
  assert.match(f, /'\|batch:' \+ batch/, '绑定值里要带批次')
})

// ---------- ⑥b 两条入口共用一条执行路径 ----------
test('控制台的回退也走两阶段：previewHealthRestore 签发，healthRestore 只认凭据', () => {
  assert.match(main, /case 'previewHealthRestore': return JSON\.stringify\(previewConsoleRestore\(/, '缺少签发命令')
  assert.match(main, /case 'healthRestore': return JSON\.stringify\(await executeRepair\(String\(\(value && value\.previewId\) \|\| ''\)\)\)/,
    'healthRestore 必须只接受 previewId —— 还认 slotId 就等于两阶段白做')
  const pc = body('previewConsoleRestore')
  assert.match(pc, /if \(!slot\.valid\)/, '签发前必须自己确认槽可用，不靠页面传')
  assert.match(pc, /mintRepairPreview\('restore-checkpoint', \[\], want\)/, '控制台路径也要走同一个签发函数')
  // 确认文案的事实来自签发瞬间的权威记录
  assert.match(pc, /capturedAt: slot\.capturedAt/, '要把捕获时间交给页面（否则确认框只能写一句空话）')
  assert.match(pc, /dshVersion: slot\.dshVersion/, '要把 DSH 版本交给页面')
  // 页面侧：先签发再确认再核销，且确认文案用的是签发返回的事实
  assert.match(app, /cmd\('previewHealthRestore', \{ slotId: s\.slotId \}\)/, '控制台必须先签发凭据')
  assert.match(app, /cmd\('healthRestore', \{ previewId: p\.previewId \}\)/, '确认后才用凭据核销')
  assert.ok(app.indexOf("cmd('previewHealthRestore'") < app.indexOf("cmd('healthRestore'"), '顺序不能反')
  assert.match(app, /p\.capturedAt/, '确认文案要用签发返回的捕获时间')
})

test('回退结果原样透传（备份文件名是唯一可复核的线索，不能压成一句话）', () => {
  const e = body('executeRepair')
  assert.match(e, /Object\.assign\(\{\}, r, \{ message: '已回退到检查点 '/, 'restoreCheckpoint 的结果要透传')
  assert.match(app, /r\.backupFile/, '控制台回执要显示备份文件名')
})

test('"在不在"与"变没变"分开判：绑定放行不等于槽还在', () => {
  // 反例：槽在签发时就已经没了 → 两次现算绑定都是 ''，相等 → 绑定那一关反而放行。
  const e = body('executeRepair')
  const restoreAt = e.indexOf("preview.action === 'restore-checkpoint'")
  const branch = e.slice(restoreAt, restoreAt + 500)
  assert.match(branch, /const stillThere = restoreBinding\(preview\.slotId\) !== ''/, '执行前必须显式确认槽还在')
  assert.match(branch, /if \(!stillThere\) return \{ ok: false, error: '该检查点已不可用[^']*', stale: true \}/, '槽不在要判 stale')
  assert.ok(branch.indexOf('stillThere') < branch.indexOf('restoreCheckpoint(preview.slotId)'), '存在性检查必须在真正写入之前')
})

// ---------- ⑦ 写后回读（行为，不只是源码字面量） ----------
/**
 * 把 main.js 里 executeRepair 的**真实源码**装进一个带桩的作用域里跑。
 * 为什么值得这么干：整批执行的行为（几个都写了、重启几次、部分失败怎么报）断言源码字面量证明不了 ——
 * 源码写得再漂亮，循环写错一行照样只处理一个。这里让它真的跑一遍。
 */
function reproWorld(targets, opts) {
  const o = opts || {}
  const disabled = new Set()
  const calls = { restarts: 0, writes: [], uninstalls: [] }
  const preview = {
    id: 'p1',
    action: o.action || 'disable-plugin',
    target: targets[0] || '',
    targets,
    slotId: '',
    binding: 'B',
    expiresAt: Date.now() + 60000,
  }
  const names = ['repairPreviews', 'bindingFor', 'pluginSwitch', 'market', 'lifecycle',
    'applyPluginChange', 'restoreBinding', 'restoreCheckpoint', 'startForConsole', 'log']
  const values = [
    { get: () => preview, delete: () => {} },
    () => 'B',
    {
      canToggle: (n) => (o.notToggleable || []).indexOf(n) < 0,
      setEnabled: (n) => { calls.writes.push(n); disabled.add(n); return { ok: true } },
      // readBackFails 里的包"写进去了但回读说没生效" —— 用来测部分失败怎么报
      isDisabled: (n) => (o.readBackFails || []).indexOf(n) < 0 && disabled.has(n),
      // 卸载路径要先记录这个包占用了哪些补丁行，卸载成功后按记录清理
      rowIdsForPackage: () => [],
      carrierDisableIds: () => [],
      removeRows: () => {},
    },
    {
      getState: () => ({ installed: true }),
      PROFILE_NAME: 'web',
      uninstallByName: async (n) => { calls.uninstalls.push(n); return o.uninstallFails && o.uninstallFails.indexOf(n) >= 0 ? { ok: false, error: 'x' } : { ok: true } },
    },
    { emit: () => {} },
    async () => { calls.restarts += 1; return true },
    () => '',
    async () => ({ ok: true }),
    async () => true,
    () => {},
  ]
  // ★ body() 从 `function` 开始切，会把前面的 `async ` 丢掉 —— 这里要真跑，必须补回来
  const src = 'async ' + body('executeRepair')
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, src + '\n}\nreturn executeRepair;')(...values)
  return { run: () => fn('p1'), calls, disabled, preview }
}

test('整批真的全写了，而且只重启一次（N 次重启正是被修掉的东西）', async () => {
  const w = reproWorld(['a-plugin', 'b-plugin', 'c-plugin'])
  const r = await w.run()
  assert.equal(r.ok, true, r.error)
  assert.deepEqual(w.calls.writes, ['a-plugin', 'b-plugin', 'c-plugin'], '三个都要写')
  assert.deepEqual([...w.disabled].sort(), ['a-plugin', 'b-plugin', 'c-plugin'])
  assert.equal(w.calls.restarts, 1, '整批只重启一次')
  assert.ok(!r.partial, '全部成功不该标 partial')
  assert.match(r.message, /已禁用 3 个插件（a-plugin、b-plugin、c-plugin）/, r.message)
  assert.match(r.message, /服务已重启/, r.message)
})

test('回读失败的包不算成功：报 partial 并点名，绝不报"已完成"', async () => {
  const w = reproWorld(['a-plugin', 'b-plugin', 'c-plugin'], { readBackFails: ['b-plugin'] })
  const r = await w.run()
  assert.equal(r.ok, true, '有成功的就仍然算执行成功')
  assert.equal(r.partial, true, '部分成功必须显式标记')
  assert.match(r.message, /b-plugin/, '没成功的要点名：' + r.message)
  assert.match(r.message, /没能禁用/, r.message)
  assert.equal(w.calls.restarts, 1, '部分失败也仍然只重启一次')
})

test('一个都没写成 → 不重启、不报成功', async () => {
  const w = reproWorld(['a-plugin'], { readBackFails: ['a-plugin'] })
  const r = await w.run()
  assert.equal(r.ok, false)
  assert.match(r.error, /都没能禁用成功/, r.error)
  assert.equal(w.calls.restarts, 0, '什么都没改就不该重启服务')
})

test('不可停用的包被跳过并算失败，不是静默丢弃', async () => {
  const w = reproWorld(['a-plugin', 'b-plugin'], { notToggleable: ['b-plugin'] })
  const r = await w.run()
  assert.deepEqual(w.calls.writes, ['a-plugin'], '禁不了的不能硬写')
  assert.equal(r.partial, true)
  assert.match(r.message, /b-plugin/, r.message)
})

test('卸载整批同理：逐个走官方命令，最后只重启一次', async () => {
  const w = reproWorld(['x-plugin', 'y-plugin'], { action: 'uninstall-plugin' })
  const r = await w.run()
  assert.deepEqual(w.calls.uninstalls, ['x-plugin', 'y-plugin'])
  assert.equal(w.calls.restarts, 1)
  assert.match(r.message, /已卸载 2 个插件/, r.message)
})

test('批次变了凭据就作废：绑定值现算，和签发时不一致直接 stale', async () => {
  // 按钮上写着"这 3 个"，预览到执行之间失败清单变成 2 个 —— 这条必须拦住。
  const w = reproWorld(['a-plugin'])
  w.preview.binding = 'B|batch:a-plugin,b-plugin,c-plugin'
  const r = await w.run()
  assert.equal(r.ok, false)
  assert.equal(r.stale, true, '要判 stale 让界面刷新，而不是照着旧批次动手')
  assert.equal(w.calls.writes.length, 0, 'stale 时一个字节都不许写')
})

test('插件写操作整批执行、逐个回读账本，且最后只重启一次', () => {
  const e = body('executeRepair')
  const at = e.indexOf("preview.action === 'disable-plugin'")
  const branch = e.slice(at, e.indexOf("preview.action === 'uninstall-plugin'"))
  assert.match(branch, /const batch = \(preview\.targets \|\| \[\]\)\.filter\(Boolean\)/, '作用域来自凭据里的整批')
  assert.match(branch, /for \(const name of batch\)/, '要逐个处理')
  assert.match(branch, /setEnabled\(name, false\)[\s\S]{0,200}?isDisabled\(name\)/,
    '每个都要回读 isDisabled：写入成功不等于状态变了')
  assert.match(branch, /failed\.push\(name\)/, '没落实的要落进 failed，不能静默跳过')
  assert.match(branch, /partial: failed\.length > 0/, '部分成功要显式标记，绝不报成整体成功')
  assert.match(branch, /没能禁用，请在控制台「插件」页手动处理/, '要如实说清哪几个没成功')
  const afterLoop = branch.slice(branch.indexOf('if (!done.length)'))
  assert.match(afterLoop, /applyPluginChange\('toggle'/, '重启要在整批写完之后')
  assert.equal((branch.match(/applyPluginChange\(/g) || []).length, 1, '整批只重启一次 —— N 次重启正是被修掉的东西')
  const uat = e.indexOf("preview.action === 'uninstall-plugin'")
  const ubranch = e.slice(uat, e.indexOf("preview.action === 'restore-checkpoint'"))
  assert.match(ubranch, /market\.uninstallByName\(name\)/, '卸载必须走官方 dsh plugin 命令（不自己改 profile）')
  assert.equal((ubranch.match(/applyPluginChange\(/g) || []).length, 1, '卸载整批也只重启一次')
  assert.match(e, /restarted[\s\S]{0,200}?服务仍未起来/, '重启失败必须如实说，不能报"已完成"')
})
// ★ 2026-10：作用域从"一个包"扩成"整批"（用户问"为什么不一次禁用全部失败的"）。
//   回读这条不变量不变，但现在必须**逐个**校验：整批里任何一个没落实都要算失败，
//   而且最后**只重启一次** —— 那正是这次改动的全部意义。
test('插件写操作整批执行、逐个回读账本，且最后只重启一次', () => {
  const e = body('executeRepair')
  const at = e.indexOf("preview.action === 'disable-plugin'")
  const branch = e.slice(at, e.indexOf("preview.action === 'uninstall-plugin'"))
  assert.match(branch, /const batch = \(preview\.targets \|\| \[\]\)\.filter\(Boolean\)/, '作用域来自凭据里的整批')
  assert.match(branch, /for \(const name of batch\)/, '要逐个处理')
  assert.match(branch, /setEnabled\(name, false\)[\s\S]{0,200}?isDisabled\(name\)/,
    '每个都要回读 isDisabled：写入成功不等于状态变了')
  assert.match(branch, /failed\.push\(name\)/, '没落实的要落进 failed，不能静默跳过')
  assert.match(branch, /partial: failed\.length > 0/, '部分成功要显式标记，绝不报成整体成功')
  assert.match(branch, /没能禁用，请在控制台「插件」页手动处理/, '要如实说清哪几个没成功')
  // 一次重启：applyPluginChange 在整批循环**之外**，且分支里只出现一次
  const afterLoop = branch.slice(branch.indexOf('if (!done.length)'))
  assert.match(afterLoop, /applyPluginChange\('toggle'/, '重启要在整批写完之后')
  assert.equal((branch.match(/applyPluginChange\(/g) || []).length, 1, '整批只重启一次 —— N 次重启正是被修掉的东西')
  // 卸载同理
  const uat = e.indexOf("preview.action === 'uninstall-plugin'")
  const ubranch = e.slice(uat, e.indexOf("preview.action === 'restore-checkpoint'"))
  assert.match(ubranch, /market\.uninstallByName\(name\)/, '卸载必须走官方 dsh plugin 命令（不自己改 profile）')
  assert.equal((ubranch.match(/applyPluginChange\(/g) || []).length, 1, '卸载整批也只重启一次')
  assert.match(e, /restarted[\s\S]{0,200}?服务仍未起来/, '重启失败必须如实说，不能报"已完成"')
})

// ---------- ⑧ 能力面 fail-closed ----------
test('能力面只从权威账本取证，且 fail-closed（查不到就不给按钮）', () => {
  const c = body('recoveryCapabilities')
  assert.match(c, /pluginSwitch\.canToggle\(name\)/, '可禁用性必须问 plugin-switch 的补丁层账本')
  assert.match(c, /market\.getState\(name\)[\s\S]{0,40}?installed/, '可卸载性必须问 profile 清单')
  assert.match(c, /for \(const name of probes\)/, '每个被点名的包都要单独取证（作用域是整批）')
  assert.match(c, /pluginTargetsOf\(failure, target\)/, '批次来自权威分类结果，不是页面传进来的')
  assert.match(c, /cap\.pluginListCapped = probes\.length >= bootFailure\.MAX_TARGETS/,
    '打到解析上限要如实标记（界面据此打"可能还有下一批"的预防针）')
  assert.match(c, /recoveryCheckpoints\(\)\.find\(\(s\) => s\.valid\)/, '检查点只认 valid 槽位')
  // 取证失败不能抛出（否则整个状态页起不来）
  assert.match(c, /catch \(e\) \{ log\(/, '取证失败只能记日志并降级')
})

// ---------- ⑨ 信任边界与打包清单 ----------
test('新增命令只扩到说明页，且必须是被信任的发送方', () => {
  assert.match(main, /case 'browser:repairBoot':/, '主进程必须实现 browser:repairBoot')
  assert.match(trust, /'browser:repairBoot'/)
  // 说明页只能发 id，不许出现能指定路径/包名的参数面
  const handler = main.slice(main.indexOf("case 'browser:repairBoot':"))
  assert.match(handler.slice(0, 400), /runBootRepair\(String\(\(value && value\.action\) \|\| ''\)\)/,
    '只接受一个 action id，目标由主进程现算')
})

// ---------- ⑪「管理插件」导航入口 ----------
test('导航入口只认白名单页面 key，主进程自己映射成控制台页面', () => {
  assert.match(trust, /'browser:openConsole'/, '说明页白名单要有这条')
  const at = main.indexOf("case 'browser:openConsole':")
  assert.ok(at > 0, '主进程必须实现 browser:openConsole')
  const branch = main.slice(at, at + 500)
  assert.match(branch, /if \(!recoveryPlan\.CONSOLE_PAGES\.includes\(page\)\) return JSON\.stringify\(\{ ok: false/,
    '页面 key 必须过白名单：说明页不许指定任意页面')
  assert.match(branch, /showConsolePage\(page\)/, '映射到控制台页面')
  assert.ok(!/showConsolePage\((value|String\(value)/.test(branch), '不许把页面传来的原值直接当页面名用')
  assert.match(planSrc, /const CONSOLE_PAGES = Object\.freeze\(\['plugins'\]\)/, '白名单本身在 recovery-plan.js')
})

test('说明页把入口画在次按钮上，且页面自己不知道控制台有哪些页', () => {
  assert.match(loading, /if \(planEntry\) \{[\s\S]{0,200}?btnAlt\.textContent = planEntry\.label/,
    '按钮文案必须来自 plan（页面不自己编）')
  assert.match(loading, /send\('openConsole', \{ page: planEntry\.page \}\)/, '点下去发的是 plan 给的 page')
  // ★ 页面里不许出现具体页面名：否则"白名单"就成了摆设
  assert.ok(!/'plugins'/.test(loading), "loading.js 里不该硬编码 'plugins'（页面不该知道控制台有哪些页）")
  assert.ok(!/showPage|showConsolePage/.test(loading), '页面不该自己决定控制台显示哪一页')
  // 入口优先于「重新检测」：两者共用一个按钮位，状态页只留两个按钮
  const altAt = loading.indexOf('if (planEntry) {')
  const sendAt = loading.indexOf("send('openConsole'")
  assert.ok(altAt > 0 && sendAt > altAt, '入口的渲染与点击分发都要有')
  assert.match(builtLoading, /send\('openConsole'/, 'wwwroot/loading.js 未同步：请执行 npm run build:assets')
})

test('recovery-plan.js 进了打包清单（否则只有装机版会 require 失败）', () => {
  assert.ok(pkg.build.files.includes('recovery-plan.js'), 'package.json build.files 缺少 recovery-plan.js')
})

// ---------- ⑩ 插件页必须覆盖 Profile 的真实内容，而不只是注册表 ----------
// 缺口：能导致启动失败的是 Profile 里**任何**一个包，而卡片来自 MANAGED_NPM_PLUGINS 注册表。
// 手动装的第三方插件以前在界面上不存在 —— 用户看得到失败原因，却找不到能关掉它的地方。
test('插件页把 Profile 里不在注册表里的插件也补成卡片', () => {
  assert.match(main, /const pluginInventory = require\('\.\/plugin-inventory'\)/, '必须引入清单模块')
  const catalog = main.slice(main.indexOf('function buildPluginCatalog('), main.indexOf('function buildPluginCatalog(') + 20000)
  assert.match(catalog, /\.\.\.pluginInventoryCards\(\)/, 'catalog 必须带上清单分组')
  assert.match(main, /targets = pluginCompat\.readProfileTargets\(DSH_PROFILE_DIR\)/,
    '清单来源必须是 readProfileTargets（与升级预判同一份判据，不新造一个）')
})

// 清单卡片的版本曾经直接抄 profile 的依赖 spec：`dsh-image-gen` 写的是 `^0.9.0`，卡片标题就
// 渲染成「dsh-image-gen v^0.9.0」—— 依赖范围是范围，不是版本，这是界面在编一个没发生过的结论。
test('清单卡片的版本走与注册表同一份判据：装的是哪版，不是依赖范围', () => {
  const fn = body('pluginInventoryCards')
  assert.match(fn, /raw\.installedPackageVersion \|\| cleanInstalledVersion\(raw\.version\)/,
    '清单卡片要用 installedPackageVersion 优先 + 从 spec 抠 semver（与注册表卡片同一份判据）')
  assert.doesNotMatch(fn, /stateOf: \(npm\) => market\.getState\(npm\) \|\| \{\}/,
    '不能把 getState 的原始 spec 直接当版本交给渲染层')
})

test('清单卡片有缓存，且失效判据是 profile 文件的 mtime（stateJson 每次推送都要跑它）', () => {
  const fn = body('pluginInventoryCards')
  assert.match(fn, /inventoryCardsCache\.key === key/, '必须有缓存命中分支')
  assert.match(fn, /stamp\(DSH_PROFILE_PACKAGE\)/, '失效判据要看 profile package.json 的 mtime')
  assert.match(fn, /stamp\(DSH_PROFILE_PATCH\)/, '失效判据要看 cordis.patch.yml 的 mtime')
  assert.match(fn, /const stamp = \(file\) => \{ try \{ return fs\.statSync\(file\)\.mtimeMs \} catch \{ return 0 \} \}/,
    '取 mtime 失败要按 0 处理（与升级预判同一套写法）')
  // 真正改了 profile 的路径要显式作废，不能只靠 mtime 的秒级分辨率
  assert.match(main, /invalidatePluginInventory\(\)/, 'applyPluginChange 之后要显式作废缓存')
})

test('清单插件的动作分发：走官方 CLI 卸载，且停用/启用要回读校验', () => {
  const d = body('dispatchManagedPluginAction')
  assert.match(d, /pid\.startsWith\(pluginInventory\.INVENTORY_ID_PREFIX\)/, '分发必须先认前缀')
  assert.match(d, /if \(act === 'enable' \|\| act === 'disable'\)/, '要有启停分支')
  assert.match(d, /market\.uninstallByName\(npm\)/, '卸载必须走官方 dsh plugin 命令')
  assert.match(d, /if \(pluginSwitch\.isDisabled\(npm\) === want\) return \{ ok: false/, '写后必须回读校验')
  assert.match(d, /只支持停用\/启用\/卸载/, '安装/更新要明确拒绝并说明，不能默默返回未知操作')
  const fs = require('node:fs')
  assert.ok(!/'profile:'/.test(main), 'main.js 里不该硬编码 profile: 前缀（改用模块常量）')
})

// ---------- ⑫「未生效」必须有出口 ----------
test('「未生效」证据接到清单卡片上，且与注册表卡片同源', () => {
  const fn = body('pluginInventoryCards')
  assert.match(fn, /activationOf: \(npm\) => \{[\s\S]{0,160}?activationIssueOf\(npm\)/,
    '清单卡片也要走 activationIssueOf（同一个判据，不另造一份）')
  assert.match(fn, /pluginActivation\.describeActivationIssue\(issue\)/, '文案同源')
  assert.match(inventory, /activation: String\(activationOf\(npm\) \|\| ''\)/, '纯函数侧要真的用上这个探针')
})

test('控制台主页把「未生效」收敛成一行（不发系统通知：按需降噪）', () => {
  // 服务起来了 ≠ 插件起来了，而这条既不是启动失败、也没有任何主动提示 —— 必须有个出口。
  const at = app.indexOf("const notActive = (state.plugins || []).filter")
  assert.ok(at > 0, '控制台主页要有这一行')
  const block = app.slice(at, at + 600)
  assert.match(block, /个插件未生效（重启不会改变）/, '文案要说清"重启不会改变"')
  assert.match(block, /可在「插件管理」页查看/, '要给出下一步去哪儿')
  assert.match(block, /notes\.push/, '走既有的提示卡，不新开模块')
  // 与"启动失败/崩溃"分开：它不属于 alert 那一档，不能染红
  const crashAt = app.indexOf('function renderCrashNote')
  const alertAt = app.indexOf("crashEl.classList.toggle('env-warning', alert)")
  assert.ok(alertAt > crashAt && alertAt < at + 600, 'alert 样式只看 severity，不受未生效影响')
})

// ---------- ⑭ 环境不就绪：说明页也必须切到实际状态 ----------
test('环境不就绪的启动路径要刷新说明页（否则背后那页永远显示"正在启动"）', () => {
  // 真机实测（DSHL_FRESH_TEST=1 让环境真的不就绪）：
  //   改前 → LOADURL-DIAG reason=start      （而且 startForConsole 在 envReady 那关就早退，
  //                                          永远到不了它自己的 refreshWebUiPhase → 一直等下去）
  //   改后 → LOADURL-DIAG reason=envMissing
  // 这一页说的是"正在启动…（已等待 N 秒）"，而实际什么都没在启动 —— 正是"文案与实际动作不符"。
  const at = main.indexOf('environment not ready, console opened for one-click install')
  assert.ok(at > 0, '找得到那条日志')
  // 日志行在 if (!envReady()) 之后，所以往前多取一点才能把那个 if 包进来
  const block = main.slice(Math.max(0, at - 300), at + 700)
  assert.match(block, /if \(!envReady\(\)\) \{[\s\S]*?refreshWebUiPhase\(\)[\s\S]*?return/,
    '环境不就绪时也要把说明页切到实际状态，再返回')
  // 成因：这条路径上**没有任何别的地方**会刷新说明页。
  // startForConsole（修复动作走的那条）在 envReady 那关直接 return，它自己不带刷新 ——
  // 所以启动路径必须自己补，不能指望下游。
  assert.match(main, /async function startForConsole\(\) \{[\s\S]{0,300}?env-not-ready[\s\S]{0,200}?\n\}/,
    'startForConsole 早退时不刷新 —— 这就是启动路径必须自己刷的原因')
  // 而 start 不在 PLAN_REASONS 里：plan 即使算出了 envMissing 也不能在 start 页上生效
  assert.match(loading, /PLAN_REASONS = new Set\(\['pluginFailed', 'settingsInvalid', 'envMissing', 'bootUnknown'\]\)/,
    'start 必须不在白名单里，否则启动中就会显示失败页')
})

// ---------- ⑮ 观察点：真实使用代替合成复现 ----------
test('四类失败页的 reason 只有一份定义，页面侧与主进程侧不许漂移', () => {
  // 主进程从 recovery-plan.PAGE_REASONS 取，页面侧是独立一份（浏览器页面 require 不到模块），
  // 所以这条断言就是防漂移的那道闸。
  const mainSide = planSrc.match(/const PAGE_REASONS = Object\.freeze\(\[([^\]]*)\]\)/)
  assert.ok(mainSide, 'recovery-plan.js 要有 PAGE_REASONS')
  const names = mainSide[1].split(',').map((s) => s.trim().replace(/^'|'$/gu, '')).filter(Boolean)
  assert.deepEqual(names, ['pluginFailed', 'settingsInvalid', 'envMissing', 'bootUnknown'])
  for (const n of names) {
    assert.ok(loading.includes(`'${n}'`), `页面侧缺 ${n}`)
    assert.ok(new RegExp(`PLAN_REASONS = new Set\\(\\[[^\\]]*'${n}'`).test(loading)
      || loading.includes(`'${n}'`), `页面白名单缺 ${n}`)
  }
  const pageSet = loading.match(/PLAN_REASONS = new Set\(\[([^\]]*)\]\)/)
  assert.ok(pageSet, '页面侧要有 PLAN_REASONS')
  const pageNames = pageSet[1].split(',').map((s) => s.trim().replace(/^'|'$/gu, '')).filter(Boolean)
  assert.deepEqual(pageNames, names, '两侧必须一模一样：多了会显示不该显示的页，少了会漏掉该显示的')
  // start 绝不能进白名单：否则启动过程中就会显示失败页
  assert.ok(!names.includes('start'), 'start 不是失败页')
})

test('四类失败页第一次真出现时要留下证据（合成场景造不出来，就靠这行日志）', () => {
  const n = body('noteRecoveryPageShown')
  assert.match(n, /recoveryPlan\.PAGE_REASONS\.includes\(reason\)/, '只记这四类，常态页记了是噪音')
  assert.match(n, /sig === lastRecoveryPageLogged\) return/, '同一种失败反复刷新不该刷屏')
  assert.match(n, /recovery: page reason=/, '日志要能直接看出是哪一页')
  for (const key of ['kind', 'target', 'targets', 'streak']) {
    assert.ok(n.includes(key + '='), `日志要带 ${key}（判断"野外的失败形状"就靠这几个字段）`)
  }
  // 必须在 refreshWebUiPhase 里被调用，且用同一个 reason（两处各算一次就会不一致）
  const r = body('refreshWebUiPhase')
  assert.match(r, /const reason = reasonForPhase\(servicePhase\(\)\)/, 'reason 只算一次')
  assert.match(r, /noteRecoveryPageShown\(reason\)/, '要真的调用')
  assert.match(r, /loadingUrl\(reason, t\.id, loadingParams\(\)\)/, '刷新用的是同一个 reason')
})

test('构建产物与源同步：wwwroot/app.js 要带上这一行', () => {
  const builtApp = read('wwwroot/app.js')
  assert.match(builtApp, /个插件未生效（重启不会改变）/, 'wwwroot/app.js 未同步：请执行 npm run build:assets')
})

// ---------- ⑬ 兜底文案不许再说谎 ----------
test('说明页的兜底文案对"有输出但认不出"和"压根没输出"两种事实都成立', () => {
  // 旧文案写死「服务没有输出可识别的错误。」—— 真机实测里日志明明白白有 SyntaxError，
  // 用户拿着日志一对照就发现界面在撒谎。兜底拿不到分类结果，所以它只能承诺"DSHL 认不出"。
  const loading = read('ui-src/loading.js')
  const t = loading.slice(loading.indexOf('bootUnknown: {'), loading.indexOf('bootUnknown: {') + 420)
  // 只看 sub 的**值**：注释里为了说明缘由引用了那句旧文案，不能被自己的注释绊倒
  const m = t.match(/sub: '([^']*)'/)
  assert.ok(m, '要能取到 bootUnknown 的 sub')
  assert.ok(!/没有输出/.test(m[1]), '兜底里还留着"没有输出"这种断言：' + m[1])
  assert.match(m[1], /DSHL 认不出这次启动失败的原因/, '兜底要只说"认不出"这一件它能确定的事')
})

test('兜底路径（主进程没下发 plan）也要把原文摆出来', () => {
  // 这条路径以前一个字都不显示，只留一句被写死的断言 —— 全页最误导的组合。
  const loading = read('ui-src/loading.js')
  const at = loading.indexOf("} else if (detail && reason !== 'blocked') {")
  assert.ok(at > 0, '要有"无 plan 但有 detail"的分支')
  const block = loading.slice(at, at + 300)
  assert.match(block, /'原始报错：' \+ detail/, '原文要真的渲染出来')
  assert.match(block, /hintEl\.classList\.remove\('hidden'\)/, '渲染了还要显示')
  assert.match(block, /reason !== 'blocked'/, 'blocked 已经把它当副文案了，别重复一遍')
})

// ---------- ⑯ 改 profile 之前先落回退点 ----------
test('改 profile 前落一个检查点：强制安装弄坏了 DSH 也有得退', () => {
  // 用户 2026-10-12 的要求："如果绕过后打不开 dsh 了，应该能提供回退"。
  // 回退链的其余部分（回退到检查点 / 禁用插件 / 自动回退）都已经有了，缺的只是"写之前那个点"：
  // maybeCaptureHealthy 是服务健康起来**之后**才落、而且每次运行只落一次
  // （healthCaptured 门槛），所以"改之前"这个状态压根不在槽里。
  const c = body('capturePreWriteSnapshot')
  assert.match(c, /health\.captureHealthy\(\{/, '要走既有捕获函数（不许自己写一套快照）')
  assert.match(c, /reason: 'pre-write'/, '原因要可辨认：恢复页据此解释这个点是怎么来的')
  assert.match(c, /invalidateRecoverySlots\(\)/, '落了新点要让恢复页缓存失效，否则列表还是旧的')
  // 只在"当前真的有一个健康状态可保护"时才落：服务没起来时快照的是坏状态，
  // 拿它当回退点等于把用户送回坑里。
  assert.match(c, /if \(!server\.running\(\) \|\| !server\.managed\(\)\) \{[\s\S]{0,200}?log\(/,
    '服务没起来 / 不是我们管的实例 → 不落点，但**必须记日志**')
  assert.match(c, /未落点/, '跳过要说清"这次没有新增回退点"')
  // 静默跳过就是白加这行日志：实测（自动代装在服务就绪之前跑）日志里一片空白，
  // 看起来像这个功能没生效，实际是"那时确实没有健康状态可保护"。两者必须可区分。
  assert.ok(!/if \(!server\.running\(\) \|\| !server\.managed\(\)\) return false/u.test(c),
    '跳过不许静默 —— 否则分不清"没调用"和"被守卫挡了"')
  // 检查点是安全网，不是前置条件：落点失败不许阻断写操作，但必须留痕
  assert.match(c, /catch \(e\) \{[\s\S]{0,160}?log\(/, '落点失败只能记日志')
  assert.ok(!/\bthrow\b/u.test(c), '落点失败绝不能抛给调用方（那会让插件操作直接失败）')
  // 不许动 healthCaptured：那是"服务就绪后捕获"的门槛，置上会让重启后不再记录新状态
  assert.ok(!/healthCaptured = true/u.test(c), '不许吃掉就绪后的那次捕获')

  // 插在所有改 profile 的统一入口上 —— 一处覆盖全部，不用在每个写入口各补一次（那种补法必然漏）
  const lock = body('tryBeginProfileOp')
  assert.match(lock, /capturePreWriteSnapshot\(/, '写锁入口要落点')
  assert.ok(lock.indexOf('capturePreWriteSnapshot(') < lock.indexOf('profileOp = token'),
    '落点必须在真正占用写锁之后、动 profile 之前')
})
