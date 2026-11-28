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
    kind: 'patch-invalid',
    lineRank: 0,
    // 真实语料（2026-11-28，profile 的 cordis.patch.yml 被写坏后）：
    //   Error: dsh: failed to parse overlay C:\Users\x\.dsh\profiles\web\cordis.patch.yml:
    //   YAMLParseError: Unexpected scalar at node end at line 509, column 1:
    // 路径里带盘符冒号，所以以 `YAMLParseError:` 作为右边界，而不是第一个冒号。
    re: /failed to parse (?:overlay|profile [^:]+) (.+?):\s*([A-Za-z]*ParseError):\s*(.*)$/iu,
    target: (m) => m[1],
    describe: (t, m) => `Profile 配置补丁${t ? ' ' + t : ''}解析失败（${m[2]}${m[3] ? '：' + String(m[3]).slice(0, 80) : ''}）`,
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
const DETERMINISTIC_KINDS = new Set(['bundle-missing', 'plugin-tree', 'settings-invalid', 'patch-invalid', 'module-missing', 'dsh-core-mismatch'])

// —— 多插件失败：一次失败里到底有几个插件坏了 ——
// DSH 侧多插件激活失败是一个 AggregateError，成员**逐条打印**：
//   dsh-app-boot/lib/index.js:4260
//   `deepest instanceof AggregateError ? ... deepest.errors.map(formatActivationError).join("\n") : ...`
// 所以"还有谁坏了"在 stderr 里是查得到的。分类只返回一个 target（挑最具体的那条），
// 若就此打住，用户会以为修完这一个就好了；重启后又被下一个拦住，看起来像循环。
const TARGET_RES = [
  /failed to import loader entry [^\s(]+\s*\(([^)]+)\)/gu,
  /cannot resolve profile bundle "([^"]+)"/gu,
  /Cannot find package '([^']+)'/gu,
]
const MAX_TARGETS = 8

// —— 内核自身依赖不匹配（不是插件问题）——
// 真实语料（2026-11-22，0.2.3-alpha.1 在本机安装后的 `dsh --version` 原文）：
//   file:///…/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:7
//   import Loader, { …, EntryValidationError, … } from "@deepseek-ai/cordis-plugin-loader";
//   SyntaxError: The requested module '@deepseek-ai/cordis-plugin-loader' does not provide an export named 'EntryValidationError'
// 这一步发生在**加载任何用户插件之前**：坏的是 DSH 安装树自己的内置组件，用户禁谁都没用。
// 旧规则只凭 "does not provide an export named" 就判成 plugin-tree，说明页于是写「禁用插件」，
// 用户照做后报错一字不变 —— 2026-11-22 实际踩到。
//
// 两条判据缺一不可：
//   1) 有 ESM 的导出缺失原文；
//   2) 报错现场的导入方路径落在 DSH 安装树里（node_modules/@deepseek-ai/dsh*），
//      且**不在** <DSH_HOME>/profiles 下（用户插件装在那里）。
// 用户插件失败的行里通常还带 "failed to import loader entry <id> (<pkg>)"，那是明确反证，先排除。
const EXPORT_MISMATCH_RE = /The requested module '([^']+)' does not provide an export named '([^']+)'/iu
const LOADER_ENTRY_EVIDENCE_RE = /failed to import loader entry/iu
// 用户插件的位置是 <DSH_HOME>/profiles/<name>/node_modules/...（DSH_HOME 可被用户改掉，
// 所以不能只认 .dsh/profiles 这个字面量；这个形状不会出现在 DSH 自己的安装树里）。
const PROFILE_PATH_RE = /[\\/]profiles[\\/][^\\/]+[\\/]node_modules[\\/]/iu
// 贪心前缀：一行里可能同时出现 <dsh>/node_modules/<dsh-app-boot>/…，要报的是**最内层**那个包
const CORE_PKG_PATH_RE = /.*node_modules[\\/]@deepseek-ai[\\/](dsh(?:-[a-z0-9._-]+)?)[\\/]/iu

/**
 * 这次 ESM 导出缺失是不是 DSH 安装树**自身**的问题（纯函数）。
 * @param {string} text 子进程 stderr
 * @returns {{importerPkg:string, missingPkg:string, exportName:string}|null}
 */
function coreMismatchOf(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const miss = EXPORT_MISMATCH_RE.exec(raw)
  if (!miss) return null
  // 有 loader entry 证据 ⇒ 至少有一个用户插件在加载期失败，按插件问题处理（旧行为不变）
  if (LOADER_ENTRY_EVIDENCE_RE.test(raw)) return null
  // 只看**报错现场**（import 语句与 SyntaxError 之前）：后面的调用栈里有 dsh/lib/bin.js 这类
  // 公共栈帧，拿它当"导入方"会把任何 ESM 失败都误判成内核问题。
  const lines = raw.split(/\r?\n/u)
  const errAt = lines.findIndex((line) => EXPORT_MISMATCH_RE.test(line))
  const scene = errAt >= 0 ? lines.slice(0, errAt + 1) : lines
  for (const line of scene) {
    if (PROFILE_PATH_RE.test(line)) return null // 导入方是装在 <DSH_HOME>/profiles 里的用户插件
    const m = CORE_PKG_PATH_RE.exec(line)
    if (m) return { importerPkg: '@deepseek-ai/' + m[1], missingPkg: miss[1], exportName: miss[2] }
  }
  return null
}

/**
 * 收集本次失败里**所有**被点名的包，去重保序。
 * 这是给界面用的"还有几个"，不参与任何判定（判定仍走 RULES + target）。
 * @param {string} text 子进程 stderr（尾部若干行）
 * @returns {string[]} 最多 MAX_TARGETS 个；识别不出则空数组
 */
function pluginTargets(text) {
  const raw = String(text === undefined || text === null ? '' : text)
  const out = []
  for (const line of raw.split(/\r?\n/u).slice(-TAIL_SCAN_LINES)) {
    for (const re of TARGET_RES) {
      re.lastIndex = 0 // 模块级全局正则：每次用前必须复位，否则 lastIndex 会跨行残留
      let m = re.exec(line)
      while (m !== null) {
        const name = cleanLine(m[1])
        if (name && !out.includes(name)) {
          out.push(name)
          if (out.length >= MAX_TARGETS) return out
        }
        if (m.index === re.lastIndex) re.lastIndex += 1 // 空匹配保护
        m = re.exec(line)
      }
    }
  }
  return out
}

/**
 * 判定「这行看起来是不是根因」。用于 firstErrorLine 的候选筛选。
 *
 * 必须**行首锚定**：Node 抛未捕获异常时会先打印出错源码行，例如
 *   `throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);`
 * 旧实现用 `(^|\s)Error\b` 会把这行源码当成根因，界面上于是只显示一段模板字符串，
 * 而真正的 `Error: dsh: failed to parse overlay …` 就在下面几行（2026-11-28 实际踩到）。
 */
function looksLikeError(line) {
  return /^(?:Uncaught\s+)?[A-Za-z]*(?:Error|Exception)\b/u.test(line) ||
    /ERR_[A-Z_]+/u.test(line) ||
    /^(?:error|fatal)\b/iu.test(line) ||
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
  // 一次失败里所有被点名的包：给界面回答"是不是还有别的插件也坏了"
  const targets = pluginTargets(raw)
  // 先判内核自身依赖不匹配：它和插件失败共用同一种 ESM 报错，但修法完全相反（换安装树 vs 禁用插件）。
  const core = coreMismatchOf(raw)
  if (core) {
    const line = firstErrorLine(raw)
    return {
      kind: 'dsh-core-mismatch',
      target: '',
      targets,
      signature: signatureOf(line || core.missingPkg + ' ' + core.exportName),
      eligible: true,
      line,
      reason: `DSH 安装树自身依赖不匹配：${core.importerPkg} 需要的导出 ${core.exportName}`
        + ` 在 ${core.missingPkg} 里不存在（禁用或卸载插件无效）`,
    }
  }
  for (const rule of RULES) {
    for (const line of lines) {
      const m = rule.re.exec(line)
      if (!m) continue
      const target = rule.target(m) || ''
      return {
        kind: rule.kind,
        target,
        targets,
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
    targets,
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
  MAX_TARGETS,
  cleanLine,
  signatureOf,
  firstErrorLine,
  pluginTargets,
  coreMismatchOf,
  classifyBootFailure,
  nextFailureStreak,
  isDeterministic,
}
