// boot-failure.js — 服务启动/崩溃失败的原因提取与「确定性失败」判定（纯函数，可单测）
//
// 为什么需要它：DSH 侧的失败原因写在子进程的 stderr（落盘为 server.err.log），而启动器原来
// 只解析一种模式（listen EACCES/EADDRINUSE）。于是两类问题：
//   1. 用户被通知「请打开控制台查看日志」，但控制台只显示启动器自己的日志，看不到原因；
//   2. 配置/插件树类的失败在每次重试时**逐字复现**，却照样把 5 次重启额度烧完再空转一次配置回退。
//
// 本模块只做判定，不做任何 IO，也不决定重试策略（那是 main.js 的事）：
//   - firstErrorLine()     从 stderr 文本里取出第一行"像是根因"的错误，用于通知与卡片；
//   - classifyBootFailure() 归一化成 { kind, target, signature, eligible }；
//   - nextFailureStreak()  按签名累计"同一失败连续出现几次"；
//   - isDeterministic()    连续两次同签名且种类可判定 → 确定性失败。
//
// fail-open 原则：无法识别的失败（kind='unknown'）与端口类失败（kind='bind'）一律 eligible=false，
// 即**不参与**确定性判定 —— 宁可多试一次，也不因为误判而提前停掉看护。
'use strict'

const LINE_MAX = 200
const TAIL_SCAN_LINES = 120

// ANSI 转义与光标控制序列：stderr 里常见，进通知前必须剥掉
const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/gu
// 控制字符（保留 \n \t）
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu

/**
 * 剥掉 ANSI / 控制字符，压掉多余空白。导出给调用方复用（通知文案）。
 * @param {unknown} value
 * @returns {string}
 */
function cleanLine(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(ANSI_RE, '')
    .replace(CTRL_RE, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * 归一化签名：把随环境漂移的部分抹平，让"同一种失败"得到同一个签名。
 * 抹平的是数字（端口/PID/行号/字节数）与临时目录 UUID；**保留**包名与路径，
 * 因为它们正是"该修哪个插件"的信息。
 * @param {string} line
 * @returns {string}
 */
function signatureOf(line) {
  return cleanLine(line)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<uuid>')
    .replace(/\d+/gu, '#')
    .slice(0, LINE_MAX)
}

// 数组顺序 = **分类优先级**：越具体的放前面。
// lineRank = **挑句子时的优先级**：越小越优先（0 = 最深的可执行根因）。
// 两者刻意分开：`plugin tree failed to load: … failed to import loader entry X (pkg): … does not provide
// an export named 'Y'` 是**同一行**，分类要的是包名（loader entry），挑句子时用户要的却是最深的那个原因。
const RULES = [
  {
    kind: 'bundle-missing',
    lineRank: 0,
    re: /cannot resolve profile bundle "([^"]+)"/iu,
    target: (m) => m[1],
    describe: (t) => (t ? `profile 声明了插件 ${t}，但它不在 node_modules 里（声明与安装不一致）` : 'profile 声明的插件与已安装内容不一致'),
  },
  {
    kind: 'plugin-tree',
    lineRank: 3,
    re: /failed to import loader entry ([^\s(]+)\s*\(([^)]+)\)/iu,
    target: (m) => m[2] || m[1],
    describe: (t) => (t ? `插件 ${t} 加载失败（多半与当前 DSH 版本不兼容）` : '插件树加载失败'),
  },
  {
    kind: 'plugin-tree',
    lineRank: 0,
    re: /does not provide an export named '([^']+)'/iu,
    target: () => '',
    describe: (t, m) => `插件引用了当前 DSH 不再提供的导出 ${m[1]}（插件与新版本 DSH 不兼容）`,
  },
  {
    kind: 'settings-invalid',
    lineRank: 1,
    // 路径里带盘符冒号（C:\…），所以取"最后一个冒号 + 大写错误码"的贪婪匹配
    re: /settings-file: invalid document at (.+):\s*([A-Z][A-Z_]+)/iu,
    target: (m) => m[1],
    describe: (t, m) => `DSH 设置文件解析失败（${m[2]}${t ? '：' + t : ''}）`,
  },
  {
    kind: 'module-missing',
    lineRank: 1,
    re: /Cannot find package '([^']+)'/iu,
    target: (m) => m[1],
    describe: (t) => (t ? `插件依赖 ${t} 未安装` : '插件依赖缺失'),
  },
  {
    kind: 'bind',
    lineRank: 2,
    re: /listen (EACCES|EADDRINUSE)/iu,
    target: () => '',
    describe: (t, m) => (String(m[1]).toUpperCase() === 'EACCES'
      ? '端口被系统保留或已被占用（listen EACCES）'
      : '端口已被占用（listen EADDRINUSE）'),
  },
]

// 参与确定性判定的种类：这些失败的根因是磁盘上的持久状态，重试不会改变结果
const DETERMINISTIC_KINDS = new Set(['bundle-missing', 'plugin-tree', 'settings-invalid', 'module-missing'])

/** 判定「这行看起来是不是根因」。用于 firstErrorLine 的候选筛选。 */
function looksLikeError(line) {
  return /(^|\s)(Error|TypeError|RangeError|ReferenceError|SyntaxError)\b/u.test(line) ||
    /ERR_[A-Z_]+/u.test(line) ||
    /^\s*(error|fatal)\b/iu.test(line) ||
    RULES.some((r) => r.re.test(line))
}

/**
 * 从 stderr 文本里取出第一行"像是根因"的错误。
 * 先在所有已识别规则里挑 lineRank 最小（= 最具体）的那一行；同 rank 取最早出现的行。
 * 挑不出已知规则时退回"首个 Error 行"。
 * @param {string} text
 * @returns {string} 清理并截断后的单行；没有则返回 ''
 */
function firstErrorLine(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const lines = raw.split(/\r?\n/u).slice(-TAIL_SCAN_LINES)
  let best = null // { rank, rule, line }
  for (const line of lines) {
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue
      if (best === null || rule.lineRank < best.rank) best = { rank: rule.lineRank, rule, line }
    }
    if (best !== null && best.rank === 0) break // 已是最具体，没有更优解
  }
  if (best !== null) return focusLine(best)
  for (const line of lines) {
    const cleaned = cleanLine(line)
    if (cleaned && looksLikeError(cleaned)) return cleaned.slice(0, LINE_MAX)
  }
  return ''
}

/**
 * 把命中的原始行裁成一条自解释的单行。
 * 超过上限时**围绕命中片段取窗口**，而不是从行首硬截 —— DSH 的插件树错误常是 250+ 字符的一行，
 * 从行首截会把真正的原因（在行尾）整个切掉。
 * @param {{rule: {re: RegExp}, line: string}} hit
 */
function focusLine(hit) {
  const cleaned = cleanLine(hit.line)
  if (cleaned.length <= LINE_MAX) return cleaned
  // cleanLine 压过空白，原行下标会漂；在新串里重新定位同一片段
  const m = hit.rule.re.exec(cleaned)
  const at = m ? m.index : 0
  const start = at > 60 ? at - 60 : 0
  const budget = LINE_MAX - (start > 0 ? 1 : 0)
  return (start > 0 ? '…' : '') + cleaned.slice(start, start + budget)
}

/**
 * 分类一次启动/崩溃失败。
 * @param {string} text 子进程 stderr（尾部若干行即可）
 * @returns {{kind: string, target: string, signature: string, eligible: boolean, line: string, reason: string}}
 *          kind='unknown' 表示没识别出来；eligible=false 表示不参与确定性判定（fail-open）
 */
function classifyBootFailure(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const lines = raw.split(/\r?\n/u).slice(-TAIL_SCAN_LINES)
  for (const rule of RULES) {
    for (const line of lines) {
      const m = rule.re.exec(line)
      if (!m) continue
      const target = rule.target(m) || ''
      return {
        kind: rule.kind,
        target,
        signature: signatureOf(line),
        eligible: DETERMINISTIC_KINDS.has(rule.kind),
        line: cleanLine(line).slice(0, LINE_MAX),
        reason: rule.describe(target, m),
      }
    }
  }
  const line = firstErrorLine(raw)
  return {
    kind: 'unknown',
    target: '',
    signature: line ? signatureOf(line) : '',
    eligible: false,
    line,
    reason: line ? '服务启动失败（原因未识别）' : '服务启动失败，且子进程没有输出可读的错误',
  }
}

/**
 * 按签名累计"同一失败连续出现几次"。签名变化即从 1 重新计数。
 * @param {{signature?: string, count?: number}|null|undefined} prev
 * @param {string} signature
 * @returns {{signature: string, count: number}}
 */
function nextFailureStreak(prev, signature) {
  const sig = String(signature || '')
  if (!sig) return { signature: '', count: 0 }
  const p = prev || {}
  if (p.signature === sig) return { signature: sig, count: Math.max(1, Math.floor(Number(p.count) || 0)) + 1 }
  return { signature: sig, count: 1 }
}

/** 同一签名连续出现多少次才判定为确定性失败。2 = 第二次同样的失败即不再重试。 */
const DETERMINISTIC_STREAK = 2

/**
 * 是否已可判定为确定性失败（重试不会改变结果）。
 * @param {{eligible?: boolean, count?: number}|null|undefined} failure
 * @returns {boolean}
 */
function isDeterministic(failure) {
  if (!failure || failure.eligible !== true) return false
  return Math.floor(Number(failure.count) || 0) >= DETERMINISTIC_STREAK
}

module.exports = {
  DETERMINISTIC_STREAK,
  DETERMINISTIC_KINDS,
  LINE_MAX,
  cleanLine,
  signatureOf,
  firstErrorLine,
  classifyBootFailure,
  nextFailureStreak,
  isDeterministic,
}
