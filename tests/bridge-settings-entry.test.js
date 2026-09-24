const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const { Script, createContext } = require('node:vm')

const archive = join(__dirname, '..', 'assets', 'bridge-next', 'bridge-next.tgz')
const client = execFileSync('tar', ['-xOzf', archive, 'package/lib/client.js'], { maxBuffer: 2 * 1024 * 1024 }).toString('utf8')
const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json']).toString('utf8'))
const meta = JSON.parse(readFileSync(join(__dirname, '..', 'assets', 'bridge-next', 'version.json'), 'utf8'))

function registrations(source) {
  let loaded
  const vm = createContext({ window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } } })
  new Script(source).runInContext(vm)
  const layoutEffects = []
  const reactMock = {
    createContext: () => ({ Provider: () => null, Consumer: () => null }),
    forwardRef: (component) => component, memo: (component) => component,
    useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn, useId: () => 'phone-test', useEffect: () => {},
    useLayoutEffect: (fn) => layoutEffects.push(fn),
  }
  const plugin = loaded.factory((name) => {
    if (name === 'react') return reactMock
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected client import: ${name}`)
  })
  const registered = []
  const ctx = {
    connection: { rpc: {} },
    inject: () => {}, // selection observable; this test covers only UI registration
    effect: (install) => install(),
    slots: {
      inject: (_, install) => install(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { registered, plugin, vm, layoutEffects }
}

test('Bridge 2.0 client entry resides only under Settings after Plugin Market', async () => {
  const { MARKER, patchClient } = await import('../integrations/bridge-settings-entry/patch-client.mjs')
  assert.equal(manifest.version, meta.version)
  assert.equal(manifest.name, '@agents-anywhere/dsh-bridge-next')
  assert.ok(client.includes(MARKER))
  assert.doesNotMatch(client, /sidebar\.footer\.action/)
  assert.equal(patchClient(client).changed, false, 'patch must be idempotent')
  const { registered, plugin } = registrations(client)
  assert.equal([...plugin.inject].join(','), 'slots,connection')
  const section = registered.find(({ options }) => options.name === 'settings.section')
  const icon = registered.find(({ options }) => options.name === 'settings.action')
  assert.ok(section)
  assert.equal(section.options.id, 'agents-anywhere-mobile')
  assert.equal(section.options.order, 16)
  assert.equal(section.options.label(), '手机连接')
  assert.ok(icon, 'phone icon adapter should mount only in the Settings dialog')
  assert.equal(icon.options.id, 'agents-anywhere-phone-icon')
  assert.ok(!registered.some(({ options }) => options.name === 'sidebar.footer.action'))
  assert.match(client, /data-agents-anywhere-phone/)
  assert.match(client, /function ConnectionEntry\(\{ host \}\)/)
  assert.doesNotMatch(client.slice(client.indexOf('function ConnectionEntry({ host })'), client.indexOf('function PhoneSettingsNavIcon')), /\.Modal|\.Tooltip|aria-haspopup/)
})


test('Settings section renders in-place and only its nav row receives a phone icon', () => {
  const { registered, vm, layoutEffects } = registrations(client)
  const section = registered.find(({ options }) => options.name === 'settings.section')
  const panel = section.component({ host: {} })
  assert.equal(panel.type, 'div')
  assert.equal(panel.props.className, 'aa-settings-section')
  assert.ok(panel.props.children.some(({ props }) => props?.role === 'tablist'))
  const icon = registered.find(({ options }) => options.name === 'settings.action')
  const anchor = icon.component()
  assert.equal(anchor.type, 'span')
  const attrs = new Map()
  const phoneRow = {
    querySelector: () => ({ textContent: '手机连接' }),
    setAttribute: (key, value) => attrs.set(key, value),
    removeAttribute: (key) => attrs.delete(key),
  }
  const otherRow = { querySelector: () => ({ textContent: '插件市场' }) }
  const nav = { querySelectorAll: () => [otherRow, phoneRow] }
  anchor.props.ref.current = { closest: () => ({ querySelector: () => nav }) }
  let css
  vm.document = {
    createElement: () => ({ dataset: {}, remove() { css = null } }),
    head: { appendChild(style) { css = style } },
  }
  vm.MutationObserver = class { observe() {} disconnect() {} }
  const cleanup = layoutEffects.pop()()
  assert.ok(attrs.has('data-agents-anywhere-phone'))
  assert.match(css.textContent, /data-agents-anywhere-phone.*mask:/)
  assert.equal(otherRow['data-agents-anywhere-phone'], undefined)
  cleanup()
  assert.ok(!attrs.has('data-agents-anywhere-phone'))
})
