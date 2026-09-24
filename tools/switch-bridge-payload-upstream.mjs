// tools/switch-bridge-payload-upstream.mjs — 对照实验：把随包 bridge payload 换成上游 npm 2.0.0
//
// 目的：验证「网页端收不到回复」是不是出在我们自己那 5 处行为补丁上。
// 组成（只保留 dsh 兼容所需的 3 处）：
//   1) peer 放宽：@deepseek-ai/dsh-typert-protocol 0.1.5-rc.2 → >=0.1.5-rc.1 <0.2.0（不放宽会被 dsh 兼容闸整个跳过）
//   2) callid 兼容：tool/result 取值改 message-first（上游仍是 0.1.7 之前的 content[0] 形态）
//   3) icon 兼容：两个图标名换成 0.1.7 上的 Regular 变体
// 明确**不带**我们的 5 处行为补丁（ack 宽容 / 健康上报 / 通知与操作容错 / 背压不改作废 / 中断日志级别）——
// 因此预期会出现：卡片可能回到「启动中/异常」、积压时仍可能作废整条流。这是实验变量，不是遗漏。
//
// 回滚：node tools/switch-bridge-payload-upstream.mjs --rollback
// 用法：node tools/switch-bridge-payload-upstream.mjs
'use strict'

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
const backupDir = join(repoRoot, '.alpha-notes', 'bridge-payload-backup-dev6')

const UPSTREAM = '@agents-anywhere/dsh-bridge-next@2.0.0'
const PEER = '@deepseek-ai/dsh-typert-protocol'
const PEER_NEW = '>=0.1.5-rc.1 <0.2.0'
const CALLID_OLD = '\t\t\tconst value = event.data.message.content[0];\n' +
  '\t\t\tresult(value.toolCallId, value.content, value.isError === true || Boolean(event.data.error), event, event.data.meta, event.data.error);'
const CALLID_NEW = '\t\t\tconst message = event.data.message;\n' +
  '\t\t\tconst value = message.content[0];\n' +
  '\t\t\tresult(message.toolCallId ?? value.toolCallId, message.content ?? value.content, message.isError === true || value.isError === true || Boolean(event.data.error), event, event.data.meta, event.data.error);'
const ICON_PAIRS = [['IconUserOutline16', 'IconUserOutlineRegular'], ['IconGlobeOutline14', 'IconGlobeOutlineRegular']]

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

if (process.argv.includes('--rollback')) {
  if (!existsSync(join(backupDir, 'bridge-next.tgz'))) throw new Error('没有可用备份：' + backupDir)
  cpSync(join(backupDir, 'bridge-next.tgz'), tgzPath)
  cpSync(join(backupDir, 'version.json'), metaPath)
  console.log('已回滚到备份 payload：' + JSON.parse(readFileSync(metaPath, 'utf8')).version)
  console.log('重新打包：npm run dist:win -- --config.publish.channel=alpha')
  process.exit(0)
}

// 1) 备份现 payload
mkdirSync(backupDir, { recursive: true })
cpSync(tgzPath, join(backupDir, 'bridge-next.tgz'))
cpSync(metaPath, join(backupDir, 'version.json'))
const prev = JSON.parse(readFileSync(metaPath, 'utf8'))
console.log(`已备份现 payload（${prev.version}）→ ${backupDir}`)
console.log('回滚命令：node tools/switch-bridge-payload-upstream.mjs --rollback\n')

// 2) 取上游 2.0.0 并解包
const work = mkdtempSync(join(tmpdir(), 'dshl-upstream-switch-'))
const packDir = join(work, 'pack-out')
try {
  execFileSync('npm', ['pack', UPSTREAM, '--silent', '--pack-destination', work], { stdio: 'inherit', shell: process.platform === 'win32' })
  const tgzs = readdirSync(work).filter((n) => n.endsWith('.tgz'))
  if (tgzs.length !== 1) throw new Error('未能定位上游 tgz（' + tgzs.length + '）')
  execFileSync('tar', ['-xzf', join(work, tgzs[0]), '-C', work], { stdio: 'inherit' })
  const pkgDir = join(work, 'package')

  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  if (pkg.version !== '2.0.0') throw new Error('上游版本不是 2.0.0：' + pkg.version)

  // 3) 三处 dsh 兼容补丁
  const applied = []
  if (pkg.peerDependencies?.[PEER] !== PEER_NEW) {
    pkg.peerDependencies[PEER] = PEER_NEW
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    applied.push(`peer ${PEER} → ${PEER_NEW}（绕开 dsh 兼容闸）`)
  } else applied.push(`peer ${PEER} 已是 ${PEER_NEW}`)

  const jsPath = join(pkgDir, 'lib', 'index.js')
  let js = readFileSync(jsPath, 'utf8')
  if (!js.includes('message.toolCallId ?? value.toolCallId')) {
    if (!js.includes(CALLID_OLD)) throw new Error('找不到 callid 旧取值点，上游结构变了，请人工检查')
    js = js.replace(CALLID_OLD, CALLID_NEW)
    writeFileSync(jsPath, js)
    applied.push('callid 取值改 message-first')
  } else applied.push('callid 已是 message-first')

  const clientPath = join(pkgDir, 'lib', 'client.js')
  let client = readFileSync(clientPath, 'utf8')
  for (const [oldName, newName] of ICON_PAIRS) {
    const n = client.split(oldName).length - 1
    if (n > 0) { client = client.split(oldName).join(newName); applied.push(`icon ${oldName} → ${newName}（${n} 处）`) }
  }
  writeFileSync(clientPath, client)

  execFileSync(process.execPath, ['--check', jsPath], { stdio: 'inherit' })
  execFileSync(process.execPath, ['--check', clientPath], { stdio: 'inherit' })

  // 4) 重打包并替换
  mkdirSync(packDir, { recursive: true })
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: pkgDir, stdio: 'inherit', shell: process.platform === 'win32' })
  const produced = readdirSync(packDir).filter((n) => n.endsWith('.tgz'))
  if (produced.length !== 1) throw new Error('未能定位打包产物')
  if (existsSync(tgzPath)) rmSync(tgzPath)
  renameSync(join(packDir, produced[0]), tgzPath)

  // 5) version.json：版本=上游 2.0.0（触发启动器重装），记录来源与"故意不带"的行为补丁
  const packed = bridge.readPackageFromTarball(tgzPath)
  if (packed.version !== '2.0.0') throw new Error('复验失败：产物版本 ' + packed.version)
  const meta = {
    version: '2.0.0',
    sha256: sha256File(tgzPath),
    tarball: 'bridge-next.tgz',
    package: { name: packed.name, version: packed.version },
    source: 'npm ' + UPSTREAM,
    experiment: {
      why: '对照实验：网页端收不到回复，验证是否出在 dshl 的 5 处行为补丁上',
      kept: applied,
      omitted: ['ack 宽容（失效流幂等成功 / Feed.ack 越界忽略）', '首个 ack 后上报 running', '未知通知与未知操作 kind 容错', '背压溢出改为丢弃而非作废整条流 + 上限抬高', '同步中断日志改为 error 落盘'],
      rollback: 'node tools/switch-bridge-payload-upstream.mjs --rollback',
    },
    patched: { by: 'dshl tools/switch-bridge-payload-upstream.mjs', why: '仅保留 dsh 兼容所需 3 处，用于对照实验', appliedAt: new Date().toISOString() },
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')

  console.log('\npayload 已切换为上游 2.0.0（对照实验）：')
  for (const a of applied) console.log('  兼容补丁 ' + a)
  console.log('  版本   2.0.0（原 ' + prev.version + '）')
  console.log('  sha    ' + meta.sha256)
  console.log('  回滚   node tools/switch-bridge-payload-upstream.mjs --rollback\n')
  console.log('注意：tests/bridge-sync-{ack,health,backpressure}.test.js 会因缺少那 5 处补丁而失败 —— 这是实验的预期结果。')
} finally {
  rmSync(work, { recursive: true, force: true })
}
