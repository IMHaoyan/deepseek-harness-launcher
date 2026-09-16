// start-progress.js — 状态说明页的"第几步/共几步"模型（纯数据 + 纯函数，可单测）
//
// 说明页（ui-src/loading.html）由主进程加载，页面自己拿不到服务状态，只能靠主进程推的
// loading:progress 知道进度。这里只管：某个 reason 有哪些步骤、里程碑键 → 文案。
// 打点在真实检查处（handleStart / startServer / markReady / 各流程自己的段），键不在表里就自动忽略，
// 所以 handleStart/startServer 这些共用代码可以无脑打点。
'use strict'

const { redact } = require('./redact')

const LABELS = {
  stop: '停止旧服务',
  env: '检查运行环境',
  port: '检查端口占用',
  spawn: '启动服务进程',
  ready: '等待服务就绪',
  load: '载入界面',
  install: '安装新版本（npm）',
  restore: '写回健康检查点',
  reload: '重载配置并重新探测环境',
}

// reason 与 ui-src/loading.js 的 TEXTS 键一一对应；表里没有的 reason（offline/failed/blocked/auth）
// 不显示步骤行 —— 那些页面要的是用户动作，不是进度。
const PLANS = {
  start: ['env', 'port', 'spawn', 'ready', 'load'],
  restart: ['stop', 'env', 'port', 'spawn', 'ready', 'load'],
  restartManual: ['stop', 'env', 'port', 'spawn', 'ready', 'load'],
  update: ['stop', 'install', 'spawn', 'ready', 'load'],
  // 插件市场是"先装（控制台里显示进度）→ 再重启服务生效"，说明页只覆盖重启那一段，别虚报安装进度
  plugin: ['stop', 'spawn', 'ready', 'load'],
  recovery: ['stop', 'restore', 'reload', 'spawn', 'ready', 'load'],
}

function stepsFor(reason) {
  const plan = PLANS[reason]
  if (!plan) return []
  return plan.map((key) => ({ key, label: LABELS[key] || key }))
}

// ---------- 启动期"当前环节"（纯函数，可单测） ----------
// 为什么只转述、不推断：DSH 启动期不打印结构化进度（空 profile 冷启实测 stdout/stderr 0 行输出），
// 凭空写"正在装载插件 / 正在组装前端"只是猜测 —— 界面文案必须与真实动作一一对应，宁可不写。
// 唯一可观测的环节信号是服务进程自己打印的插件日志（形如 `[usage-billing] aggregated 112 sessions`）：
// 有就转述它，没有就由说明页如实显示"暂无输出"。
const PHASE_FALLBACK = '服务进程暂无输出（正在等待端口应答）'
const PHASE_MAX = 160

/**
 * 清洗一行输出；不是"可安全展示的环节行"就返回 ''。
 * 只放行 `[名字] …` 形态的插件日志：DSH 的 stderr 里还混着多行错误转储与堆栈，
 * 把 `location: {` 或 `at Proxy.foo (…)` 当"当前环节"展示就是误报。
 * @param {string} raw
 * @returns {string}
 */
function cleanPhaseLine(raw) {
  let s = String(raw == null ? '' : raw)
  s = s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '') // ANSI 转义序列
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') // 控制字符
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return ''
  if (/token=/i.test(s)) return '' // 任何带 token 的行一律不进界面（启动地址就是这种）
  // 多行输出的首行常以 "…: [" / "…: {" 收尾（后面几行是列表或对象）：先去掉悬空的续行标点，
  // 否则界面上会出现一条尾巴开着的半句话（真实日志里 usage-billing 就是这么打印的）。
  s = s.replace(/[\s:：,，;；、\-–—[({\[]+$/, '')
  // 只放行 `[名字] 正文`：光剩一个标签（[x]）或没有正文的行没有信息量，不当环节展示
  if (!/^\[[^\]]{1,40}\]\s*\S/.test(s)) return ''
  const clipped = s.length > PHASE_MAX ? s.slice(0, PHASE_MAX - 1) + '…' : s
  return redact(clipped) // 兜底脱敏：key/JWT/长 token 一律打码
}

/**
 * 从一段输出里挑出最新的一条"当前环节"行；没有可展示的就返回 ''。
 * 支持直接喂单行，也支持喂多行 chunk（取最后一条合规行 = 最近的动静）。
 * @param {string} chunk
 * @returns {string}
 */
function pickPhaseLine(chunk) {
  if (typeof chunk !== 'string' || !chunk) return ''
  let found = ''
  for (const raw of chunk.split(/\r?\n/)) {
    const line = cleanPhaseLine(raw)
    if (line) found = line
  }
  return found
}

/**
 * 行缓冲读取器：进程输出是按 chunk 到达的，一行可能被劈成两半（残行不能当"环节"展示）。
 * 每次 push 返回"这一块里最后一条新的环节行"，没有就返回 ''。
 * @param {number} [keep] 缓冲上限（字节近似），防止半行无限增长
 */
function createPhaseReader(keep) {
  const cap = Number.isFinite(keep) && keep > 0 ? keep : 4096
  let buf = ''
  return {
    push(chunk) {
      if (typeof chunk !== 'string' || !chunk) return ''
      buf = (buf + chunk).slice(-cap)
      let found = ''
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const picked = pickPhaseLine(line)
        if (picked) found = picked
      }
      return found
    },
  }
}

module.exports = {
  LABELS,
  PLANS,
  stepsFor,
  PHASE_FALLBACK,
  PHASE_MAX,
  cleanPhaseLine,
  pickPhaseLine,
  createPhaseReader,
}
