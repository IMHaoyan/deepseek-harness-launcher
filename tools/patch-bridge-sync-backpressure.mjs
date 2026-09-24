// tools/patch-bridge-sync-backpressure.mjs — dshl 侧「制品级」兼容补丁：背压溢出不再作废整条流
//
// 背景（实测，payload 0.1.0-dev.5 + dsh 0.1.7-rc.1，日志 dsh-runtime.jsonl）：
//   症状：网页端「能连上、能发消息（本地 DSH 收到）、但收不到回复」。
//   证据：13:00:40 sync.failed queued=10000 waitingAck=- seq=262 → sync.stopped → bridge.sync_failed；
//         同步总账仍在推进（25 秒 +77 条 ack），批次 kinds = snapshot.* / notifications。
//   机制：DSH 回合内事件量大，host 的 Feed 有硬上限（MAX_BUFFER=1e4 条 / 16 MiB），消费端逐批 await ack
//         走 connector→relay 往返，一旦跟不上就涨到上限 → fail("DSH event buffer full; resubscribe for a
//         fresh baseline") → 整条流作废重订阅；溢出窗口内的增量（新增/回复的 timeline item）没人消费 → 网页端收不到。
//
//   本补丁（A+B 在 host JS，C+D 在 connector Python）：
//   A lib/index.js Feed.emit：溢出**不再 fail()**，改为先丢可自愈的 refresh 类、再丢最旧条目，
//     直到两条上限都满足；只记一条 sync.buffer_dropped。
//   B 上限抬高：MAX_BUFFER 1e4 → 5e4；字节上限 16 MiB → 64 MiB（字节上限才是内存真兜底）。
//   C sync.py run() 的失败日志：warning → error 并带上原因（connector/log 只持久化 ERROR/CRITICAL，
//     warning 会被丢掉，导致"谁打死了消费循环"无从可查）。
//   D sync.py 未知操作 kind：记 warning 后跳过，不再 raise 打死整条消费循环（与上一轮 P2 对通知的宽容对称）。
//
// 产物影响：payload 0.1.0-dev.5 → 0.1.0-dev.6（抬版本才会触发启动器重装），tgz 重打包，version.json 更新。
// 何时删除本脚本：上游自己把背压做成不丢流、并把消费循环改成容错后（脚本会判定 no-op 退出）。
// 用法：node tools/patch-bridge-sync-backpressure.mjs
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

const PATCHES = [
  {
    file: JS,
    site: 'A 溢出不再作废整条流（丢 refresh / 最旧条目）',
    marker: 'sync.buffer_dropped',
    oldLines: [
      'if (this.queue.length >= MAX_BUFFER || this.queuedBytes > 16777216) {',
      'this.fail(/* @__PURE__ */ new Error("DSH event buffer full; resubscribe for a fresh baseline"));',
      'return;',
      '}',
    ],
    // JS 侧缩进用制表符（与 bundle 一致）
    block: [
      '// dshl 补丁：溢出不再作废整条流 —— fail() 会重订阅，而溢出窗口内的增量（新增/回复的 timeline item）',
      '// 就此没人消费 → 网页端"能连上、能发消息、却收不到回复"。改为先丢可自愈的 refresh 类，再丢最旧条目。',
      'if (this.queue.length >= MAX_BUFFER || this.queuedBytes > 67108864) {',
      '\tconst before = this.queue.length;',
      '\tthis.queue = this.queue.filter((item) => item?.type !== "refresh");',
      '\twhile (this.queue.length > 0 && (this.queue.length >= MAX_BUFFER || this.queuedBytes > 67108864)) {',
      '\t\tconst dropped = this.queue.shift();',
      '\t\ttry { this.queuedBytes -= jsonBytes(dropped); } catch { /* 记账失败不影响继续 */ }',
      '\t}',
      '\tif (this.queuedBytes < 0) this.queuedBytes = 0;',
      '\tthis.native.diagnostics.log("debug", "sync.buffer_dropped", { dropped: before - this.queue.length, queue: this.queue.length, streamId: this.id });',
      '}',
    ],
  },
  {
    file: JS,
    site: 'B 条数上限 1e4 → 5e4',
    marker: 'const MAX_BUFFER = 5e4;',
    oldLines: ['const MAX_BUFFER = 1e4;'],
    block: ['// dshl 补丁：给慢速中继更多余量（字节上限仍是内存真兜底，见下面的 64 MiB）', 'const MAX_BUFFER = 5e4;'],
  },
  {
    file: PY,
    site: 'C 同步中断的失败日志改为可落盘的 error 并带原因',
    marker: 'dshl 补丁：改成 error 才会被落盘',
    oldLines: ['logger.warning("DSH event sync interrupted; resubscribing for history calibration ({})", type(error).__name__)'],
    // Python 侧缩进用 4 空格
    block: [
      '# dshl 补丁：改成 error 才会被落盘（connector/log 只持久化 ERROR/CRITICAL），并带上原因，',
      '# 让"是哪条 raise 打死了消费循环"在日志里可查。',
      'logger.error("DSH event sync interrupted; resubscribing for history calibration ({}: {})", type(error).__name__, error)',
    ],
  },
  {
    file: PY,
    site: 'D 未知操作 kind 只记 warning 不打死消费循环',
    marker: 'Ignoring unsupported bridge operation',
    oldLines: ['raise ValueError(f"Unsupported bridge operation: {kind}")'],
    block: [
      '# dshl 补丁：不认识的操作 kind 不该打死整条消费循环（dsh 新版可能新增投影类型）；',
      '# 跳过它，基线快照会在下次重订阅时对齐。',
      'logger.warning("Ignoring unsupported bridge operation: {}", kind)',
    ],
  },
]

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 在一段连续行（trim 后逐一相等）上做唯一定位替换；block 相对首行缩进。 */
function patchRun(src, patch) {
  const lines = src.split('\n')
  const hits = []
  for (let i = 0; i + patch.oldLines.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < patch.oldLines.length; j++) {
      if (lines[i + j].trim() !== patch.oldLines[j]) { ok = false; break }
    }
    if (ok) hits.push(i)
  }
  if (hits.length === 0) return { src, missing: true }
  if (hits.length !== 1) throw new Error(`${patch.site}：期望 1 处命中，实际 ${hits.length} 处 —— 上游产物结构变了，请人工检查`)
  const at = hits[0]
  const indent = /^\s*/u.exec(lines[at])[0]
  const replaced = patch.block.map((line) => (line === '' ? '' : indent + line))
  lines.splice(at, patch.oldLines.length, ...replaced)
  return { src: lines.join('\n'), changed: true }
}

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

const work = mkdtempSync(join(tmpdir(), 'dshl-bridge-backpressure-'))
const packDir = join(work, 'pack-out')
const verifyDir = join(work, 'verify')
try {
  execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'inherit' })
  const pkgDir = join(work, 'package')

  const beforeJs = readFileSync(join(pkgDir, JS), 'utf8')
  const beforePy = readFileSync(join(pkgDir, PY), 'utf8')
  if (PATCHES.some((p) => (p.file === JS ? beforeJs : beforePy).includes(p.marker))) {
    console.log('无需打补丁（payload 已含本补丁的标记），未改动任何文件。')
    process.exit(0)
  }

  const applied = []
  for (const patch of PATCHES) {
    const path = join(pkgDir, patch.file)
    const r = patchRun(readFileSync(path, 'utf8'), patch)
    if (r.missing) {
      console.log(`无需打补丁（${patch.site} 的目标行已不存在，上游可能已改），未改动任何文件。`)
      process.exit(0)
    }
    writeFileSync(path, r.src)
    applied.push(patch.site)
  }

  execFileSync(process.execPath, ['--check', join(pkgDir, JS)], { stdio: 'inherit' })
  const venvPython = join(process.env.USERPROFILE || '', '.agentsanywhere', 'dsh-bridge-next', 'connector-venv', 'Scripts', 'python.exe')
  const python = existsSync(venvPython) ? venvPython : 'python'
  try {
    execFileSync(python, ['-c', `import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read())`, join(pkgDir, PY)], { stdio: 'inherit' })
  } catch {
    throw new Error('sync.py 语法校验失败（缩进/语法有问题），已中止，未替换产物')
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
    by: 'dshl tools/patch-bridge-sync-backpressure.mjs',
    why: '背压溢出会 fail() 整条流 → 溢出窗口的增量没人消费 → 网页端收不到回复。A 溢出改为丢 refresh/最旧条目、B 上限抬到 5e4/64MiB、C 中断原因以 error 落盘、D 未知操作 kind 宽容跳过',
    appliedAt: new Date().toISOString(),
    upstreamSha256: prior.upstreamSha256 || oldSha,
    history: [...(Array.isArray(prior.history) ? prior.history : []), {
      by: 'dshl tools/patch-bridge-sync-backpressure.mjs',
      why: `A+B+C+D 背压与容错；payload 版本 ${oldVersion} → ${newVersion}（触发启动器重装）`,
      appliedAt: new Date().toISOString(),
      inputSha256: oldSha,
      sites: applied,
    }],
  })
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  mkdirSync(verifyDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgzPath, '-C', verifyDir], { stdio: 'inherit' })
  const vJs = readFileSync(join(verifyDir, 'package', JS), 'utf8')
  const vPy = readFileSync(join(verifyDir, 'package', PY), 'utf8')
  for (const patch of PATCHES) {
    if (!(patch.file === JS ? vJs : vPy).includes(patch.marker)) throw new Error(`复验失败：新产物缺少标记 ${patch.marker}`)
  }
  if (vJs.includes('DSH event buffer full')) throw new Error('复验失败：仍在 fail() 整条流')
  if (!vJs.includes('const MAX_BUFFER = 5e4;')) throw new Error('复验失败：条数上限没抬')
  if (!vJs.includes('67108864')) throw new Error('复验失败：字节上限没抬')
  if (vPy.includes('raise ValueError(f"Unsupported bridge operation')) throw new Error('复验失败：未知操作仍在 raise')
  if (vPy.includes('logger.warning("DSH event sync interrupted')) throw new Error('复验失败：中断日志仍是 warning（不会落盘）')
  if (sha256File(tgzPath) !== meta.sha256) throw new Error('复验失败：sha256 与 version.json 不一致')

  console.log('payload 补丁完成：')
  console.log('  package  ' + packed.name + '@' + packed.version)
  for (const s of applied) console.log('  已打     ' + s)
  console.log('  旧 sha   ' + oldSha)
  console.log('  新 sha   ' + newSha)
  console.log('  产物     ' + tgzPath)
} finally {
  rmSync(work, { recursive: true, force: true })
}
