'use strict'
// loading.html 的文案与刷新按钮（白屏/启动中/重启中状态页；页面视图由主进程加载，reason/pane 经 URL 传入）
const q = new URLSearchParams(location.search)
const reason = q.get('reason') || 'start'
const pane = q.get('pane') || ''

const TEXTS = {
  start: {
    title: '正在启动 DeepSeek Harness 服务…',
    sub: '首次启动通常需要 3~15 秒，服务就绪后窗口会自动进入。',
    btn: '重新加载',
  },
  restart: {
    title: '服务正在自动重启…',
    sub: '服务意外退出后，看护正在恢复它（几秒内）。恢复后窗口会自动进入。',
    btn: '重新加载',
  },
  update: {
    title: '正在更新 DeepSeek Harness…',
    sub: '正在下载并安装新版本（约 1~3 分钟，npmmirror 源）。升级完成后自动进入新版页面。',
    btn: '重新加载',
  },
  offline: {
    title: 'DeepSeek Harness 服务未启动',
    sub: '点击下方按钮启动服务（或回到启动器面板点「启动服务」），就绪后自动进入。',
    btn: '启动服务',
  },
  failed: {
    title: '页面加载失败',
    sub: '服务在运行，但页面没有加载成功（可能卡住了）。点击下方按钮重新加载；仍失败请到启动器面板「查看日志」。',
    btn: '重新加载',
  },
}
const t = TEXTS[reason] || TEXTS.start
document.getElementById('title').textContent = t.title
document.getElementById('sub').textContent = t.sub
document.getElementById('btnReload').textContent = t.btn
if (reason === 'failed' || reason === 'offline') document.body.classList.add('failed')

document.getElementById('btnReload').addEventListener('click', () => {
  try { window.browserBridge.send('fixPane', { id: pane }) } catch (e) { /* 桥未就绪忽略 */ }
})
