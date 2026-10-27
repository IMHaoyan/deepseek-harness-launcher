// file-open.js — 「Ctrl+点击文件链接 → 用系统默认程序打开」的参数归一化（纯函数：无 IO、无 Electron，可单测）
//
// 为什么单独一个模块：真正决定"能不能打开"的只有两类事实 —— 发送方是不是本机 DSH 页（信任判定在
// trust.isDshAppUrl，主进程负责）、以及请求里的路径是不是一个本地绝对路径（本模块负责）。
// 页面里的按钮 title 可能是 DSH 解析后的原文（含 `#L24` 已被上游剥掉、含前斜杠的 Windows 路径等），
// 这里统一成一个可直接交给 shell.openPath / shell.showItemInFolder 的路径，并把拒绝理由说清楚。
//
// 触发面只有浏览器视图 preload 的 Ctrl/Cmd+点击（页面脚本拿不到 IPC），本模块不是通用文件打开 API。
'use strict'

const MAX_PATH_LENGTH = 4096
const MODES = new Set(['open', 'reveal'])

/** Windows 本地绝对路径：盘符（C:/ 或 C:\）。 */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/u
/** UNC 路径：\\server\share\...（两个反斜杠开头且 server 非空）。 */
const UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]/u

/**
 * 把 `file:///C:/a/b.exe` 还原成 `C:/a/b.exe`；不是 file: 原样返回；无法解析返回空串。
 * @param {string} raw
 * @returns {string}
 */
function decodeFileUrl(raw) {
  if (!/^file:/iu.test(raw)) return raw
  try {
    const url = new URL(raw)
    if (url.protocol !== 'file:') return ''
    let pathname = decodeURIComponent(url.pathname)
    // file:///C:/x → /C:/x：盘符前面的斜杠不是路径的一部分
    if (/^\/[A-Za-z]:[\\/]/u.test(pathname)) pathname = pathname.slice(1)
    return pathname
  } catch {
    return ''
  }
}

/**
 * 校验并归一化一次"打开本地文件"请求。
 * @param {unknown} payload preload 发来的载荷（`{ path, mode }`）
 * @param {string} [platform] 目标平台（默认 process.platform，测试可注入 'win32' | 'darwin'）
 * @returns {{ ok: boolean, mode: 'open'|'reveal', path: string, error?: string }}
 */
function classifyOpenRequest(payload, platform = process.platform) {
  const value = payload && typeof payload === 'object' ? payload : {}
  const mode = MODES.has(value.mode) ? value.mode : 'open'
  const raw = typeof value.path === 'string' ? value.path.trim() : ''
  if (!raw) return { ok: false, mode, path: '', error: '缺少文件路径' }
  if (raw.length > MAX_PATH_LENGTH) return { ok: false, mode, path: '', error: '路径过长' }
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return { ok: false, mode, path: '', error: '路径包含控制字符' }
  const decoded = decodeFileUrl(raw)
  if (!decoded) return { ok: false, mode, path: '', error: '无法解析 file: 地址' }
  const windowsAbsolute = DRIVE_PATH.test(decoded) || UNC_PATH.test(decoded)
  const posixAbsolute = platform !== 'win32' && decoded.startsWith('/') && !decoded.startsWith('//')
  if (!windowsAbsolute && !posixAbsolute) return { ok: false, mode, path: '', error: '只接受本地绝对路径' }
  return { ok: true, mode, path: decoded }
}

module.exports = { MAX_PATH_LENGTH, classifyOpenRequest, decodeFileUrl }
