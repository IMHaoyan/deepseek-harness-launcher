'use strict'
// loading.html 的文案与按钮（白屏/启动中/重启中/未启动/端口被占用状态页；页面视图由主进程加载，参数经 URL 传入）
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
  blocked: {
    title: '端口被其他程序占用',
    sub: '', // 由 detail 参数填充（占用原因 + 建议端口）
    btn: '换到空闲端口并启动',
  },
}
const t = TEXTS[reason] || TEXTS.start
const subEl = document.getElementById('sub')
const btnEl = document.getElementById('btnReload')
document.getElementById('title').textContent = t.title
subEl.textContent = t.sub
btnEl.textContent = t.btn
if (reason === 'failed' || reason === 'offline') document.body.classList.add('failed')

// 端口冲突页：detail 展示冲突原因；suggest 有值 → 一键换端口启动；无值 → 引导打开启动器面板
const detail = (q.get('detail') || '').slice(0, 500)
const suggest = q.get('suggest') || ''
if (reason === 'blocked') {
  subEl.textContent = detail || t.sub
  btnEl.textContent = suggest ? `换到端口 ${suggest} 并启动` : '打开启动器面板（更换端口）'
  document.body.classList.add('failed')
}

document.getElementById('btnReload').addEventListener('click', () => {
  try {
    if (reason === 'blocked' && suggest) window.browserBridge.send('blockSwitch', { port: Number(suggest) })
    else window.browserBridge.send('fixPane', { id: pane })
  } catch (e) { /* 桥未就绪忽略 */ }
})
