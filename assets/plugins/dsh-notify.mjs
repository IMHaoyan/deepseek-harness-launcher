// dsh-notify.mjs — DSH 会话事件 → Windows 托盘通知桥
//
// 挂载方式：~/.dsh/cordis.patch.yml 的 insert 行（file:// 绝对路径 name）。
// 事件源（ctx.on('session/event')）：
//   - turn/end + reason.completed  → 对话完成
//   - approval/asked               → 权限/沙箱选择等待
//   - tool/call ask_user_question  → 模型向你提问等待
// 只通知主会话（跳过子代理会话：header.parentSession 存在即跳过）。
// 输出：dropbox 目录下的 JSON 文件，由 DSHL（DeepSeek Harness Launcher）托盘扫描并弹气泡。
// 激活时在 dropbox 写入 loaded.stamp（诊断用，非 .json，托盘不会弹）。
// 零依赖：仅用 Node 内置模块，可直接被构建产物（plain node）加载。

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'

export const name = 'dsh-notify'

const DEFAULTS = {
  /** 通知投递目录；默认 $DSH_HOME/dshl-logs/notify（DSH_HOME 缺省时回退 ~/.dsh） */
  dropbox: undefined,
  /** 点击通知打开的地址 */
  webUrl: 'http://127.0.0.1:3080',
  /** 相邻通知最小间隔（毫秒），防刷屏 */
  minIntervalMs: 2500,
  notifyCompleted: true,
  notifyApproval: true,
  notifyQuestion: true,
}

export function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config }
  // 注意：DSH_HOME 只是可选环境变量（DSH 自身对缺省有 ~/.dsh 兜底），
  // 不能依赖它存在——托盘链启动的进程环境里常常没有它。
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const dropbox = opts.dropbox ?? join(home, 'dshl-logs', 'notify')

  let lastAt = 0
  let seq = 0
  const emit = (kind, title, message) => {
    const now = Date.now()
    if (now - lastAt < opts.minIntervalMs) return
    lastAt = now
    const stamp = String(now).padStart(13, '0')
    const file = join(dropbox, `notify-${stamp}-${String(seq++).padStart(4, '0')}.json`)
    const payload = JSON.stringify({ kind, title, message, url: opts.webUrl, at: now })
    void mkdir(dropbox, { recursive: true })
      .then(() => writeFile(file, payload, 'utf8'))
      .catch(() => {})
  }

  // 激活即留痕：创建目录并写时间戳标记，便于诊断"插件是否已加载"
  void mkdir(dropbox, { recursive: true })
    .then(() => writeFile(join(dropbox, 'loaded.stamp'), JSON.stringify({ at: Date.now(), webUrl: opts.webUrl }), 'utf8'))
    .catch(() => {})

  ctx.on('session/event', (session, event) => {
    // 只通知主会话：子代理/工作流子会话有自己的生命期，不打扰
    if (session?.header?.parentSession !== undefined) return
    if (event.type === 'turn/end' && opts.notifyCompleted && event.data.reason.kind === 'completed') {
      emit('completed', 'DeepSeek Harness', '对话已完成')
    } else if (event.type === 'approval/asked' && opts.notifyApproval) {
      emit('approval', 'DeepSeek Harness', `需要你的选择：${event.data.toolName}`)
    } else if (event.type === 'tool/call' && opts.notifyQuestion && event.data.name === 'ask_user_question') {
      emit('question', 'DeepSeek Harness', 'DSH 向你提问，需要你的选择')
    }
  })
}
