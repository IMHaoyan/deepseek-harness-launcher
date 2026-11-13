// service-listener.js — 端口监听 PID 的取证（netstat → Get-NetTCPConnection 兜底）与纯解析
//
// 背景（2026-11 事故复盘）：旧 findListenPid() 在 Windows 上只跑 `netstat -ano -p TCP`，且
// `if (err) return 0` —— 超时 / 默认 1MiB maxBuffer 溢出 / PATH 里没有 netstat / 解析失败
// 全部静默退化成"没有监听者"。下游据此把"端口空闲"当事实，产生误判崩溃、误建议换端口。
//
// 本模块把结果分成三态：
//   found   —— 拿到了监听 PID（via=netstat | net-tcp）
//   absent  —— netstat/lsof 正常返回且没有该端口的 LISTENING 行，且端口确实没人应答
//   unknown —— 取证失败，或端口有人应答但两条通道都查不到 PID（绝不能当 absent 用）
// Get-NetTCPConnection 单次实测 1.6~2.3s（比 netstat 慢约 27 倍），只在"netstat 没给出 PID
// 且端口确实有人应答"时触发，并做 ~1.2s 缓存；绝不能放进 300ms 的交接轮询里裸调。
//
// 纯解析函数与 IO 编排分开，IO 通过 execFileImpl / runPwshImpl 注入，便于 node --test 覆盖。
'use strict'

const NETSTAT_TIMEOUT_MS = 8000
const NETSTAT_MAX_BUFFER = 4 * 1024 * 1024 // 默认 1MiB 在大连接表机器上会溢出（ERR_CHILD_PROCESS_STDIO_MAXBUFFER）
const FALLBACK_TIMEOUT_MS = 8000

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

// "127.0.0.1:3080" / "[::1]:3080" / "[::]:3080" → { hostPart, port }
function splitHostPort(local) {
  const s = String(local || '')
  const at = s.lastIndexOf(':')
  if (at < 0) return null
  let hostPart = s.slice(0, at)
  if (hostPart.startsWith('[') && hostPart.endsWith(']')) hostPart = hostPart.slice(1, -1)
  const port = parseInt(s.slice(at + 1), 10)
  if (!hostPart || !Number.isInteger(port)) return null
  return { hostPart, port }
}

function rankHost(hostPart, host) {
  if (hostPart === host) return 0 // 精确命中 --host（默认 127.0.0.1）
  if (WILDCARD_HOSTS.has(hostPart)) return 1 // 0.0.0.0 / :: 的监听也是这个端口的合法持有者
  return 2
}

function summarize(candidates, host, via) {
  if (!candidates.length) {
    return { status: 'absent', pid: 0, via, ambiguous: false, candidates: [] }
  }
  const ranked = candidates
    .map((c) => ({ ...c, rank: rankHost(c.host, host) }))
    .sort((a, b) => a.rank - b.rank)
  const best = ranked[0].rank
  const top = ranked.filter((c) => c.rank === best)
  const pids = [...new Set(top.map((c) => c.pid))]
  // 同优先级出现多个不同 PID = 歧义。仍返回第一个，但调用方可以据 ambiguous 记录/拒绝认领。
  return { status: 'found', pid: top[0].pid, via, ambiguous: pids.length > 1, candidates }
}

/**
 * 解析 netstat 输出（TCP + TCPv6；不再传 -p TCP，否则 IPv6 监听必然漏掉）。
 * @param {string} stdout
 * @param {number|string} port
 * @param {string} host
 */
function parseNetstatListeners(stdout, port, host) {
  const candidates = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const parsed = splitHostPort(parts[1])
    if (!parsed || String(parsed.port) !== String(port)) continue
    const pid = parseInt(parts[parts.length - 1], 10)
    if (!Number.isInteger(pid) || pid <= 0) continue // PID=0 行不能提前 return；跳过继续收集
    candidates.push({ pid, host: parsed.hostPart })
  }
  return summarize(candidates, host, 'netstat')
}

/**
 * 解析 Get-NetTCPConnection 的输出（每行 "pid;localAddress"）。
 * 查询侧已用 RemotePort=0 过滤掉已接受连接；这里再按 host 精确度择优。
 */
function parseNetTcpRows(stdout, host) {
  const candidates = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    const at = text.indexOf(';')
    if (at < 0) continue
    const pid = parseInt(text.slice(0, at), 10)
    if (!Number.isInteger(pid) || pid <= 0) continue
    candidates.push({ pid, host: text.slice(at + 1).trim() })
  }
  return summarize(candidates, host, 'net-tcp')
}

// 端口有人应答但拿不到 PID 时，查 Get-NetTCPConnection。用 RemotePort=0 判监听行
// （不依赖 State 枚举：报告机器上 State 曾出现空串；监听 socket 的 RemotePort 恒为 0）。
function fallbackScript(port) {
  return [
    `Get-NetTCPConnection -LocalPort ${Number(port)} -ErrorAction SilentlyContinue`,
    '| Where-Object { $_.OwningProcess -gt 0 -and $_.RemotePort -eq 0 }',
    '| ForEach-Object { "$($_.OwningProcess);$($_.LocalAddress)" }',
    '; exit 0', // 无匹配时 PowerShell 也会以 1 退出（SilentlyContinue 挡不住），必须显式归零
  ].join(' ')
}

function createListenerResolver({
  isWin,
  host = '127.0.0.1',
  execFileImpl,
  runPwshImpl,
  now = Date.now,
  cacheMs = 1200,
} = {}) {
  if (typeof execFileImpl !== 'function' || typeof runPwshImpl !== 'function') {
    throw new TypeError('createListenerResolver 需要注入 execFileImpl / runPwshImpl')
  }
  const fallbackCache = new Map() // port → { at, result }

  function runExec(file, args) {
    return new Promise((resolve) => {
      const started = now()
      try {
        execFileImpl(file, args, { windowsHide: true, timeout: NETSTAT_TIMEOUT_MS, maxBuffer: NETSTAT_MAX_BUFFER }, (err, stdout, stderr) => {
          resolve({ err: err || null, stdout: String(stdout || ''), stderr: String(stderr || ''), ms: now() - started })
        })
      } catch (err) {
        resolve({ err, stdout: '', stderr: '', ms: now() - started })
      }
    })
  }

  function diagOf(run, extra) {
    const err = run.err
    return {
      ok: !err,
      code: err ? (err.code || (err.killed ? 'killed' : 'error')) : 0,
      killed: !!(err && err.killed),
      signal: err ? String(err.signal || '') : '',
      ms: run.ms,
      bytes: run.stdout.length,
      lines: run.stdout ? run.stdout.split(/\r?\n/).length : 0,
      ...(extra || {}),
    }
  }

  async function primaryResolve(port) {
    if (isWin) {
      const run = await runExec('netstat', ['-ano']) // 不传 -p TCP：要同时覆盖 IPv4/IPv6
      if (run.err) return { ...summarize([], host, 'netstat'), status: 'unknown', diag: diagOf(run) }
      return { ...parseNetstatListeners(run.stdout, port, host), diag: diagOf(run) }
    }
    const run = await runExec('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'])
    // lsof 无匹配时以退出码 1 结束 = 正常 absent；工具缺失/超时才是不确定。
    if (run.err) {
      const absent = run.err.code === 1 && !run.err.killed
      return {
        ...summarize([], host, 'lsof'),
        ...(absent ? {} : { status: 'unknown' }),
        diag: diagOf(run),
      }
    }
    const first = String(run.stdout || '').trim().split(/\r?\n/)[0]
    const pid = parseInt(first, 10)
    if (!Number.isInteger(pid) || pid <= 0) return { ...summarize([], host, 'lsof'), diag: diagOf(run) }
    return { ...summarize([{ pid, host }], host, 'lsof'), diag: diagOf(run) }
  }

  async function fallbackResolve(port) {
    const started = now()
    let out
    try {
      out = await runPwshImpl(fallbackScript(port), { timeoutMs: FALLBACK_TIMEOUT_MS })
    } catch (err) {
      out = { ok: false, code: 'error', stdout: '', stderr: err && err.message ? err.message : String(err) }
    }
    const diag = {
      ok: out.ok === true,
      code: out.code || 0,
      ms: now() - started,
      bytes: String(out.stdout || '').length,
      stderr: String(out.stderr || '').trim().slice(0, 200),
    }
    if (!out.ok) return { status: 'unknown', pid: 0, via: 'net-tcp', ambiguous: false, candidates: [], diag }
    const parsed = parseNetTcpRows(out.stdout, host)
    // 端口有人应答、兜底却查不到 PID：这是 unknown，不能落成 absent（否则又回到旧 bug）。
    return parsed.status === 'absent'
      ? { status: 'unknown', pid: 0, via: 'net-tcp', ambiguous: false, candidates: [], diag }
      : { ...parsed, diag }
  }

  /**
   * @param {number|string} port
   * @param {{probePortOpen?: () => Promise<boolean>|boolean}} [options]
   * @returns {Promise<{status:'found'|'absent'|'unknown', pid:number, via:string,
   *                    ambiguous:boolean, diag:object, cached:boolean, totalMs:number}>}
   */
  async function resolve(port, { probePortOpen } = {}) {
    const started = now()
    const primary = await primaryResolve(port)
    if (primary.status === 'found') return { ...primary, cached: false, totalMs: now() - started }
    // 兜底的代价是 1.6~2.3s：只有"端口确实有人应答"才值得跑；端口关着就没有监听者可言。
    let open = false
    if (typeof probePortOpen === 'function') {
      try { open = (await probePortOpen()) === true } catch { open = false }
    }
    if (!open || !isWin) return { ...primary, cached: false, totalMs: now() - started }
    const cached = fallbackCache.get(String(port))
    if (cached && now() - cached.at < cacheMs) {
      return { ...cached.result, cached: true, totalMs: now() - started }
    }
    const result = await fallbackResolve(port)
    fallbackCache.set(String(port), { at: now(), result })
    // 保留主通道（netstat）的失败诊断：最终 unknown 时，两段证据都要能解释。
    return { ...result, diag: { ...result.diag, primary: primary.diag }, cached: false, totalMs: now() - started }
  }

  return { resolve }
}

module.exports = {
  splitHostPort,
  parseNetstatListeners,
  parseNetTcpRows,
  fallbackScript,
  createListenerResolver,
}
