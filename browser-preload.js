// browser-preload.js — DSHL 浏览器壳的安全桥（contextIsolation + sandbox）
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserBridge', {
  send: (name, payload) => ipcRenderer.invoke('dsh:cmd', 'browser:' + name, payload),
  onState: (cb) => ipcRenderer.on('browser:state', (_e, s) => { try { cb(s) } catch { /* noop */ } }),
})
