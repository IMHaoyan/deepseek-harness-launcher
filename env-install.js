// env-install.js — 一键安装引擎：托管 Node.js（官方发行包下载/校验/解压）与 DSH（npm 前缀安装）+ 通知插件拷贝
//
// 设计要点：
//  - 全程零管理员权限：Node 用官方 zip（自带 npm），装到 ~/.dsh/dshl-runtime/node/<ver>/；
//    DSH 用该 npm 安装到 ~/.dsh/dshl-runtime/dsh/（路径绝对稳定，不碰 PATH）。
//  - 状态机单例：阶段列表 + 权重进度 + 实时日志（环形缓冲 500 行 + install.log 落盘）+ 取消。
//  - 下载优先 Electron net（自动走系统代理）；脱离 Electron（脚本/测试）回退 Node http/https。
//  - 官方源失败自动回退 npmmirror 镜像；Node 包校验官方 SHASUMS256.txt。
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')

const IS_WIN = process.platform === 'win32'

let HOME = path.join(os.homedir(), '.dsh')
let Config = { nodeMajor: 22, dshVersion: '0.1.0-rc.6', npmRegistry: '' }
let ASSETS_DIR = ''
let logFn = () => {}
let onPushFn = () => {}
let onDoneFn = () => {}

const INSTALL_LOG = 'dshl-logs/install.log' // 相对 HOME 的安装日志

function initInstaller(opts = {}) {
  if (opts.HOME) HOME = opts.HOME
  if (opts.Config) Config = opts.Config
  if (opts.ASSETS_DIR) ASSETS_DIR = opts.ASSETS_DIR
  if (opts.log) logFn = opts.log
  if (opts.onPush) onPushFn = opts.onPush
  if (opts.onDone) onDoneFn = opts.onDone
}

function log(message) {
  try { logFn('[install] ' + message) } catch { /* noop */ }
}

function runtimeBase() {
  return path.join(HOME, 'dshl-runtime')
}

function installLogPath() {
  return path.join(HOME, INSTALL_LOG)
}

// 安装日志落盘（1MB 轮转，保留 3 份）
function appendInstallLog(line) {
  try {
    const file = installLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > 1024 * 1024) {
        for (let i = 2; i >= 1; i--) {
          try { if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch { /* noop */ }
        }
        try { fs.renameSync(file, `${file}.1`) } catch { /* noop */ }
      }
    } catch { /* 文件不存在 */ }
    fs.appendFileSync(file, `[${new Date().toLocaleString('sv-SE', { hour12: false })}] ${line}\n`)
  } catch { /* noop */ }
}

// ---------- 命令执行 ----------

function runExec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const child = execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 0 }, (err, stdout, stderr) => {
        if (err) {
          const e = new Error(`${cmd} failed: ${String(err.message || err)}\n${String(stderr || '').slice(-800)}`)
          e.stdout = String(stdout || '')
          e.stderr = String(stderr || '')
          reject(e)
        } else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
      })
      if (opts.onAbort) opts.onAbort(() => { try { child.kill() } catch { /* noop */ } })
    } catch (err) { reject(err) }
  })
}

function killChildTree(child) {
  try {
    if (!child || child.exitCode !== null) return
    if (IS_WIN) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* noop */ } }
    }
  } catch { /* noop */ }
}

// ---------- 下载（Electron net 优先，回退 Node http/https；支持重定向、进度、取消） ----------

function electronNet() {
  try { return require('electron').net } catch { return null }
}

function downloadToFile(url, dest, onProgress, abortRef) {
  return new Promise((resolve, reject) => {
    const httpMod = (() => { try { return require(url.startsWith('https:') ? 'https' : 'http') } catch { return null } })()
    const done = (err, bytes) => { if (err) reject(err); else resolve({ bytes }) }
    const fail = (err) => {
      try { fs.unlinkSync(dest) } catch { /* noop */ }
      done(err)
    }
    const abort = () => { try { if (current) current.destroy ? current.destroy() : current.abort() } catch { /* noop */ } }
    abortRef.onAbort = abort
    let current = null
    const netMod = electronNet()
    if (netMod) {
      current = netMod.request(url)
      current.on('response', (res) => {
        const code = res.statusCode
        const loc = res.headers.location && String(res.headers.location[0] || res.headers.location)
        if ([301, 302, 303, 307, 308].includes(code) && loc) {
          try { res.resume() } catch { /* noop */ }
          abortRef.onAbort = null
          resolve(downloadToFile(new URL(loc, url).toString(), dest, onProgress, abortRef))
          return
        }
        if (code !== 200) { try { res.resume() } catch { /* noop */ } return fail(new Error(`HTTP ${code} ${url}`)) }
        const total = Number(res.headers['content-length'] || 0) || 0
        let got = 0
        const ws = fs.createWriteStream(dest)
        ws.on('error', (e) => fail(e))
        res.on('data', (chunk) => { got += chunk.length; try { ws.write(chunk) } catch { /* noop */ } if (onProgress) onProgress(got, total) })
        res.on('end', () => { try { ws.end(() => done(null, got)) } catch { done(null, got) } })
        res.on('error', (e) => { try { ws.destroy() } catch { /* noop */ } fail(e) })
      })
      current.on('error', (e) => fail(e))
      current.end()
    } else if (httpMod) {
      current = httpMod.get(url, { headers: { 'user-agent': 'dshl-installer/1.0' } }, (res) => {
        const code = res.statusCode
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          try { res.resume() } catch { /* noop */ }
          abortRef.onAbort = null
          resolve(downloadToFile(new URL(res.headers.location, url).toString(), dest, onProgress, abortRef))
          return
        }
        if (code !== 200) { try { res.resume() } catch { /* noop */ } return fail(new Error(`HTTP ${code} ${url}`)) }
        const total = Number(res.headers['content-length'] || 0) || 0
        let got = 0
        const ws = fs.createWriteStream(dest)
        ws.on('error', (e) => fail(e))
        res.on('data', (chunk) => { got += chunk.length; try { ws.write(chunk) } catch { /* noop */ } if (onProgress) onProgress(got, total) })
        res.on('end', () => { try { ws.end(() => done(null, got)) } catch { done(null, got) } })
        res.on('error', (e) => { try { ws.destroy() } catch { /* noop */ } fail(e) })
      })
      current.on('error', (e) => fail(e))
    } else {
      return fail(new Error('no http client available'))
    }
  })
}

// 小文本下载（index.json / SHASUMS256.txt）
async function downloadText(url, abortRef) {
  const tmp = path.join(os.tmpdir(), `dshl-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  try {
    await downloadToFile(url, tmp, null, abortRef)
    return fs.readFileSync(tmp, 'utf8')
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* noop */ }
  }
}

// ---------- 各阶段实现 ----------

function nodeBases() {
  const list = []
  if (Config.nodeMirror) list.push(Config.nodeMirror.replace(/\/+$/, ''))
  else list.push('https://nodejs.org/dist', 'https://npmmirror.com/dist')
  return [...new Set(list)]
}

async function resolveNodeVersion(job, base) {
  const index = JSON.parse(await downloadText(`${base}/index.json`, job.abortRef))
  const major = Number(Config.nodeMajor) || 22
  const entry = index.find((e) => typeof e.version === 'string' && e.version.startsWith(`v${major}.`))
  if (!entry) throw new Error(`Node.js v${major} 在 ${base} 中不存在`)
  return entry.version.replace(/^v/, '')
}

function nodeDistFile(ver) {
  const p = process.platform
  const a = process.arch
  const arch = a === 'x64' || a === 'arm64' ? a : 'x64'
  if (p === 'win32') return `node-v${ver}-win-${arch}.zip`
  if (p === 'darwin') return `node-v${ver}-darwin-${arch}.tar.gz`
  return `node-v${ver}-linux-${arch}.tar.xz`
}

async function verifySha256(job, base, ver, file, archivePath) {
  const sums = await downloadText(`${base}/v${ver}/SHASUMS256.txt`, job.abortRef)
  const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${file}`))
  if (!line) throw new Error(`校验文件 SHASUMS256.txt 中找不到 ${file}`)
  const expected = line.trim().split(/\s+/)[0]
  const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')
  if (expected.toLowerCase() !== actual.toLowerCase()) throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}`)
}

async function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  if (IS_WIN) {
    try {
      await runExec('tar', ['-xf', archive, '-C', destDir], { timeout: 300000 })
      return
    } catch (e) { log('tar.exe 解压失败，回退 PowerShell Expand-Archive: ' + e.message) }
    await runExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`], { timeout: 600000 })
  } else {
    const flag = archive.endsWith('.tar.xz') ? '-xJf' : '-xzf'
    await runExec('tar', [flag, archive, '-C', destDir], { timeout: 300000 })
  }
}

async function installNode(job, nodeDest, onExtractStart) {
  const bases = nodeBases()
  let ver = null
  let lastErr = null
  for (const base of bases) {
    try {
      ver = await resolveNodeVersion(job, base)
      job.logLine(`Node.js 版本列表：${base} → v${ver}`)
      break
    } catch (e) { lastErr = e; job.logLine(`版本列表获取失败（${base}）：${e.message}`) }
  }
  if (!ver) throw new Error('无法获取 Node.js 版本列表（网络不可用？）' + (lastErr ? ` ${lastErr.message}` : ''))

  const file = nodeDistFile(ver)
  const tmpDir = path.join(runtimeBase(), 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const archivePath = path.join(tmpDir, file)
  const extractDir = path.join(tmpDir, `extract-${Date.now()}`)

  let ok = false
  let lastDownloadErr = null
  for (const base of bases) {
    if (job.aborted) throw job.cancelledError()
    const url = `${base}/v${ver}/${file}`
    job.logLine(`下载 Node.js：${url}`)
    job.currentDownloadFile = archivePath
    try {
      const { bytes } = await downloadToFile(url, archivePath, (got, total) => {
        if (job.aborted) { try { job.abortRef.onAbort && job.abortRef.onAbort() } catch { /* noop */ } }
        job.stageProgress = total > 0 ? Math.min(1, got / total) : 0
        job.pushProgress()
      }, job.abortRef)
      job.currentDownloadFile = null
      job.logLine(`下载完成：${(bytes / 1024 / 1024).toFixed(1)} MB`)
      try {
        await verifySha256(job, base, ver, file, archivePath)
        job.logLine('SHA256 校验通过（官方 SHASUMS256.txt）')
      } catch (e) {
        job.logLine(`SHA256 校验失败：${e.message}（换源重试）`)
        try { fs.unlinkSync(archivePath) } catch { /* noop */ }
        continue
      }
      ok = true
      break
    } catch (e) {
      job.currentDownloadFile = null
      lastDownloadErr = e
      job.logLine(`下载失败（${base}）：${e.message}${bases.length > 1 && base === bases[0] ? '，回退镜像源重试' : ''}`)
    }
  }
  if (!ok) throw new Error(`Node.js 下载失败：${lastDownloadErr ? lastDownloadErr.message : '未知错误'}`)

  if (job.aborted) throw job.cancelledError()
  if (onExtractStart) onExtractStart()
  job.logLine('解压 Node.js 发行包…')
  await extractArchive(archivePath, extractDir)
  const archiveRoot = file.replace(/\.(zip|tar\.gz|tar\.xz)$/, '')
  const extracted = path.join(extractDir, archiveRoot)
  if (!fs.existsSync(extracted)) throw new Error(`解压后未找到目录 ${archiveRoot}`)
  fs.mkdirSync(path.dirname(nodeDest), { recursive: true })
  try { fs.rmSync(nodeDest, { recursive: true, force: true }) } catch { /* noop */ }
  fs.renameSync(extracted, nodeDest)
  try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch { /* noop */ }
  try { fs.unlinkSync(archivePath) } catch { /* noop */ }
  const nodeBin = path.join(nodeDest, IS_WIN ? 'node.exe' : 'node')
  if (!fs.existsSync(nodeBin)) throw new Error(`Node 可执行文件缺失：${nodeBin}`)
  job.logLine(`Node.js 安装完成：${nodeDest}`)
  return nodeBin
}

// 解析 npm CLI：托管/发行版 Node 自带 <dir>/node_modules/npm/bin/npm-cli.js
function npmCliFor(nodeBin) {
  const cli = path.join(path.dirname(nodeBin), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(cli)) return cli
  return null
}

function runNpmInstall(job, nodeBin, npmCli, args) {
  return new Promise((resolve, reject) => {
    // 关键：把 Node 可执行文件所在目录注入子进程 PATH。
    // 无系统 Node 的干净机器上，koffi/node-pty 等原生包的生命周期脚本以 `cmd /c node xxx.js` 执行，
    // 找不到 node 会报 "'node' 不是内部或外部命令"（npm 退出码 1）。
    const nodeDir = path.dirname(nodeBin)
    const env = Object.assign({}, process.env, { PATH: nodeDir + path.delimiter + (process.env.PATH || '') })
    let child
    try {
      if (npmCli) {
        child = spawn(nodeBin, [npmCli, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      } else if (IS_WIN) {
        // cmd.exe 兜底：每个 token 独立双引号包裹（cmd /s /c 会剥外层引号），避免路径/参数含空格时错乱
        const cmdLine = ['npm', ...args].map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ')
        child = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      } else {
        child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], env })
      }
    } catch (err) { return reject(err) }
    job.child = child
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line.trim()) job.logLine(line)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => reject(err))
    child.on('exit', (code) => {
      job.child = null
      if (job.aborted) return reject(job.cancelledError())
      if (code === 0) resolve()
      else reject(new Error(`npm 退出码 ${code}`))
    })
  })
}

async function installDsh(job, nodeBin) {
  const prefix = path.join(runtimeBase(), 'dsh')
  const version = (job.opts && job.opts.dshVersion) || Config.dshVersion || '0.1.0-rc.6'
  const spec = version === 'latest' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${version}`
  let npmCli = npmCliFor(nodeBin)
  if (!npmCli) {
    // nodeBin 可能是 PATH 上的裸 'node'：解析真实可执行路径，再找同目录的 npm-cli.js（MSI/nvm 发行版都自带）
    try {
      const res = await runExec(nodeBin, ['-p', 'process.execPath'], { timeout: 10000 })
      const real = String(res.stdout || '').trim()
      if (real) npmCli = npmCliFor(real)
    } catch { /* 忽略，走 cmd.exe 兜底 */ }
  }
  if (!npmCli) job.logLine('警告：所选 Node 未内置 npm，回退到 PATH 中的 npm 命令')
  const registries = Config.npmRegistry ? [Config.npmRegistry] : [null, 'https://registry.npmmirror.com']
  let lastErr = null
  for (const registry of registries) {
    if (job.aborted) throw job.cancelledError()
    const args = ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=info']
    if (registry) args.push('--registry', registry)
    args.push(spec)
    job.logLine(`npm install（registry=${registry || '默认'}）：${spec}`)
    try {
      await runNpmInstall(job, nodeBin, npmCli, args)
      return prefix
    } catch (e) {
      lastErr = e
      job.logLine(`npm 安装失败（registry=${registry || '默认'}）：${e.message}${registry === null ? '，回退镜像源重试' : ''}`)
    }
  }
  throw new Error(`DSH 安装失败：${lastErr ? lastErr.message : '未知错误'}`)
}

async function verifyDsh(job, nodeBin, prefix) {
  const dshBin = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(dshBin)) throw new Error(`DSH 入口缺失：${dshBin}`)
  const res = await runExec(nodeBin, [dshBin, '--version'], { timeout: 60000, onAbort: job.setAbort })
  const ver = String(res.stdout || '').trim()
  if (!/^\d/.test(ver)) throw new Error(`DSH 验证失败：--version 输出异常（${ver || '空'}）`)
  job.logLine(`DSH 验证通过：v${ver}`)
  return dshBin
}

async function installPlugin(job) {
  const src = ASSETS_DIR ? path.join(ASSETS_DIR, 'plugins', 'dsh-notify.mjs') : ''
  const dest = path.join(HOME, 'plugins', 'dsh-notify', 'dsh-notify.mjs')
  if (!src || !fs.existsSync(src)) throw new Error(`插件资产缺失：${src}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  job.logLine(`通知插件安装完成：${dest}`)
}

// ---------- 状态机 ----------

let currentJob = null
let jobSeq = 0

const KIND_LABELS = { source: '源码版', global: '全局安装', npx: 'npx 缓存', managed: '托管安装' }

function buildStages(items) {
  const stages = []
  const wantNode = items.includes('node')
  const wantDsh = items.includes('dsh')
  const wantPlugin = items.includes('plugin')
  if (wantNode && wantDsh && wantPlugin) {
    stages.push({ id: 'node-dl', label: '下载 Node.js', start: 0, end: 40 })
    stages.push({ id: 'node-ex', label: '校验并解压 Node.js', start: 40, end: 50 })
    stages.push({ id: 'dsh-npm', label: '安装 DeepSeek Harness（npm）', start: 50, end: 90 })
    stages.push({ id: 'dsh-verify', label: '验证 DeepSeek Harness', start: 90, end: 97 })
    stages.push({ id: 'plugin', label: '安装通知插件', start: 97, end: 100 })
  } else if (wantNode && wantDsh) {
    stages.push({ id: 'node-dl', label: '下载 Node.js', start: 0, end: 35 })
    stages.push({ id: 'node-ex', label: '校验并解压 Node.js', start: 35, end: 45 })
    stages.push({ id: 'dsh-npm', label: '安装 DeepSeek Harness（npm）', start: 45, end: 90 })
    stages.push({ id: 'dsh-verify', label: '验证 DeepSeek Harness', start: 90, end: 100 })
  } else if (wantDsh && wantPlugin) {
    stages.push({ id: 'dsh-npm', label: '安装 DeepSeek Harness（npm）', start: 0, end: 84 })
    stages.push({ id: 'dsh-verify', label: '验证 DeepSeek Harness', start: 84, end: 94 })
    stages.push({ id: 'plugin', label: '安装通知插件', start: 94, end: 100 })
  } else if (wantNode && wantPlugin) {
    stages.push({ id: 'node-dl', label: '下载 Node.js', start: 0, end: 76 })
    stages.push({ id: 'node-ex', label: '校验并解压 Node.js', start: 76, end: 92 })
    stages.push({ id: 'plugin', label: '安装通知插件', start: 92, end: 100 })
  } else if (wantNode) {
    stages.push({ id: 'node-dl', label: '下载 Node.js', start: 0, end: 80 })
    stages.push({ id: 'node-ex', label: '校验并解压 Node.js', start: 80, end: 100 })
  } else if (wantDsh) {
    stages.push({ id: 'dsh-npm', label: '安装 DeepSeek Harness（npm）', start: 0, end: 88 })
    stages.push({ id: 'dsh-verify', label: '验证 DeepSeek Harness', start: 88, end: 100 })
  } else {
    stages.push({ id: 'plugin', label: '安装通知插件', start: 0, end: 100 })
  }
  return stages
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status, // running | done | failed | cancelled
    items: job.items,
    stages: job.stages.map((s) => ({ id: s.id, label: s.label, status: s.status })),
    currentStage: job.currentStage,
    percent: Math.round(job.percent),
    stageText: job.stageText,
    error: job.error || null,
  }
}

function pushJob(job, lines) {
  try { onPushFn({ job: publicJob(job), lines: lines || null }) } catch { /* noop */ }
}

let pendingLines = []
let flushTimer = null
function flushPending() {
  if (!currentJob || !pendingLines.length) return
  const lines = pendingLines.splice(0, pendingLines.length)
  try { onPushFn({ job: publicJob(currentJob), lines }) } catch { /* noop */ }
}
function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = null; flushPending() }, 120)
}

function startInstall(items, opts = {}) {
  if (currentJob && currentJob.status === 'running') {
    const e = new Error('已有安装任务正在进行')
    e.alreadyRunning = true
    throw e
  }
  const valid = ['node', 'dsh', 'plugin']
  const list = [...new Set((items || []).filter((i) => valid.includes(i)))]
  if (!list.length) throw new Error('没有需要安装的项目')
  const job = {
    id: ++jobSeq,
    items: list,
    opts: opts || {},
    status: 'running',
    stages: buildStages(list).map((s) => ({ ...s, status: 'pending' })),
    currentStage: -1,
    percent: 0,
    stageText: '',
    error: null,
    log: [], // 环形日志（最近 500 行）
    aborted: false,
    abortRef: { onAbort: null },
    child: null,
    stageProgress: 0,
    currentDownloadFile: null,
  }
  job.cancelledError = () => { const e = new Error('安装已取消'); e.cancelled = true; return e }
  job.logLine = (line) => {
    appendInstallLog(line)
    log(line)
    job.log.push({ t: Date.now(), line })
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500)
    pendingLines.push(line)
    scheduleFlush()
  }
  job.setAbort = (fn) => { job.abortRef.onAbort = fn }
  job.pushProgress = () => {
    const s = job.stages[job.currentStage]
    if (!s) return
    job.percent = s.start + (s.end - s.start) * Math.min(1, Math.max(0, job.stageProgress || 0))
    job.stageText = s.label
    // 节流：整数百分比变化才推送，避免下载回调刷屏
    const pct = Math.round(job.percent)
    if (job._lastPushedPct !== pct) { job._lastPushedPct = pct; pushJob(job) }
  }
  job.enterStage = (idx) => {
    job.currentStage = idx
    job.stageProgress = 0
    for (let i = 0; i < job.stages.length; i++) {
      job.stages[i].status = i < idx ? 'done' : i === idx ? 'active' : 'pending'
    }
    const s = job.stages[idx]
    job.percent = s.start
    job.stageText = s.label
    job.logLine(`—— 阶段：${s.label} ——`)
    pushJob(job)
  }
  job.finishStage = () => {
    const s = job.stages[job.currentStage]
    if (s) { s.status = 'done'; job.stageProgress = 1; job.percent = s.end }
    pushJob(job)
  }
  currentJob = job
  job.logLine(`开始一键安装：${list.join(', ')}`)
  pushJob(job)
  void runJob(job)
  return job
}

async function runJob(job) {
  const stageIdx = (id) => job.stages.findIndex((s) => s.id === id)
  let nodeBin = null
  let nodeDest = null
  try {
    if (job.items.includes('node')) {
      job.enterStage(stageIdx('node-dl'))
      const tmpDest = path.join(runtimeBase(), 'node', '_installing-' + Date.now())
      try {
        nodeBin = await installNode(job, tmpDest, () => {
          job.finishStage()
          job.enterStage(stageIdx('node-ex'))
        })
        nodeDest = tmpDest
      } catch (e) {
        try { fs.rmSync(tmpDest, { recursive: true, force: true }) } catch { /* noop */ }
        throw e
      }
      job.finishStage()
      job.logLine(`Node.js 就绪：${nodeBin}`)
    }
    if (job.items.includes('dsh')) {
      job.enterStage(stageIdx('dsh-npm'))
      if (!nodeBin) {
        // 未装 Node：用探测到的系统 Node（其 npm 可能缺失，runNpmInstall 有兜底）
        const { detectEnv } = require('./env-detect')
        const report = await detectEnv(false)
        if (!report.node || report.node.status !== 'ok' || !report.node.path) {
          throw new Error('需要先安装 Node.js')
        }
        nodeBin = report.node.path
      }
      const prefix = await installDsh(job, nodeBin)
      job.finishStage()
      job.enterStage(stageIdx('dsh-verify'))
      await verifyDsh(job, nodeBin, prefix)
      job.finishStage()
    }
    if (job.items.includes('plugin')) {
      job.enterStage(stageIdx('plugin'))
      await installPlugin(job)
      job.finishStage()
    }
    // 托管 Node 落位：把 _installing-<ts> 重命名为真实版本目录
    if (nodeBin && nodeDest) {
      const ver = await (async () => {
        try {
          const out = await runExec(nodeBin, ['-v'], { timeout: 10000 })
          return String(out.stdout || '').trim().replace(/^v/, '')
        } catch { return '' }
      })()
      const finalDest = path.join(runtimeBase(), 'node', ver || `ver-${Date.now()}`)
      try { fs.rmSync(finalDest, { recursive: true, force: true }) } catch { /* noop */ }
      fs.renameSync(nodeDest, finalDest)
      job.logLine(`托管 Node 落位：${finalDest}`)
    }
    job.status = 'done'
    job.percent = 100
    job.stageText = '环境安装完成'
    for (const s of job.stages) s.status = 'done'
    job.logLine('环境安装完成，即将启动服务')
    pushJob(job)
    flushPending()
    try { onDoneFn() } catch { /* noop */ }
  } catch (err) {
    job.child = null
    if (err && err.cancelled) {
      job.status = 'cancelled'
      job.error = '安装已取消'
      job.logLine('安装已取消')
    } else {
      job.status = 'failed'
      job.error = err && err.message ? err.message : String(err)
      job.logLine(`安装失败：${job.error}`)
      const s = job.stages[job.currentStage]
      if (s && s.status === 'active') s.status = 'error'
    }
    job.stageText = job.status === 'cancelled' ? '安装已取消' : '安装失败'
    pushJob(job)
    flushPending()
  } finally {
    try { job.abortRef.onAbort = null } catch { /* noop */ }
    job.child = null
  }
}

function cancelInstall() {
  const job = currentJob
  if (!job || job.status !== 'running') return false
  job.aborted = true
  if (job.child) killChildTree(job.child)
  try { if (job.abortRef.onAbort) job.abortRef.onAbort() } catch { /* noop */ }
  try { if (job.currentDownloadFile) fs.unlinkSync(job.currentDownloadFile) } catch { /* noop */ }
  job.logLine('收到取消请求')
  return true
}

function getJob() {
  if (!currentJob) return null
  return {
    job: publicJob(currentJob),
    log: currentJob.log.slice(-400),
  }
}

module.exports = {
  initInstaller,
  startInstall,
  cancelInstall,
  getJob,
  installLogPath,
  runtimeBase,
  KIND_LABELS,
}
