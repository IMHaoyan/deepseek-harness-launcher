// preload.js — 渲染进程与主进程之间的最小桥（sandbox + contextIsolation 安全模型）
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshBridge', {
  // 命令信封：cmd('getState') → 状态 JSON 字符串；其余命令 → '{}'
  cmd: (name, value) => ipcRenderer.invoke('dsh:cmd', name, value),
  // 主进程状态推送（JSON 字符串）
  onState: (cb) => ipcRenderer.on('dsh:state', (_event, json) => { try { cb(json) } catch { /* noop */ } }),
  // 环境安装任务推送（JSON 字符串：{job, lines}）
  onEnv: (cb) => ipcRenderer.on('dsh:env', (_event, json) => { try { cb(json) } catch { /* noop */ } }),
  // 自动更新状态推送（JSON 字符串）
  onUpdater: (cb) => ipcRenderer.on('dsh:updater', (_event, json) => { try { cb(json) } catch { /* noop */ } }),
  // 控制台定向跳页推送（JSON 字符串：{page}）——托盘「恢复…」等入口
  onConsolePage: (cb) => ipcRenderer.on('console:page', (_event, json) => { try { cb(json) } catch { /* noop */ } }),
})
