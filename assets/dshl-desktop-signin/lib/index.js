// dshl-desktop-signin — DSH host 侧登录辅助（由 DSHL 在启用桌面壳时安装）
//
// 为什么在 Host 侧：一旦渲染进程带上 dshDesktop 标记，DSH 账号登录会走 desktop 分支
// （dsh-client-ui-settings-account：startSignIn(..., 'desktop')）。desktop 分支不再由前端
// 预开标签页，Host 只等浏览器回调；官方桌面 App 由自己的主进程打开 authorizeUrl。
// DSHL 不是官方壳，所以必须补这一步，否则登录弹窗停在「复制登录链接」。
//
// 开关：只认 DSHL 写的就绪标记（<DSH_HOME>/dshl/desktop-shell.active）。标记不存在时本插件是
// 严格 no-op —— 保证 DSH 退回 web runtime（标记/桥未就绪、配置关闭）时不会替浏览器模式再开一个页。
//
// 边界：只处理 waiting-browser 阶段、只打开 https（或回环 http）地址、按 attempt id 去重；
// 打开失败只记日志，UI 里始终保留「复制链接」兜底。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dshl-desktop-signin'
export const inject = ['deepseekAccount']

/** attempt id 去重上限：登录尝试很少，超出只丢最旧的一条。 */
const MAX_REMEMBERED = 32

function dshHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/** DSHL 在桌面壳桥就绪时写、关闭/退出时删。 */
function desktopShellActive() {
  try {
    return fs.statSync(path.join(dshHome(), 'dshl', 'desktop-shell.active')).isFile()
  } catch {
    return false
  }
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost'
}

/**
 * 只放行 https（或回环 http）：授权地址来自 Host 的 Platform 响应，但这里仍做协议/凭据校验，
 * 避免把任意 scheme 交给系统打开器。
 * @param {unknown} raw
 * @returns {URL|null}
 */
function safeAuthorizeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) return null
  if (url.username || url.password) return null
  return url
}

/** 交系统默认浏览器；detached 且忽略 stdio，不阻塞 Host 进程。 */
function openInBrowser(url) {
  const target = url.href
  const options = { detached: true, stdio: 'ignore', windowsHide: true }
  if (process.platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', target], options).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', [target], options).unref()
    return
  }
  spawn('xdg-open', [target], options).unref()
}

function info(ctx, message) {
  try { ctx.logger.info(message) } catch { /* logger 不可用不影响主流程 */ }
}

function warn(ctx, message) {
  try { ctx.logger.warn(message) } catch { /* noop */ }
}

/**
 * @param {object} ctx host plugin context
 */
export function apply(ctx) {
  const opened = []
  ctx.effect(() => {
    const controller = new AbortController()
    const run = async () => {
      try {
        for await (const snapshot of ctx.deepseekAccount.watch(controller.signal)) {
          if (controller.signal.aborted) return
          const attempt = snapshot && snapshot.attempt
          if (!attempt || attempt.phase !== 'waiting-browser') continue
          const url = safeAuthorizeUrl(attempt.authorizeUrl)
          if (!url) continue
          // 标记不存在 = DSHL 此刻没有以桌面壳身份运行（web 分支自己会开标签页）
          if (!desktopShellActive()) continue
          const id = String(attempt.id || url.href)
          if (opened.includes(id)) continue
          opened.push(id)
          if (opened.length > MAX_REMEMBERED) opened.shift()
          try {
            openInBrowser(url)
            info(ctx, 'dshl-desktop-signin: opened platform authorization page')
          } catch (error) {
            warn(ctx, 'dshl-desktop-signin: failed to open authorization page: ' + ((error && error.message) || String(error)))
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          warn(ctx, 'dshl-desktop-signin: account watch ended: ' + ((error && error.message) || String(error)))
        }
      }
    }
    void run()
    return () => controller.abort()
  }, 'dshl-desktop-signin: open desktop-mode authorization page')
}
