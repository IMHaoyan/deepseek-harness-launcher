// tests/file-open-preload.test.js — Ctrl+点击文件链接的 preload 捕获行为（真跑 browser-preload.js）
//
// 背景（2026-10-27）：DSH 的 Markdown 文件链接是 `<button title="<链接原文>">`，普通点击只在右侧栏
// 预览。用户要求 Ctrl/Cmd+点击时用 Windows 默认程序打开（exe 直接运行）。实现放在 preload 隔离世界：
// 主世界拿不到这个能力，只有真实用户手势能触发；主进程仍会复核发送方与路径。
//
// 真机反馈（同一天）后补了 B 路：相对路径链接 / 图片链接（DSH 不写 title）/ @ 提及 chip 拿不到
// 绝对路径，preload 放行 DSH 的普通点击，观察预览头部 [data-textpreview-path] 的 title
// （Host 解析后的绝对路径），再交给主进程。这里用沙箱执行真实 preload 源码，锁住：
//   ① 本机 DSH 页才挂监听（file:// / 外部站点 / 说明页不挂）；② 无修饰键点击不拦截；
//   ③ title 是绝对路径（含 @ 前缀 / 引号形式）→ 直接拦截并请求打开；
//   ④ Ctrl+Shift+点击 → {mode:'reveal'}；
//   ⑤ 相对路径 / 图片按钮 → 不拦截、不立即发 IPC，等预览头部解析出绝对路径再发；
//   ⑥ 隐藏的旧预览、多个预览页并存时，只挑这次点击打开的那一个；2 秒内没等到就不打开。
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

/**
 * 在沙箱里执行真实 preload 源码。
 * @param {{origin?: object|null, href?: string, syncThrows?: boolean, previews?: Array<{title: string, visible?: boolean}>}} options
 */
function runPreload(options = {}) {
  const exposed = {}
  const listeners = []
  const calls = []
  const observers = []
  const previews = (options.previews || []).map((item) => previewNode(item.title, item.visible !== false))
  const sync = (channel) => {
    if (options.syncThrows) throw new Error('ipc unavailable')
    if (channel === 'dshl:file-open:origin') {
      return options.origin === undefined ? { host: '127.0.0.1', port: '3080' } : options.origin
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
 * @param {{ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, title?: string, text?: string, button?: boolean}} options
 *   title 省略 = 按钮没有 title（图片链接）；button:false = 点的不是按钮。
 */
function clickEvent({ ctrlKey = true, metaKey = false, shiftKey = false, title, text = '', button = true } = {}) {
  const element = button
    ? {
        getAttribute: (name) => (name === 'title' && title !== undefined ? title : null),
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
  const path = 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dist\\dshl-1.4.13-alpha.1.exe'
  const event = clickEvent({ title: path })
  handler(event)
  assert.equal(event.defaultPrevented, true, '必须阻止 DSH 的"右侧栏预览"默认动作')
  assert.equal(event.propagationStopped, true, '捕获阶段就停住，React 的 onClick 不能再跑')
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].channel, 'dsh:file-open')
  assert.equal(run.calls[0].payload.path, path)
  assert.equal(run.calls[0].payload.mode, 'open')
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

test('无修饰键点击 / 点的不是按钮 / @ 相对路径：一律放行给 DSH 原行为', () => {
  const run = runPreload()
  const handler = clickHandler(run)

  const plain = clickEvent({ ctrlKey: false, title: 'C:\\a.exe' })
  handler(plain)
  assert.equal(plain.defaultPrevented, false)

  const notButton = clickEvent({ button: false })
  handler(notButton)
  assert.equal(notButton.defaultPrevented, false)

  const relativeMention = clickEvent({ title: '@src/main.js', text: 'main.js' })
  handler(relativeMention)
  assert.equal(relativeMention.defaultPrevented, false, '相对路径无法可靠解析成绝对路径，不能拦截')

  assert.deepEqual(run.calls, [], '以上都不该立即发 IPC')
})

test('相对路径链接：放行点击，等预览头部解析出绝对路径后再打开', () => {
  const run = runPreload()
  const handler = clickHandler(run)
  const event = clickEvent({ title: 'dsh-update.js#L496-L546', text: 'dsh-update.js' })
  handler(event)
  assert.equal(event.defaultPrevented, false, '必须放行，DSH 才会打开右侧栏预览')
  assert.equal(run.calls.length, 0, '预览头部还没出现，不能瞎猜路径')

  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].channel, 'dsh:file-open')
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js')
  assert.equal(run.calls[0].payload.mode, 'open')
})

test('图片链接（按钮没有 title）：同样走预览头部兜底', () => {
  const run = runPreload()
  const handler = clickHandler(run)
  const event = clickEvent({ text: 'preview.png' }) // 没有 title
  handler(event)
  assert.equal(event.defaultPrevented, false)
  assert.equal(run.calls.length, 0)

  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\test\\preview.png')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\test\\preview.png')
})

test('Ctrl+Shift 点击相对路径：预览解析出来后请求定位', () => {
  const run = runPreload()
  clickHandler(run)(clickEvent({ shiftKey: true, title: 'dshl-update.js', text: 'dshl-update.js' }))
  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\dshl-update.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.mode, 'reveal')
})

test('重复点击已打开的文件：预览头部本来就在，按按钮文本里的文件名认领', () => {
  const run = runPreload({ previews: [{ title: 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js' }] })
  clickHandler(run)(clickEvent({ title: 'dsh-update.js', text: 'dsh-update.js' }))
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\dsh-update.js')
})

test('隐藏的旧预览 + 新预览并存：只认这次点击新出现/变为可见的那一个', () => {
  const run = runPreload({ previews: [{ title: 'C:\\Users\\gonghaoyan\\Desktop\\other\\stale.js', visible: false }] })
  clickHandler(run)(clickEvent({ title: 'target.js', text: 'target.js' }))
  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\target.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\target.js')
})

test('多个新预览页：用按钮文本里的文件名收敛到唯一命中', () => {
  const run = runPreload()
  clickHandler(run)(clickEvent({ title: 'target.js', text: 'target.js' }))
  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\wrong.ts')
  run.addPreview('C:\\Users\\gonghaoyan\\Desktop\\dshl\\target.js')
  run.fireMutations()
  assert.equal(run.calls.length, 1)
  assert.equal(run.calls[0].payload.path, 'C:\\Users\\gonghaoyan\\Desktop\\dshl\\target.js')
})

test('点了一个不打开预览的按钮：不会误开任何文件', () => {
  const run = runPreload()
  const event = clickEvent({ text: '复制' })
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
