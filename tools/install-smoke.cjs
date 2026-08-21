// install-smoke.cjs — 安装引擎冒烟测试（脱离 Electron，纯 Node）
// 用法：node tools/install-smoke.cjs plugin   （快：仅插件拷贝，验证状态机/日志/回调）
//       node tools/install-smoke.cjs node     （中：真实下载 Node 官方发行包，校验 sha256 + 解压落位到用户级目录）
//       node tools/install-smoke.cjs dsh      （慢：真实 npm install -g @deepseek-ai/dsh 到临时全局根）
// 退出码：0 = 通过；1 = 失败
'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

const mode = process.argv[2] || 'plugin'
const tmpHome = path.join(os.tmpdir(), `dshl-smoke-${mode}-${Date.now()}`)
// 测试隔离：用户级 Node 目录 / npm 全局根 指向临时目录，且不写真实用户 PATH
process.env.DSHL_USER_NODE_DIR = path.join(tmpHome, 'user-node')
process.env.DSHL_NPM_GLOBAL_ROOT = path.join(tmpHome, 'npm-global')
process.env.DSHL_SKIP_PATH = '1'

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
    if (mode === 'dsh') {
      const bin = path.join(process.env.DSHL_NPM_GLOBAL_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      const ok = fs.existsSync(bin)
      console.log('global dsh bin exists:', ok)
      if (!ok) code = 1
    }
    if (mode === 'plugin') {
      const p = path.join(tmpHome, 'plugins', 'dsh-notify', 'dsh-notify.mjs')
      console.log('plugin exists:', fs.existsSync(p))
    }
    if (mode === 'node') {
      const bin = path.join(process.env.DSHL_USER_NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node')
      const ok = fs.existsSync(bin)
      console.log('user node dir:', process.env.DSHL_USER_NODE_DIR)
      console.log('node bin exists:', ok)
      if (!ok) code = 1
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
