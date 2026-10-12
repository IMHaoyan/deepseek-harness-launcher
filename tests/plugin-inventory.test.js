// tests/plugin-inventory.test.js — Profile 清单补全的投影（node --test）
//
// 对应的缺口：插件页的卡片来自 MANAGED_NPM_PLUGINS 注册表，而能导致启动失败的是 Profile 里
// 真实存在的**任何**包。手动装的第三方插件在界面上不存在 —— 用户在启动失败页看到"插件 X 加载
// 失败"，却在控制台里找不到能关掉 X 的地方。
//
// 这些用例钉的是**可执行性由权威探针现算**这条（照搬 dsh-desktop 的 projectBundles）：
// 探针说不行就不给按钮，而不是给一个点了没用的灰按钮。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const inv = require('../plugin-inventory')

// 已安装插件的真实形状是 **dependencies + dsh.profile.bundles 都有**（见 market.pluginStateOf 的
// "缺任一条都算没装好"）。默认给这个形状，而不是只给 bundle —— 只给 bundle 的是 DSH 自带核心 bundle，
// 那类会被 plugin-inventory 明确挡掉（见"DSH 自带的核心 bundle 绝不上这张清单"那条）。
const T = (name, sources) => ({ name, sources: sources || ['dep', 'bundle'] })
const base = (over) => Object.assign({
  targets: [T('third-party-plugin')],
  known: [],
  stateOf: () => ({ version: '1.2.3' }),
  isDisabled: () => false,
  canToggle: () => true,
}, over)

test('不在注册表里的包补成一张卡片，且结构与插件页其余卡片同构', () => {
  const [c] = inv.inventoryCards(base())
  assert.equal(c.id, 'profile:third-party-plugin', 'id 带前缀，插件页据此不必区分来源')
  assert.equal(c.subtitle, 'third-party-plugin')
  assert.equal(c.name, 'third-party-plugin')
  assert.equal(c.version, '1.2.3', '版本来自 profile 清单')
  assert.equal(c.installed, true)
  assert.equal(c.enabled, true)
  // 界面真正会读的字段必须齐全，否则卡片会渲染出一片空白
  for (const k of ['note', 'order', 'preset', 'icon', 'category', 'sourceLabel', 'repo', 'installed',
    'enabled', 'version', 'latestVersion', 'outdated', 'payloadReady', 'busy', 'error', 'activation',
    'lastChange', 'autoInstall', 'tags', 'toggleAction', 'status', 'actions']) {
    assert.ok(k in c, '卡片缺字段：' + k)
  }
})

test('注册表已经覆盖的包不再补一张（同一页不出现两张卡）', () => {
  const cards = inv.inventoryCards(base({ targets: [T('dshmarket'), T('dsh-better-sidebar'), T('third-party-plugin')], known: ['dshmarket', 'dsh-better-sidebar'] }))
  assert.equal(cards.length, 1)
  assert.equal(cards[0].subtitle, 'third-party-plugin')
})

// ★ 真机沙箱实测抓到的：profile 的 bundles 里躺着 DSH **安装自带**的核心 bundle，
//   它们不在 DSHL 注册表里，于是被列成了"第三方插件"还各带一个「卸载」按钮 —— 点下去
//   会动 profile 的 bundle 声明。判据用 sources（readProfileTargets 的权威归类），
//   不是硬编码包名前缀。
test('只收真的装在 profile 里的：DSH 自带的核心 bundle 绝不上这张"可卸载"清单', () => {
  const cards = inv.inventoryCards(base({
    targets: [
      T('@deepseek-ai/dsh-base', ['bundle']),
      T('@deepseek-ai/dsh-web-app', ['bundle']),
      T('third-party-plugin', ['dep']),
      T('patch-only-plugin', ['patch']),
    ],
  }))
  assert.deepEqual(cards.map((c) => c.subtitle), ['third-party-plugin'],
    '只有 dependencies 里的才可卸载；纯 bundle / 纯补丁行的都不能给卸载按钮')
})

test('既在 dependencies 又在 bundles 里 → 正常列出（这是绝大多数第三方插件）', () => {
  const [c] = inv.inventoryCards(base({ targets: [T('third-party-plugin', ['dep', 'bundle'])] }))
  assert.equal(c.subtitle, 'third-party-plugin')
  assert.equal(c.actions[0].action, 'uninstall')
})

test('可停用性由探针现算：canToggle=false 就不给开关，且说明为什么', () => {
  const [c] = inv.inventoryCards(base({ canToggle: () => false }))
  assert.equal(c.toggleAction, '', '拿不到加载项就不给开关（不是给灰开关）')
  assert.equal(c.status.tone, 'warn')
  assert.match(c.status.title, /找不到它/, '必须解释为什么不能停用，否则用户只看到一个坏掉的开关位')
  assert.equal(c.enabled, true, '没被禁用就是启用状态')
})

test('已停用的包：状态为「已关闭」，开关仍然给（要能开回来）', () => {
  const [c] = inv.inventoryCards(base({ isDisabled: () => true }))
  assert.equal(c.status.label, '已关闭')
  assert.equal(c.status.tone, 'muted')
  assert.equal(c.enabled, false)
  assert.equal(c.toggleAction, 'toggle', '停用了必须还能启用回来')
})

test('动作面只有「卸载」：安装/更新不给（来源未知，编一个就是文案与动作不符）', () => {
  const [c] = inv.inventoryCards(base())
  assert.deepEqual(c.actions.map((a) => a.action), ['uninstall'])
  assert.match(c.actions[0].confirmTitle, /third-party-plugin/, '确认框要点名')
  assert.equal(c.actions[0].tone, 'danger')
  assert.ok(!('gate' in c) && !('autoInstall' in c && c.autoInstall), '不该带上安装/更新的语义')
  assert.equal(c.outdated, false, '不做更新预判')
  assert.equal(c.latestVersion, '')
})

test('@scope/name 的显示名只取 name，全名进 subtitle', () => {
  const [c] = inv.inventoryCards(base({ targets: [T('@michengai/dsh-skills-manager')] }))
  assert.equal(c.name, 'dsh-skills-manager')
  assert.equal(c.subtitle, '@michengai/dsh-skills-manager')
  assert.equal(c.id, 'profile:@michengai/dsh-skills-manager')
})

test('busy 时状态显示进行中的动作，且 busy 字段非空（卡片会进忙态）', () => {
  const [c] = inv.inventoryCards(base({
    busyOf: () => 'uninstall',
    busyLabel: (a) => (a === 'uninstall' ? '卸载中…' : a),
  }))
  assert.equal(c.busy, 'uninstall')
  assert.equal(c.status.tone, 'busy')
  assert.equal(c.status.label, '卸载中…')
})

// ★ 这条是补一个真缺口：DSH 对"bundle 被跳过 / 行没激活"只写 stderr、退出码 0，服务照常起。
//   能出这种事的**多半是第三方插件**——正是本分组覆盖的那批。不接证据的话，
//   插件页会对一个根本没加载起来的插件显示「已启用」，是最糟的那种谎。
test('「未生效」的证据必须也接给这一类卡片（否则会对坏插件显示"已启用"）', () => {
  const [withIssue] = inv.inventoryCards(base({ activationOf: () => '启动时未激活：failed to import' }))
  assert.equal(withIssue.activation, '启动时未激活：failed to import')
  assert.equal(withIssue.status.label, '已启用', '启停状态与是否生效是两件事，别混')
  const [clean] = inv.inventoryCards(base({ activationOf: () => '' }))
  assert.equal(clean.activation, '')
})

test('activation 探针缺失/抛错都降级成空串（不缺证据就不诬告）', () => {
  assert.equal(inv.inventoryCards(base())[0].activation, '')
  assert.equal(inv.inventoryCards(base({ activationOf: () => { throw new Error('boom') } }))[0].activation, '')
})

// ---------- fail-closed：探针缺失一律按"证明不了" ----------
test('探针缺失不炸也不猜：不给开关、不给版本，卡片仍在（否则用户连卸载都找不到）', () => {
  const [c] = inv.inventoryCards({ targets: [T('third-party-plugin')], known: [] })
  assert.equal(c.toggleAction, '', '没有 canToggle 探针就不给开关')
  assert.equal(c.version, '', '没有 stateOf 探针就不编版本号')
  assert.equal(c.actions[0].action, 'uninstall', '卸载仍要给 —— 这是用户唯一的出路')
})

test('探针抛错不当成 true（fail-closed 的边界由 main.js 的包装保证，这里钉返回约定）', () => {
  const [c] = inv.inventoryCards(base({ canToggle: () => { throw new Error('boom') } }))
  assert.equal(c.toggleAction, '', '探针抛错不该冒泡成"可以停用"')
})

test('包名不合法的条目直接丢弃（readProfileTargets 已过滤，这里是第二道）', () => {
  const cards = inv.inventoryCards(base({
    targets: [T(''), T('UPPER'), T('has space'), T('ok-plugin'), T(null), {}, 'string-entry'],
  }))
  assert.deepEqual(cards.map((c) => c.subtitle), ['ok-plugin'])
})

test('targets 不是数组 / 缺字段都返回空数组而不是抛错', () => {
  for (const targets of [undefined, null, 'x', 42, {}]) {
    assert.deepEqual(inv.inventoryCards({ targets }), [])
  }
  assert.deepEqual(inv.inventoryCards(), [])
})

test('描述里说明"为什么它在这儿"，且来源只用于解释、不参与判定', () => {
  // 两种都必须是"装在 profile 里"的（含 dep）；纯 bundle 的那类已被上面那条挡掉
  const both = inv.inventoryCards(base({ targets: [T('p', ['dep', 'bundle'])] }))[0]
  assert.match(both.description, /不在 DSHL 的插件清单中/)
  assert.match(both.status.title, /dsh\.profile\.bundles/, '有 bundle 来源就说得具体些')
  const depOnly = inv.inventoryCards(base({ targets: [T('p', ['dep'])] }))[0]
  assert.match(depOnly.status.title, /直接依赖/)
  // 来源不同不改变可执行性
  assert.equal(both.toggleAction, depOnly.toggleAction)
  assert.equal(both.actions[0].action, depOnly.actions[0].action)
})

test('INVENTORY_ID_PREFIX 与 main.js 的分发分支同源（改一处必须改另一处）', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.equal(inv.INVENTORY_ID_PREFIX, 'profile:')
  assert.match(main, /pid\.startsWith\(pluginInventory\.INVENTORY_ID_PREFIX\)/,
    'main.js 必须用同一个常量判前缀，不能自己写字符串字面量')
  assert.ok(!/'profile:'/.test(main), 'main.js 里不该出现硬编码的 profile: 前缀')
})
