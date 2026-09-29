// plugin-activation.js — 把 DSH 启动期 stderr 里「插件没生效」的证据翻译成结构化条目（只读、纯函数）。
//
// 为什么要有它：DSH 有两种「插件没起来」的输出，且都只写 stderr —— 服务照常就绪、进程不崩、
// 退出码为 0，启动器的崩溃判定与健康检查一个信号都拿不到：
//
//   1) dsh: skipping profile bundle "<pkg>": <reason>
//      bundle 层整条被跳过：peer 兼容闸（声明的 @deepseek-ai/dsh* peer 不满足运行中的 dsh 版本）、
//      包目录解析不到、没声明 dsh.bundle、bundle patch 缺失或解析失败。
//   2) dsh: warning: N entries did not activate
//      <entry id> (<pkg>): failed to import | failed: <error> | pending (waiting for services: x, y)
//      行进了组合树、但没有激活：模块导入失败，或者在等一个没人提供的服务。
//
// 两种情形在用户侧的观感一模一样：插件市场显示「已安装，重启后生效」，而重启永远不生效
// （2026-09-29 实测：新机器 dsh 0.1.7-rc.2 上 @agents-anywhere/dsh-bridge-next failed to import，
//  08:54/08:55/08:56 三轮启动各报一次，手机上一直没有「手机连接」分区）。
//
// 本模块只负责「文本 → 结构化条目」；判定与呈现留在调用方，这样它能被单独钉死。
'use strict'

/** 控制台文本每行可能带启动器加的 `[时间] ` 前缀，解析前先剥掉（server.errTail 里是原始行，剥不到也无害）。 */
const STAMP_RE = /^\[[^\]]*\]\s*/u
/** `dsh: skipping profile bundle "<pkg>": <reason>`（前缀是可执行名，不写死成 dsh）。 */
const SKIP_RE = /^[^\s:]+:\s*skipping profile bundle "(?<pkg>[^"]+)":\s*(?<reason>.+)$/u
/** `dsh: warning: 1 entry did not activate` / `2 entries did not activate`。 */
const WARNING_RE = /^[^\s:]+:\s*warning:\s*\d+\s+entr(?:y|ies) did not activate\s*$/u
/** 紧随 warning 头之后的一行：`<entry id> (<package>): <detail>`。 */
const ENTRY_RE = /^(?<id>\S+)\s+\((?<pkg>[^)]+)\):\s*(?<detail>.*)$/u
/** `pending (waiting for service: sessions)` / `pending (waiting for services: a, b)`。 */
const PENDING_RE = /pending \(waiting for services?:\s*(?<services>[^)]*)\)/u
/** `Plugin <pkg>@<ver> is incompatible with dsh <ver>: peerDependencies {…}`。 */
const INCOMPATIBLE_RE = /is incompatible with dsh ([^\s:]+)/u
/** 单条原因在界面上占一行的上限：长尾（peer 列表、栈）留在 tooltip 与日志里。 */
const MAX_DETAIL_CHARS = 120

function stripStamp(line) {
  return String(line == null ? '' : line).replace(STAMP_RE, '')
}

function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    const key = item.kind + '\u0000' + item.packageName + '\u0000' + item.detail
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 解析一段 DSH stderr 文本，返回去重后的问题条目（按出现顺序）。
 * 条目行只在紧跟 `… did not activate` 头之后才认 —— 否则别的插件日志里
 * 形如 `foo (bar): baz` 的行会被误判成激活失败。
 * @param {string} text 原始 stderr（可含多行、可含时间戳前缀）
 * @returns {Array<{kind:'skipped'|'inactive', packageName:string, entryId:string, detail:string, services:string[]}>}
 */
function parseActivationIssues(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/)
  const out = []
  let expectEntries = false
  for (const raw of lines) {
    const line = stripStamp(raw).trim()
    if (!line) { expectEntries = false; continue }
    const skip = SKIP_RE.exec(line)
    if (skip) {
      expectEntries = false
      out.push({
        kind: 'skipped',
        packageName: skip.groups.pkg.trim(),
        entryId: '',
        detail: skip.groups.reason.trim(),
        services: [],
      })
      continue
    }
    if (WARNING_RE.test(line)) { expectEntries = true; continue }
    const entry = ENTRY_RE.exec(line)
    if (entry && expectEntries) {
      const detail = String(entry.groups.detail || '').trim()
      const pending = PENDING_RE.exec(detail)
      out.push({
        kind: 'inactive',
        packageName: entry.groups.pkg.trim(),
        entryId: entry.groups.id.trim(),
        detail,
        services: pending ? pending.groups.services.split(',').map((s) => s.trim()).filter(Boolean) : [],
      })
      continue
    }
    expectEntries = false
  }
  return dedupe(out)
}

/** 取第一条证据里可读的一段（丢掉英文长尾与处置建议），供界面单行显示。 */
function shortDetail(text) {
  const first = String(text == null ? '' : text).trim().split(/\r?\n/)[0].trim().replace(/^Error:\s*/u, '')
  if (!first) return ''
  // DSH 的原因行形如「<原因>; run 'dsh plugin --profile …'」：处置建议属于 tooltip，单行只留原因
  const head = first.split(';')[0].trim() || first
  return head.length > MAX_DETAIL_CHARS ? head.slice(0, MAX_DETAIL_CHARS - 1) + '…' : head
}

/**
 * 启动器自己做的**启动前 import 自检**的条目（不是从 DSH stderr 解析来的）。
 *
 * 为什么需要它：DSH 加载器对"插件模块导入失败"只回一句 `… : failed to import`，
 * 真正的报错（缺哪个包 / 哪个命名导出没了 / Node 太老）被吞掉，"装了却永远不生效"
 * 只能靠人工在那台机器上复现。启动器在起服务前用**同一个 Node** 试 import 一次，
 * 把这个原因带回日志与卡片。
 * @param {string} packageName 包名
 * @param {string} detail 自检得到的错误原文（取第一条有信息量的行）
 * @returns {object} 与 parseActivationIssues 的条目同形
 */
function importCheckIssue(packageName, detail) {
  return {
    kind: 'import-check',
    packageName: String(packageName || ''),
    entryId: '',
    detail: String(detail == null ? '' : detail),
    services: [],
  }
}

/**
 * 一条证据 → 界面上的单行文案（与卡片状态一一对应，不写"重启后生效"这种会误导的话）。
 * @param {object} issue parseActivationIssues / importCheckIssue 的条目
 * @returns {string}
 */
function describeActivationIssue(issue) {
  const it = issue || {}
  if (it.kind === 'import-check') return `启动前自检失败：${shortDetail(it.detail) || '原因见日志'}`
  if (it.kind === 'skipped') {
    const incompatible = INCOMPATIBLE_RE.exec(String(it.detail || ''))
    if (incompatible) return `启动时被跳过：与 dsh ${incompatible[1]} 不兼容`
    return `启动时被跳过：${shortDetail(it.detail) || '原因见服务日志'}`
  }
  if (Array.isArray(it.services) && it.services.length > 0) {
    return `启动时未激活：缺 ${it.services.join('、')} 服务（没有插件提供）`
  }
  return `启动时未激活：${shortDetail(it.detail) || '原因见服务日志'}`
}

/**
 * 卡片 tooltip：原因原文 + 一句为什么重启没用。只在这一行真的没起来时才占版面。
 * @param {object} issue 证据条目
 * @param {string} [extra] 调用方补充的处置建议（可空）
 * @returns {string}
 */
function activationIssueHint(issue, extra) {
  const it = issue || {}
  const lines = [
    it.kind === 'skipped'
      ? 'DSH 启动时跳过了这个 bundle，原因原文：'
      : (it.kind === 'import-check'
        ? '启动器在起服务之前试着导入这个插件，失败了（原因原文）：'
        : 'DSH 启动时这一行没有激活，原因原文：'),
    String(it.detail || '').trim() || '（服务日志里没有留下原因原文）',
  ]
  if (Array.isArray(it.services) && it.services.length > 0) lines.push('缺的服务：' + it.services.join('、'))
  lines.push(it.kind === 'import-check'
    ? '这一步发生在启动器起服务之前（插件自己的模块加载/解析失败），所以重启不会改变它；'
      + '缺的依赖可由启动器在下次启动时自愈，若报的是"找不到包/没有这个导出"，则需要换一份能匹配当前 dsh 的 payload。'
    : '服务本身能正常启动（这是一条 warning），所以重启不会改变它：插件那一行始终不在运行中的组合树里，'
      + '插件市场就会一直显示「重启后生效」。')
  if (extra) lines.push(String(extra))
  return lines.join('\n')
}

/**
 * 在证据列表里找某个包的条目。
 * @param {Array} issues 证据列表
 * @param {string} packageName 包名
 * @returns {object|undefined}
 */
function findActivationIssue(issues, packageName) {
  const name = String(packageName || '')
  if (!name || !Array.isArray(issues)) return undefined
  return issues.find((issue) => issue && issue.packageName === name)
}

module.exports = {
  parseActivationIssues,
  importCheckIssue,
  describeActivationIssue,
  activationIssueHint,
  findActivationIssue,
  // 纯函数（测试用）
  stripStamp,
  shortDetail,
}
