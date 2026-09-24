// assert-package.cjs — 打包后产物断言（缺一即失败退出，已接进 tools/release.mjs 的构建之后）
// 检查四件事：
//   1) 安装包 / blockmap / 渠道 yml 都在，且 yml 的 version / path / size / sha512 与**真实安装包**一致
//      （文件名对得上不代表内容对得上：dist 里常年堆着历史产物）
//   2) exe 的 FileVersion / ProductVersion 与 package.json 版本一致
//   3) app.asar 里打进包的界面文件与仓库里的文件逐字节一致（wwwroot/**、build.files 的顶层 js、assets/**）
//      —— 拦住「改了源码没跑 build:assets」和「打的是旧产物」这两类静默降级
//   4) app.asar 里的界面锚点在位（版本行 / 更新入口 / 渠道 chip）
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version

/** 版本号里的预发布段决定渠道（与 tools/release.mjs 同一口径）。 */
function channelOf(value) {
  const tag = value.includes('-') ? value.slice(value.indexOf('-') + 1).split('.')[0] : ''
  return tag === 'alpha' ? 'alpha' : 'latest'
}

/** 该版本对应的 electron-builder 渠道 yml 文件名。 */
function ymlNameOf(value) {
  return channelOf(value) === 'latest' ? 'latest.yml' : `${channelOf(value)}.yml`
}

/** 界面锚点：缺一个界面就残；新增/改名界面契约时同步维护这里。 */
const ANCHORS = {
  'wwwroot/index.html': ['id="dshVersion"', 'id="dshUpdRowHint"', 'id="dshUpdTarget"', 'id="dshChannelChips"', 'id="btnDshCheckHover"', 'id="btnDshUpdateNow"'],
  'wwwroot/app.js': ['renderDshUpdate', 'dshUpdTarget', 'latestTag'],
  'wwwroot/styles.css': ['.version-target', '.version-hint'],
}

/** electron-builder 写的渠道 yml 形状固定；取出来供逐项比对。 */
function parseYml(text) {
  const pick = (re) => ((re.exec(text) || [])[1] || '').trim()
  return {
    version: pick(/^version:\s*(\S+)/mu),
    path: pick(/^path:\s*(\S+)/mu),
    sha512: pick(/^sha512:\s*(\S+)/mu),
    size: pick(/^\s+size:\s*(\d+)/mu),
  }
}

/**
 * yml 与真实安装包是否对得上（纯函数，供测试直接验证）。
 * @param {{yml:object, exeName:string, version:string, exeSize:number, exeSha512:string}} input 待比对的一组事实
 * @returns {string[]} 问题清单，空数组表示一致
 */
function ymlProblems(input) {
  const src = input || {}
  const yml = src.yml || {}
  const problems = []
  if (!yml.version) problems.push('yml 里读不到 version')
  else if (yml.version !== src.version) problems.push(`yml 版本是 ${yml.version}，package.json 是 ${src.version}`)
  if (!yml.path) problems.push('yml 里读不到 path')
  else if (yml.path !== src.exeName) problems.push(`yml 指向 ${yml.path}，本次安装包是 ${src.exeName}`)
  if (!yml.size) problems.push('yml 里读不到 size')
  else if (Number(yml.size) !== src.exeSize) problems.push(`yml 记录 ${yml.size} 字节，实际安装包 ${src.exeSize} 字节`)
  if (!yml.sha512) problems.push('yml 里读不到 sha512')
  else if (yml.sha512 !== src.exeSha512) problems.push('yml 的 sha512 与安装包实际内容不符（dist 里可能是旧产物）')
  return problems
}

// ---------- asar：只读文件头 + 按偏移取文件，不依赖任何第三方包 ----------
// 头部是两层 pickle：前 8 字节 [4..7] = 外层负载长度；负载 = 内层 pickle
//（[0..3] = 内层长度、[4..7] = JSON 字符串长度、[8..] = JSON 正文，尾部按 4 字节对齐）。
// 数据区起点 = 8 + 外层负载长度。
function asarOpen(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(8)
    fs.readSync(fd, head, 0, 8, 0)
    const headerSize = head.readUInt32LE(4)
    if (!headerSize || headerSize > 64 * 1024 * 1024) throw new Error('asar 头部长度异常：' + headerSize)
    const payload = Buffer.alloc(headerSize)
    fs.readSync(fd, payload, 0, headerSize, 8)
    const jsonLength = payload.readUInt32LE(4)
    if (payload[8] !== 0x7b || !jsonLength) throw new Error('asar 头部不是预期的 JSON 头')
    const header = JSON.parse(payload.toString('utf8', 8, 8 + jsonLength))
    return { fd, header, baseOffset: 8 + headerSize }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function asarEntry(session, rel) {
  let node = session.header
  for (const part of rel.split('/')) {
    node = node && node.files ? node.files[part] : null
    if (!node) return null
  }
  return node
}

function asarRead(session, entry) {
  if (typeof entry.size !== 'number' || entry.offset === undefined) return null
  const buffer = Buffer.alloc(entry.size)
  fs.readSync(session.fd, buffer, 0, entry.size, session.baseOffset + Number(entry.offset))
  return buffer
}

function walkDir(dir, prefix, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walkDir(full, `${prefix}${name}/`, out)
    else out.push(`${prefix}${name}`)
  }
  return out
}

/** 该进包的仓库文件：build.files 的具名文件 + wwwroot/** + assets/**（assets/node-dist 走 extraResources，不进 asar）。 */
function packagedSources() {
  const rels = []
  for (const entry of pkg.build.files || []) {
    if (entry.includes('*')) continue
    if (fs.existsSync(path.join(root, entry))) rels.push(entry.replace(/\\/g, '/'))
  }
  for (const rel of walkDir(path.join(root, 'wwwroot'), 'wwwroot/', [])) rels.push(rel)
  for (const rel of walkDir(path.join(root, 'assets'), 'assets/', [])) {
    if (rel.startsWith('assets/node-dist/')) continue
    rels.push(rel)
  }
  return rels
}

function exeVersion(file, field) {
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Item -LiteralPath '${file}').VersionInfo.${field}`,
  ], { encoding: 'utf8' }).trim()
}

function main() {
  const problems = []
  if (process.platform !== 'win32') {
    console.log('产物断言跳过：Windows 安装包只能在 Windows 上校验')
    return problems
  }
  const dist = path.join(root, 'dist')
  const exeName = `dshl-${version}.exe`
  const exePath = path.join(dist, exeName)
  const blockmapPath = `${exePath}.blockmap`
  const ymlPath = path.join(dist, ymlNameOf(version))
  const asarPath = path.join(dist, 'win-unpacked', 'resources', 'app.asar')

  for (const [label, file] of [['安装包', exePath], ['blockmap', blockmapPath], ['渠道 yml', ymlPath], ['app.asar', asarPath]]) {
    if (!fs.existsSync(file)) problems.push(`${label}缺失：${file}`)
  }
  if (problems.length) { report(problems); return problems }

  const exeBuffer = fs.readFileSync(exePath)
  const yml = parseYml(fs.readFileSync(ymlPath, 'utf8'))
  problems.push(...ymlProblems({
    yml,
    exeName,
    version,
    exeSize: exeBuffer.length,
    exeSha512: crypto.createHash('sha512').update(exeBuffer).digest('base64'),
  }))

  for (const field of ['FileVersion', 'ProductVersion']) {
    let actual = ''
    try { actual = exeVersion(exePath, field) } catch (error) { problems.push(`读不到 exe 的 ${field}：${error.message}`) ; continue }
    if (actual !== version) problems.push(`exe 的 ${field} 是 ${actual || '（空）'}，package.json 是 ${version}`)
  }

  let session
  try {
    session = asarOpen(asarPath)
  } catch (error) {
    problems.push(`app.asar 无法解析：${error.message}`)
    report(problems)
    return problems
  }
  try {
    const sources = packagedSources()
    const missing = []
    const differs = []
    for (const rel of sources) {
      const entry = asarEntry(session, rel)
      if (!entry || typeof entry.size !== 'number') { missing.push(rel); continue }
      const packed = asarRead(session, entry)
      if (!packed || Buffer.compare(packed, fs.readFileSync(path.join(root, rel))) !== 0) differs.push(rel)
    }
    if (missing.length) problems.push(`app.asar 缺少文件：${missing.join('、')}`)
    if (differs.length) problems.push(`app.asar 内文件与仓库不一致（先跑 npm run build:assets 再打包）：${differs.join('、')}`)

    for (const [rel, anchors] of Object.entries(ANCHORS)) {
      const entry = asarEntry(session, rel)
      const text = entry && typeof entry.size === 'number' ? asarRead(session, entry).toString('utf8') : ''
      const absent = anchors.filter((anchor) => !text.includes(anchor))
      if (absent.length) problems.push(`${rel} 缺界面锚点：${absent.join('、')}`)
    }
  } finally {
    fs.closeSync(session.fd)
  }
  report(problems)
  return problems
}

function report(problems) {
  if (problems.length) {
    console.error('\n产物断言失败：')
    for (const problem of problems) console.error('  ✗ ' + problem)
    process.exitCode = 1
    return
  }
  console.log(`产物断言通过：${`dshl-${version}.exe`} / ${ymlNameOf(version)} / app.asar（版本、哈希、包内文件与界面锚点一致）`)
}

module.exports = { channelOf, ymlNameOf, parseYml, ymlProblems, asarOpen, asarEntry, asarRead, packagedSources, main }

if (require.main === module) {
  const problems = main()
  if (problems.length) process.exit(1)
}
