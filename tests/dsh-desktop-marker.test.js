// tests/dsh-desktop-marker.test.js — dshDesktop 标记的暴露边界（2026-09-30）。
//
// 背景：上游把 `"dshDesktop" in globalThis` 当"跑在官方桌面壳里"的判据，用来决定要不要注册
// 账号设置页与登录弹窗。但同一个标记还牵动三处与登录无关的行为：
//   - dsh-client-ui-settings-models  关掉 API Key 自助引导与其设置入口
//   - dsh-client-ui-chat            默认展示模式 detailed → standard
//   - dsh-client-product-analytics  开客户端埋点
// 所以这个标记是"全局身份开关"，不是"显示登录按钮的开关"。它必须精确落在真 DSH 页面上：
// 经 window.open 出去的外部网页、启动器自己的 file:// 说明页都不能拿到。
// 这里跑的是 browser-preload.js 的真实源码（vm 沙箱 + 桩），不是复制一份逻辑。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const preloadSrc = fs.readFileSync(path.join(root, 'browser-preload.js'), 'utf8')
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

const DSH_ORIGIN = 'http://127.0.0.1:3080'
const ORIGIN_FLAG = `--dshl-dsh-origin=${DSH_ORIGIN}`

/** 在沙箱里执行真实 preload 源码，返回它暴露到主世界的键。 */
function exposeFor({ argv, origin }) {
  const exposed = {}
  const sandbox = {
    require(name) {
      // sandbox preload 的 require 只认 electron/events/timers/url；别的在这里就该炸
      if (name !== 'electron') throw new Error('sandbox preload 不允许 require：' + name)
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } },
        ipcRenderer: { invoke: async () => undefined, on: () => undefined },
      }
    },
    process: { argv },
    location: { origin },
    console,
  }
  vm.runInNewContext(preloadSrc, sandbox, { filename: 'browser-preload.js' })
  return exposed
}

test('DSH 页面：拿到 dshDesktop，安全桥不受影响', () => {
  const exposed = exposeFor({ argv: ['electron', ORIGIN_FLAG], origin: DSH_ORIGIN })
  assert.ok('dshDesktop' in exposed, 'DSH 页面必须拿到 dshDesktop，否则账号入口与登录弹窗不会注册')
  assert.ok('browserBridge' in exposed, '加了新标记不能把既有安全桥挤掉')
})

test('外部网页：不得被标记成官方桌面壳', () => {
  for (const origin of ['https://example.com', 'http://127.0.0.1:9999']) {
    const exposed = exposeFor({ argv: ['electron', ORIGIN_FLAG], origin })
    assert.ok(!('dshDesktop' in exposed), `${origin} 不能拿到 dshDesktop`)
    assert.ok('browserBridge' in exposed, `${origin} 仍需安全桥（查找/分屏控件要靠它）`)
  }
})

test('file:// 说明页：不得被标记成官方桌面壳', () => {
  const exposed = exposeFor({ argv: ['electron', ORIGIN_FLAG], origin: 'file://' })
  assert.ok(!('dshDesktop' in exposed), '启动器自己的 loading.html 等 file:// 页面不是 DSH 页面')
})

test('拿不到地址参数时不暴露（宁少不误）', () => {
  const exposed = exposeFor({ argv: ['electron', '--no-sandbox'], origin: DSH_ORIGIN })
  assert.ok(!('dshDesktop' in exposed), 'argv 里没有地址就无从比对，必须按不暴露处理')
})

test('argv 不可读时不抛异常，且不暴露', () => {
  const exposed = {}
  const sandbox = {
    require: () => ({
      contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v } },
      ipcRenderer: { invoke: async () => undefined, on: () => undefined },
    }),
    // 模拟受限运行时：读 argv 直接抛
    get process() { throw new Error('argv unavailable') },
    location: { origin: DSH_ORIGIN },
    console,
  }
  assert.doesNotThrow(() => vm.runInNewContext(preloadSrc, sandbox, { filename: 'browser-preload.js' }))
  assert.ok(!('dshDesktop' in exposed))
})

test('main.js 必须把本机 DSH 地址交给标签页 preload', () => {
  const start = mainJs.indexOf('function webCreateTab')
  assert.notEqual(start, -1, '找不到 webCreateTab')
  const end = mainJs.indexOf('webActivateTab(id)', start)
  assert.notEqual(end, -1, '找不到 webCreateTab 的结束标记')
  const block = mainJs.slice(start, end)
  assert.ok(
    block.includes('additionalArguments: [`--dshl-dsh-origin=${WEB_URL}`]'),
    'webCreateTab 必须注入 --dshl-dsh-origin，否则 DSH 页面永远拿不到 dshDesktop 标记',
  )
})
