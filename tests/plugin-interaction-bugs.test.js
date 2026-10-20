// tests/plugin-interaction-bugs.test.js — 插件管理页交互逻辑的回归契约（2026-10-20）
//
// 用户直接反馈「插件管理页面有很多交互逻辑的问题和 bug」。这一轮修的是**不是功能缺失**、
// 而是界面与真实状态对不上的那类问题：
//   ① 分组：清单内卡片排在「Profile 中的其他插件」标题之后，归属读错；
//   ② 写锁：别的插件正在改 profile 时，其他卡片的按钮/开关仍可点，点了才收到
//      「另一个插件操作正在进行」（dshl.log 里实测多串 profile-lock 拒绝）；
//   ③ 批量按钮：没目标时变成点不动的死按钮（「没有可更新」提示永远到不了用户眼前）；
//   ④ 批量结束：只把按钮文案恢复，不告诉用户跑完没有、结果如何；
//   ⑤ 刷新：npm 限流导致「可更新」消失时无任何提示，看起来像"插件都最新"；
//   ⑥ 开关/重启失败：只写进会被下一次渲染覆盖的卡片行，不给 toast；
//   ⑦ 「已安装」筛选把 enabled（手机连接已开启但 payload 未装）也算进去，与右上角计数自相矛盾。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const app = read('ui-src/app.js')
const main = read('main.js')

test('分组：清单内先渲染，小标题后只跟 Profile 清单外卡片', () => {
  assert.match(app, /const managed = visible\.filter\(\(p\) => !isProfileInventoryCard\(p\)\)/,
    '清单内卡片必须单独渲染，不能按"第一张清单外卡片前插标题"的旧方式')
  assert.match(app, /const inventory = visible\.filter\(isProfileInventoryCard\)/)
  assert.match(app, /for \(const p of managed\) cards\.appendChild\(pluginCardEl\(p\)\)/)
  assert.match(app, /cards\.appendChild\(pluginGroupHeadEl\(inventory\.length\)\)/,
    '标题后只渲染 inventory，数字与渲染张数同口径')
  assert.match(app, /for \(const p of inventory\) cards\.appendChild\(pluginCardEl\(p\)\)/)
})

test('全局 profile 写锁：主进程下发，页面禁用所有插件写操作', () => {
  assert.match(main, /pluginOp: \{\s*\n\s*busy: profileOpBusy\(\),/, 'state 必须下发写锁状态')
  assert.match(app, /window\._pluginOpBusy = !!\(state\.pluginOp && state\.pluginOp\.busy\)/,
    '页面必须接收写锁状态（否则其他卡片仍可点）')
  assert.match(app, /function pluginOpBusyNow\(\)/)
  assert.match(app, /const locked = !p\.busy && pluginOpBusyNow\(\)/)
  assert.match(app, /switchInput\.disabled = !!p\.busy \|\| locked/)
  assert.match(app, /if \(p\.busy \|\| locked\) btn\.disabled = true/)
  // 卡片按钮/开关触发点也要有兜底拦截（防止 disabled 被未来样式或键盘绕过）
  assert.match(app, /if \(pluginOpBusyNow\(\)\) \{\s*\n\s*showConsoleToast\('另一个插件操作正在进行，请稍候'\)/)
  assert.match(app, /installBtn\.disabled = running \|\| locked/)
})

test('批量按钮：没目标也不做死按钮，点一下给出可读解释', () => {
  assert.match(app, /const pending = plugins\.filter\(\(p\) => p && p\.preset && !p\.installed\)/)
  assert.match(app, /const installable = pending\.filter/)
  assert.match(app, /if \(!targets\.length\) \{\s*\n\s*showConsoleToast/,
    '一键安装的点按守卫必须存在（旧实现根本没有"全部已装"的提示）')
  assert.match(app, /缺失的预装插件都需先授权：请在卡片上点「授权并安装」/)
  assert.match(app, /所有预装插件都已安装/)
  // 一键更新不再按"没得更新"置灰：handler 里的 0 目标提示必须真的能被用户触发
  assert.match(app, /updateBtn\.disabled = false;\s*\n\s*updateBtn\.title = updatable\.length/)
})

test('批量结果回执：主进程写 result，页面在 running 结束后播一次 toast', () => {
  assert.match(main, /pluginBatchResult = \{ at: Date\.now\(\), kind: 'install'/, '安装批次要写结果')
  assert.match(main, /pluginBatchResult = \{\s*\n\s*at: Date\.now\(\),\s*\n\s*kind: 'update'/, '更新批次要写结果')
  assert.match(main, /result: pluginBatchResult \|\| null/, '结果必须随 state 下发')
  assert.match(app, /const result = info && info\.result/)
  assert.match(app, /result\.at !== window\._batchResultShownAt/, '同一条结果只播一次')
  assert.match(app, /showConsoleToast\(\(result\.ok \? '' : '✕ '\) \+ result\.message\)/)
})

test('版本查询失败/刷新：给出可读结果，不把限流当成已是最新', () => {
  assert.match(main, /pluginVersionQueryErrors: \[\.\.\.npmVersionErrors\.keys\(\)\]/)
  assert.match(app, /window\._pluginVersionQueryErrors = Array\.isArray\(state\.pluginVersionQueryErrors\)/)
  assert.match(app, /个插件的版本查询失败（可能被 npm 限流），暂时无法判断更新/)
  assert.match(app, /已刷新：' \+ outdated \+ ' 个插件可更新/)
})

test('开关失败、重启失败必须有 toast；重启按钮不会被状态推送重新点亮', () => {
  assert.match(app, /showConsoleToast\('✕ ' \+ \(turnOn \? '开启' : '关闭'\)/)
  assert.match(app, /showConsoleToast\('✕ 重启失败/)
  assert.match(app, /const applying = !!window\._applyRestartBusy/)
  assert.match(app, /btn\.disabled = applying \|\| locked/, '状态推送到达时不能在"重启中"重新可点')
  assert.match(app, /window\._applyRestartBusy = false/)
})

test('卡片 busy 合并动作忙态：市场/手机连接操作期间开关与按钮也要禁用', () => {
  assert.match(main, /busy: marketAct \|\| m\.busy/, '插件市场卡片要合并动作忙态，不能只写 m.busy')
  assert.match(main, /busy: bridgeAct \|\| b\.busy/, '手机连接卡片同理')
})

test('筛选计数口径一致：已安装只认 installed（与右上角 N 个已安装同口径）', () => {
  const start = app.indexOf('function pluginMatches(p, filter, query) {')
  assert.ok(start > 0, '找不到 pluginMatches')
  const fn = new Function(app.slice(start, app.indexOf('\n}\n', start) + 3) + '\nreturn pluginMatches')()
  const p = (over) => Object.assign({ name: 'x', subtitle: '', description: '', id: 'x', category: '' }, over)
  assert.equal(fn(p({ installed: false, enabled: true, tags: [] }), 'installed', ''), false,
    'enabled 但未安装（手机连接 payload 缺失）不能算进「已安装」')
  assert.equal(fn(p({ installed: false, enabled: true, tags: [] }), 'available', ''), true)
  assert.equal(fn(p({ installed: true, enabled: false, tags: [] }), 'installed', ''), true)
  assert.equal(fn(p({ installed: true, enabled: false, tags: [] }), 'available', ''), false)
})

test('挂起变更：日志动词跟随 action（update/reinstall 不能写成已安装）', () => {
  assert.match(main, /verb === 'update' \? '已更新'/)
  assert.match(main, /verb === 'reinstall' \? '已重新安装'/)
  assert.match(main, /async function applyPendingPluginChanges\(trigger = 'user'\)/,
    '应用挂起变更要带触发来源：批量更新收尾不是"用户点"')
})
