// browser-preload.js — DSHL 浏览器壳的安全桥（contextIsolation + sandbox）
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserBridge', {
  send: (name, payload) => ipcRenderer.invoke('dsh:cmd', 'browser:' + name, payload),
  // 页面内查找专用通道：主进程只允许搜索发出命令的那个 webContents，不进入 browser:* 控制域。
  findCommand: (action, payload) => ipcRenderer.invoke('dsh:find', { action, payload }),
  onState: (cb) => ipcRenderer.on('browser:state', (_e, s) => { try { cb(s) } catch { /* noop */ } }),
  // 状态说明页的步骤进度（主进程在真实检查点推；页面按自己的 reason 过滤）
  onLoadingProgress: (cb) => ipcRenderer.on('loading:progress', (_e, p) => { try { cb(p) } catch { /* noop */ } }),
})

// ---------- dshDesktop 标记：只对本机 DSH 页面暴露 ----------
//
// 上游拿 `'dshDesktop' in globalThis` 当"当前跑在官方桌面壳里"的判据，而它管的远不止登录入口：
//   - dsh-client-ui-settings-account  注册账号设置页 / 登录弹窗（我们要的）
//   - dsh-client-ui-settings-models   关掉 API Key 自助引导与其设置入口
//   - dsh-client-ui-chat              默认展示模式 detailed → standard
//   - dsh-client-product-analytics    开启客户端埋点（在 web profile 下该插件行本身是 disabled）
// 所以它必须只落在真 DSH 页面上：window.open 出去的外部网页、以及启动器自己的
// file:// 说明页（location.origin 为 "file://"）都不得拿到它。
//
// 期望地址由主进程经 additionalArguments 传入：sandbox preload 只能 require
// electron/events/timers/url，读不到 main.js 里的 WEB_URL。读不到 argv 就不暴露——宁少不误。
const DSH_ORIGIN_FLAG = '--dshl-dsh-origin='
function dshPageOrigin() {
  try {
    for (const arg of process.argv || []) {
      const s = String(arg)
      if (s.startsWith(DSH_ORIGIN_FLAG)) return s.slice(DSH_ORIGIN_FLAG.length)
    }
  } catch { /* argv 不可读：当作未知地址处理 */ }
  return ''
}
const expectedOrigin = dshPageOrigin()
if (expectedOrigin !== '' && location.origin === expectedOrigin) {
  // 故意为空对象：上游只做 "dshDesktop" in globalThis 的存在性判断，其余读取点
  // （deviceInfo / shortcuts / keyboard）都带 ?. 或只在 runtime==='desktop' 时才取值，
  // 这里不提供它们，免得凭空多出没有实现支撑的能力。
  contextBridge.exposeInMainWorld('dshDesktop', {})
}
