// tests/dsh-login-web-mode.test.js — DSH 必须以 web 模式运行，登录才能交给系统浏览器
//
// 2026-10-20 决策（替换 09-30 的 dshDesktop 标记做法）：
//   上游用 `"dshDesktop" in globalThis` 判断"跑在官方桌面壳里"，并因此切换登录路径：
//     · 有标记（desktop 分支）：只调用 Host 的 startSignIn，等**官方桌面壳**负责打开 authorizeUrl；
//       DSHL 不是官方壳 → 登录弹窗永远停在「复制登录链接」。
//     · 没标记（web 分支）：点击登录时 window.open('about:blank') 预开页，再把平台授权地址写进
//       popup.location → main.js webCreateTab 的窗口策略把首次真实导航交给系统默认浏览器。
// 实测（真实 DSH 0.2.1-rc.2）：无标记时「账号菜单 → 登录」存在且触发 window.open，所以这里
// 明确不暴露 dshDesktop，也不再把 DSH 地址经 argv 传进 preload。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const preloadSrc = read('browser-preload.js')
const mainJs = read('main.js')

/** 在沙箱里执行真实 preload 源码，返回它暴露到主世界的键。 */
function exposedKeys({ argv = ['electron'], origin = 'http://127.0.0.1:3080' } = {}) {
  const exposed = {}
  const sandbox = {
    require(name) {
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

test('不暴露 dshDesktop：DSH 必须走 web 登录分支', () => {
  for (const origin of ['http://127.0.0.1:3080', 'http://127.0.0.1:9999', 'https://example.com', 'file://']) {
    const exposed = exposedKeys({ origin })
    assert.ok(!('dshDesktop' in exposed), `${origin} 不能拿到 dshDesktop（否则登录退化成复制链接）`)
    assert.ok('browserBridge' in exposed, '安全桥不能被这件事挤掉')
  }
  assert.doesNotMatch(preloadSrc, /exposeInMainWorld\(\s*['"]dshDesktop['"]/u, '不要在 preload 里再暴露 dshDesktop')
})

test('preload 不再依赖 argv 里的 DSH 地址', () => {
  assert.doesNotMatch(preloadSrc, /dshl-dsh-origin/u, '旧标记链路（--dshl-dsh-origin）应移除')
  assert.doesNotMatch(preloadSrc, /process\.argv/u, 'preload 不需要再读 argv 判断 origin')
})

test('main.js：标签页不再注入 dshDesktop 标记所需的 argv', () => {
  const start = mainJs.indexOf('function webCreateTab')
  assert.ok(start > 0, '找不到 webCreateTab')
  const end = mainJs.indexOf('webActivateTab(id)', start)
  assert.ok(end > start, '找不到 webCreateTab 的结束标记')
  const block = mainJs.slice(start, end)
  assert.ok(block.includes("preload: path.join(__dirname, 'browser-preload.js')"), '标签页仍要挂安全桥 preload')
  assert.ok(!block.includes('--dshl-dsh-origin='), '不再注入 dshDesktop 标记参数')
  assert.ok(!block.includes('additionalArguments'), '标签页 webPreferences 不再需要 additionalArguments')
})

test('登录链路的另一半在 main.js：about:blank 隐藏预开页 + 首次导航交系统浏览器', () => {
  const start = mainJs.indexOf('function webCreateTab')
  const end = mainJs.indexOf('webActivateTab(id)', start)
  const block = mainJs.slice(start, end)
  assert.ok(block.includes("if (url === '' || url === 'about:blank')"), 'about:blank 预开页要放行（否则 DSH 拿不到 popup）')
  assert.ok(block.includes("wc.on('did-create-window'"), '要接住预开页')
  assert.ok(block.includes('shell.openExternal(targetUrl)'), '授权链接要交给系统默认浏览器')
  assert.ok(block.includes('child.destroy()'), '交出去后销毁隐藏窗口')
})
