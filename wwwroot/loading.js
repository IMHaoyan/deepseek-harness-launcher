'use strict'
// loading.html 的文案与按钮（白屏/启动中/重启中/未启动/端口被占用状态页；页面视图由主进程加载，参数经 URL 传入）
const q = new URLSearchParams(location.search)
const reason = q.get('reason') || 'start'
const pane = q.get('pane') || ''

const TEXTS = {
  start: {
    title: '正在启动 DeepSeek Harness 服务…',
    sub: '首次启动通常需要 8~15 秒，服务就绪后窗口会自动进入。',
    btn: '重新加载',
  },
  restart: {
    title: '服务正在自动重启…',
    sub: '服务意外退出后，看护正在恢复它（几秒内）。恢复后窗口会自动进入。',
    btn: '重新加载',
  },
  restartManual: {
    title: '正在重启 DeepSeek Harness…',
    sub: '已停止旧服务，正在拉起新进程（通常 7~10 秒）。',
    // 第二行单独成段：句号后断行，避免在“进入。”中间被自动折行（展示口径 7~10 秒）
    sub2: '就绪后窗口会自动刷新进入。',
    btn: '重新加载',
  },
  plugin: {
    title: '正在应用插件变更…',
    sub: '正在安装或卸载 DSH 插件，完成后会自动重启服务并回到页面（约 10~60 秒）。',
    btn: '重新加载',
  },
  recovery: {
    title: '正在回退到健康检查点…',
    sub: '正在把配置写回上一个正常快照（当前配置已备份），随后自动重启服务并回到页面。',
    btn: '重新加载',
  },
  update: {
    title: '正在更新 DeepSeek Harness…',
    sub: '正在下载并安装新版本（约 1~3 分钟，npmmirror 源）。升级完成后自动进入新版页面。',
    btn: '重新加载',
  },
  offline: {
    title: 'DeepSeek Harness 服务未启动',
    sub: '点击下方按钮启动服务（或回到 DSHL 控制台点「启动 DSH」），就绪后自动进入。',
    btn: '启动服务',
  },
  failed: {
    title: '页面加载失败',
    sub: '服务在运行，但页面没有加载成功（可能卡住了）。点击下方按钮重新加载；仍失败请到 DSHL 控制台「查看日志」。',
    btn: '重新加载',
  },
  blocked: {
    title: '端口被其他程序占用',
    sub: '', // 由 detail 参数填充（占用原因 + 建议端口）
    btn: '换到空闲端口并启动',
  },
  auth: {
    title: '服务已自行重启，页面需要重新连接',
    sub: '服务在正常运行，窗口里的登录凭据通常仍然有效：先刷新一次页面即可恢复。'
      + '如果刷新后仍停在 401 凭据页，页面会给出「重启服务以恢复访问」的选项（重启会中断正在跑的会话）。',
    btn: '刷新页面',
  },
  authRestart: {
    title: '页面仍缺少有效的登录凭据',
    sub: '窗口当前没有有效的登录凭据（cookie），刷新无法恢复。需要由启动器重启一次服务来恢复访问'
      + '（会中断正在跑的会话）；不想中断的话，也可以自己在服务里重新打开页面。',
    btn: '重启服务以恢复访问',
    alt: '再刷新一次',
  },
}
const triedAuth = reason === 'auth' && q.get('tried') === '1'
const t = (triedAuth ? TEXTS.authRestart : TEXTS[reason]) || TEXTS.start
const subEl = document.getElementById('sub')
const sub2El = document.getElementById('sub2')
const btnEl = document.getElementById('btnReload')
document.getElementById('title').textContent = t.title
subEl.textContent = t.sub
btnEl.textContent = t.btn

const btnAlt = document.getElementById('btnSecondary')
if (triedAuth && t.alt) {
  btnAlt.textContent = t.alt
  btnAlt.classList.remove('hidden')
}
if (reason === 'failed' || reason === 'offline' || reason === 'auth') document.body.classList.add('failed')

// 端口冲突页：detail 展示冲突原因；suggest 有值 → 一键换端口启动；
// 无值（附近端口全被占）→ 就地重新探测端口并重试启动。
// 按钮文案必须等于真实动作：这里以前写「打开 DSHL 控制台（更换端口）」，点下去发的却是 fixPane（重载本页），说的和做的不是一回事。
const detail = (q.get('detail') || '').slice(0, 500)
const suggest = q.get('suggest') || ''
if (reason === 'blocked') {
  subEl.textContent = detail || t.sub
  btnEl.textContent = suggest ? `换到端口 ${suggest} 并启动` : '重新检测端口并重试'
  document.body.classList.add('failed')
}

// ---------- 步骤进度（主进程在真实检查点推 loading:progress） ----------
// 只负责"第几步/共几步 + 已等待秒数"这行文字：进度条保持循环动画（不按步数画死宽度）。
// 没数据 / reason 不匹配（未启动、端口冲突、页面失败、凭据页）→ 不显示步骤行。
const stepEl = document.getElementById('step')
const phaseEl = document.getElementById('phase')
const baseSub = t.sub
const baseSub2 = t.sub2 || '' // 可选的第二行（见 TEXTS.restartManual）
let progressData = null
let tickTimer = null

// 文案渲染：单行状态照旧写进 #sub；有第二行的状态把它挂在 #sub2。
// 「（已等待 N 秒）」永远跟在最后一行后面 —— 不给两行各挂一个，也不让它跑回第一行。
function renderSub(suffix) {
  const tail = suffix || ''
  subEl.textContent = baseSub + (baseSub2 ? '' : tail)
  if (!sub2El) return
  sub2El.textContent = baseSub2 ? baseSub2 + tail : ''
  sub2El.classList.toggle('hidden', !baseSub2)
}
if (reason !== 'blocked') renderSub('')

// 当前环节行：转述服务进程自己刚打印的那条日志（主进程已清洗/脱敏，页面只做展示）。
// 超过 3 秒没有新日志就标注"（N 秒前）"——不把已经过去的事说成"正在执行"。
function renderPhase() {
  if (!phaseEl) return
  if (!progressData) { phaseEl.textContent = ''; phaseEl.classList.add('hidden'); return }
  const line = String(progressData.phase || '')
  if (line) {
    const ago = progressData.phaseAt ? Math.round((Date.now() - progressData.phaseAt) / 1000) : 0
    phaseEl.textContent = '服务进程日志：' + line + (ago >= 3 ? '（' + ago + ' 秒前）' : '')
  } else {
    phaseEl.textContent = progressData.phaseFallback || ''
  }
  phaseEl.classList.toggle('hidden', !phaseEl.textContent)
}

function tickElapsed() {
  if (!progressData || !subEl) return
  const sec = Math.max(0, Math.round((Date.now() - progressData.startedAt) / 1000))
  renderSub('（已等待 ' + sec + ' 秒）')
  renderPhase()
}

function renderProgress(p) {
  if (!p || p.reason !== reason || !p.total) {
    progressData = null
    if (stepEl) stepEl.classList.add('hidden')
    if (phaseEl) { phaseEl.textContent = ''; phaseEl.classList.add('hidden') }
    if (subEl && reason !== 'blocked') renderSub('')
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
    return
  }
  progressData = p
  if (stepEl) {
    stepEl.textContent = '第 ' + p.step + '/' + p.total + ' 步 · ' + p.label
    stepEl.classList.remove('hidden')
  }
  tickElapsed()
  if (!tickTimer) tickTimer = setInterval(tickElapsed, 1000)
}

// 动作按钮的出场时机：需要用户介入的状态（未启动 / 端口被占用 / 页面加载失败 / 凭据失效）立刻给按钮；
// 纯"进行中"的状态（启动 / 重启 / 更新 / 插件变更 / 回退）先不给 —— 主进程就绪后会自动把说明页换成真实页面，
// 提前摆一个「重新加载」只会让人以为必须手点。超过阈值还停在说明页（说明卡住了）才放出兜底按钮 + 提示。
const BUSY_REVEAL_MS = { start: 15000, restart: 15000, restartManual: 15000, plugin: 15000, recovery: 15000, update: 90000 }
const revealMs = BUSY_REVEAL_MS[reason] || 0
const hintEl = document.getElementById('hint')
if (revealMs > 0) {
  btnEl.classList.add('hidden')
  setTimeout(() => {
    btnEl.classList.remove('hidden')
    if (hintEl) {
      hintEl.textContent = `已等待 ${Math.round(revealMs / 1000)} 秒仍未就绪：可以手动重试一次（不会打断后台启动）。`
      hintEl.classList.remove('hidden')
    }
  }, revealMs)
}
document.getElementById('btnReload').addEventListener('click', () => {
  try {
    // blocked 且没有建议端口时走 fixPane：主进程会重新探测端口 → 重试启动 → 按最新状态刷新本页
    if (reason === 'blocked' && suggest) window.browserBridge.send('blockSwitch', { port: Number(suggest) })
    else if (triedAuth) window.browserBridge.send('authRestart', { id: pane })
    else window.browserBridge.send('fixPane', { id: pane })
  } catch (e) { /* 桥未就绪忽略 */ }
})
btnAlt.addEventListener('click', () => {
  try { window.browserBridge.send('fixPane', { id: pane }) } catch (e) { /* 桥未就绪忽略 */ }
})

// 步骤进度订阅：主进程推、本页按自己的 reason 过滤（桥不支持时静默）
try { window.browserBridge.onLoadingProgress(renderProgress) } catch (e) { /* 桥未就绪忽略 */ }
