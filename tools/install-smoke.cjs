// install-smoke.cjs — 安装引擎冒烟测试（脱离 Electron，纯 Node）
// 用法：node tools/install-smoke.cjs plugin   （快：仅插件拷贝，验证状态机/日志/回调）
//       node tools/install-smoke.cjs node     （中：真实下载 Node 官方发行包，校验 sha256 + 解压落位）
//       node tools/install-smoke.cjs dsh      （慢：真实 npm 安装 @deepseek-ai/dsh 到临时 HOME）
// 退出码：0 = 通过；1 = 失败
'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

const mode = process.argv[2] || 'plugin'
const tmpHome = path.join(os.tmpdir(), `dshl-smoke-${mode}-${Date.now()}`)

const envInstall = require('../env-install')
const envDetect = require('../env-detect')

envDetect.initEnv({ realHome: path.join(os.homedir(), '.dsh'), Config: { harnessRoot: '', nodePath: '' }, log: () => {} })
envInstall.initInstaller({
  HOME: tmpHome,
  Config: { nodeMajor: 22, dshVersion: '0.1.0-rc.6', npmRegistry: '' },
  ASSETS_DIR: path.join(__dirname, '..', 'assets'),
  log: (l) => console.error('[install] ' + l),
  onPush: (p) => {
    if (p.job && p.job.status === 'failed') { console.error('SMOKE FAILED:', p.job.error); finish(1); return }
    if (p.job && p.job.status === 'cancelled') { console.error('SMOKE CANCELLED'); finish(1); return }
    if (p.job && p.job.status !== 'running') console.log('[push] job:', JSON.stringify(p.job))
    else if (p.job && p.job.currentStage === 0 && p.job.percent % 25 < 1) console.log('[push] progress:', p.job.percent + '%')
  },
  onDone: () => { finish(0) },
})

let finished = false
function finish(code) {
  if (finished) return
  finished = true
  setTimeout(() => {
    if (code === 0 && mode === 'dsh') {
      const bin = path.join(tmpHome, 'dshl-runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      console.log('dsh bin exists:', fs.existsSync(bin))
    }
    if (code === 0 && mode === 'plugin') {
      const p = path.join(tmpHome, 'plugins', 'dsh-notify', 'dsh-notify.mjs')
      console.log('plugin exists:', fs.existsSync(p))
    }
    if (code === 0 && mode === 'node') {
      const base = path.join(tmpHome, 'dshl-runtime', 'node')
      const entries = fs.readdirSync(base).filter((d) => /^\d+\.\d+\.\d+$/.test(d))
      const bin = entries.length ? path.join(base, entries[0], process.platform === 'win32' ? 'node.exe' : 'node') : ''
      console.log('managed node dirs:', entries.join(', '))
      console.log('node bin exists:', !!bin && fs.existsSync(bin))
      if (!bin || !fs.existsSync(bin)) finish(1)
    }
    console.log('tmpHome:', tmpHome)
    process.exit(code)
  }, 300)
}

const timer = setTimeout(() => { console.error('SMOKE TIMEOUT'); finish(1) }, mode === 'dsh' ? 30 * 60 * 1000 : mode === 'node' ? 15 * 60 * 1000 : 60 * 1000)
timer.unref()

try {
  if (mode === 'plugin') envInstall.startInstall(['plugin'])
  else if (mode === 'node') envInstall.startInstall(['node'])
  else if (mode === 'dsh') envInstall.startInstall(['dsh'])
  else { console.error('usage: install-smoke.cjs plugin|node|dsh'); process.exit(2) }
} catch (err) {
  console.error('startInstall threw:', err)
  finish(1)
}
