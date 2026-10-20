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

// ---------- 故意不暴露 dshDesktop 标记（2026-10-20 决策，替换 09-30 的旧做法） ----------
//
// 上游用 `"dshDesktop" in globalThis` 当"跑在官方桌面壳里"的判据，而它会切换账号登录路径：
//   - 有标记 → DSH 走 desktop 分支：只调用 Host 的 startSignIn，然后**等官方桌面壳**替它打开
//     平台授权页（官方桌面 App 自己实现了这一步）。DSHL 不是官方壳，于是登录弹窗永远停在
//     「没有自动打开新页面？复制登录链接」——用户只能手动粘贴。
//   - 没标记 → DSH 走 web 分支：点击登录时先 window.open('about:blank') 预开标签页，拿到
//     authorizeUrl 后再写进 popup.location。DSHL 的窗口策略（main.js webCreateTab）会把这个
//     隐藏预开页的第一次真实导航交给系统默认浏览器；登录回调仍走 DSH Host 的 /oauth/callback，
//     由 Host 轮询 attempt 状态完成闭环。
//
// 当前 DSH（0.2.1-rc.2）的账号设置页与登录入口在 web 模式下同样注册（已用真实 DSH UI 实测：
// 无标记时「账号菜单 → 登录」存在且会触发 window.open）。标记只额外影响 API Key 自助引导、
// 会话展示默认模式、客户端埋点等非登录行为，那些差异对启动器可接受。
