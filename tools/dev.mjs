// tools/dev.mjs — 开发模式守护：改代码不用手动重启
//
//   npm run dev
//
// 做三件事（全部自动，Ctrl+C 退出）：
//   1. ui-src/* 变化  → 立即重建 wwwroot 产物（与 build:assets 相同的组装，但不重新生成图标、不需要 sharp）
//                      → 主进程的 fs.watch 收到变化后自动刷新启动器面板（见 main.js 开发模式热刷新块）
//   2. 主进程文件变化  → 自动结束 electron 进程树并重新拉起（main.js / preload.js / updater.js / dsh-update.js /
//                      env-detect.js / env-install.js / balance.js / package.json）
//   3. electron 崩溃   → 2 秒后自动重启
//
// 注意单实例锁：启动前请先托盘右键「退出」正在运行的启动器，否则本脚本拉起的实例会立刻退出。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const uiSrc = join(root, 'ui-src')
const wwwroot = join(root, 'wwwroot')

// ---------- 鲸鱼路径（与 build-assets.mjs 同源，纯文本提取，不依赖 sharp） ----------
function loadWhalePath() {
  // 候选源：DSH_REPO 环境变量 → E:\deepseek-harness → ~/deepseek-harness → 已内联的 wwwroot/index.html
  const candidates = [
    process.env.DSH_REPO ? join(process.env.DSH_REPO, 'packages', 'client', 'ui-primitives', 'src', 'FishLogo.tsx') : null,
    'E:/deepseek-harness/packages/client/ui-primitives/src/FishLogo.tsx',
    join(homedir(), 'deepseek-harness', 'packages', 'client', 'ui-primitives', 'src', 'FishLogo.tsx'),
  ].filter(Boolean)
  for (const f of candidates) {
    if (!existsSync(f)) continue
    const m = /<path d="([^"]+)"/.exec(readFileSync(f, 'utf8'))
    if (m) return m[1]
  }
  // 兜底：从已组装的 wwwroot/index.html 提取（源码仓库移走后仍可用）
  const htmlPath = join(wwwroot, 'index.html')
  if (existsSync(htmlPath)) {
    const m = /<path fill="currentColor" d="([^"]+)"/.exec(readFileSync(htmlPath, 'utf8'))
    if (m) return m[1]
  }
  throw new Error('whale path not found (no DSH repo and no inlined wwwroot/index.html)')
}
const whalePath = loadWhalePath()

const COPIED = ['styles.css', 'app.js', 'offline.html', 'browser.html', 'browser.css', 'browser.js']

// ---------- 产物组装（index.html 内联鲸鱼 + 拷贝其余文件；与 build:assets 一致，不含图标） ----------
function buildAssets() {
  mkdirSync(wwwroot, { recursive: true })
  let html = readFileSync(join(uiSrc, 'index.html'), 'utf8')
  if (!html.includes('__WHALE_PATH__')) throw new Error('placeholder not found in ui-src/index.html')
  html = html.replace('__WHALE_PATH__', whalePath)
  writeFileSync(join(wwwroot, 'index.html'), html)
  for (const f of COPIED) copyFileSync(join(uiSrc, f), join(wwwroot, f))
}

// ---------- 变更探测：时间戳轮询（比 fs.watch 在 Windows 上更稳，且能拿到"哪个文件变了"） ----------
function snapshot(dir, files) {
  const map = new Map()
  for (const f of files) {
    try { map.set(f, statSync(join(dir, f)).mtimeMs) } catch { map.set(f, -1) }
  }
  return map
}
function changedName(prev, cur) {
  for (const [f, t] of cur) if (prev.get(f) !== t) return f
  return null
}

const UI_FILES = ['index.html', ...COPIED]
const MAIN_FILES = ['main.js', 'preload.js', 'browser-preload.js', 'updater.js', 'dsh-update.js', 'env-detect.js', 'env-install.js', 'balance.js', 'package.json']

// ---------- electron 子进程管理 ----------
const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
let electron = null
let running = true
let restartTimer = null

function killElectron() {
  const child = electron
  electron = null
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    // /T 结束 electron 进程树；DSH 服务是"接管的外部实例"（独立进程树），不受影响
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
  } else {
    try { child.kill('SIGKILL') } catch { /* noop */ }
  }
}

function startElectron() {
  const child = spawn(electronExe, ['.', '--panel'], { cwd: root, stdio: 'inherit' })
  electron = child
  console.log(`[dev] electron 已启动 (PID ${child.pid})`)
  child.on('exit', (code) => {
    if (electron !== child) return
    electron = null
    if (!running) return
    if (code === 0) {
      console.log('[dev] electron 已退出 —— 修改主进程文件会自动重新拉起')
    } else {
      console.log(`[dev] electron 异常退出 (code ${code}) —— 2 秒后自动重启`)
      setTimeout(() => { if (running && !electron) startElectron() }, 2000)
    }
  })
}

function otherElectronRunning() {
  if (process.platform !== 'win32') return false
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, encoding: 'utf8' })
    const out = r.stdout || ''
    return out.trim().split(/\r?\n/).some((line) => line && line.trim().length > 5)
  } catch { return false }
}

// ---------- 主循环 ----------
if (!existsSync(electronExe)) {
  console.error('[dev] 找不到 electron：请先 npm install')
  process.exit(1)
}
if (otherElectronRunning()) {
  console.log('[dev] ⚠ 检测到已有 electron 实例在运行（单实例锁会让本脚本拉起的实例直接退出）：请先托盘右键「退出」')
}
try {
  buildAssets()
  console.log('[dev] wwwroot 已按 ui-src 重建')
} catch (err) {
  console.error('[dev] 产物重建失败：' + err.message)
  process.exit(1)
}
console.log('[dev] 监听中：ui-src/*（重建+面板热刷新）、主进程文件（自动重启 electron）。Ctrl+C 退出')
startElectron()

let uiPrev = snapshot(uiSrc, UI_FILES)
let mainPrev = snapshot(root, MAIN_FILES)

setInterval(() => {
  if (!running) return
  const uiCur = snapshot(uiSrc, UI_FILES)
  const f = changedName(uiPrev, uiCur)
  if (f) {
    uiPrev = uiCur
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    try {
      buildAssets()
      console.log(`[dev] ${t} ui-src/${f} 已变更 → 产物重建，面板自动刷新`)
    } catch (err) {
      console.error(`[dev] ${t} 重建失败：${err.message}`)
    }
  }
  const mc = snapshot(root, MAIN_FILES)
  const mf = changedName(mainPrev, mc)
  if (mf) {
    mainPrev = mc
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      console.log(`[dev] ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${mf} 已变更 → 重启 electron`)
      killElectron()
      setTimeout(() => { if (running) startElectron() }, 800)
    }, 400)
  }
}, 400)

function shutdown() {
  if (!running) return
  running = false
  clearTimeout(restartTimer)
  killElectron()
  console.log('[dev] 已退出')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
