// node-reuse-smoke.cjs — 隔离环境冒烟：用户级 Node 目录的"复用 vs 忽略重装"判据
//
// 复现两种真实场景（全程隔离，不碰真实用户目录与 PATH）：
//   1) 目录里是 Node 18（探针注入 v18.20.4）→ 必须忽略旧目录、备份后重装，且不残留备份；
//   2) 目录里是达标版本（真实探测）→ 必须复用并跳过下载。
// 用内置 Node 发行包（assets/node-dist），不联网。
//
// 用法：node tools/node-reuse-smoke.cjs
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const repo = 'C:\\Users\\gonghaoyan\\Desktop\\dshl'
const base = path.join(os.tmpdir(), 'dshl-reuse-e2e-' + Date.now())
const userNodeDir = path.join(base, 'Programs', 'nodejs')
const home = path.join(base, '.dsh')
fs.mkdirSync(userNodeDir, { recursive: true })
fs.copyFileSync(process.execPath, path.join(userNodeDir, 'node.exe')) // 内容不重要：版本由注入探针给出

process.env.DSHL_USER_NODE_DIR = userNodeDir
process.env.DSHL_NPM_GLOBAL_ROOT = path.join(base, 'npm-global')
process.env.DSHL_SKIP_PATH = '1'
process.env.DSHL_FRESH_TEST = '1'

const envInstall = require(path.join(repo, 'env-install'))

function run(items, opts) {
  return new Promise((resolve) => {
    envInstall.initInstaller({
      HOME: home,
      Config: { nodeMajor: 22, dshVersion: 'latest', pnpmVersion: '11.8.0', npmRegistry: '' },
      ASSETS_DIR: path.join(repo, 'assets'),
      log: () => {},
      onPush: () => {},
    })
    const job = envInstall.startInstall(items, opts)
    // 注意：两个定时器都要在完成时清掉，否则进程会空等到超时才退出
    let iv = null
    let to = null
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (iv) clearInterval(iv)
      if (to) clearTimeout(to)
      resolve(job)
    }
    iv = setInterval(() => { if (job.status !== 'running') finish() }, 300)
    to = setTimeout(finish, 180000)
  })
}

;(async () => {
  const job1 = await run(['node'], { nodeVersionProbe: async () => 'v18.20.4' })
  const log1 = (job1.log || []).map((l) => (l && l.line) || String(l))
  const ignored = log1.some((l) => /不满足 .*忽略旧版本并重新安装/.test(l))
  const nodeExe = path.join(userNodeDir, 'node.exe')
  let installedVer = ''
  try { installedVer = execFileSync(nodeExe, ['-v'], { encoding: 'utf8' }).trim() } catch (e) { installedVer = 'ERR ' + e.message }
  const backupsLeft = fs.readdirSync(path.dirname(userNodeDir)).filter((n) => n.includes('nodejs.old-'))
  console.log('[1] status=' + job1.status + ' 忽略旧版本=' + ignored + ' 新装版本=' + installedVer + ' 残留备份=' + JSON.stringify(backupsLeft))
  if (!ignored || !/^v2[24]\./.test(installedVer) || backupsLeft.length) {
    console.log('FAILED(第1轮)。Node 相关日志：')
    console.log(log1.filter((l) => /Node|node/.test(l)).slice(-14).join('\n'))
    process.exit(1)
  }

  const job2 = await run(['node'], {})
  const log2 = (job2.log || []).map((l) => (l && l.line) || String(l))
  const reused = log2.some((l) => /已存在且版本可用/.test(l) && /跳过下载/.test(l))
  console.log('[2] status=' + job2.status + ' 复用=' + reused)
  if (!reused) { console.log('FAILED(第2轮)：未复用'); console.log(log2.filter((l) => /Node/.test(l)).join('\n')); process.exit(1) }
  console.log('E2E OK')
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* noop */ }
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1) })