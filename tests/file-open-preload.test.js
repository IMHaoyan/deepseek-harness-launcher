// tests/file-open-preload.test.js — Ctrl+点击文件链接的 preload 捕获行为（真跑 browser-preload.js）
//
// 背景（2026-10-27）：DSH 的 Markdown 文件链接是 `<button title="<链接原文>">`，普通点击只在右侧栏
// 预览。用户要求 Ctrl/Cmd+点击时用 Windows 默认程序打开（exe 直接运行）。实现放在 preload 隔离世界：
// 主世界拿不到这个能力，只有真实用户手势能触发；主进程仍会复核发送方与路径。
//
// 同日真机两轮反馈后，preload 分三条路（测试逐条锁住）：
//   A 绝对路径 title（含 @ 提及绝对路径）→ 直接拦截 + 请求打开；
//   B 相对路径 title（相对链接 / 相对 @ 提及）→ 取点击所在会话的 data-conversation-session，
//     同步请主进程用 DSH 的 workspace.json 还原绝对路径，成功才拦截；
//   C title 缺失（图片链接等）→ 放行 DSH 预览，再从 [data-textpreview-path] 读绝对路径打开。
// 另外锁住：无修饰键不拦、非本机 DSH 页不挂监听、预览多页/隐藏旧页时只认这次点击的那一个。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { URL } = require('node:url')

const root = path.resolve(__dirname, '..')
const preloadSrc = fs.readFileSync(path.join(root, 'browser-preload.js'), 'utf8').replace(/\r\n?/gu, '\n')
const PREVIEW_SELECTOR = '[data-textpreview-path]'
const SESSION_SELECTOR = '[data-conversation-session]'

/** 造一个预览头部 PathLabel 节点；title 就是 Host 解析后的路径。 */
function previewNode(title, visible = true) {
  return {
    title,
    visible,
    getAttribute(name) { return name === 'title' ? title : null },
    closest(selector) { return visible ? null : { hidden: true, selector } },
    getClientRects() { return visible ? [{}] : [] },
  }
}

/** 造一个带 data-conversation-session 的节点。 */
function sessionNode(value) {
  if (value === undefined) return null
  return { getAttribute: (name) => (name === 'data-conversation-session' ? value : null) }
}

/**
 * 在沙箱里执行真实 preload 源码。
 * @param {{origin?: object|null, href?: string, syncThrows?: boolean, documentSession?: string,
 *          resolve?: (payload: object) => object, resolveResult?: object,
 *          previews?: Array<{title: string, visible?: boolean}>}} options
 */
function runPreload(options = {}) {
  const exposed = {}
  const listeners = []
  const calls = []
  const syncCalls = []
  const observers = []
  const previews = (options.previews || []).map((item) => previewNode(item.title, item.visible !== false))
  const sync = (channel, payload) => {
    if (options.syncThrows) throw new Error('ipc unavailable')
    if (channel === 'dshl:file-open:origin') {
      return options.origin === undefined ? { host: '127.0.0.1', port: '3080' } : options.origin
    }
    if (channel === 'dshl:file-open:resolve') {
      syncCalls.push(payload)
      if (typeof options.resolve === 'function') return options.resolve(payload)
      return options.resolveResult === undefined ? { ok: false } : options.resolveResult
    }
    return null // 桌面壳配置：关闭 → 不暴露 dshDesktop
  }
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      observers.push(this)
    }
    observe() { /* 测试里手动 fire */ }
    disconnect() { this.disconnected = true }
    fire() {
      if (!this.disconnected) this.callback([], this)
    }
  }
  const document = {
    documentElement: { setAttribute: () => undefined },
    querySelectorAll: (selector) => (selector === PREVIEW_SELECTOR ? previews.slice() : []),
    querySelector: (selector) => (selector === SESSION_SELECTOR ? sessionNode(options.documentSession) : null),
  }
  const sandbox = {
    require(name) {
      if (name !== 'electron') throw new Error('sandbox preload 不允许 require：' + name)
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } },
        ipcRenderer: {
          sendSync: sync,
          on: () => undefined,
          removeListener: () => undefined,
          invoke: (channel, payload) => { calls.push({ channel, payload }); return Promise.resolve('{}') },
        },
      }
    },
    process: { platform: 'win32' },
    location: { href: options.href || 'http://127.0.0.1:3080/?token=abc' },
    window: { addEventListener: (type, handler, capture) => { listeners.push({ type, handler, capture }) } },
    document,
    MutationObserver: FakeMutationObserver,
    URL,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(preloadSrc, sandbox, { filename: 'browser-preload.js' })
  return {
    exposed,
    listeners,
    calls,
    syncCalls,
    observers,
    fireMutations: () => { for (const observer of observers) observer.fire() },
    addPreview: (title, visible = true) => { const node = previewNode(title, visible); previews.push(node); return node },
  }
}

function clickHandler(run) {
  const entry = run.listeners.find((item) => item.type === 'click' && item.capture === true)
  assert.ok(entry, '本机 DSH 页必须挂 click 捕获监听')
  return entry.handler
}

/**
 * 造一次点击事件。
 * @param {{ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, title?: string, text?: string,
 *          button?: boolean, session?: string}} options
 *   title 省略 = 按钮没有 title（图片链接）；button:false = 点的不是按钮；
 *   session 省略 = 按钮不在任何会话正文里。
 */
function clickEvent({ ctrlKey = true, metaKey = false, shiftKey = false, title, text = '', button = true, session } = {}) {
  const element = button
    ? {
        getAttribute: (name) => (name === 'title' && title !== undefined ? title : null),
        closest: (selector) => (selector === SESSION_SELECTOR ? sessionNode(session) : null),
        textContent: text,
      }
    : null
  const target = {
    closest(selector) {
      return selector === 'button' ? element : null
    },
  }
  return {
    ctrlKey,
    metaKey,
    shiftKey,
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
}

test('Ctrl+点击绝对路径链接：拦截并请求主进程用默认程序打开', () => {
  const run = runPreload()
  const handler = clickHandler(run)
  const absolute = 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dist\\dshl-1.4.13-alpha.1.exe'
  const event = clickEvent({ title: absolute })
  handler(event)
  assert.equal(event.defaultPrevented, true, '必须阻止 DSH 的"右侧栏预览"默认动作')
  assert.equal(event.propagationStopped, true, '捕获阶段就停住，React 的 onClick 不能再跑')
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].channel, 'dsh:file-open')
  assert.equal(run.calls[0].payload.path, absolute)
  assert.equal(run.calls[0].payload.mode, 'open')
  assert.equal(run.syncCalls.length, 0, '绝对路径不该去问会话解析')
})

test('Ctrl+Shift+点击：请求在文件管理器里定位', () => {
  const run = runPreload()
  const event = clickEvent({ shiftKey: true, title: 'C:/Users/gonghaoyan/Desktop/dshl/dist/a.exe' })
  clickHandler(run)(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.mode, 'reveal')
})

test('@ 提及 chip：title 是原始 mention 文本，剥掉 @ / 引号后按绝对路径处理', () => {
  const run = runPreload()
  const handler = clickHandler(run)
  handler(clickEvent({ title: '@C:\\Users\\gonghaoyan\\a b.txt' }))
  handler(clickEvent({ title: '@"C:\\Program Files\\Some App\\c.txt"' }))
  assert.deepEqual(run.calls.map((call) => call.payload.path), [
    'C:\\Users\\gonghaoyan\\a b.txt',
    'C:\\Program Files\\Some App\\c.txt',
  ])
  assert.equal(run.calls.every((call) => call.payload.mode === 'open'), true)
})

test('相对路径链接：用「点击所在会话 + 工作区映射」还原绝对路径，拦截且不打开预览', () => {
  const run = runPreload({
    documentSession: 'session-fallback',
    resolve: (payload) => (payload.sessionId === 'session-74b7110a' && payload.path === 'browser-preload.js'
      ? { ok: true, path: 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\browser-preload.js' }
      : { ok: false }),
  })
  const event = clickEvent({ title: 'browser-preload.js', text: 'browser-preload.js', session: 'session-74b7110a' })
  clickHandler(run)(event)
  assert.equal(event.defaultPrevented, true, '还原成功要拦下 DSH 的预览')
  assert.equal(event.propagationStopped, true)
  assert.equal(run.syncCalls.length, 1)
  assert.equal(run.syncCalls[0].sessionId, 'session-74b7110a')
  assert.equal(run.syncCalls[0].path, 'browser-preload.js')
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\browser-preload.js')
})

test('@ 相对提及 chip：同样走会话 + 工作区映射还原', () => {
  const run = runPreload({
    resolve: () => ({ ok: true, path: 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\browser-preload.js' }),
  })
  const event = clickEvent({ title: '@browser-preload.js', text: 'browser-preload.js', session: 'session-74b7110a' })
  clickHandler(run)(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(run.syncCalls.length, 1)
  assert.equal(run.syncCalls[0].sessionId, 'session-74b7110a')
  assert.equal(run.syncCalls[0].path, 'browser-preload.js')
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\browser-preload.js')
})

test('相对路径还原失败：不拦截，仍可走预览头部兜底', () => {
  const run = runPreload({ resolveResult: { ok: false } })
  const event = clickEvent({ title: 'dsh-update.js', text: 'dsh-update.js', session: 'session-x' })
  clickHandler(run)(event)
  assert.equal(event.defaultPrevented, false, '解析不出来就放行 DSH 原行为')
  assert.equal(run.syncCalls.length, 1)
  assert.equal(run.calls.length, 0)

  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js')
})

test('页面上没有会话节点：不问解析，直接走预览兜底', () => {
  const run = runPreload()
  const event = clickEvent({ title: 'dsh-update.js', text: 'dsh-update.js' })
  clickHandler(run)(event)
  assert.equal(event.defaultPrevented, false)
  assert.equal(run.syncCalls.length, 0)
  assert.equal(run.calls.length, 0)

  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
})

test('图片链接（按钮没有 title）：放行点击，等预览头部解析出绝对路径后再打开', () => {
  const run = runPreload()
  const handler = clickHandler(run)
  const event = clickEvent({ text: 'preview.png' }) // 没有 title
  handler(event)
  assert.equal(event.defaultPrevented, false)
  assert.equal(run.calls.length, 0)
  assert.equal(run.syncCalls.length, 0, '没有路径文本，不能去猜')

  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\test\\preview.png')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\test\\preview.png')
})

test('Ctrl+Shift 点击不可解析项：预览解析出来后请求定位', () => {
  const run = runPreload()
  clickHandler(run)(clickEvent({ shiftKey: true, text: 'dshl-update.js' }))
  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\dshl-update.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.mode, 'reveal')
})

test('重复点击已打开的文件：预览头部本来就在，按按钮文本里的文件名认领', () => {
  const run = runPreload({ previews: [{ title: 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js' }] })
  clickHandler(run)(clickEvent({ text: 'dsh-update.js' }))
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js')
})

test('隐藏的旧预览 + 新预览并存：只认这次点击新出现/变为可见的那一个', () => {
  const run = runPreload({ previews: [{ title: 'C:\\Users\\gonghaoyan\\Desktop\\other\\stale.js', visible: false }] })
  clickHandler(run)(clickEvent({ text: 'target.js' }))
  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\target.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\target.js')
})

test('多个新预览页：用按钮文本里的文件名收敛到唯一命中', () => {
  const run = runPreload()
  clickHandler(run)(clickEvent({ text: 'target.js' }))
  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\wrong.ts')
  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\target.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\target.js')
})

test('无修饰键点击 / 点的不是按钮：一律放行给 DSH 原行为', () => {
  const run = runPreload({ documentSession: 'session-x' })
  const handler = clickHandler(run)

  const plain = clickEvent({ ctrlKey: false, title: 'C:\\a.exe', session: 'session-x' })
  handler(plain)
  assert.equal(plain.defaultPrevented, false)

  const relativePlain = clickEvent({ ctrlKey: false, title: 'main.js', session: 'session-x' })
  handler(relativePlain)
  assert.equal(relativePlain.defaultPrevented, false)

  const notButton = clickEvent({ button: false })
  handler(notButton)
  assert.equal(notButton.defaultPrevented, false)

  assert.deepEqual(run.calls, [])
  assert.deepEqual(run.syncCalls, [])
})

test('点了一个不打开预览的按钮（tooltip 文本不是文件）：不会误开任何文件', () => {
  const run = runPreload()
  const event = clickEvent({ title: '复制', text: '复制' })
  clickHandler(run)(event)
  run.fireMutations()
  assert.equal(event.defaultPrevented, false)
  assert.deepEqual(run.calls, [])
})

test('非本机 DSH 页（file:// / 其它端口）：不挂监听', () => {
  for (const href of ['file:///C:/wwwroot/loading.html', 'http://127.0.0.1:9999/', 'https://example.com/']) {
    const run = runPreload({ href })
    assert.equal(run.listeners.length, 0, href + ' 不该拿到文件打开能力')
  }
})

test('主进程同步取 origin 失败：fail-closed，不挂监听', () => {
  const run = runPreload({ syncThrows: true })
  assert.equal(run.listeners.length, 0)
  assert.ok('browserBridge' in run.exposed, '安全桥不能被这件事挤掉')
})
