// tests/file-open-preload.test.js — Ctrl+点击文件链接的 preload 捕获行为（真跑 browser-preload.js）
//
// 背景（2026-10-27）：DSH 的 Markdown 文件链接是 `<button title="<路径>">`，普通点击只在右侧栏预览。
// 用户要求 Ctrl/Cmd+点击时用 Windows 默认程序打开（exe 直接运行）。实现放在 preload 隔离世界：
// 主世界拿不到这个能力，只有真实用户手势能触发；主进程仍会复核发送方与路径。
//
// 这里用沙箱执行真实 preload 源码，锁住五条行为：
//   ① 本机 DSH 页才挂监听（file:// / 外部站点 / 说明页不挂）；② 无修饰键点击不拦截；
//   ③ Ctrl+点击 → dsh:file-open {mode:'open'}；④ Ctrl+Shift+点击 → {mode:'reveal'}；
//   ⑤ 非本地绝对路径的 title 不拦截（相对路径无法可靠解析，宁可不打开）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { URL } = require('node:url')

const root = path.resolve(__dirname, '..')
const preloadSrc = fs.readFileSync(path.join(root, 'browser-preload.js'), 'utf8').replace(/\r\n?/gu, '\n')

/**
 * 在沙箱里执行真实 preload 源码。
 * @param {{origin?: object|null, href?: string, syncThrows?: boolean}} options
 */
function runPreload(options = {}) {
  const exposed = {}
  const listeners = []
  const calls = []
  const sync = (channel) => {
    if (options.syncThrows) throw new Error('ipc unavailable')
    if (channel === 'dshl:file-open:origin') {
      return options.origin === undefined ? { host: '127.0.0.1', port: '3080' } : options.origin
    }
    return null // 桌面壳配置：关闭 → 不暴露 dshDesktop
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
    document: { documentElement: { setAttribute: () => undefined } },
    URL,
    console,
  }
  vm.runInNewContext(preloadSrc, sandbox, { filename: 'browser-preload.js' })
  return { exposed, listeners, calls }
}

function clickHandler(run) {
  const entry = run.listeners.find((item) => item.type === 'click' && item.capture === true)
  assert.ok(entry, '本机 DSH 页必须挂 click 捕获监听')
  return entry.handler
}

/** 造一次点击事件；title 为 undefined 表示点到的不是文件链接。 */
function clickEvent({ ctrlKey = true, metaKey = false, shiftKey = false, title } = {}) {
  const button = title === undefined ? null : { getAttribute: (name) => (name === 'title' ? title : null) }
  const target = {
    closest(selector) {
      return selector === 'button[title]' ? button : null
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

test('Ctrl+点击文件链接：拦截并请求主进程用默认程序打开', () => {
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

test('无修饰键点击 / 非文件链接 / 相对路径：一律放行给 DSH 原行为', () => {
  const run = runPreload()
  const handler = clickHandler(run)

  const plain = clickEvent({ ctrlKey: false, title: 'C:\\a.exe' })
  handler(plain)
  assert.equal(plain.defaultPrevented, false)

  const notFile = clickEvent({ title: undefined })
  handler(notFile)
  assert.equal(notFile.defaultPrevented, false)

  const relative = clickEvent({ title: 'dist\\dshl.exe' })
  handler(relative)
  assert.equal(relative.defaultPrevented, false, '相对路径无法可靠解析成绝对路径，宁可不打开')

  assert.deepEqual(run.calls, [], '以上都不该发 IPC')
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
