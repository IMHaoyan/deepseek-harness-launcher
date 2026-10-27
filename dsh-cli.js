// dsh-cli.js — 极薄的 `dsh plugin --profile web …` 调用器
//
// 为什么单独存在：桌面壳登录辅助（desktop-signin.js）需要往 profile 里装一个 link: 包，而原来的
// bridge.js 已随「手机连接改为 npm 托管」一起退役。这里只保留一条最小路径：选对 node/dsh/pnpm、
// 带 DSH_HOME、输出截断到 64KB、被 pnpm 的 24h 新版本观察期整体拒绝时按同一策略放行重试一次。
'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const releaseAge = require('./release-age')

const PROFILE_NAME = 'web'
const CLI_TIMEOUT_MS = 15 * 60 * 1000
const MAX_CLI_OUTPUT_BYTES = 64 * 1024

let HOME = ''
let envDetect = null
let log = () => {}

function initCli(opts = {}) {
  HOME = opts.home || HOME
  envDetect = opts.envDetect || envDetect
  if (typeof opts.log === 'function') log = opts.log
}

function profileDir() {
  return path.join(HOME, 'profiles', PROFILE_NAME)
}

/** node/npm/pnpm 同属一套工具链：把它们所在目录提到 PATH 最前（Windows 下 PATH/Path 都写）。 */
function withToolchainPath(baseEnv, dirs) {
  const env = Object.assign({}, baseEnv)
  const parts = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    if (!dir) continue
    const index = parts.findIndex((item) => item.toLowerCase() === String(dir).toLowerCase())
    if (index >= 0) parts.splice(index, 1)
    parts.unshift(dir)
  }
  env.PATH = parts.join(path.delimiter)
  env.Path = env.PATH
  return env
}

function pnpmReady(env) {
  return !!(env && env.pnpm && env.pnpm.status === 'ok' && env.pnpm.path)
}

function capture(child, label) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    const cap = (chunk) => {
      chunks.push(chunk.toString('utf8'))
      bytes += chunk.length
      while (bytes > MAX_CLI_OUTPUT_BYTES && chunks.length > 0) {
        bytes -= Buffer.byteLength(chunks[0])
        chunks.shift()
      }
    }
    child.stdout.on('data', cap)
    child.stderr.on('data', cap)
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, CLI_TIMEOUT_MS)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const output = chunks.join('').trimEnd()
      if (code === 0) {
        resolve({ code, output })
        return
      }
      const error = new Error(label + ' 退出码 ' + code + (output ? '：' + output.slice(-400) : ''))
      error.exitCode = code
      error.output = output // 完整输出：24h 观察期判定与条目提取都靠它
      reject(error)
    })
  })
}

/** 跑一次 `dsh plugin`（不注入任何放行参数）。 */
async function runCliOnce(args) {
  if (!envDetect) throw new Error('dsh-cli: envDetect 未初始化')
  const env = await envDetect.detectEnv(false)
  if (!env || !env.plan) throw new Error('运行环境未就绪，无法改写 profile')
  if (!pnpmReady(env)) {
    const detail = env.pnpm ? (env.pnpm.detail || '未就绪') : '未检测到 pnpm'
    throw new Error('pnpm 未就绪：' + detail + '。请先在运行环境页安装/修复 pnpm。')
  }
  const { nodeCmd, dshBin } = env.plan
  if (!fs.existsSync(dshBin)) throw new Error('DSH 入口不存在：' + dshBin)
  const nodeDir = nodeCmd.includes(path.sep) || nodeCmd.includes('/') ? path.dirname(nodeCmd) : ''
  const pnpmDir = env.pnpm && env.pnpm.path ? path.dirname(env.pnpm.path) : ''
  const child = spawn(nodeCmd, [dshBin, 'plugin', '--profile', PROFILE_NAME, ...args], {
    cwd: profileDir(),
    env: withToolchainPath(Object.assign({}, process.env, { DSH_HOME: HOME }), [nodeDir, pnpmDir]),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return capture(child, 'dsh plugin')
}

/** 统一入口：先按策略默认跑，被 24h 观察期整体拒绝时才一次性放行重试一次。 */
async function runCli(args) {
  const list = Array.isArray(args) ? args : []
  try {
    return await runCliOnce(list)
  } catch (error) {
    if (!releaseAge.isViolation(error && error.output)) throw error
    const entries = releaseAge.parseEntries(error && error.output)
    log('pnpm 的 24h 新版本观察期拒绝了整份 lockfile（' + entries.length + ' 个条目）：一次性放行后重试')
    try {
      return await runCliOnce(releaseAge.withOverride(list))
    } catch (retryError) {
      const wrapped = new Error(((retryError && retryError.message) || String(retryError)) + '（已用一次性放行重试过一次）')
      wrapped.exitCode = retryError && retryError.exitCode
      wrapped.output = (retryError && retryError.output) || ''
      throw wrapped
    }
  }
}

module.exports = {
  initCli,
  runCli,
  PROFILE_NAME,
  // 纯函数（测试用）
  withToolchainPath,
  pnpmReady,
}
