// tools/patch-bridge-sync-ack-compat.mjs — dshl 侧「制品级」兼容补丁：修 ACK 竞态导致的同步猝死循环
//
// 背景（实测，dsh 0.1.7-rc.1 + payload 0.1.0-dev.3，日志 ~/.agentsanywhere/dsh-bridge-next/logs/dsh-runtime.jsonl）：
//   现象：网页端「手机连接」卡片进「异常」，且每 1-2 分钟复现一次；host 日志里
//       sync.stopped waitingAck=16/63/110 → sync.failed queuedEvents=10000 → connector 报 INTERNAL_ERROR → 重订阅 → 循环。
//   根因链（每条都有日志或代码位置）：
//     1) connector 每批要 await 每个 operation 才 ack，而 operation 里会回调 host RPC
//        （host 日志：session.read 单次 400-800ms、visibility_read 814ms）→ 批次一慢，ack 就晚；
//     2) host 的路由只有**一个 feed 槽**，任何一次 runtime.sync.subscribe 都先 close() 再换新流
//        （lib/index.js:5389-5395）→ 旧流上在途/迟到的 ack 落到新 feed 上；
//     3) 路由对这种情况抛 `INVALID_PARAMS`("Unknown event stream.")、retryable=false（lib/index.js:5405）
//        → connector 的 consume() 里这个请求是 await 且不捕获（sync.py:255）→ 整个消费循环退出；
//     4) 之后无人 ack → host 队列涨到 MAX_BUFFER=10000 → fail("DSH event buffer full") → 卡片「异常」。
//
// 本补丁只切断「迟到 ack = 消费者猝死」这条链，host「等不到 ack 就重订阅拿新基线」的上游设计保持不变：
//   P1 lib/index.js 路由 runtime.sync.ack：流已换/已关闭时**幂等成功**并记一条 sync.ack_stale（ACK 天生幂等，拒绝它没有收益）
//   P2 lib/index.js Feed.ack：越界/重复序号只忽略，不再抛 INVALID_PARAMS
//   P3 lib/bundled-connector/.../sync.py：乱序批次**重新对齐**后继续，不再 raise 退出整条消费循环
//
// 产物影响：
//   - payload 包版本 0.1.0-dev.3 → 0.1.0-dev.4（main.js 只在「包版本变了」时重装随包 payload；bridge.js 的
//     satisfied() 只比 spec 基名，光换 sha 不会触发重装）→ 启动器自动物化新 payload 并重启服务
//   - assets/bridge-next/bridge-next.tgz 重新打包（npm pack --ignore-scripts），version.json 更新 version/sha256/patched
//
// 何时删除本脚本：上游把这三处改宽松后（脚本会逐处判定 no-op 并退出）。
// 用法：node tools/patch-bridge-sync-ack-compat.mjs
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

const JS = 'lib/index.js'
const PY = 'lib/bundled-connector/connector/runtimes/dsh/bridge/sync.py'

// 每处补丁：按「整行 trim 后完全相等」定位，必须恰好命中 1 行；marker 用于幂等与复验。
const PATCHES = [
  {
    file: JS,
    site: 'P1 路由 runtime.sync.ack：失效流的确认幂等成功',
    marker: 'sync.ack_stale',
    oldLine: 'if (!this.feed || params.streamId !== this.feed.id || typeof params.batchSeq !== "number") throw new BridgeError("INVALID_PARAMS", "Unknown event stream.");',
    block: [
      '// dshl 补丁：ACK 天生幂等 —— 流已换/已关闭时抛 INVALID_PARAMS(non-retryable) 会把 connector 的消费',
      '// 循环直接打死（它 await 这个请求且不捕获），之后无人 ACK → 队列涨到上限 → 卡片进「异常」。',
      '// 改为幂等成功，只留一条 debug（日志事件 sync.ack_stale）。',
      'if (!this.feed || params.streamId !== this.feed.id || typeof params.batchSeq !== "number") {',
      '\tthis.reader?.native?.diagnostics?.log?.("debug", "sync.ack_stale", {',
      '\t\tstreamId: params.streamId,',
      '\t\tbatchSeq: params.batchSeq,',
      '\t\tcurrentStreamId: this.feed?.id',
      '\t});',
      '\treturn { ok: true };',
      '}',
    ],
  },
  {
    file: JS,
    site: 'P2 Feed.ack：越界/重复序号不再抛错',
    marker: 'dshl 补丁：迟到或重复的确认',
    oldLine: 'if (seq < 1 || seq > this.batchSeq || !Number.isSafeInteger(seq)) throw new BridgeError("INVALID_PARAMS", "Invalid event acknowledgement.");',
    block: [
      '// dshl 补丁：迟到或重复的确认不该抛错（同路由层的理由）；越界只忽略。',
      'if (seq < 1 || seq > this.batchSeq || !Number.isSafeInteger(seq)) return;',
    ],
  },
  {
    file: PY,
    site: 'P3 connector：乱序批次重新对齐而非退出',
    marker: 'dshl 补丁：host 换流/重发基线',
    oldLine: 'raise ValueError("Out-of-order event batch; reconnect to recalibrate")',
    block: [
      '# dshl 补丁：host 换流/重发基线时 batchSeq 会回到 1，原先直接 raise 会让整条消费循环退出',
      '# （之后无人 ack → host 队列打满 → 卡片「异常」）。改为重新对齐后继续。',
      'expected = batch["batchSeq"]',
    ],
  },
]

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 按「trim 后整行相等」定位唯一一行，用 block（相对缩进）替换它。 */
function patchLines(src, patch) {
  const lines = src.split('\n')
  const hits = lines.map((line, i) => (line.trim() === patch.oldLine ? i : -1)).filter((i) => i >= 0)
  if (hits.length === 0) return { src, missing: true }
  if (hits.length !== 1) throw new Error(`${patch.site}：期望 1 处命中，实际 ${hits.length} 处 —— 上游产物结构变了，请人工检查`)
  const at = hits[0]
  const indent = /^\s*/u.exec(lines[at])[0]
  lines[at] = patch.block.map((line) => (line === '' ? '' : indent + line)).join('\n')
  return { src: lines.join('\n'), changed: true }
}

/** payload 版本抬一格（...-dev.N → ...-dev.N+1）；不是该形态就让脚本失败，交给人工决定。 */
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

const work = mkdtempSync(join(tmpdir(), 'dshl-bridge-syncack-'))
const packDir = join(work, 'pack-out')
const verifyDir = join(work, 'verify')
try {
  execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'inherit' })
  const pkgDir = join(work, 'package')

  // 幂等：任一处已打过 → 认为整包已处理，直接退出（三处是一起打的）
  const jsBefore = readFileSync(join(pkgDir, JS), 'utf8')
  if (PATCHES.some((p) => jsBefore.includes(p.marker) || readFileSync(join(pkgDir, p.file), 'utf8').includes(p.marker))) {
    console.log('无需打补丁（payload 已含本补丁的标记），未改动任何文件。')
    process.exit(0)
  }

  const applied = []
  for (const patch of PATCHES) {
    const path = join(pkgDir, patch.file)
    const before = readFileSync(path, 'utf8')
    const r = patchLines(before, patch)
    if (r.missing) {
      console.log(`无需打补丁（${patch.site} 的旧行已不存在，上游可能已放宽），未改动任何文件。`)
      process.exit(0)
    }
    writeFileSync(path, r.src)
    applied.push({ file: patch.file, site: patch.site })
  }

  // 语法兜底：JS 走 node --check，Python 走 ast.parse（找得到解释器就查，找不到只提示）
  execFileSync(process.execPath, ['--check', join(pkgDir, JS)], { stdio: 'inherit' })
  const venvPython = join(process.env.USERPROFILE || '', '.agentsanywhere', 'dsh-bridge-next', 'connector-venv', 'Scripts', 'python.exe')
  const python = existsSync(venvPython) ? venvPython : 'python'
  try {
    execFileSync(python, ['-c', `import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())`, join(pkgDir, PY)], { stdio: 'inherit' })
  } catch {
    console.log('提示：未能用 Python 校验 sync.py 语法（解释器不可用），仅做了缩进一致的行替换。')
  }

  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const oldVersion = pkg.version
  const newVersion = bumpDev(oldVersion)
  pkg.version = newVersion
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

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
  const packed = bridge.readPackageFromTarball(tgzPath)
  if (packed.name !== pkg.name) throw new Error('复验失败：包名变了 ' + packed.name)
  if (packed.version !== newVersion) throw new Error('复验失败：产物版本 ' + packed.version + ' 与期望 ' + newVersion + ' 不一致')

  const prior = meta.patched || {}
  meta.version = newVersion
  if (meta.package && typeof meta.package === 'object') meta.package.version = newVersion
  meta.sha256 = newSha
  meta.patched = Object.assign({}, prior, {
    by: 'dshl tools/patch-bridge-sync-ack-compat.mjs',
    why: 'ACK 竞态：resubscribe 会换掉唯一 feed 槽，旧流上迟到的 ack 被路由判 INVALID_PARAMS(non-retryable) → connector 消费循环退出 → host 队列打满 → 卡片「异常」循环。P1 路由幂等成功、P2 Feed.ack 忽略越界、P3 connector 乱序重新对齐',
    appliedAt: new Date().toISOString(),
    upstreamSha256: prior.upstreamSha256 || oldSha,
    history: [...(Array.isArray(prior.history) ? prior.history : []), {
      by: 'dshl tools/patch-bridge-sync-ack-compat.mjs',
      why: `P1+P2+P3 同步 ack 宽容化；payload 版本 ${oldVersion} → ${newVersion}（触发启动器重装）`,
      appliedAt: new Date().toISOString(),
      inputSha256: oldSha,
      sites: applied.map((a) => `${a.file}: ${a.site}`),
    }],
  })
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  mkdirSync(verifyDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgzPath, '-C', verifyDir], { stdio: 'inherit' })
  const vPkg = join(verifyDir, 'package')
  const verifyJs = readFileSync(join(vPkg, JS), 'utf8')
  const verifyPy = readFileSync(join(vPkg, PY), 'utf8')
  for (const patch of PATCHES) if (!readFileSync(join(vPkg, patch.file), 'utf8').includes(patch.marker)) throw new Error(`复验失败：新产物缺少标记 ${patch.marker}`)
  if (verifyJs.includes('throw new BridgeError("INVALID_PARAMS", "Unknown event stream.")')) throw new Error('复验失败：路由仍在抛 Unknown event stream')
  if (verifyJs.includes('throw new BridgeError("INVALID_PARAMS", "Invalid event acknowledgement.")')) throw new Error('复验失败：Feed.ack 仍在抛 Invalid event acknowledgement')
  if (verifyPy.includes('raise ValueError("Out-of-order event batch')) throw new Error('复验失败：connector 仍在 raise 乱序')
  if (!verifyPy.includes('expected = batch["batchSeq"]')) throw new Error('复验失败：connector 未重新对齐')
  if (sha256File(tgzPath) !== meta.sha256) throw new Error('复验失败：sha256 与 version.json 不一致')

  console.log('payload 补丁完成：')
  console.log('  package  ' + packed.name + '@' + packed.version)
  for (const a of applied) console.log('  已打     ' + a.file + ' — ' + a.site)
  console.log('  旧 sha   ' + oldSha)
  console.log('  新 sha   ' + newSha)
  console.log('  产物     ' + tgzPath)
} finally {
  rmSync(work, { recursive: true, force: true })
}
