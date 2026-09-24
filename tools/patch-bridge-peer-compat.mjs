// tools/patch-bridge-peer-compat.mjs — dshl 侧「制品级」兼容补丁：bridge-next payload 的 dsh peer 范围
//
// 背景（实测，dsh 0.1.7-rc.1）：
//   0.1.7-rc.1 新引入插件兼容闸（dsh-app-boot 的 evaluatePluginCompatibility）：对每个
//   `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer，要求「运行中的 dsh 版本满足声明的范围」
//   （includePrerelease），不满足就跳过整个 bundle：
//       dsh: skipping profile bundle "@agents-anywhere/dsh-bridge-next": Error: Plugin … is incompatible
//            with dsh 0.1.7-rc.1: peerDependencies {"@deepseek-ai/dsh-typert-protocol":"0.1.5-rc.1"}
//   本 payload 把该 peer 精确钉成 0.1.5-rc.1 → satisfies("0.1.7-rc.1", "0.1.5-rc.1") = false → 启动即被跳过。
//   插件页此时仍显示「已安装，重启后生效」（那是热挂载文案），重启永远不会生效。
//   上游 @agents-anywhere/dsh-bridge-next@2.0.0 的同一 peer 也只是 0.1.5-rc.2 —— 升级上游同样过不了闸。
//
// 本补丁把该 peer 放宽为 `>=0.1.5-rc.1 <0.2.0`：覆盖 0.1.x 全部版本（含预发布），
//   但 0.2.0 一到仍会被闸拦下 —— 那时才该重新确认 typert 协议兼容性，而不是静默放行。
//
// 产物影响：
//   - payload 包版本 0.1.0-dev.2 → 0.1.0-dev.3。原因：main.js 只在「包版本变了」时才重装随包 payload
//     （bridge.js 的 satisfied() 只比 spec 基名，光换 sha 不会触发重装）；版本一变 → outdated=true → 自动重装修复。
//   - assets/bridge-next/bridge-next.tgz 重新打包（npm pack --ignore-scripts，白名单与产物一致）
//   - assets/bridge-next/version.json 更新 version / package.version / sha256 与 patched 备注
//
// 何时删除本脚本：上游发布 peer 范围覆盖当前 dsh 的构建后（本脚本会判定为 no-op 并直接退出）。
// 用法：node tools/patch-bridge-peer-compat.mjs
'use strict'

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const bridge = require('../bridge.js')

const toolDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(toolDir, '..')
const assetsDir = join(repoRoot, 'assets', 'bridge-next')
const tgzPath = join(assetsDir, 'bridge-next.tgz')
const metaPath = join(assetsDir, 'version.json')

const PEER = '@deepseek-ai/dsh-typert-protocol'
const RANGE_OLD = '0.1.5-rc.1'
const RANGE_NEW = '>=0.1.5-rc.1 <0.2.0'

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** payload 版本抬一格（...-dev.N → ...-dev.N+1）；不是该形态就让脚本失败，交给人工决定版本号。 */
function bumpDev(version) {
  const m = /^(.*-dev\.)(\d+)$/u.exec(String(version || ''))
  if (!m) throw new Error(`payload 版本 ${version} 不是 ...-dev.N 形态，需人工决定新版本号后再改本脚本`)
  return m[1] + (Number(m[2]) + 1)
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
const oldSha = sha256File(tgzPath)
if (meta.sha256 !== oldSha) {
  throw new Error('assets/bridge-next 的 tgz 与 version.json 的 sha256 不一致，先修正再打补丁')
}

const work = mkdtempSync(join(tmpdir(), 'dshl-bridge-peer-'))
const packDir = join(work, 'pack-out')
const verifyDir = join(work, 'verify')
try {
  execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'inherit' })
  const pkgDir = join(work, 'package')
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) throw new Error('产物内缺少 package/package.json')

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const range = pkg.peerDependencies && pkg.peerDependencies[PEER]
  if (range === RANGE_NEW) {
    console.log('无需打补丁（peer 范围已是 ' + RANGE_NEW + '），未改动任何文件。')
    process.exit(0)
  }
  if (range !== RANGE_OLD) {
    throw new Error(`${PEER} 的 peer 范围是 ${JSON.stringify(range)}，既不是 ${RANGE_OLD} 也不是 ${RANGE_NEW} —— 上游产物结构变了，请人工检查后再打补丁`)
  }

  const newVersion = bumpDev(pkg.version)
  const oldVersion = pkg.version
  pkg.peerDependencies[PEER] = RANGE_NEW
  pkg.version = newVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  JSON.parse(readFileSync(pkgPath, 'utf8')) // 语法兜底：写坏了宁可失败也不发坏产物

  mkdirSync(packDir, { recursive: true })
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: pkgDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  const produced = readdirSync(packDir).filter((n) => n.endsWith('.tgz'))
  if (produced.length !== 1) throw new Error('未能定位 npm pack 产物（期望 1 个 .tgz，实际 ' + produced.length + ' 个）')
  if (existsSync(tgzPath)) rmSync(tgzPath)
  renameSync(join(packDir, produced[0]), tgzPath)

  const newSha = sha256File(tgzPath)
  const packed = bridge.readPackageFromTarball(tgzPath) // 身份校验：包名 / 版本 / bundle patch / client 都要合法
  if (packed.name !== pkg.name) throw new Error('复验失败：包名变了 ' + packed.name)
  if (packed.version !== newVersion) throw new Error('复验失败：产物版本 ' + packed.version + ' 与期望 ' + newVersion + ' 不一致')

  const prior = meta.patched || {}
  meta.version = newVersion
  if (meta.package && typeof meta.package === 'object') meta.package.version = newVersion
  meta.sha256 = newSha
  meta.patched = Object.assign({}, prior, {
    by: 'dshl tools/patch-bridge-peer-compat.mjs',
    why: `dsh 0.1.7-rc.1 新增插件兼容闸，payload 把 ${PEER} 精确钉成 ${RANGE_OLD} 会被整体跳过；放宽为 ${RANGE_NEW}，并抬 payload 版本以触发启动器重装`,
    appliedAt: new Date().toISOString(),
    upstreamSha256: prior.upstreamSha256 || oldSha,
    history: [...(Array.isArray(prior.history) ? prior.history : []), {
      by: 'dshl tools/patch-bridge-peer-compat.mjs',
      why: `peer ${PEER}: ${RANGE_OLD} → ${RANGE_NEW}；payload 版本 ${oldVersion} → ${newVersion}（触发启动器重装）`,
      appliedAt: new Date().toISOString(),
      inputSha256: oldSha,
    }],
  })
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  mkdirSync(verifyDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgzPath, '-C', verifyDir], { stdio: 'inherit' })
  const verifyPkg = JSON.parse(readFileSync(join(verifyDir, 'package', 'package.json'), 'utf8'))
  if (verifyPkg.peerDependencies[PEER] !== RANGE_NEW) throw new Error('复验失败：新产物的 peer 范围没改上')
  if (verifyPkg.version !== newVersion) throw new Error('复验失败：新产物版本号没抬上')
  if (verifyPkg.peerDependencies['@deepseek-ai/cordis'] !== pkg.peerDependencies['@deepseek-ai/cordis']) throw new Error('复验失败：其它 peer 被改动')
  if (sha256File(tgzPath) !== meta.sha256) throw new Error('复验失败：sha256 与 version.json 不一致')

  console.log('payload 补丁完成：')
  console.log('  package  ' + packed.name + '@' + packed.version)
  console.log('  peer     ' + PEER + ': ' + RANGE_OLD + ' → ' + RANGE_NEW)
  console.log('  旧 sha   ' + oldSha)
  console.log('  新 sha   ' + newSha)
  console.log('  产物     ' + tgzPath)
} finally {
  rmSync(work, { recursive: true, force: true })
}
