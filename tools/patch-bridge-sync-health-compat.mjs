// tools/patch-bridge-sync-health-compat.mjs — dshl 侧「制品级」兼容补丁：让「同步已就绪」真的被上报
//
// 背景（实测，payload 0.1.0-dev.4 + dsh 0.1.7-rc.1）：
//   同步本身完全正常（dsh-runtime.jsonl：sync.batch 889 / sync.ack 889，零失败），但网页端「手机连接」卡片
//   仍显示「启动中 + 异常」，tooltip 是「正在同步 DSH 会话…」。客户端判定见 client.js:381/386/388：
//       detected = snapshot.desktop.status;  failed = … || detected === "error";
//       statusMessage = … detected === "error" ? snapshot.desktop.message : …
//   ⇒ desktop 记录被判成 error，而它带的是**进度**文案 —— 即最后收到的 health 上报停留在 starting。
//   上游唯一的「starting → running」跃迁在 bundled-connector/…/sync.py:205-206，触发条件是
//   DSH 发出 `session.inventory.complete{complete:true}` 通知；而 consume() 每次（重）订阅都会先发一次
//   starting/sync.py:235-237。于是只要那条 inventory 通知没有（或早于）到来，记录就永远停在 starting。
//
// 本补丁（只动 connector）：
//   P1 consume()：首个批次 ack 成功后上报一次 runtime_health_update("running")（每流一次）
//      —— 有数据在流即视为同步已就绪，不再依赖"某天恰好发出的 inventory 通知"。
//   P2 未知 runtime 通知：logger.warning 后忽略，不再 raise ValueError
//      —— 上游 `else: raise ValueError("Unsupported runtime notification: …")` 会让 rc.1 新增的任一通知类型
//      直接打死整条消费循环（重订阅 → 队列打满 → 卡片异常），这一整类故障就此消除。
//
// 产物影响：payload 0.1.0-dev.4 → 0.1.0-dev.5（抬版本才会触发启动器重装），tgz 重打包，version.json 更新。
// 何时删除本脚本：上游自己把 health 跃迁改成与 inventory 通知解耦后（脚本会判定 no-op 退出）。
// 用法：node tools/patch-bridge-sync-health-compat.mjs
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

const PY = 'lib/bundled-connector/connector/runtimes/dsh/bridge/sync.py'

const PATCHES = [
  {
    file: PY,
    site: 'P1a consume()：初始化一次性上报标记',
    marker: 'health_reported',
    oldLine: 'stream_id, expected = subscription["streamId"], 1',
    block: [
      'stream_id, expected = subscription["streamId"], 1',
      'health_reported = False  # dshl 补丁：本流是否已上报过 running',
    ],
  },
  {
    file: PY,
    site: 'P1b consume()：首个 ack 成功后上报 running',
    marker: '同步已就绪',
    oldLine: 'await self.client.request("runtime.sync.ack", {"streamId": stream_id, "batchSeq": expected})',
    block: [
      'await self.client.request("runtime.sync.ack", {"streamId": stream_id, "batchSeq": expected})',
      '# dshl 补丁：首个批次确认成功即视为同步已就绪。上游只在 DSH 发出 session.inventory.complete',
      '# {complete:true} 时才上报 running，否则 desktop 记录会永远停在「正在同步 DSH 会话…」→ 卡片判为异常。',
      'if not health_reported:',
      '\thealth_reported = True',
      '\tawait self.host.runtime_health_update("running")',
    ],
  },
  {
    file: PY,
    site: 'P2 未知通知：记 warning 后忽略',
    marker: 'Ignoring unsupported runtime notification',
    oldLine: 'raise ValueError(f"Unsupported runtime notification: {method}")',
    block: [
      '# dshl 补丁：未知通知不应打死整条消费循环（dsh 新版可能新增通知类型）。',
      'logger.warning("Ignoring unsupported runtime notification: {}", method)',
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

const work = mkdtempSync(join(tmpdir(), 'dshl-bridge-health-'))
const packDir = join(work, 'pack-out')
const verifyDir = join(work, 'verify')
try {
  execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'inherit' })
  const pkgDir = join(work, 'package')

  const beforeSrc = readFileSync(join(pkgDir, PY), 'utf8')
  if (PATCHES.some((p) => beforeSrc.includes(p.marker))) {
    console.log('无需打补丁（payload 已含本补丁的标记），未改动任何文件。')
    process.exit(0)
  }

  const applied = []
  for (const patch of PATCHES) {
    const path = join(pkgDir, patch.file)
    const r = patchLines(readFileSync(path, 'utf8'), patch)
    if (r.missing) {
      console.log(`无需打补丁（${patch.site} 的旧行已不存在，上游可能已改），未改动任何文件。`)
      process.exit(0)
    }
    writeFileSync(path, r.src)
    applied.push(patch.site)
  }

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
    by: 'dshl tools/patch-bridge-sync-health-compat.mjs',
    why: '「同步已就绪」从未上报：desktop 记录停在 starting → 卡片判为异常。P1 首个 ack 成功后上报 running；P2 未知通知记 warning 不再 raise',
    appliedAt: new Date().toISOString(),
    upstreamSha256: prior.upstreamSha256 || oldSha,
    history: [...(Array.isArray(prior.history) ? prior.history : []), {
      by: 'dshl tools/patch-bridge-sync-health-compat.mjs',
      why: `P1+P2 健康上报跃迁与未知通知容忍；payload 版本 ${oldVersion} → ${newVersion}（触发启动器重装）`,
      appliedAt: new Date().toISOString(),
      inputSha256: oldSha,
      sites: applied,
    }],
  })
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  mkdirSync(verifyDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgzPath, '-C', verifyDir], { stdio: 'inherit' })
  const verifyPy = readFileSync(join(verifyDir, 'package', PY), 'utf8')
  for (const patch of PATCHES) if (!verifyPy.includes(patch.marker)) throw new Error(`复验失败：新产物缺少标记 ${patch.marker}`)
  if (verifyPy.includes('raise ValueError(f"Unsupported runtime notification')) throw new Error('复验失败：未知通知仍在 raise')
  if (!verifyPy.includes('await self.host.runtime_health_update("running")')) throw new Error('复验失败：缺少 running 上报')
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
