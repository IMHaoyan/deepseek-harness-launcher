// tools/patch-bridge-declare-peers.mjs — 制品级补丁：让 payload 的 manifest 声明「入口真正 import 的包」
//
// 背景（2026-09-29 实测事故）：
//   @agents-anywhere/dsh-bridge-next 的 lib/index.js import 了
//     @deepseek-ai/dsh-session-title / @deepseek-ai/dsh-llm / @deepseek-ai/dsh-session
//   但这三个包**在 package.json 里一个字都没写**。启动器建的解析镜像原先只按声明取材，
//   于是某些机器（profile 侧缺件）镜像里就没有它们 → Node 解析失败 → DSH 只回一句
//   `failed to import` → 插件永远不生效（市场显示「已安装，重启后生效」）。
//   镜像侧已改为「按入口 import 补齐 + 安装树/npm 前缀兜底」；本补丁把 manifest 补诚实：
//   入口 import 的每个 @deepseek-ai/dsh* 都必须在 dependencies/optionalDependencies/peerDependencies 里声明。
//
// 为什么是 peerDependencies：这些包由 dsh 运行时提供，不该被打进 payload 自己的依赖树
//   （link: 安装下 payload 的 dependencies 会被启动器单独 pnpm 安装，把 dsh 内部包也塞进去只会造成第二份副本）。
//   范围沿用 patch-bridge-peer-compat 定下的 `>=0.1.5-rc.1`（无上界）→ 兼容闸永远放行，不会再因为 dsh 升级重打。
//
// fail-closed：入口 import 了一个**非 @deepseek-ai/dsh\*** 又没声明的包时，脚本直接失败交人工决定，
//   绝不替它猜一个版本号或范围。
//
// 产物影响：
//   - payload 包版本 ...-dev.N → ...-dev.N+1（启动器据此判 outdated 并重装）
//   - assets/bridge-next/bridge-next.tgz 重新打包（npm pack --ignore-scripts，白名单与产物一致）
//   - assets/bridge-next/version.json 更新 version / package.version / sha256 / patched.history
//
// 何时删除本脚本：上游把入口 import 的包都声明齐了之后（本脚本会判定为 no-op 并直接退出）。
// 用法：node tools/patch-bridge-declare-peers.mjs
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

/** 与 patch-bridge-peer-compat 同一约定：无上界，dsh 再升级也不必重打。 */
const PEER_RANGE = '>=0.1.5-rc.1'
const LOCKSTEP_PREFIX = '@deepseek-ai/dsh'

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** payload 版本抬一格（...-dev.N → ...-dev.N+1）；不是该形态就让脚本失败，交给人工决定版本号。 */
function bumpDev(version) {
  const m = /^(.*-dev\.)(\d+)$/u.exec(String(version || ''))
  if (!m) throw new Error(`payload 版本 ${version} 不是 ...-dev.N 形态，需人工决定新版本号后再改本脚本`)
  return m[1] + (Number(m[2]) + 1)
}

/** 入口文件里 import 的裸包名（与 bridge.js 的 entryImportSpecifiers 同规则）。 */
function entryImportSpecifiers(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const rel = String(pkg.main || './lib/index.js').replace(/\\/gu, '/').replace(/^\.\//u, '')
  const code = readFileSync(join(pkgDir, rel), 'utf8')
  const out = new Set()
  for (const m of code.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gmu)) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
    out.add(spec)
  }
  return [...out]
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
const oldSha = sha256File(tgzPath)
if (meta.sha256 !== oldSha) {
  throw new Error('assets/bridge-next 的 tgz 与 version.json 的 sha256 不一致，先修正再打补丁')
}

const work = mkdtempSync(join(tmpdir(), 'dshl-bridge-peers-'))
const packDir = join(work, 'pack-out')
try {
  execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'inherit' })
  const pkgDir = join(work, 'package')
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) throw new Error('产物内缺少 package/package.json')

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ])
  const undeclared = entryImportSpecifiers(pkgDir).filter((name) => !declared.has(name))
  if (undeclared.length === 0) {
    console.log('无需打补丁（入口 import 的包都已在 manifest 里声明），未改动任何文件。')
    process.exit(0)
  }

  const lockstep = undeclared.filter((name) => name === LOCKSTEP_PREFIX || name.startsWith(LOCKSTEP_PREFIX + '-'))
  const foreign = undeclared.filter((name) => !lockstep.includes(name))
  if (foreign.length > 0) {
    throw new Error('入口 import 了未声明、且不属于 @deepseek-ai/dsh* 的包，需要人工决定版本/范围：' + foreign.join('、'))
  }

  const newVersion = bumpDev(pkg.version)
  const oldVersion = pkg.version
  pkg.peerDependencies = Object.assign({}, pkg.peerDependencies || {})
  for (const name of lockstep) pkg.peerDependencies[name] = PEER_RANGE
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

  // 复验：身份 + 版本 + 新声明的 peer + **入口 import 全部已声明**
  const packed = bridge.readPackageFromTarball(tgzPath)
  if (packed.name !== pkg.name) throw new Error('复验失败：包名变了 ' + packed.name)
  if (packed.version !== newVersion) throw new Error('复验失败：产物版本 ' + packed.version + ' 与期望 ' + newVersion + ' 不一致')
  const verifyDir = join(work, 'verify')
  mkdirSync(verifyDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgzPath, '-C', verifyDir], { stdio: 'inherit' })
  const verifyPkg = JSON.parse(readFileSync(join(verifyDir, 'package', 'package.json'), 'utf8'))
  if (verifyPkg.version !== newVersion) throw new Error('复验失败：新产物版本号没抬上')
  const verifiedDeclared = new Set([
    ...Object.keys(verifyPkg.dependencies || {}),
    ...Object.keys(verifyPkg.optionalDependencies || {}),
    ...Object.keys(verifyPkg.peerDependencies || {}),
  ])
  const stillUndeclared = entryImportSpecifiers(join(verifyDir, 'package')).filter((name) => !verifiedDeclared.has(name))
  if (stillUndeclared.length > 0) throw new Error('复验失败：仍有入口 import 未声明：' + stillUndeclared.join('、'))
  for (const name of lockstep) {
    if (verifyPkg.peerDependencies[name] !== PEER_RANGE) throw new Error(`复验失败：${name} 的 peer 范围不是 ${PEER_RANGE}`)
  }

  const newSha = sha256File(tgzPath)
  const prior = meta.patched || {}
  meta.version = newVersion
  if (meta.package && typeof meta.package === 'object') meta.package.version = newVersion
  meta.sha256 = newSha
  meta.patched = Object.assign({}, prior, {
    by: 'dshl tools/patch-bridge-declare-peers.mjs',
    why: '入口 import 的 @deepseek-ai/dsh* 未在 manifest 声明，镜像按声明取材时会漏掉它们（部分机器因此 failed to import）；'
      + '补齐为 peerDependencies ' + PEER_RANGE + '，并抬 payload 版本以触发启动器重装',
    appliedAt: new Date().toISOString(),
    upstreamSha256: prior.upstreamSha256 || oldSha,
    history: [...(Array.isArray(prior.history) ? prior.history : []), {
      by: 'dshl tools/patch-bridge-declare-peers.mjs',
      why: `声明缺失的入口依赖：${lockstep.join('、')}（peer ${PEER_RANGE}）；payload 版本 ${oldVersion} → ${newVersion}`,
      appliedAt: new Date().toISOString(),
      inputSha256: oldSha,
    }],
  })
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  console.log('payload 补丁完成：')
  console.log('  package  ' + packed.name + '@' + packed.version)
  console.log('  新增声明 ' + lockstep.join('、') + '（peer ' + PEER_RANGE + '）')
  console.log('  旧 sha   ' + oldSha)
  console.log('  新 sha   ' + newSha)
  console.log('  产物     ' + tgzPath)
} finally {
  rmSync(work, { recursive: true, force: true })
}
