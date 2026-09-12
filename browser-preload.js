// browser-preload.js — DSHL 浏览器壳的安全桥（contextIsolation + sandbox）
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserBridge', {
  send: (name, payload) => ipcRenderer.invoke('dsh:cmd', 'browser:' + name, payload),
  onState: (cb) => ipcRenderer.on('browser:state', (_e, s) => { try { cb(s) } catch { /* noop */ } }),
  // 状态说明页的步骤进度（主进程在真实检查点推；页面按自己的 reason 过滤）
  onLoadingProgress: (cb) => ipcRenderer.on('loading:progress', (_e, p) => { try { cb(p) } catch { /* noop */ } }),
})
