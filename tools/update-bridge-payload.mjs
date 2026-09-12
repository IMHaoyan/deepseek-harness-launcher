// tools/update-bridge-payload.mjs — 更新随启动器分发的 DSH Bridge Next payload
//
// 用法：
//   node tools/update-bridge-payload.mjs <path-to-built-dsh-bridge-next>
//
// <path> 指向上游 Agents-Anywhere 仓库里已构建好的 dsh-bridge-next 目录
// （先在该目录执行 corepack yarn install && corepack yarn build）。
// 脚本把 lib/ 产物按 package.json 的 files 白名单打成 tgz，写入 assets/bridge-next/，
// 并生成 version.json（版本 + SHA256 + 上游提交 + 打包时间）。
//
// 为什么不在启动器里现场构建：插件未发布 npm，上游多包 devDeps 存在版本漂移
// （typecheck 在 0.1.5-rc.1 上已失败），用户机器上构建不可复现。启动器只分发已构建产物。
'use strict'

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const bridge = require('../bridge.js')
const toolDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(toolDir, '..')
const assetsDir = join(repoRoot, 'assets', 'bridge-next')

const sourceDir = process.argv[2]
if (!sourceDir) {
  console.error('用法：node tools/update-bridge-payload.mjs <已构建的 dsh-bridge-next 目录>')
  process.exit(1)
}
const src = resolve(sourceDir)
for (const rel of ['package.json', 'lib/index.js', 'lib/client.js', 'lib/bundled-connector/connector/cli.py', 'cordis.patch.yml']) {
  if (!existsSync(join(src, rel))) {
    console.error('源目录不完整，缺少 ' + rel + '：' + src)
    console.error('请先在该目录执行 corepack yarn install && corepack yarn build')
    process.exit(1)
  }
}

mkdirSync(assetsDir, { recursive: true })
const tgzName = 'bridge-next.tgz'
const tgzPath = join(assetsDir, tgzName)

// npm pack --ignore-scripts：跳过上游 prepack（yarn check 因依赖版本漂移失败），只打包已构建产物
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', assetsDir], {
  cwd: src,
  stdio: 'inherit',
  shell: process.platform === 'win32', // Windows 上 npm 是 .cmd，Node 24 需 shell 才能启动
})
// npm pack 以包名命名，统一重命名成固定文件名
const produced = readdirSync(assetsDir).filter((n) => n.endsWith('.tgz') && n !== tgzName)
if (produced.length !== 1) {
  console.error('未能定位 npm pack 产物（期望 1 个 .tgz，实际 ' + produced.length + ' 个）')
  process.exit(1)
}
if (existsSync(tgzPath)) rmSync(tgzPath)
renameSync(join(assetsDir, produced[0]), tgzPath)

const pkg = bridge.readPackageFromTarball(tgzPath)
const sha256 = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
let upstream = ''
try {
  upstream = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
} catch { /* 非 git 目录：留空 */ }

const meta = {
  version: pkg.version,
  sha256,
  tarball: tgzName,
  package: { name: pkg.name, version: pkg.version },
  upstreamCommit: upstream,
  builtAt: new Date().toISOString(),
}
writeFileSync(join(assetsDir, 'version.json'), JSON.stringify(meta, null, 2) + '\n')

console.log('payload 已更新：')
console.log('  版本   ' + meta.version)
console.log('  SHA256 ' + meta.sha256)
console.log('  提交   ' + (upstream || '(未知)'))
console.log('  产物   ' + tgzPath)


