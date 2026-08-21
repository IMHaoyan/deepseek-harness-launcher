// fresh-install-demo.cjs — 全新机模拟安装演示（等价"虚拟机"效果，全程隔离，不碰真实系统）
//
// 隔离手段（与 install-smoke 同策略）：
//   - HOME 指向临时目录（配置/日志/托管落点全部隔离）
//   - DSHL_USER_NODE_DIR / DSHL_NPM_GLOBAL_ROOT 指向临时目录（用户级 Node / npm 全局根不写真实位置）
//   - DSHL_SKIP_PATH=1（不写真实用户 PATH）
//   - DSHL_FRESH_TEST=1（环境探测无视系统级安装，只认 dshl 自装物 → 真实"全新机"视角）
//
// 用法：node tools/fresh-install-demo.cjs   （完整流程：探测 → node+dsh+plugin 安装 → 探测；约 1-3 分钟）
'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

const base = path.join(os.tmpdir(), 'dshl-fresh-demo-' + Date.now())
const home = path.join(base, '.dsh')
process.env.DSHL_USER_NODE_DIR = path.join(base, 'Programs', 'nodejs')
process.env.DSHL_NPM_GLOBAL_ROOT = path.join(base, 'npm-global')
process.env.DSHL_SKIP_PATH = '1'
process.env.DSHL_FRESH_TEST = '1'

const envInstall = require('../env-install')
const envDetect = require('../env-detect')

const ts = () => new Date().toLocaleTimeString('sv-SE')
function line(s) { console.log(`[${ts()}] ${s}`) }

let lastPct = -1
envInstall.initInstaller({
  HOME: home,
  Config: { nodeMajor: 22, dshVersion: '0.1.0-rc.6', npmRegistry: '' },
  ASSETS_DIR: path.join(__dirname, '..', 'assets'),
  log: line,
  onPush: (p) => {
    const j = p && p.job
    if (j) {
      const st = j.currentStage >= 0 && j.stages[j.currentStage] ? j.stages[j.currentStage] : null
      const pct = Math.round(j.percent)
      if (j.status !== 'running') {
        line(`★ 任务结束（${j.status}）@ ${j.percent}%${j.error ? ' 错误: ' + j.error : ''}`)
      } else if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct
        line(`▶ 进度 ${pct}%（${st ? st.label : ''}）`)
      }
    }
    if (p && Array.isArray(p.lines)) {
      for (const l of p.lines) line('    · ' + l)
    }
  },
  onDone: () => { void afterInstall() },
})

async function detect(tag) {
  envDetect.initEnv({ realHome: home, Config: { harnessRoot: '', nodePath: '' }, log: () => {} })
  const r = await envDetect.detectEnv(true)
  const s = envDetect.envSummary(r)
  line(`${tag}环境探测 → node=${s.node.status}${s.node.version ? '/' + s.node.version : ''}(${s.node.source || '-'}) dsh=${s.dsh.status}/${s.dsh.kind}/${s.dsh.version || '-'} plugin=${s.plugin.status} ready=${s.ready}`)
  return r
}

let finished = false
async function afterInstall() {
  if (finished) return
  finished = true
  try {
    const r = await detect('安装后')
    line('--- 安装落点 ---')
    line(`用户级 Node  : ${process.env.DSHL_USER_NODE_DIR}`)
    line(`npm 全局根   : ${process.env.DSHL_NPM_GLOBAL_ROOT}`)
    line(`全局 DSH 目录: ${path.join(process.env.DSHL_NPM_GLOBAL_ROOT, 'node_modules', '@deepseek-ai', 'dsh')}`)
    line(`通知插件     : ${path.join(home, 'plugins', 'dsh-notify', 'dsh-notify.mjs')}`)
    line(`安装日志     : ${path.join(home, 'dshl-logs', 'install.log')}`)
    const bin = path.join(process.env.DSHL_NPM_GLOBAL_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const nodeBin = path.join(process.env.DSHL_USER_NODE_DIR, 'node.exe')
    if (fs.existsSync(bin) && fs.existsSync(nodeBin)) {
      const { execFile } = require('child_process')
      execFile(nodeBin, [bin, '--version'], { windowsHide: true }, (err, stdout) => {
        line(`DSH --version → ${err ? '失败: ' + err.message : String(stdout).trim()}`)
        line(`✅ 演示完成：全新机一键安装全流程通过（隔离环境：${base}）`)
        process.exit(r.ready ? 0 : 1)
      })
    } else {
      line('❌ 安装产物缺失')
      process.exit(1)
    }
  } catch (e) {
    line('❌ 演示失败：' + (e && e.message ? e.message : String(e)))
    process.exit(1)
  }
}

const timer = setTimeout(() => { line('❌ 演示超时'); process.exit(1) }, 30 * 60 * 1000)
timer.unref()

void (async () => {
  line('==============================================================')
  line('DSHL 一键安装 · 全新机模拟演示（隔离环境，不碰真实系统）')
  line(`隔离根：${base}`)
  line('==============================================================')
  await detect('安装前')
  line('--- 开始一键安装（node → dsh → plugin）---')
  try {
    envInstall.startInstall(['node', 'dsh', 'plugin'])
  } catch (e) {
    line('❌ startInstall 失败：' + e.message)
    process.exit(1)
  }
})()
