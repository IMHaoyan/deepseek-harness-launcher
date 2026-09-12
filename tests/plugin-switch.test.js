// tests/plugin-switch.test.js — DSH user-patch-layer 启停契约（不卸载插件也能关）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pluginSwitch = require('../plugin-switch')

function makeHome(packageName = 'pkg', bundlePatch = "- insert:\n    - id: mine\n      name: 'pkg'\n") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-plugin-switch-'))
  const profile = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [packageName] } } }))
  const packageDir = path.join(profile, 'node_modules', packageName)
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  fs.writeFileSync(path.join(packageDir, 'cordis.patch.yml'), bundlePatch)
  const marketDir = path.join(profile, 'node_modules', 'dshmarket')
  fs.mkdirSync(marketDir, { recursive: true })
  fs.writeFileSync(path.join(marketDir, 'package.json'), JSON.stringify({ name: 'dshmarket' }))
  return { home, profile }
}

test('parsePatchRows：只把 insert 下的行算作插件自己的行 id', () => {
  const rows = pluginSwitch.parsePatchRows([
    '- id: foreign-row',
    '  disabled: true',
    '- insert:',
    '    - id: mine',
    "      name: 'pkg'",
  ].join('\n'))
  assert.deepEqual(rows.insertedIds, ['mine'])
  assert.deepEqual(rows.ids, ['foreign-row', 'mine'])
})

test('disable/enable：写 user patch layer，保留安装状态并同步 market disabled', () => {
  const { home, profile } = makeHome()
  pluginSwitch.initPluginSwitch({ home })
  assert.equal(pluginSwitch.canToggle('pkg'), true)
  assert.equal(pluginSwitch.isDisabled('pkg'), false)

  const off = pluginSwitch.setEnabled('pkg', false)
  assert.equal(off.ok, true)
  assert.equal(pluginSwitch.isDisabled('pkg'), true)
  const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: mine\n  disabled: true/)

  const marketState = JSON.parse(fs.readFileSync(path.join(profile, '.dsh-market', 'state.json'), 'utf8'))
  assert.deepEqual(marketState.disabled, ['pkg'])

  const on = pluginSwitch.setEnabled('pkg', true)
  assert.equal(on.ok, true)
  assert.equal(pluginSwitch.isDisabled('pkg'), false)
  const after = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(after, /- id: mine\n  disabled: true/)
})

test('最后一条开关移除后恢复 [] 占位，profile 永远仍是合法条目数组', () => {
  const { home, profile } = makeHome()
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]')
  pluginSwitch.initPluginSwitch({ home })
  assert.equal(pluginSwitch.setEnabled('pkg', false).ok, true)
  assert.equal(pluginSwitch.setEnabled('pkg', true).ok, true)
  assert.equal(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), '[]\n')
})

test('removeRows：卸载时清掉开关行和 market disabled 记录', () => {
  const { home, profile } = makeHome()
  pluginSwitch.initPluginSwitch({ home })
  const rows = pluginSwitch.rowIdsForPackage('pkg')
  assert.equal(pluginSwitch.setEnabled('pkg', false).ok, true)
  pluginSwitch.removeRows('pkg', rows)
  const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /disabled: true/)
  const marketState = JSON.parse(fs.readFileSync(path.join(profile, '.dsh-market', 'state.json'), 'utf8'))
  assert.deepEqual(marketState.disabled, [])
})

test('pruneRows：只清指定旧行 id，不碰当前版本的新行', () => {
  const { home, profile } = makeHome()
  pluginSwitch.initPluginSwitch({ home })
  const patchPath = path.join(profile, 'cordis.patch.yml')
  fs.writeFileSync(patchPath, '- id: old-row\n  disabled: true\n- id: mine\n  disabled: true\n')
  pluginSwitch.pruneRows(['old-row'])
  const patch = fs.readFileSync(patchPath, 'utf8')
  assert.doesNotMatch(patch, /old-row/)
  assert.match(patch, /- id: mine\n  disabled: true/)
})
test('carrier：关闭 codex-ui 时同步强制打开它禁用的侧栏行，打开时撤回覆盖', () => {
  const carrierPatch = [
    '- id: ui-sidebar',
    '  disabled: true',
    '- id: ui-settings-general',
    '  disabled: true',
    '- insert:',
    '    - id: codex-ui',
    "      name: '@michengai/dsh-codex-ui'",
  ].join('\n')
  const { home, profile } = makeHome('@michengai/dsh-codex-ui', carrierPatch)
  pluginSwitch.initPluginSwitch({ home })
  assert.deepEqual(pluginSwitch.carrierDisableIds('@michengai/dsh-codex-ui'), ['ui-sidebar', 'ui-settings-general'])

  assert.equal(pluginSwitch.setEnabled('@michengai/dsh-codex-ui', false).ok, true)
  let patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: codex-ui\n  disabled: true/)
  assert.match(patch, /- id: ui-sidebar\n  disabled: false/)
  assert.match(patch, /- id: ui-settings-general\n  disabled: false/)

  assert.equal(pluginSwitch.setEnabled('@michengai/dsh-codex-ui', true).ok, true)
  patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(patch, /- id: codex-ui\n  disabled: true/)
  assert.doesNotMatch(patch, /- id: ui-sidebar\n  disabled: false/)
  assert.doesNotMatch(patch, /- id: ui-settings-general\n  disabled: false/)
})

test('market disabled：控制台状态应直接读成已关闭，reconcile 补回 patch 覆盖', () => {
  const carrierPatch = [
    '- id: ui-sidebar',
    '  disabled: true',
    '- id: ui-settings-general',
    '  disabled: true',
    '- insert:',
    '    - id: codex-ui',
    "      name: '@michengai/dsh-codex-ui'",
  ].join('\n')
  const { home, profile } = makeHome('@michengai/dsh-codex-ui', carrierPatch)
  fs.mkdirSync(path.join(profile, '.dsh-market'), { recursive: true })
  fs.writeFileSync(path.join(profile, '.dsh-market', 'state.json'), JSON.stringify({ disabled: ['@michengai/dsh-codex-ui'] }))
  pluginSwitch.initPluginSwitch({ home })
  assert.equal(pluginSwitch.isMarketDisabled('@michengai/dsh-codex-ui'), true)
  assert.equal(pluginSwitch.isDisabled('@michengai/dsh-codex-ui'), true)

  const result = pluginSwitch.reconcileDisabledPackages(['@michengai/dsh-codex-ui'])
  assert.deepEqual(result.names, ['@michengai/dsh-codex-ui'])
  const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: codex-ui\n  disabled: true/)
  assert.match(patch, /- id: ui-sidebar\n  disabled: false/)

  // 在 DSH 市场里重新打开：reconcile 应撤回 DSHL 写入的覆盖行。
  fs.writeFileSync(path.join(profile, '.dsh-market', 'state.json'), JSON.stringify({ disabled: [] }))
  const enabled = pluginSwitch.reconcileDisabledPackages(['@michengai/dsh-codex-ui'])
  assert.deepEqual(enabled.names, ['@michengai/dsh-codex-ui'])
  const after = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(after, /- id: codex-ui\n  disabled: true/)
  assert.doesNotMatch(after, /- id: ui-sidebar\n  disabled: false/)
})
test('hasClientPart：带 dsh.client 的插件需要页面刷新，纯 host 插件不需要', () => {
  const { home } = makeHome()
  pluginSwitch.initPluginSwitch({ home })
  const pkgPath = path.join(home, 'profiles', 'web', 'node_modules', 'pkg', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.equal(pluginSwitch.hasClientPart('pkg'), false)
  pkg.dsh.client = { platform: 'web' }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg))
  assert.equal(pluginSwitch.hasClientPart('pkg'), true)
})