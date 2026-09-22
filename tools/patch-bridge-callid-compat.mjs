// tools/patch-bridge-callid-compat.mjs — dshl 侧「制品级」兼容补丁：bridge-next payload 的 tool/result 取值
//
// 背景（实测，dsh 0.1.7-alpha.1）：
//   tool/result 事件的形状是 data.message = { role, source, toolCallId, content, isError, id }，
//   其中 data.message.content = [{ type: "text", text }, { type: "image", attachment }]。
//   上游 bridge-next 0.1.0-dev.2 的 lib/index.js 仍从 content[0] 上取 toolCallId/content/isError：
//       const value = event.data.message.content[0];
//       result(value.toolCallId, value.content, value.isError === true || Boolean(event.data.error), ...)
//   于是 callId 永远是 undefined，后果有两条：
//     1) item id 由 itemId(externalId, "tool", undefined) 生成 —— 整个会话的工具结果塌缩成一条 item，
//        对应的 tool/call 永远停在 interrupted、output 为空；
//     2) content 里留下 callId: undefined —— JS 侧 canonical JSON 把 undefined 当作字面量 undefined
//        参与 sha256，而 JSON.stringify 发车时该键被丢掉 → connector 重算 contentHash 必然不一致
//        → 每轮同步在 snapshot.items 批次被拒（sync.stopped waitingAck:3）→ 网页端手机连接永远停在
//        「启动中/异常」，本机插件页却仍显示「运行中」。
//
// 本补丁在 1 个调用点注入「message.* 优先、content[0].* 兜底」的写法：0.1.7+ 取 message，
// 旧形态（tool-result block 自带 toolCallId）仍可工作。
//
// 产物影响：
//   - assets/bridge-next/bridge-next.tgz 重新打包（npm pack --ignore-scripts，白名单与原产物一致）
//   - assets/bridge-next/version.json 更新 sha256，并追加 patched 备注（记录打补丁前的 sha）
//   启动器按 `version + sha256 前 12 位` 生成 payload 目录，sha 变化 => 用户侧自动换上新 payload。
//
// 何时删除本脚本：上游发布按 data.message 取值的构建后（届时本脚本会判定为 no-op 并直接退出）。
// 用法：node tools/patch-bridge-callid-compat.mjs
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

const SITE = 'dsh-runtime 投影：tool/result 事件'
const MARKER = 'message.toolCallId ?? value.toolCallId'
const NEEDLE_OLD =
  '\t\t\tconst value = event.data.message.content[0];\n' +
  '\t\t\tresult(value.toolCallId, value.content, value.isError === true || Boolean(event.data.error), event, event.data.meta, event.data.error);'
const NEEDLE_NEW =
  '\t\t\tconst message = event.data.message;\n' +
  '\t\t\tconst value = message.content[0];\n' +
  '\t\t\tresult(message.toolCallId ?? value.toolCallId, message.content ?? value.content, message.isError === true || value.isError === true || Boolean(event.data.error), event, event.data.meta, event.data.error);'

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function patchToolResult(src) {
  if (src.includes(MARKER)) return { src, already: true }
  const count = src.split(NEEDLE_OLD).length - 1
  if (count === 0) return { src, missing: true }
  if (count !== 1) {
    throw new Error(`期望 1 处 tool/result 取值点（${SITE}），实际 ${count} 处 —— 上游产物结构变了，请人工检查后再打补丁`)
  }
  return { src: src.replace(NEEDLE_OLD, NEEDLE_NEW), changed: true }
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
const oldSha = sha256File(tgzPath)
if (meta.sha256 !== oldSha) {
  throw new Error('assets/bridge-next 的 tgz 与 version.json 的 sha256 不一致，先修正再打补丁')
}

const work = mkdtempSync(join(tmpdir(), 'dshl-bridge-callid-'))
const packDir = join(work, 'pack-out')
const verifyDir = join(work, 'verify')
try {
  execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'inherit' })
  const pkgDir = join(work, 'package')
  const indexPath = join(pkgDir, 'lib', 'index.js')
  if (!existsSync(indexPath)) throw new Error('产物内缺少 package/lib/index.js')

  const src = readFileSync(indexPath, 'utf8')
  const r = patchToolResult(src)
  if (r.already) {
    console.log('无需打补丁（payload 已是 message-first 形态），未改动任何文件。')
    process.exit(0)
  }
  if (r.missing) {
    console.log('无需打补丁（产物里已无旧取值点，上游可能已修复），未改动任何文件。')
    process.exit(0)
  }

  writeFileSync(indexPath, r.src)
  execFileSync(process.execPath, ['--check', indexPath], { stdio: 'inherit' }) // 语法兜底：宁可失败也不发坏产物

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
  const prior = meta.patched || {}
  meta.sha256 = newSha
  meta.patched = Object.assign({}, prior, {
    by: 'dshl tools/patch-bridge-callid-compat.mjs',
    why: 'dsh 0.1.7 tool/result 事件把 toolCallId/content/isError 放在 data.message 上；产物内改为「message.* 优先、content[0].* 兜底」，兼容新旧两种形态',
    appliedAt: new Date().toISOString(),
    upstreamSha256: prior.upstreamSha256 || oldSha,
    history: [...(Array.isArray(prior.history) ? prior.history : []), {
      by: 'dshl tools/patch-bridge-callid-compat.mjs',
      why: 'tool/result 取值改为 message-first（修 undefined callId 导致的 contentHash 不一致与工具结果塌缩）',
      appliedAt: new Date().toISOString(),
      inputSha256: oldSha,
    }],
  })
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  mkdirSync(verifyDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgzPath, '-C', verifyDir], { stdio: 'inherit' })
  const verifySrc = readFileSync(join(verifyDir, 'package', 'lib', 'index.js'), 'utf8')
  if (!verifySrc.includes(MARKER)) throw new Error('复验失败：新产物缺少 message-first 取值')
  if (verifySrc.includes('\t\t\tresult(value.toolCallId, value.content,')) throw new Error('复验失败：新产物仍保留旧取值点')
  if (sha256File(tgzPath) !== meta.sha256) throw new Error('复验失败：sha256 与 version.json 不一致')

  console.log('payload 补丁完成：')
  console.log('  package  ' + pkg.name + '@' + pkg.version)
  console.log('  旧 sha   ' + oldSha)
  console.log('  新 sha   ' + newSha)
  console.log('  产物     ' + tgzPath)
} finally {
  rmSync(work, { recursive: true, force: true })
}
