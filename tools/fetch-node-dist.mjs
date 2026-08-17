// fetch-node-dist.mjs — 发布构建前置：下载 Node 官方发行包到 assets/node-dist（安装包内置，首装免下载）
// 用法：node tools/fetch-node-dist.mjs [version]   （默认 22.23.2）
// 产出：assets/node-dist/node-v<ver>-win-x64.zip + 同名 .sha256（安装器校验用）
// 校验：与官方 SHASUMS256.txt 比对（npmmirror 优先，nodejs.org 回退）
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync, createWriteStream, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { request } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'assets', 'node-dist')
const version = process.argv[2] || '22.23.2'
const file = `node-v${version}-win-x64.zip`
const outPath = join(outDir, file)
const BASES = ['https://npmmirror.com/dist', 'https://nodejs.org/dist']

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? get : request
    const req = lib(u, { headers: { 'User-Agent': 'DSHL release build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return downloadTo(new URL(res.headers.location, u).toString(), dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      const ws = createWriteStream(dest)
      res.pipe(ws)
      ws.on('finish', () => ws.close(() => resolve()))
      ws.on('error', (e) => { try { unlinkSync(dest) } catch { /* noop */ } reject(e) })
    })
    req.on('error', reject)
    req.end()
  })
}

async function fetchText(url) {
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? get : request
  return new Promise((resolve, reject) => {
    lib(u, { headers: { 'User-Agent': 'DSHL release build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return fetchText(new URL(res.headers.location, u).toString()).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)) }
      let body = ''
      res.on('data', (d) => { body += String(d) })
      res.on('end', () => resolve(body))
    }).on('error', reject)
  })
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  for (const base of BASES) {
    const url = `${base}/v${version}/${file}`
    console.log('下载', url)
    try { await downloadTo(url, outPath) } catch (e) { console.error('  下载失败：' + e.message); continue }
    if (!existsSync(outPath)) continue
    // 官方 SHASUMS256.txt 校验
    let expected = ''
    try {
      const sums = await fetchText(`${base}/v${version}/SHASUMS256.txt`)
      const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${file}`))
      if (line) expected = line.trim().split(/\s+/)[0]
    } catch { /* 校验文件拉不到则信任下载源 */ }
    const actual = createHash('sha256').update(readFileSync(outPath)).digest('hex')
    if (expected && expected.toLowerCase() !== actual.toLowerCase()) {
      console.error(`  SHA256 不匹配：期望 ${expected}，实际 ${actual}（换源重试）`)
      try { unlinkSync(outPath) } catch { /* noop */ }
      continue
    }
    if (expected) console.log('  SHA256 校验通过（官方 SHASUMS256.txt）')
    writeFileSync(outPath + '.sha256', `${actual}  ${file}\n`)
    console.log('完成：' + outPath + `（${Math.round(readFileSync(outPath).length / 1024 / 1024)} MB）`)
    return
  }
  console.error('所有源下载失败')
  process.exit(1)
}

main()
