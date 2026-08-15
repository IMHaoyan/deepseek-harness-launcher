// envcheck.cjs — 脱离 Electron 的独立环境探测脚本（CI / 排障 / 开发自测）
// 用法：npm run envcheck   （退出码：0 = 环境就绪；1 = 环境未就绪；2 = 探测异常）
'use strict'

const os = require('os')
const path = require('path')

const Config = {
  harnessRoot: process.env.DSH_HARNESS_ROOT || '',
  nodePath: process.env.DSH_NODE_PATH || '',
}

const envDetect = require('../env-detect')
envDetect.initEnv({
  realHome: path.join(os.homedir(), '.dsh'),
  Config,
  log: (line) => console.error('[env] ' + line),
})

envDetect.detectEnv(true)
  .then((report) => {
    const summary = envDetect.envSummary(report)
    console.log(JSON.stringify({ ready: summary.ready, ...summary, plan: report.plan }, null, 2))
    process.exit(report.ready ? 0 : 1)
  })
  .catch((err) => {
    console.error('envcheck failed: ' + (err && err.stack ? err.stack : err))
    process.exit(2)
  })
