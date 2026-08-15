// repro-detect.cjs — 复现"一键安装完成后的环境检测"：在临时 HOME 里构造托管 Node/DSH/插件布局后跑检测
// 用法：node tools/repro-detect.cjs
'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpHome = path.join(os.tmpdir(), `dshl-repro-${Date.now()}`)

// 1) 托管 Node：真实 node.exe 拷贝（探测只跑 `node -v`）
const nodeVer = '22.20.0'
const nodeDir = path.join(tmpHome, 'dshl-runtime', 'node', nodeVer)
fs.mkdirSync(nodeDir, { recursive: true })
const realNode = process.execPath
fs.copyFileSync(realNode, path.join(nodeDir, 'node.exe'))
console.log('fabricated managed node:', path.join(nodeDir, 'node.exe'))

// 2) 托管 DSH：npm 安装后的真实布局（package.json + lib/bin.js）
const dshDir = path.join(tmpHome, 'dshl-runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0-rc.6' }))
fs.writeFileSync(path.join(dshDir, 'lib', 'bin.js'), '// fake bin\n')
console.log('fabricated managed dsh:', dshDir)

// 3) 插件
const pluginDest = path.join(tmpHome, 'plugins', 'dsh-notify', 'dsh-notify.mjs')
fs.mkdirSync(path.dirname(pluginDest), { recursive: true })
fs.copyFileSync(path.join(__dirname, '..', 'assets', 'plugins', 'dsh-notify.mjs'), pluginDest)

// 4) 检测（与 main.js 的 refreshEnv(true) 同一路径）
const envDetect = require('../env-detect')
envDetect.initEnv({ realHome: tmpHome, Config: { harnessRoot: '', nodePath: '', dshVersion: '0.1.0-rc.6', nodeMajor: 22 }, log: (l) => console.error('[env] ' + l) })

envDetect.detectEnv(true).then((r) => {
  console.log('RESULT:')
  console.log('  ready      =', r.ready)
  console.log('  node       =', JSON.stringify(r.node))
  console.log('  dsh        =', JSON.stringify(r.dsh))
  console.log('  plugin     =', JSON.stringify(r.plugin))
  console.log('  plan       =', JSON.stringify(r.plan))
  console.log('  issues     =', JSON.stringify(r.issues))
  console.log('  summary.ready =', envDetect.envSummary(r).ready)
  process.exit(0)
}).catch((e) => { console.error('DETECT THREW:', e); process.exit(2) })
