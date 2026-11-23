// shortcut-conflicts.test.js — 默认快捷键冲突的纯函数回归
// 夹具按 minified client bundle 的真实形态（反引号/双引号混用）书写。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const sc = require('../shortcut-conflicts')

const defs = (code, mods) => [
  'defaults:{',
  `"desktop:macos":{code:\`${code}\`,modifiers:[\`${mods[0]}\`,\`${mods[1]}\`]},`,
  `"desktop:windows":{code:\`${code}\`,modifiers:[\`${mods[0]}\`,\`${mods[1]}\`]},`,
  `"web:windows":{code:\`${code}\`,modifiers:[\`${mods[0]}\`,\`${mods[1]}\`]}`,
  '}',
].join('')

const usageBilling = 'x.register({id:`usage-billing.open-dashboard`,label:()=>\'\',aliases:[`usage`],' + defs('KeyU', ['primary', 'shift']) + '})'
const workspace = 'ctx.effect(()=>ctx.shortcuts.register({id:"session.toggleRead",label:()=>"",' + defs('KeyU', ['primary', 'shift']) + '}))'
const workspaceOther = 'ctx.effect(()=>ctx.shortcuts.register({id:"session.archive",label:()=>"",' + defs('KeyA', ['primary', 'alt']) + '}))'

test('提取命令 id 与 defaults 绑定（反引号/双引号混用）', () => {
  const third = sc.extractShortcutCommands(usageBilling)
  assert.equal(third.length, 1)
  assert.equal(third[0].id, 'usage-billing.open-dashboard')
  assert.deepEqual(third[0].bindings.map((b) => b.combo),
    ['desktop:macos', 'desktop:windows', 'web:windows'])
  assert.equal(third[0].bindings[0].key, 'KeyU|primary+shift', '修饰键要归一化排序')

  const official = sc.extractShortcutCommands(workspace)
  assert.equal(official[0].id, 'session.toggleRead')
})

test('同一平台同一绑定 → 冲突；修饰键/平台不同 → 不冲突', () => {
  const third = [{ npm: '@kenz1117/dsh-ui-usage-billing', official: false, commands: sc.extractShortcutCommands(usageBilling) }]
  const official = [{ npm: '@deepseek-ai/dsh-client-ui-workspace', official: true, commands: sc.extractShortcutCommands(workspace) }]
  const hits = sc.findDefaultConflicts([...third, ...official])
  assert.equal(hits.length, 1)
  assert.equal(hits[0].npm, '@kenz1117/dsh-ui-usage-billing')
  assert.equal(hits[0].commandId, 'usage-billing.open-dashboard')
  assert.equal(hits[0].otherId, 'session.toggleRead')
  assert.equal(hits[0].combo, 'desktop:macos')

  const differentMods = [{ npm: 'p', official: false, commands: [{ id: 'third.x', bindings: [{ combo: 'web:windows', key: 'KeyU|primary+alt' }] }] }]
  const noHit = sc.findDefaultConflicts([...differentMods, ...official])
  assert.equal(noHit.length, 0, '不同按键不能报冲突')

  const differentPlatform = [{ npm: 'p', official: false, commands: [{ id: 'third.x', bindings: [{ combo: 'web:linux', key: 'KeyU|primary+shift' }] }] }]
  assert.equal(sc.findDefaultConflicts([...differentPlatform, ...official]).length, 0, '不同平台不能报冲突')
})

test('两个三方插件互撞：两边都列为排查对象；官方内部互撞不报', () => {
  const a = { npm: 'a', official: false, commands: [{ id: 'a.x', bindings: [{ combo: 'web:windows', key: 'KeyU|primary' }] }] }
  const b = { npm: 'b', official: false, commands: [{ id: 'b.y', bindings: [{ combo: 'web:windows', key: 'KeyU|primary' }] }] }
  const hits = sc.findDefaultConflicts([a, b])
  assert.deepEqual(hits.map((h) => h.npm).sort(), ['a', 'b'])

  const o1 = { npm: 'o1', official: true, commands: [{ id: 's.a', bindings: [{ combo: 'web:windows', key: 'KeyU|primary' }] }] }
  const o2 = { npm: 'o2', official: true, commands: [{ id: 's.b', bindings: [{ combo: 'web:windows', key: 'KeyU|primary' }] }] }
  assert.equal(sc.findDefaultConflicts([o1, o2]).length, 0, '官方包之间不参与归因')
})

test('解析不到的输入返回空：没有 id、超大文件、空文本', () => {
  assert.deepEqual(sc.extractShortcutCommands('defaults:{"web:windows":{code:`KeyU`,modifiers:[`primary`]}}'), [],
    '没有命令 id 的命令无法归因，必须丢弃')
  assert.deepEqual(sc.extractShortcutCommands(''), [])
  assert.deepEqual(sc.extractShortcutCommands('x'.repeat(9 * 1024 * 1024)), [], '超大 bundle 不解析')
  assert.deepEqual(sc.findDefaultConflicts([]), [])
  assert.deepEqual(sc.findDefaultConflicts([{ npm: 'x' }]), [])
})
