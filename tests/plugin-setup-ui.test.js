// Run the real onboarding functions in a DOM/IPC-only VM: no Electron, installs or builds.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../ui-src/app.js'), 'utf8')
const html = fs.readFileSync(path.join(__dirname, '../ui-src/index.html'), 'utf8')
function section(start, end) {
  const a = source.indexOf(start)
  const b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `UI section must exist: ${start}`)
  return source.slice(a, b)
}
const plugins = [
  { id: 'market', name: '插件市场', npm: 'dshmarket', description: '浏览插件' },
  { id: 'bridge', name: '手机连接', npm: '@agents-anywhere/dsh-bridge-next', description: '远程连接' },
  { id: 'usage', name: '用量计费', npm: '@kenz1117/dsh-ui-usage-billing', description: '用量统计' },
  { id: 'skills', name: '技能管理', npm: '@michengai/dsh-skills-manager', description: '管理技能' },
  { id: 'rewind', name: '对话回退', npm: 'dsh-rewind-plugin', description: '对话回退' },
  { id: 'mcp', name: 'MCP 连接器', npm: 'dsh-mcp-connector', description: '<script>unsafe</script>' },
]
const baseSetup = { choice: 'pending', running: false, current: '', done: 0, total: 6, error: '', completed: false, selectedIds: null }

function harness({ ready = true, running = true, setup = baseSetup, firstRun = true } = {}) {
  const nodes = new Map()
  const calls = []
  const callbacks = new Map()
  const frames = []
  let timerId = 0
  let now = 0
  let invoke = async () => null
  function $(id) {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden'])
      const listeners = new Map()
      let innerHTML = ''
      let inputs = []
      nodes.set(id, {
        style: {}, textContent: '', scrollTop: 0, scrollHeight: 0,
        get innerHTML() { return innerHTML },
        set innerHTML(value) {
          innerHTML = value
          inputs = Array.from(value.matchAll(/data-plugin-setup-id="([^"]+)"/g), (m) => ({
            dataset: { pluginSetupId: m[1] }, checked: false, disabled: false,
            closest: (selector) => selector === 'input[data-plugin-setup-id]' ? inputs.find((input) => input.dataset.pluginSetupId === m[1]) : null,
          }))
        },
        querySelectorAll: (selector) => selector === 'input[data-plugin-setup-id]' ? inputs : [],
        contains: (input) => inputs.includes(input),
        disabled: false,
        classList: {
          add: (key) => classes.add(key), remove: (key) => classes.delete(key),
          contains: (key) => classes.has(key),
          toggle(key, force) {
            const add = force === undefined ? !classes.has(key) : force
            if (add) classes.add(key)
            else classes.delete(key)
            return add
          },
        },
        addEventListener: (type, fn) => listeners.set(type, fn),
        click: () => listeners.get('click')?.(),
        emit: (type, event) => listeners.get(type)?.(event),
      })
    }
    return nodes.get(id)
  }
  const context = {
    $, console, renderPlugins() {}, showConsoleToast() {},
    window: { _envSummary: { ready }, _running: running, _firstRun: firstRun, _wizardActive: true },
    document: { title: '', querySelectorAll: () => [] },
    CONSOLE_PAGE_ALIASES: { main: 'general' }, CONSOLE_NAV_IDS: {}, CONSOLE_PAGE_LABELS: {},
    Date: { now: () => now }, performance: { now: () => now },
    requestAnimationFrame: (fn) => (frames.push(fn), frames.length), cancelAnimationFrame() {},
    setTimeout: (fn) => { callbacks.set(++timerId, fn); return timerId },
    clearTimeout: (id) => callbacks.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
    confirmDialog: async () => true,
    cmd: async (name, value) => { calls.push({ name, value }); return invoke(name, value) },
  }
  vm.createContext(context)
  vm.runInContext(section('function esc(s)', 'function missingEnvItems('), context)
  vm.runInContext(section('function missingEnvItems(', '// Node.js 升级的唯一入口'), context)
  vm.runInContext(section('function showPage(name)', 'function render(state)'), context)
  vm.runInContext(section('const WIZARD_STAGE_LABELS', '// 环境页打开时的全量快照'), context)
  // Leave unrelated console/version/profile widgets outside the fixture, but retain real routes.
  context.render = (state) => {
    context.window._running = !!state.running
    context.window._firstRun = !!state.firstRun
    context.window._pluginOpBusy = !!(state.pluginOp && state.pluginOp.busy)
    context.renderPluginSetup(state.pluginSetup, state.pluginSetupPlugins)
    context.window._envSummary = state.env
    if (context.window._wizardActive) context.routeWizard()
  }
  if (setup) context.renderPluginSetup({ ...setup }, plugins)
  return {
    context, $, calls,
    inputs: () => $('wizardPluginList').querySelectorAll('input[data-plugin-setup-id]'),
    check(id, checked) {
      const input = $('wizardPluginList').querySelectorAll('input[data-plugin-setup-id]').find((item) => item.dataset.pluginSetupId === id)
      assert.ok(input, `checkbox exists for ${id}`)
      input.checked = checked
      $('wizardPluginList').emit('change', { target: input })
    },
    setSetup: (extra) => context.renderPluginSetup({ ...baseSetup, ...extra }, plugins),
    route: () => context.routeWizard(),
    state: () => vm.runInContext('wizardStartState', context),
    visible: (id) => !$(id).classList.contains('hidden'),
    command: (fn) => { invoke = fn },
    advance: (ms) => { now += ms },
    flushFrames: () => { for (const fn of frames.splice(0)) fn(now) },
    flushTimers: () => { for (const [id, fn] of [...callbacks]) { callbacks.delete(id); fn() } },
  }
}
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

test('pending always prompts, including ready environments and later environment job done', () => {
  for (const ready of [false, true]) {
    const h = harness({ ready })
    assert.equal(h.visible('pageWizard'), true)
    assert.equal(h.visible('wizardPlugins'), true)
    h.context.renderWizardJob({ status: 'done', items: [] })
    h.context.showWizardScreen('done')
    h.context.ensureWizardStart()
    h.context.finishWizardStart()
    assert.equal(h.visible('wizardPlugins'), true)
    assert.equal(h.visible('wizardDone'), false)
    assert.equal(h.state(), null)
  }
})

test('environment snapshot arriving after opening wizard cannot cover pending', async () => {
  const h = harness()
  const snapshot = deferred()
  h.command(async (name) => name === 'envGetState' ? snapshot.promise : null)
  h.context.showPage('wizard')
  snapshot.resolve({ job: { status: 'done', items: [] }, log: [] })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.visible('wizardPlugins'), true)
  assert.equal(h.state(), null)
})

test('advanced environment skip and start cannot bypass pending choice', async () => {
  const h = harness({ ready: false })
  h.$('btnWizardStart').click()
  await h.$('btnWizardSkip').click()
  assert.equal(h.visible('wizardPlugins'), true)
  assert.equal(h.visible('pageWizard'), true)
  assert.equal(h.calls.some((c) => c.name === 'envInstall'), false)
})

test('running renders exact current plugin and counts; neither 60s nor 90s implies completion', () => {
  const h = harness()
  h.setSetup({ choice: 'install', running: true, current: 'mcp', done: 2, total: 6 })
  h.route()
  assert.match(h.$('wizardPluginStatus').textContent, /MCP 连接器.*2\/6/)
  assert.equal(h.$('wizardPluginBar').style.width, (2 / 6 * 100) + '%')
  assert.equal(h.visible('wizardPluginChoices'), false)
  for (const ms of [60000, 90000, 600000]) {
    h.advance(ms)
    h.context.renderWizardJob({ status: 'done', items: [] })
    h.context.ensureWizardStart()
    h.context.finishWizardStart()
    h.flushTimers()
    assert.equal(h.visible('wizardPlugins'), true)
    assert.equal(h.state(), null)
  }
})

test('completed is authoritative: full counters alone are insufficient; zero targets and old users finish', () => {
  const h = harness()
  h.setSetup({ choice: 'install', done: 6, total: 6, completed: false })
  h.route()
  assert.equal(h.visible('wizardPlugins'), true)
  assert.equal(h.state(), null)
  for (const counts of [{ done: 6, total: 6 }, { done: 0, total: 0 }]) {
    const old = harness({ firstRun: false, setup: { ...baseSetup, choice: 'install', completed: true, ...counts } })
    old.context.showPage('wizard')
    assert.equal(old.visible('wizardDone'), true)
    assert.equal(old.state().finished, true)
    old.flushFrames()
    assert.equal(old.$('wizardStartBar').style.width, '100%', 'late frame must not regress to 90%')
    old.flushTimers()
    assert.equal(old.visible('pageGeneral'), true)
  }
})

test('batch errors and running still block success even when completed is true', () => {
  for (const extra of [{ error: 'network failed' }, { running: true }]) {
    const h = harness({ setup: { ...baseSetup, choice: 'install', completed: true, ...extra } })
    h.route()
    assert.equal(h.visible('wizardPlugins'), true)
    assert.equal(h.state(), null)
    if (extra.error) assert.match(h.$('wizardPluginStatus').textContent, /network failed/)
  }
})

test('skip needs no completed flag: missing env welcomes, ready env waits for real service readiness', () => {
  for (const ready of [false, true]) {
    const h = harness({ ready, running: false, setup: { ...baseSetup, choice: 'skip' } })
    h.route()
    assert.equal(h.visible(ready ? 'wizardDone' : 'wizardWelcome'), true)
    if (ready) {
      assert.equal(h.state().finished, false)
      h.advance(90000)
      h.route()
      assert.equal(h.state().finished, false)
      h.context.window._running = true
      h.route()
      assert.equal(h.state().finished, true)
    }
  }
})

test('choice remains pending until successful IPC acknowledgment; duplicate click sends only one choice', async () => {
  for (const choice of ['install', 'skip']) {
    const h = harness({ ready: false, running: false })
    const ack = deferred()
    h.command(async (name) => name === 'pluginsSetSetupChoice' ? ack.promise : {
      pluginSetup: { ...baseSetup, choice }, env: { ready: false }, running: false,
    })
    const pending = h.context.choosePluginSetup(choice)
    await h.context.choosePluginSetup(choice === 'install' ? 'skip' : 'install')
    assert.equal(h.context.window._pluginSetup.choice, 'pending')
    assert.equal(h.context.window._pluginSetupSubmitting, true)
    assert.equal(h.$('btnWizardPluginsInstall').disabled, true)
    assert.equal(h.$('btnWizardPluginsSkip').disabled, true)
    assert.equal(h.calls.filter((c) => c.name === 'pluginsSetSetupChoice').length, 1)
    assert.equal(h.calls.find((c) => c.name === 'pluginsSetSetupChoice').value.choice, choice)
    h.context.renderWizardJob({ status: 'done', items: [] })
    assert.equal(h.visible('wizardPlugins'), true)
    ack.resolve({ ok: true })
    await pending
    assert.equal(h.context.window._pluginSetup.choice, choice)
    assert.equal(h.context.window._pluginSetupSubmitting, false)
    assert.equal(h.visible('wizardWelcome'), true)
  }
})

test('install acknowledgment followed by queued batch does not finish despite ready service', async () => {
  const h = harness()
  h.command(async (name) => name === 'pluginsSetSetupChoice' ? { ok: true } : {
    pluginSetup: { ...baseSetup, choice: 'install', running: true }, env: { ready: true }, running: true,
  })
  await h.context.choosePluginSetup('install')
  assert.equal(h.visible('wizardPlugins'), true)
  assert.equal(h.state(), null)
})

test('ready environment reaches startup screen after acknowledged skip or completed install', async () => {
  for (const choice of ['install', 'skip']) {
    const h = harness()
    h.command(async (name) => name === 'pluginsSetSetupChoice' ? { ok: true } : {
      pluginSetup: { ...baseSetup, choice, completed: choice === 'install', selectedIds: choice === 'install' ? plugins.map((p) => p.id) : [] },
      env: { ready: true }, running: true,
    })
    await h.context.choosePluginSetup(choice)
    assert.equal(h.visible('wizardDone'), true)
    assert.equal(h.state().finished, true)
  }
})

test('delayed finish callback rechecks batch and service state before returning to main', () => {
  for (const change of ['pending', 'running', 'error', 'service']) {
    const h = harness()
    h.setSetup({ choice: 'install', completed: true })
    h.route()
    assert.equal(h.state().finished, true)
    if (change === 'service') h.context.window._running = false
    else h.setSetup({ choice: change === 'pending' ? 'pending' : 'install',
      completed: true, running: change === 'running', error: change === 'error' ? 'failed' : '' })
    h.flushTimers()
    assert.equal(h.visible('pageWizard'), true)
    assert.equal(h.context.window._wizardActive, true)
  }
})

test('failed persistence or missing acknowledgment preserves pending and enables retry', async () => {
  for (const result of [{ ok: false, error: 'disk denied' }, null]) {
    const h = harness()
    h.command(async () => result)
    await h.context.choosePluginSetup('install')
    assert.equal(h.context.window._pluginSetup.choice, 'pending')
    assert.equal(h.context.window._pluginSetupSubmitting, false)
    assert.equal(h.visible('wizardPlugins'), true)
    assert.equal(h.$('btnWizardPluginsInstall').disabled, false)
    assert.match(h.$('wizardPluginStatus').textContent, /选择未保存/)
    assert.equal(h.calls.some((c) => c.name === 'getState'), false)
  }
})

test('leaving for main is not a choice or successful completion; broadcasts do not repeatedly steal focus', () => {
  const h = harness()
  h.$('btnWizardPluginsMain').click()
  assert.equal(h.visible('pageGeneral'), true)
  assert.equal(h.context.window._pluginSetup.choice, 'pending')
  assert.equal(h.context.window._wizardActive, false)
  h.setSetup({ choice: 'pending' })
  assert.equal(h.visible('pageGeneral'), true)
  assert.equal(h.calls.some((c) => c.name === 'pluginsSetSetupChoice'), false)
  assert.equal(h.state(), null)
})

test('six checkbox defaults, clear/all controls and delegated changes update real selection state', () => {
  const h = harness()
  assert.equal(h.inputs().length, 6)
  assert.ok(h.inputs().every((input) => input.checked && !input.disabled))
  assert.equal(h.$('btnWizardPluginsInstall').textContent, '安装选中的 6 个插件')
  h.check('mcp', false)
  assert.equal(h.inputs().find((input) => input.dataset.pluginSetupId === 'mcp').checked, false)
  assert.equal(h.$('wizardPluginSelectedCount').textContent, '已选 5/6')
  assert.equal(h.$('btnWizardPluginsInstall').textContent, '安装选中的 5 个插件')
  h.$('btnWizardPluginsClear').click()
  assert.ok(h.inputs().every((input) => !input.checked))
  assert.equal(h.$('btnWizardPluginsInstall').disabled, true)
  assert.equal(h.$('btnWizardPluginsSkip').disabled, false)
  h.$('btnWizardPluginsAll').click()
  assert.ok(h.inputs().every((input) => input.checked))
  assert.equal(h.$('btnWizardPluginsInstall').disabled, false)
})

test('checkbox draft survives pending broadcasts, list rebuilds and leaving/reopening wizard', () => {
  const h = harness()
  h.check('mcp', false)
  h.context.renderPluginSetup({ ...baseSetup, selectedIds: [] }, plugins)
  assert.equal(h.context.pluginSetupSelectedIds().length, 5)
  h.$('btnWizardPluginsMain').click()
  h.context.showPage('wizard')
  h.context.renderPluginSetup({ ...baseSetup, selectedIds: null }, plugins.map((p) => ({ ...p, description: p.description + ' updated' })))
  assert.equal(h.inputs().find((input) => input.dataset.pluginSetupId === 'mcp').checked, false)
  assert.equal(h.$('wizardPluginSelectedCount').textContent, '已选 5/6')
})

test('explicit saved subset initializes checkboxes, legacy null initializes all', () => {
  const h = harness({ setup: { ...baseSetup, selectedIds: ['mcp', 'market'] } })
  assert.deepEqual(Array.from(h.context.pluginSetupSelectedIds()), ['market', 'mcp'])
  assert.equal(h.inputs().filter((input) => input.checked).length, 2)
  const old = harness({ firstRun: false, setup: { ...baseSetup, choice: 'install', completed: true, selectedIds: null } })
  assert.ok(old.inputs().every((input) => input.checked && input.disabled))
})

test('empty install sends no IPC, but skip persists an empty selectedIds array', async () => {
  const h = harness({ ready: false })
  h.$('btnWizardPluginsClear').click()
  await h.context.choosePluginSetup('install')
  assert.equal(h.calls.some((call) => call.name === 'pluginsSetSetupChoice'), false)
  h.command(async (name) => name === 'pluginsSetSetupChoice' ? { ok: true, choice: 'skip', selectedIds: [] } : null)
  await h.context.choosePluginSetup('skip')
  const payload = h.calls.find((call) => call.name === 'pluginsSetSetupChoice').value
  assert.equal(payload.choice, 'skip')
  assert.deepEqual(Array.from(payload.selectedIds), [])
  assert.deepEqual(Array.from(h.context.window._pluginSetup.selectedIds), [])
})

test('delegated checkbox subset is sent in catalog order and canonical acknowledgment is retained', async () => {
  const h = harness({ ready: false })
  h.$('btnWizardPluginsClear').click()
  h.check('mcp', true)
  h.check('market', true)
  h.command(async (name) => name === 'pluginsSetSetupChoice' ? { ok: true, choice: 'install', selectedIds: ['market', 'mcp'] } : null)
  await h.context.choosePluginSetup('install')
  const payload = h.calls.find((call) => call.name === 'pluginsSetSetupChoice').value
  assert.deepEqual(Array.from(payload.selectedIds), ['market', 'mcp'])
  assert.deepEqual(Array.from(h.context.window._pluginSetup.selectedIds), ['market', 'mcp'])
  assert.deepEqual(Array.from(h.context.pluginSetupSelectedIds()), ['market', 'mcp'])
})

test('submitting and running freeze all/clear and checkbox delegated mutations', async () => {
  const h = harness({ ready: false })
  h.check('mcp', false)
  const ack = deferred()
  h.command(async (name) => name === 'pluginsSetSetupChoice' ? ack.promise : null)
  const save = h.context.choosePluginSetup('install')
  assert.ok(h.inputs().every((input) => input.disabled))
  h.check('mcp', true)
  h.$('btnWizardPluginsAll').click()
  h.$('btnWizardPluginsClear').click()
  assert.equal(h.context.pluginSetupSelectedIds().length, 5)
  ack.resolve({ ok: false, error: 'disk denied' })
  await save
  assert.equal(h.context.pluginSetupSelectedIds().length, 5)
  assert.equal(h.inputs().find((input) => input.dataset.pluginSetupId === 'mcp').checked, false)
  h.setSetup({ choice: 'install', running: true, selectedIds: ['market'] })
  assert.ok(h.inputs().every((input) => input.disabled))
  h.$('btnWizardPluginsClear').click()
  h.check('mcp', true)
  assert.equal(h.context.pluginSetupSelectedIds().length, 5)
})

test('delegated change rejects elements outside the list and unknown plugin IDs', () => {
  const h = harness()
  const foreign = { dataset: { pluginSetupId: 'market' }, checked: false, closest() { return this } }
  h.$('wizardPluginList').emit('change', { target: foreign })
  assert.equal(h.context.pluginSetupSelectedIds().length, 6)
  const unknown = { dataset: { pluginSetupId: 'not-allowed' }, checked: true, closest() { return this } }
  h.inputs().push(unknown)
  h.$('wizardPluginList').emit('change', { target: unknown })
  assert.equal(h.context.pluginSetupSelectedIds().length, 6)
})

test('actual toolbar entry rereads saved subset/skip/null and enables editing without writing config', async () => {
  for (const saved of [
    { choice: 'install', selectedIds: ['market', 'mcp'] },
    { choice: 'skip', selectedIds: [] },
    { choice: 'install', selectedIds: null },
  ]) {
    const h = harness({ setup: { ...baseSetup, choice: 'install', completed: true, selectedIds: ['usage'] } })
    h.command(async (name) => name === 'getState' ? {
      pluginSetup: { ...baseSetup, completed: true, ...saved }, pluginSetupPlugins: plugins,
      env: { ready: true }, running: true,
    } : null)
    await h.$('btnPluginsSetup').click()
    assert.equal(h.context.window._pluginSetupEditing, true)
    assert.equal(h.context.pluginSetupPending(), false, 'must not synthesize persisted pending')
    assert.equal(h.context.pluginSetupSelecting(), true)
    assert.equal(h.visible('wizardPlugins'), true)
    assert.equal(h.visible('btnWizardPluginsBack'), true)
    assert.equal(h.$('wizardPluginTitle').textContent, '预装插件选择')
    assert.equal(h.context.document.title, 'DSHL 控制台 · 预装插件选择')
    const expected = saved.selectedIds === null ? plugins.map((p) => p.id) : saved.selectedIds
    assert.deepEqual(Array.from(h.context.pluginSetupSelectedIds()), expected)
    assert.ok(h.inputs().every((input) => !input.disabled))
    assert.equal(h.calls.some((call) => call.name === 'pluginsSetSetupChoice'), false)
  }
  assert.match(html, /id="btnPluginsSetup"[^>]*>预装插件选择<\/button>/)
})

test('editing draft survives saved-state broadcasts and environment done; return discards without IPC', async () => {
  const h = harness({ setup: { ...baseSetup, choice: 'install', completed: true, selectedIds: ['market', 'mcp'] } })
  const saved = { pluginSetup: { ...baseSetup, choice: 'install', completed: true, selectedIds: ['market', 'mcp'] },
    pluginSetupPlugins: plugins, env: { ready: true }, running: true }
  h.command(async (name) => name === 'getState' ? saved : null)
  await h.$('btnPluginsSetup').click()
  h.check('mcp', false)
  h.check('usage', true)
  h.context.render(saved)
  h.context.renderWizardJob({ status: 'done', items: [] })
  h.context.showWizardScreen('done')
  assert.equal(h.visible('wizardPlugins'), true)
  assert.equal(h.context.pluginSetupBlocksFinish(), true)
  assert.equal(h.state(), null)
  assert.deepEqual(Array.from(h.context.pluginSetupSelectedIds()), ['market', 'usage'])
  h.$('btnWizardPluginsBack').click()
  assert.equal(h.context.window._pluginSetupEditing, false)
  assert.equal(h.context.window._wizardActive, false)
  assert.equal(h.visible('pagePlugins'), true)
  assert.deepEqual(Array.from(h.context.pluginSetupSelectedIds()), ['market', 'mcp'])
  assert.equal(h.calls.some((call) => call.name === 'pluginsSetSetupChoice'), false)
})

test('entry is immediately disabled by batch/submission/profile busy, including readback lock races', async () => {
  for (const busy of ['running', 'submitting', 'profile']) {
    const h = harness({ setup: { ...baseSetup, choice: 'skip', selectedIds: [] } })
    if (busy === 'running') h.context.window._pluginSetup.running = true
    if (busy === 'submitting') h.context.window._pluginSetupSubmitting = true
    if (busy === 'profile') h.context.window._pluginOpBusy = true
    h.context.renderPluginSetup()
    assert.equal(h.$('btnPluginsSetup').disabled, true)
    const count = h.calls.length
    await h.$('btnPluginsSetup').click()
    assert.equal(h.calls.length, count)
    assert.equal(h.context.window._pluginSetupEditing, undefined)
  }
  const h = harness({ setup: { ...baseSetup, choice: 'skip', selectedIds: [] } })
  const snapshot = { pluginSetup: { ...baseSetup, choice: 'skip', selectedIds: [] }, pluginOp: { busy: true }, env: { ready: true }, running: true }
  h.command(async (name) => name === 'getState' ? snapshot : null)
  await h.$('btnPluginsSetup').click()
  assert.equal(h.$('btnPluginsSetup').disabled, true)
  assert.equal(h.context.window._pluginSetupEditing, undefined)
  h.context.render(snapshot)
  assert.equal(h.$('btnPluginsSetup').disabled, true)
})

test('reselecting saved skip via real entry persists new IDs; saving skip returns to plugins not stale done', async () => {
  for (const choice of ['install', 'skip']) {
    const h = harness({ setup: { ...baseSetup, choice: 'skip', completed: true, selectedIds: [] } })
    h.command(async (name, value) => {
      if (name === 'pluginsSetSetupChoice') return { ok: true, choice: value.choice, selectedIds: Array.from(value.selectedIds) }
      if (name === 'getState') return {
        pluginSetup: { ...baseSetup, choice: 'skip', completed: true, selectedIds: [] }, pluginSetupPlugins: plugins,
        env: { ready: true }, running: true,
      }
      return null
    })
    await h.$('btnPluginsSetup').click()
    h.check('mcp', true)
    h.check('market', true)
    await h.context.choosePluginSetup(choice)
    const payload = h.calls.find((call) => call.name === 'pluginsSetSetupChoice').value
    assert.equal(payload.choice, choice)
    assert.deepEqual(Array.from(payload.selectedIds), choice === 'skip' ? [] : ['market', 'mcp'])
    assert.equal(h.context.window._pluginSetupEditing, false)
    if (choice === 'skip') {
      assert.equal(h.visible('pagePlugins'), true)
      assert.equal(h.visible('pageWizard'), false)
      assert.equal(h.context.window._wizardActive, false)
      assert.equal(h.state(), null)
    } else {
      assert.equal(h.state(), null, 'stale previous skip completed cannot complete new install')
      assert.equal(h.context.window._pluginSetup.completed, false)
      assert.equal(h.visible('wizardPlugins'), true)
    }
  }
})

test('real pending return button cannot invent skip, and failed entry read leaves saved config unchanged', async () => {
  const pending = harness()
  pending.$('btnWizardPluginsBack').click()
  assert.equal(pending.context.window._pluginSetup.choice, 'pending')
  assert.equal(pending.visible('pageWizard'), true)
  assert.equal(pending.calls.some((call) => call.name === 'pluginsSetSetupChoice'), false)
  const saved = harness({ setup: { ...baseSetup, choice: 'skip', selectedIds: [] } })
  await saved.$('btnPluginsSetup').click()
  assert.equal(saved.context.window._pluginSetupEditing, undefined)
  assert.equal(saved.context.window._pluginSetup.choice, 'skip')
  assert.deepEqual(Array.from(saved.context.window._pluginSetup.selectedIds), [])
})

test('plugin list is escaped, data driven and choice controls are wired into existing wizard', () => {
  const h = harness()
  assert.match(h.$('wizardPluginList').innerHTML, /MCP 连接器/)
  assert.match(h.$('wizardPluginList').innerHTML, /dsh-mcp-connector/)
  assert.match(h.$('wizardPluginList').innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/)
  assert.doesNotMatch(h.$('wizardPluginList').innerHTML, /<script>/)
  for (const id of ['wizardPlugins', 'wizardPluginList', 'btnWizardPluginsInstall', 'btnWizardPluginsSkip']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(html, /跳过不会影响 DSH 使用/)
  assert.doesNotMatch(html, /不修改系统设置/)
})
