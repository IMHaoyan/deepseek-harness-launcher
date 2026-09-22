// tools/patch-bridge-icon-compat.mjs — dshl 侧「制品级」兼容补丁：bridge-next payload 图标名
//
// 背景：dsh 0.1.7-alpha.1 把 @deepseek-ai/dsh-client-ui-primitives 的图标导出整体改名
//   IconXxx14/16/20（尺寸后缀） -> IconXxxRegular/Medium（描边权重后缀）。
//   上游 bridge-next 0.1.0-dev.2 的 lib/client.js 仍按旧名取组件，在 0.1.7 上取到 undefined，
//   渲染时报 Minified React error #130（设置页「手机连接」分区整块崩）。
//   上游 Agents-Anywhere 仓库不在我们的写权限范围内，所以在这里对**已构建产物**做补丁：
//   在 2 个调用点注入「新名 || 旧名」的 fallback —— 0.1.7+ 取新名，0.1.6 及更早取旧名，两个版本都可用。
//
// 产物影响：
//   - assets/bridge-next/bridge-next.tgz 重新打包（npm pack --ignore-scripts，白名单与原产物一致）
//   - assets/bridge-next/version.json 更新 sha256，并追加 patched 备注（记录打补丁前的 sha）
//   启动器按 `version + sha256 前 12 位` 生成 payload 目录，sha 变化 => 用户侧自动换上新 payload。
//
// 何时删除本脚本：上游发布不含旧图标名的构建后（届时本脚本会判定为 no-op 并直接退出）。
// 用法：node tools/patch-bridge-icon-compat.mjs
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

const MOD = '_deepseek_ai_dsh_client_ui_primitives'
const PATCHES = [
  { oldName: 'IconUserOutline16', newName: 'IconUserOutlineRegular', site: 'account-panel 头像 (size 28)' },
  { oldName: 'IconGlobeOutline14', newName: 'IconGlobeOutlineRegular', site: 'account-panel 连接入口 (size 16)' },
]

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function patchCallSite(src, { oldName, newName, site }) {
  if (src.includes(`${MOD}.${newName} ||`)) return { src, changed: false, already: true }
  const needle = `${MOD}.${oldName}`
  const count = src.split(needle).length - 1
  if (count === 0) return { src, changed: false, missing: true }
  if (count !== 1) {
    throw new Error(`期望 1 处 ${oldName}（${site}），实际 ${count} 处 —— 上游产物结构变了，请人工检查后再打补丁`)
  }
  const replacement = `(${MOD}.${newName} || ${MOD}.${oldName})`
  return { src: src.replace(needle, replacement), changed: true }
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
const oldSha = sha256File(tgzPath)
if (meta.sha256 !== oldSha) {
  throw new Error('assets/bridge-next 的 tgz 与 version.json 的 sha256 不一致，先修正再打补丁')
}

const work = mkdtempSync(join(tmpdir(), 'dshl-bridge-compat-'))
const packDir = join(work, 'pack-out')
const verifyDir = join(work, 'verify')
try {
  execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'inherit' })
  const pkgDir = join(work, 'package')
  const clientPath = join(pkgDir, 'lib', 'client.js')
  if (!existsSync(clientPath)) throw new Error('产物内缺少 package/lib/client.js')

  let src = readFileSync(clientPath, 'utf8')
  let changedCount = 0
  let skipped = 0
  for (const p of PATCHES) {
    const r = patchCallSite(src, p)
    if (r.changed) {
      src = r.src
      changedCount++
      console.log(`patch: ${p.oldName} -> (${p.newName} || ${p.oldName})  [${p.site}]`)
    } else if (r.already) {
      skipped++
      console.log(`skip: ${p.oldName} 已是 fallback 形态`)
    } else {
      skipped++
      console.log(`skip: 产物里已无 ${p.oldName}（上游可能已修复）`)
    }
  }
  if (changedCount === 0) {
    console.log('无需打补丁（payload 已是兼容形态或上游已修复），未改动任何文件。')
    process.exit(0)
  }
  if (skipped > 0) {
    throw new Error('只命中部分调用点（可能上游已修复一半/结构漂移），为保证一致性请人工检查，未落盘。')
  }

  writeFileSync(clientPath, src)
  execFileSync(process.execPath, ['--check', clientPath], { stdio: 'inherit' }) // 语法兜底：宁可失败也不发坏产物

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
  const pkg = bridge.readPackageFromTarball(tgzPath)
  meta.sha256 = newSha
  meta.patched = Object.assign({}, meta.patched, {
    by: 'dshl tools/patch-bridge-icon-compat.mjs',
    why: 'dsh 0.1.7 图标导出改名（Icon*14/16 -> *Regular/Medium）；产物内注入「新名 || 旧名」fallback，兼容 0.1.6 与 0.1.7+',
    appliedAt: new Date().toISOString(),
    upstreamSha256: (meta.patched && meta.patched.upstreamSha256) || oldSha,
  })
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  mkdirSync(verifyDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgzPath, '-C', verifyDir], { stdio: 'inherit' })
  const verifySrc = readFileSync(join(verifyDir, 'package', 'lib', 'client.js'), 'utf8')
  for (const p of PATCHES) {
    if (!verifySrc.includes(`(${MOD}.${p.newName} || ${MOD}.${p.oldName})`)) {
      throw new Error(`复验失败：新产物缺少 ${p.newName} fallback`)
    }
  }
  if (sha256File(tgzPath) !== meta.sha256) throw new Error('复验失败：sha256 与 version.json 不一致')

  console.log('payload 补丁完成：')
  console.log('  package  ' + pkg.name + '@' + pkg.version)
  console.log('  旧 sha   ' + oldSha)
  console.log('  新 sha   ' + newSha)
  console.log('  产物     ' + tgzPath)
} finally {
  rmSync(work, { recursive: true, force: true })
}