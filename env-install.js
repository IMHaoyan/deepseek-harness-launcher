// env-install.js — 一键安装引擎：用户级 Node.js（官方发行包下载/校验/解压 + 用户 PATH）+ DSH（全局 npm 安装）+ 通知插件拷贝
//
// 设计要点：
//  - 全程零管理员权限：Node 用官方 zip（自带 npm）装到 %LOCALAPPDATA%\Programs\nodejs 并写入用户 PATH
//    （HKCU\Environment，重开终端即可用 npm/node/dsh）；DSH 用 npm install -g 装到全局根
//    （有系统 npm 按其 prefix，否则 %APPDATA%\npm），与用户命令行 npm 完全同源。
//  - 失败回退：全局 npm 装不上 → 回退托管目录（~/.dsh/dshl-runtime/dsh）；旧版保留不动。
//  - 状态机单例：阶段列表 + 权重进度 + 实时日志（环形缓冲 500 行 + install.log 落盘）+ 取消。
//  - 下载优先 Electron net（自动走系统代理）；脱离 Electron（脚本/测试）回退 Node http/https。
//  - npm 源 npmmirror 优先，失败回退官方源；Node 包校验官方 SHASUMS256.txt。
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

// 用户级 Node 安装目录（官方 zip 解压落位；免管理员；可用环境变量覆盖，测试用）。
// 非 Windows 平台保持托管目录（macOS/Linux 用户 PATH 方案未验证，不冒险）。
function userNodeDir() {
  if (process.env.DSHL_USER_NODE_DIR) return process.env.DSHL_USER_NODE_DIR
  if (!IS_WIN) return path.join(runtimeBase(), 'node')
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'Programs', 'nodejs')
}

// npm 全局根（npm i -g 落点；Windows 默认 %APPDATA%\npm，与官方安装器一致）
function npmGlobalRoot() {
  if (process.env.DSHL_NPM_GLOBAL_ROOT) return process.env.DSHL_NPM_GLOBAL_ROOT
  if (!IS_WIN) return '/usr/local'
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm')
}

// ---------- 用户 PATH（HKCU\Environment；免管理员，仅 Windows） ----------

async function readUserPath() {
  const out = { type: 'REG_EXPAND_SZ', value: '' }
  try {
    const r = await runExec('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { timeout: 10000 })
    const m = /Path\s+(REG_\w+)\s+(.*)$/m.exec(r.stdout)
    if (m) { out.type = m[1]; out.value = m[2] }
  } catch { /* 无 Path 值，按新建处理 */ }
  return out
}

// 把目录写入用户 PATH（默认追加；prepend=true 时置顶——用于 dshl 自装 Node 优先于过旧系统 Node）
async function addToUserPath(job, dirs, opts = {}) {
  if (!IS_WIN) { job.logLine('非 Windows 平台，跳过用户 PATH 写入'); return }
  if (process.env.DSHL_SKIP_PATH === '1') { job.logLine('跳过用户 PATH 写入（DSHL_SKIP_PATH=1，测试模式）'); return }
  const { type, value } = await readUserPath()
  const parts = value ? value.split(';').map((p) => p.trim()).filter(Boolean) : []
  const norm = (p) => { try { return path.resolve(p.replace(/^"(.*)"$/, '$1')).toLowerCase() } catch { return p.toLowerCase() } }
  const added = []
  for (const d of dirs) {
    if (!d || parts.some((p) => norm(p) === norm(d))) continue
    parts.push(d)
    added.push(d)
  }
  if (!added.length) { job.logLine('用户 PATH 已包含所需目录，无需修改'); return }
  if (opts.prepend) {
    // 置顶：新装 Node 应优先于系统里过旧的 Node
    for (const d of added) { const i = parts.indexOf(d); if (i > 0) { parts.splice(i, 1); parts.unshift(d) } }
  }
  const newValue = parts.join(';')
  await runExec('reg', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', type, '/d', newValue, '/f'], { timeout: 15000 })
  job.logLine(`用户 PATH 已更新：${added.join('、')}${opts.prepend ? '（置顶）' : ''}（新开终端生效）`)
  broadcastEnvironmentChange()
}

// 广播 WM_SETTINGCHANGE：让 Explorer 立即重载环境变量（新终端无需注销即可看到新 PATH）
function broadcastEnvironmentChange() {
  const ps = [
    "Add-Type -Namespace Dshl -Name Env -MemberDefinition '[DllImport(\"user32.dll\", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'",
    '$r = [UIntPtr]::Zero',
    '[Dshl.Env]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r) | Out-Null',
  ].join('; ')
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' })
  } catch { /* 广播失败不影响：重开终端/重启资源管理器后仍生效 */ }
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
      const child = execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 0, env: opts.env || process.env }, (err, stdout, stderr) => {
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

// 内置 Node 发行包（发布构建时由 tools/fetch-node-dist.mjs 预置，首装免下载）：
// 查找顺序：环境变量 DSHL_NODE_DIST_DIR（测试用）→ 开发模式 <项目根>/assets/node-dist → 打包后 <resources>/node-dist
function bundledNodeDist() {
  const major = Number(Config.nodeMajor) || 22
  const dirs = [
    process.env.DSHL_NODE_DIST_DIR,
    path.join(__dirname, 'assets', 'node-dist'),
    path.join(process.resourcesPath || '', 'node-dist'),
  ].filter(Boolean)
  for (const dir of dirs) {
    try {
      const zips = fs.readdirSync(dir).filter((f) => new RegExp(`^node-v${major}\\.\\d+\\.\\d+-win-x64\\.zip$`).test(f))
      if (!zips.length) continue
      const file = zips.sort().pop() // 同主版本取最高补丁版
      const archivePath = path.join(dir, file)
      const shaFile = archivePath + '.sha256'
      const expected = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0] : ''
      return { archivePath, ver: file.replace(/^node-v/, '').replace(/-win-x64\.zip$/, ''), expected }
    } catch { /* 换下一个位置 */ }
  }
  return null
}

// 校验并解压 Node 发行包 → 落位 nodeDest（下载路径与内置包路径共用）
async function finalizeNode(job, archivePath, extractDir, file, nodeDest, onExtractStart) {
  if (job.aborted) throw job.cancelledError()
  if (onExtractStart) onExtractStart()
  job.logLine('解压 Node.js 发行包…')
  await extractArchive(archivePath, extractDir)
  const archiveRoot = file.replace(/\.(zip|tar\.gz|tar\.xz)$/, '')
  const extracted = path.join(extractDir, archiveRoot)
  if (!fs.existsSync(extracted)) throw new Error(`解压后未找到目录 ${archiveRoot}`)
  fs.mkdirSync(path.dirname(nodeDest), { recursive: true })
  try { fs.rmSync(nodeDest, { recursive: true, force: true }) } catch { /* noop */ }
  try {
    fs.renameSync(extracted, nodeDest)
  } catch (e) {
    // 跨卷（如 tmp 在 C:、目标在 D:）rename 会 EXDEV：回退复制
    if (!e || e.code !== 'EXDEV') throw e
    job.logLine('跨卷移动，改用复制落位…')
    fs.cpSync(extracted, nodeDest, { recursive: true })
    try { fs.rmSync(extracted, { recursive: true, force: true }) } catch { /* noop */ }
  }
  try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch { /* noop */ }
  try { fs.unlinkSync(archivePath) } catch { /* noop */ }
  const nodeBin = path.join(nodeDest, IS_WIN ? 'node.exe' : 'node')
  if (!fs.existsSync(nodeBin)) throw new Error(`Node 可执行文件缺失：${nodeBin}`)
  job.logLine(`Node.js 安装完成：${nodeDest}`)
  return nodeBin
}

async function installNode(job, nodeDest, onExtractStart) {
  // 快路径：打包内置的 Node 发行包（免下载、秒装；SHA256 校验失败或不存在则回退下载）
  const bundled = bundledNodeDist()
  if (bundled) {
    job.logLine(`使用内置 Node.js 发行包 v${bundled.ver}（免下载）：${bundled.archivePath}`)
    let shaOk = true
    if (bundled.expected) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(bundled.archivePath)).digest('hex')
      shaOk = actual.toLowerCase() === bundled.expected.toLowerCase()
      if (!shaOk) job.logLine(`内置包 SHA256 校验失败（期望 ${bundled.expected.slice(0, 16)}…），回退下载`)
    }
    if (shaOk) {
      job.stageProgress = 1
      job.pushProgress()
      const tmpDir = path.join(runtimeBase(), 'tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      const extractDir = path.join(tmpDir, `extract-${Date.now()}`)
      const file = `node-v${bundled.ver}-win-x64.zip`
      // 内置包在只读资源目录（asar 外）里：拷贝到 tmp 再解压，避免占用原始文件
      const localCopy = path.join(tmpDir, file)
      try { fs.copyFileSync(bundled.archivePath, localCopy) } catch (e) { job.logLine(`内置包拷贝失败（回退下载）：${e.message}`); }
      if (fs.existsSync(localCopy)) {
        return await finalizeNode(job, localCopy, extractDir, file, nodeDest, onExtractStart)
      }
    }
    job.logLine('内置包不可用，回退在线下载')
  }

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
  return await finalizeNode(job, archivePath, extractDir, file, nodeDest, onExtractStart)
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
        // cmd.exe 兜底：首 token（程序名）不加引号（cmd /s /c 会剥字符串首尾引号，加引号会把 npm 变成 npm"），
        // 仅对含空格/& 的参数加引号
        const cmdLine = args.map((a, i) => {
          const s = String(a).replace(/"/g, '\\"')
          return i === 0 ? s : (/\s|&/.test(s) ? `"${s}"` : s)
        }).join(' ')
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

// ---------- npm 安装（统一渠道：npmmirror 镜像优先，失败回退 npm 官方源） ----------

// npm 双源安装循环：返回 true/false
async function npmInstallTo(job, nodeBin, prefix, spec) {
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
  const registries = Config.npmRegistry ? [Config.npmRegistry] : ['https://registry.npmmirror.com', null]
  for (const registry of registries) {
    if (job.aborted) throw job.cancelledError()
    const args = ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=info']
    if (registry) args.push('--registry', registry)
    args.push(spec)
    job.logLine(`npm install（registry=${registry || '默认'}）：${spec}`)
    try {
      await runNpmInstall(job, nodeBin, npmCli, args)
      return true
    } catch (e) {
      job.logLine(`npm 安装失败（registry=${registry || '默认'}）：${e.message}${registry ? '，回退官方源重试' : ''}`)
    }
  }
  return false
}

// 全局 npm 安装：npm i -g --prefix <全局根> @deepseek-ai/dsh@<ver>（npmmirror 优先、官方回退）
// 返回全局根（<root>/node_modules/@deepseek-ai/dsh 即安装处）；已装同版本时跳过
async function installDshGlobal(job, nodeBin, globalRoot) {
  const version = (job.opts && job.opts.dshVersion) || Config.dshVersion || '0.1.0-rc.6'
  const spec = version === 'latest' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${version}`
  const pkgDir = path.join(globalRoot, 'node_modules', '@deepseek-ai', 'dsh')
  const binPath = path.join(pkgDir, 'lib', 'bin.js')
  const installed = readInstalledVersion(pkgDir)
  if (installed && version !== 'latest' && installed === version) {
    job.logLine(`全局 npm 已安装 v${installed}（与目标版本一致），跳过安装`)
    return globalRoot
  }
  // 落点可写性预检：给用户一条可行动的报错，而不是 npm 的深层错误
  try {
    const probe = path.join(globalRoot, '.dshl-write-test-' + Date.now())
    fs.mkdirSync(globalRoot, { recursive: true })
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
  } catch (e) {
    throw new Error(`npm 全局目录不可写：${globalRoot}（${e.message}）`)
  }
  const registries = Config.npmRegistry ? [Config.npmRegistry] : ['https://registry.npmmirror.com', null]
  let lastErr = null
  // 解析 npm CLI：nodeBin 可能是 PATH 上的裸 'node'，先解析真实可执行路径再找同目录 npm-cli.js
  let npmCli = npmCliFor(nodeBin)
  if (!npmCli && nodeBin) {
    try {
      const res = await runExec(nodeBin, ['-p', 'process.execPath'], { timeout: 10000 })
      const real = String(res.stdout || '').trim()
      if (real) npmCli = npmCliFor(real)
    } catch { /* 忽略，走 cmd.exe 兜底 */ }
  }
  if (!npmCli) job.logLine('警告：所选 Node 未内置 npm，回退到 PATH 中的 npm 命令')
  for (const registry of registries) {
    if (job.aborted) throw job.cancelledError()
    const args = ['install', '-g', '--prefix', globalRoot, '--no-audit', '--no-fund', '--loglevel=info']
    if (registry) args.push('--registry', registry)
    args.push(spec)
    job.logLine(`npm install -g（registry=${registry || '默认'}）：${spec} → ${globalRoot}`)
    try {
      await runNpmInstall(job, nodeBin, npmCli, args)
      if (!fs.existsSync(binPath)) throw new Error(`安装后未找到 ${binPath}`)
      job.logLine(`全局 npm 安装完成：${pkgDir}`)
      return globalRoot
    } catch (e) {
      lastErr = e
      job.logLine(`npm install -g 失败（registry=${registry || '默认'}）：${e.message}${registry ? '，回退官方源重试' : ''}`)
    }
  }
  throw lastErr || new Error('npm install -g 失败')
}

// 已装全局 DSH 版本（npm i -g 落点）
function readInstalledVersion(pkgDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    return (pkg && pkg.name === '@deepseek-ai/dsh' && pkg.version) || ''
  } catch { return '' }
}

// 解析 npm 全局根：有系统 npm 时按其真实 prefix（与用户命令行 npm 完全一致）；否则默认 %APPDATA%\npm
async function resolveGlobalRoot(nodeBin) {
  if (process.env.DSHL_NPM_GLOBAL_ROOT) return process.env.DSHL_NPM_GLOBAL_ROOT // 测试覆盖
  const fallback = npmGlobalRoot()
  const candidates = []
  try {
    const r = await runExec('npm', ['config', 'get', 'prefix'], { timeout: 20000 })
    if (r.stdout && r.stdout.trim()) candidates.push(String(r.stdout).trim())
  } catch { /* 无系统 npm */ }
  if (nodeBin) {
    const cli = npmCliFor(nodeBin)
    if (cli) {
      try {
        const r = await runExec(nodeBin, [cli, 'config', 'get', 'prefix'], { timeout: 20000 })
        if (r.stdout && r.stdout.trim()) candidates.push(String(r.stdout).trim())
      } catch { /* 忽略 */ }
    }
  }
  const found = candidates.find((p) => p && /[/\\]/.test(p))
  return found || fallback
}

// 托管目录安装（回退路径）：原子安装，永远装到 dsh-new，成功后毫秒级切换；旧版保留到切换成功
async function installDshManaged(job, nodeBin) {
  const dshDir = path.join(runtimeBase(), 'dsh')
  const freshDir = path.join(runtimeBase(), 'dsh-new')
  const oldDir = path.join(runtimeBase(), 'dsh-old')
  const version = (job.opts && job.opts.dshVersion) || Config.dshVersion || '0.1.0-rc.6'
  const spec = version === 'latest' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${version}`
  try { fs.rmSync(freshDir, { recursive: true, force: true }) } catch { /* noop */ }
  try { fs.rmSync(oldDir, { recursive: true, force: true }) } catch { /* noop */ }
  fs.mkdirSync(path.dirname(freshDir), { recursive: true })
  try {
    const npmOk = await npmInstallTo(job, nodeBin, freshDir, spec)
    if (!npmOk) throw new Error('DSH 安装失败（npmmirror 镜像与 npm 官方源均未成功）')
    // 原子切换：旧版 → dsh-old（备份）→ dsh-new → dsh → 删除备份
    if (fs.existsSync(dshDir)) fs.renameSync(dshDir, oldDir)
    fs.renameSync(freshDir, dshDir)
    try { fs.rmSync(oldDir, { recursive: true, force: true }) } catch { /* 备份删不掉不影响 */ }
    job.logLine('DSH 目录已原子切换完成')
    return dshDir
  } catch (e) {
    try { fs.rmSync(freshDir, { recursive: true, force: true }) } catch { /* noop */ }
    throw e
  }
}

// DSH 安装主入口：优先全局 npm（统一渠道）；失败回退托管目录（旧逻辑兜底）
async function installDsh(job, nodeBin) {
  try {
    const globalRoot = await resolveGlobalRoot(nodeBin)
    return await installDshGlobal(job, nodeBin, globalRoot)
  } catch (e) {
    job.logLine(`全局 npm 安装失败（回退托管目录）：${e.message}`)
    return await installDshManaged(job, nodeBin)
  }
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

const KIND_LABELS = { source: '源码版', global: '全局 npm 安装', npx: 'npx 缓存', managed: '托管安装' }

// dsh-npm 阶段预估耗时：默认种子值（npm 安装 3-6 分钟，取 4 分钟为种子；EWMA 学习后贴近本机真实水平）；
// 真实耗时会在每台机器上持续学习（EWMA 平滑），首装之后即贴近本机真实水平
const NPM_STAGE_ESTIMATE_MS = 240000
// 各阶段名义耗时（与 buildStages 权重一致；Node 内置包解压秒级 → 名义 10s；dsh-npm 用学习值）
const STAGE_NOMINAL_MS = { 'node-dl': 10000, 'node-ex': 10000, 'dsh-npm': NPM_STAGE_ESTIMATE_MS, 'dsh-verify': 5000, 'plugin': 3000 }

// 进度展示缓动：当前为纯线性（EASE_MIX=0，显示=真实进度）。
//   历史实验：'in'（加速冲线）/ 'inout'（两头慢）均因体感与剩余时间不一致被否——线性最诚实。
//   如需恢复缓动：EASE_STYLE='in'|'inout'，EASE_MIX>0（∈[0,1]，与线性混合度）
const EASE_STYLE = 'in'
const EASE_MIX = 0
const EASE_POW = 1.6
function easePercent(raw) {
  const t = Math.max(0, Math.min(1, raw / 100))
  if (!EASE_MIX) return raw
  const s = EASE_STYLE === 'inout' ? t * t * (3 - 2 * t) : Math.pow(t, EASE_POW)
  return ((1 - EASE_MIX) * t + EASE_MIX * s) * 100
}

// 安装统计（本机学习值）：~/.dsh/dshl-runtime/install-stats.json
function installStatsPath() {
  return path.join(runtimeBase(), 'install-stats.json')
}
function loadInstallStats() {
  try {
    const s = JSON.parse(fs.readFileSync(installStatsPath(), 'utf8'))
    const ms = Number(s.dshNpmMs)
    // 下限 60s：旧版（pnpm 快路径）学习值 ~40s 会导致 npm 安装期间进度条提前跑满；EWMA 会逐步校正
    if (Number.isFinite(ms) && ms > 10000) return { dshNpmMs: Math.max(60000, Math.round(ms)) }
  } catch { /* 首次安装或文件损坏 */ }
  return { dshNpmMs: NPM_STAGE_ESTIMATE_MS }
}
function saveInstallStats(s) {
  try {
    fs.mkdirSync(path.dirname(installStatsPath()), { recursive: true })
    fs.writeFileSync(installStatsPath(), JSON.stringify(s))
  } catch { /* 写失败不影响安装 */ }
}
// 学习真实耗时：EWMA 0.6×旧值 + 0.4×本次实际（单次波动只影响四成，越装越准）
function learnNpmDuration(actualMs) {
  const s = loadInstallStats()
  s.dshNpmMs = Math.round(s.dshNpmMs * 0.6 + actualMs * 0.4)
  saveInstallStats(s)
  return s.dshNpmMs
}

// 阶段权重由 STAGE_NOMINAL_MS 自动计算（改种子/学习值无需手调）：
// Node 阶段（内置包解压，秒级）占小块；DSH 主程序安装（npm，数分钟）是绝对大头；尾部验证/插件小块
const STAGE_LABELS = {
  'node-dl': '准备 Node.js',
  'node-ex': '校验并解压 Node.js',
  'dsh-npm': '安装 DeepSeek Harness 主程序',
  'dsh-verify': '验证 DeepSeek Harness',
  plugin: '安装桌面通知',
}
function buildStages(items) {
  const order = ['node-dl', 'node-ex', 'dsh-npm', 'dsh-verify', 'plugin']
  const wanted = order.filter((id) => {
    if (id === 'node-dl' || id === 'node-ex') return items.includes('node')
    if (id === 'dsh-npm' || id === 'dsh-verify') return items.includes('dsh')
    return items.includes('plugin')
  })
  if (!wanted.length) return []
  const total = wanted.reduce((sum, id) => sum + (STAGE_NOMINAL_MS[id] || 10000), 0)
  const stages = []
  let acc = 0
  wanted.forEach((id, i) => {
    acc += STAGE_NOMINAL_MS[id] || 10000
    const isLast = i === wanted.length - 1
    stages.push({
      id,
      label: STAGE_LABELS[id],
      start: i === 0 ? 0 : Math.round(((acc - (STAGE_NOMINAL_MS[id] || 10000)) / total) * 1000) / 10,
      end: isLast ? 100 : Math.round((acc / total) * 1000) / 10,
    })
  })
  return stages
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status, // running | done | failed | cancelled
    items: job.items,
    stages: job.stages.map((s) => ({ id: s.id, label: s.label, status: s.status })),
    currentStage: job.currentStage,
    percent: Math.round(easePercent(job.percent)), // 展示进度走缓动曲线（内部仍按真实进度计算）
    stageProgress: job.stageProgress || 0,
    stageText: job.stageText,
    startedAt: job.startedAt,
    estimateMs: job.estimateMs || null,
    estimateNpmMs: job.estimateNpmMs || null,
    stageNominalMs: STAGE_NOMINAL_MS,
    silent: !!(job.opts && job.opts.silent), // 静默任务（后台迁移）：完成时不自动启动服务
    migrate: !!(job.opts && job.opts.migrate), // 迁移任务：失败重试节流用
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
  const stageDefs = buildStages(list)
  const stats = loadInstallStats()
  const estimateNpmMs = stats.dshNpmMs
  const estimateMs = stageDefs.reduce((sum, s) => sum + (s.id === 'dsh-npm' ? estimateNpmMs : (STAGE_NOMINAL_MS[s.id] || 10000)), 0)
  const job = {
    id: ++jobSeq,
    startedAt: Date.now(),
    estimateMs,
    estimateNpmMs,
    items: list,
    opts: opts || {},
    status: 'running',
    stages: stageDefs.map((s) => ({ ...s, status: 'pending' })),
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
  // 阶段时钟：对没有真实进度回调的长阶段（dsh-npm），按预估耗时推进百分比。
  // 渐近爬升（永不停步）：frac = CAP × (1 − e^(−t/τ))，τ = est/2.5，CAP = 0.985。
  //   - 预估时刻 ≈ 阶段 88%，之后越爬越慢但绝不冻结（实际超时也不会卡死在某百分比）；
  //   - 阶段真正完成时 finishStage 直接跳到终点（跳幅很小）。
  job.startStageClock = (estMs) => {
    const s = job.stages[job.currentStage]
    if (!s) return null
    const CAP = 0.985
    const TAU = Math.max(1000, estMs / 2.5)
    job._stageClockStart = Date.now()
    const tick = () => {
      const t = Date.now() - job._stageClockStart
      const frac = CAP * (1 - Math.exp(-t / TAU))
      job.stageProgress = frac
      job.pushProgress()
    }
    tick()
    return setInterval(tick, 1000)
  }
  job.stopStageClock = (timer) => { if (timer) clearInterval(timer) }
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
      const useUserLevel = !!process.env.DSHL_USER_NODE_DIR || IS_WIN
      if (useUserLevel) {
        // 用户级安装：官方 Node 发行包落位到 %LOCALAPPDATA%\Programs\nodejs（免管理员），并写入用户 PATH。
        // 已存在时直接复用（重复迁移/重试不重复下载）。
        const dest = userNodeDir()
        const existing = path.join(dest, IS_WIN ? 'node.exe' : 'node')
        if (fs.existsSync(existing)) {
          job.logLine(`用户级 Node.js 已存在：${dest}，跳过下载/解压`)
          nodeBin = existing
          nodeDest = null
          job.finishStage()
          job.enterStage(stageIdx('node-ex'))
          job.finishStage()
        } else {
          try {
            nodeBin = await installNode(job, dest, () => {
              job.finishStage()
              job.enterStage(stageIdx('node-ex'))
            })
            nodeDest = null
          } catch (e) { throw e }
          job.finishStage()
        }
        job.logLine(`Node.js 就绪：${nodeBin}`)
        await addToUserPath(job, [dest, npmGlobalRoot()], { prepend: true })
      } else {
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
      // 阶段时钟按本机预估耗时渐近爬升（CAP 98.5% 封顶，永不冻结），npm 真正完成时 finishStage 跳到阶段终点
      const npmT0 = Date.now()
      const clock = job.startStageClock(job.estimateNpmMs)
      let prefix
      try {
        prefix = await installDsh(job, nodeBin)
      } finally {
        job.stopStageClock(clock)
      }
      // 学习真实耗时：更新本机预估（EWMA），下次安装的进度/剩余时间更准
      const actualMs = Date.now() - npmT0
      const learned = learnNpmDuration(actualMs)
      job.logLine(`DSH 安装实际耗时 ${Math.round(actualMs / 1000)}s，本机预估已更新为 ${Math.round(learned / 1000)}s`)
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
  userNodeDir,
  npmGlobalRoot,
  resolveGlobalRoot,
}
