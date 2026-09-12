// service-handover.js — DSH 自重启识别的纯决策函数（无 IO、无定时器，便于单测）
// 背景：DSH Web UI 的「重启服务」会用自己的 argv 克隆一个新进程再退出。启动器只持有旧 PID，
// 于是把孩子退出误判成崩溃、把后继误判成"端口被别的程序占用"，继而抢同一端口 → EADDRINUSE 死循环。
// 这里只做判定：谁来持有端口 / 是不是我们这一轮启动的后继 / 崩溃裁决该不该继续等。
'use strict'

// 命令行按空格切分，双引号内视为一个 token（Windows 进程命令行就是这个格式）
function splitCmdline(line) {
  const out = []
  let cur = ''
  let quoted = false
  let started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // "" 在引号内表示一个字面双引号
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ } else quoted = !quoted
      started = true
      continue
    }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (started) { out.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  return out
}

// 路径段归一：统一分隔符、去尾斜杠、按需忽略大小写（Windows 路径大小写不敏感）
function normalizePath(value, caseInsensitive) {
  let s = String(value || '').trim().replace(/^"|"$/g, '').replace(/\\/g, '/')
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return caseInsensitive ? s.toLowerCase() : s
}

function tokenEqual(a, b, caseInsensitive) {
  return caseInsensitive ? String(a).toLowerCase() === String(b).toLowerCase() : a === b
}

/**
 * 判断某条进程命令行是否与"本轮我们启动 DSH 的签名"一致。
 * 只认脚本路径 + 脚本之后的参数：node 可以是裸 `node`、全路径、也可能夹着 --no-warnings 之类的前置参数。
 * @param {string} cmdline 操作系统给出的完整命令行
 * @param {{script:string, args:string[], caseInsensitive?:boolean}} sig
 * @returns {{ok:boolean, why?:string, matched?:string[]}}
 */
function matchLaunchSig(cmdline, sig) {
  const caseInsensitive = sig.caseInsensitive !== false
  const script = normalizePath(sig.script, caseInsensitive)
  if (!script || !String(cmdline || '').trim()) return { ok: false, why: 'cmdline-unknown' }
  const tokens = splitCmdline(cmdline)
  if (!tokens.length) return { ok: false, why: 'cmdline-unknown' }
  let idx = -1
  for (let i = 0; i < tokens.length; i++) {
    if (normalizePath(tokens[i], caseInsensitive) === script) { idx = i; break }
  }
  if (idx < 0) return { ok: false, why: 'script-mismatch' }
  const tail = tokens.slice(idx + 1)
  const want = (sig.args || []).map(String)
  if (tail.length !== want.length) return { ok: false, why: 'flag-mismatch', matched: tail }
  for (let i = 0; i < want.length; i++) {
    // --host/--port 的取值（IP、端口）必须逐字相等，开关名忽略大小写
    if (!tokenEqual(tail[i], want[i], caseInsensitive)) return { ok: false, why: 'flag-mismatch', matched: tail }
  }
  return { ok: true, matched: tail }
}

/**
 * child 退出后的交接裁决。
 * @param {{listenerPid:number, matchedPid?:number, elapsedMs:number,
 *          settleMs:number, maxMs:number}} state
 * @returns {'self-restart'|'external'|'pending'|'crash'}
 */
function classifyHandover(state) {
  const listenerPid = Number(state.listenerPid) || 0
  const matchedPid = Number(state.matchedPid) || 0
  if (listenerPid > 0) {
    // 只有"端口持有者 == 命令行逐参数匹配的那个进程"才认领；读不到命令行一律当外部实例
    return matchedPid > 0 && matchedPid === listenerPid ? 'self-restart' : 'external'
  }
  // 端口暂时没人监听：后继可能还在启动（bind 实测 3.5~4.5s）。有匹配候选就多等，没有就短等。
  const budget = matchedPid > 0 ? state.maxMs : state.settleMs
  return Number(state.elapsedMs) < budget ? 'pending' : 'crash'
}

/**
 * 端口被占时的"占有者裁决"：防止把自家正在启动的后继误判成外部程序抢端口。
 *
 * 事故现场：DSH 自重启 → 旧进程退出、后继刚 bind 但还没开始应答 → HTTP 指纹必然不命中，
 * 只看指纹就会得出"端口被其他程序占用"，进而误换端口、起出第二个实例（实测：3080 上并存两个 dsh）。
 *
 * 判据优先级：命令行签名（进程一创建就能读到，最可靠）→ HTTP 指纹 → 等待（端口有人但没应答）→ 冲突。
 * @param {{hasListener:boolean, sigMatched:boolean, probeOk:boolean, probeReason:string,
 *          waitedMs:number, budgetMs:number}} state
 * @returns {'retry-start'|'adopt'|'wait'|'conflict'}
 */
function classifyOccupant(state) {
  const s = state || {}
  if (s.hasListener !== true) return 'retry-start' // 端口又空了：交给启动器自己拉起
  if (s.sigMatched === true) return 'adopt' // 命令行逐参数一致 = 我们的后继
  if (s.probeOk === true) return 'adopt' // 指纹命中 = 已在运行的 DSH（外部实例）
  if (s.probeReason === 'fingerprint') return 'conflict' // 明确回了非 DSH 内容：确实是别人的程序
  const waited = Number(s.waitedMs) || 0
  const budget = Number(s.budgetMs) || 0
  return waited >= budget ? 'conflict' : 'wait'
}

/**
 * 就绪判定：端口有人应答不等于"我们的进程起来了"。
 * @param {{listenerPid:number, childPid:number, sigMatched:boolean}} state
 * @returns {'ready'|'claim'|'not-ours'|'ready-unverified'}
 */
function classifyReadiness(state) {
  const listenerPid = Number(state.listenerPid) || 0
  if (listenerPid > 0 && listenerPid === Number(state.childPid)) return 'ready'
  if (listenerPid === 0) return 'ready-unverified' // netstat 不可用/查不到：不否决就绪，但要留证据
  return state.sigMatched ? 'claim' : 'not-ours'
}

/** 冷却未到：返回还需等待的毫秒数（调用方必须据此排补偿定时器，否则看护会静默停摆） */
function planCooldownRetry(state) {
  const last = Number(state.lastRestartAt) || 0
  if (!last) return null
  const elapsed = Number(state.now) - last
  const waitMs = Number(state.cooldownMs) - elapsed
  return waitMs > 0 ? { waitMs } : null
}

/** 端口连续多轮没人监听才判定"服务消失"（克隆交接有一瞬空档，单次采样会误报崩溃） */
function shouldDeclareGone(state) {
  return (Number(state.downStreak) || 0) * (Number(state.tickMs) || 0) >= Number(state.confirmMs)
}

/**
 * 解析 DSH 打印的访问地址行，取带 token 的本机地址（纯函数版，副作用留给调用方）。
 * @returns {string|null} launch URL，或 null 表示与本世代无关（旧版无 token / 别的端口 / LAN 地址）
 */
function parseDshWebLine(line, opts) {
  const m = String(line || '').trim().match(/dsh web:\s*(https?:\/\/\S+)/)
  if (!m) return null
  let url
  try { url = new URL(m[1]) } catch { return null }
  const hostOk = url.hostname === opts.host || url.hostname === 'localhost'
  const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (!hostOk || effectivePort !== String(opts.port)) return null
  if (!url.searchParams.has('token')) return null
  return url.href
}

module.exports = {
  splitCmdline,
  matchLaunchSig,
  classifyHandover,
  classifyOccupant,
  classifyReadiness,
  planCooldownRetry,
  shouldDeclareGone,
  parseDshWebLine,
}
