// fetch-node-dist.mjs — 发布构建前置：下载 Node 官方发行包到 assets/node-dist（安装包内置，首装免下载）
// 用法：node tools/fetch-node-dist.mjs [version] [--msi-only | --zip-only]
//   默认两份都内置：
//     · node-v<ver>-x64.msi      —— **官方 MSI，dshl 的默认安装路径**（与官网 .msi 完全一致）
//     · node-v<ver>-win-x64.zip  —— 用户级兜底路径用（策略禁用 MSI / 拒绝或没有管理员授权时，免联网也能装）
//   已存在且哈希与官方 SHASUMS256.txt 一致的文件会跳过下载（重复构建不必重下 60+ MB）。
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
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const msiOnly = process.argv.includes('--msi-only')
const zipOnly = process.argv.includes('--zip-only')
const version = args[0] || '22.23.2'
const BASES = ['https://npmmirror.com/dist', 'https://nodejs.org/dist']

const MSI = `node-v${version}-x64.msi`
const ZIP = `node-v${version}-win-x64.zip`
const files = msiOnly ? [MSI] : zipOnly ? [ZIP] : [MSI, ZIP]

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

// 取官方 SHASUMS256.txt（任一源成功即可）；全部失败返回 ''（此时信任下载源并照常记下实际哈希）
async function loadSums() {
  for (const base of BASES) {
    try {
      const sums = await fetchText(`${base}/v${version}/SHASUMS256.txt`)
      if (sums && sums.includes('node-v')) return sums
    } catch { /* 换下一个源 */ }
  }
  return ''
}

async function fetchOne(file, sums) {
  const outPath = join(outDir, file)
  const line = sums ? sums.split(/\r?\n/).find((l) => l.trim().endsWith(`  ${file}`)) : null
  const expected = line ? line.trim().split(/\s+/)[0] : ''
  // 已存在且与官方哈希一致 → 跳过下载（发布构建重复跑不必重下几十 MB）
  if (existsSync(outPath) && expected) {
    const have = createHash('sha256').update(readFileSync(outPath)).digest('hex')
    if (have.toLowerCase() === expected.toLowerCase()) {
      const sidecar = outPath + '.sha256'
      const sidecarOk = existsSync(sidecar) && readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0].toLowerCase() === have.toLowerCase()
      if (!sidecarOk) writeFileSync(sidecar, `${have}  ${file}\n`)
      console.log('已就绪（哈希与官方清单一致，跳过下载）：' + file)
      return true
    }
  }
  for (const base of BASES) {
    const url = `${base}/v${version}/${file}`
    console.log('下载', url)
    try { await downloadTo(url, outPath) } catch (e) { console.error('  下载失败：' + e.message); continue }
    if (!existsSync(outPath)) continue
    const actual = createHash('sha256').update(readFileSync(outPath)).digest('hex')
    if (expected && expected.toLowerCase() !== actual.toLowerCase()) {
      console.error(`  SHA256 不匹配：期望 ${expected}，实际 ${actual}（换源重试）`)
      try { unlinkSync(outPath) } catch { /* noop */ }
      continue
    }
    if (expected) console.log('  SHA256 校验通过（官方 SHASUMS256.txt）')
    else console.warn('  警告：未取到官方 SHASUMS256.txt，仅记录实际哈希')
    writeFileSync(outPath + '.sha256', `${actual}  ${file}\n`)
    console.log('完成：' + outPath + `（${Math.round(readFileSync(outPath).length / 1024 / 1024)} MB）`)
    return true
  }
  return false
}

async function main() {
  mkdirSync(outDir, { recursive: true })
  const sums = await loadSums()
  if (!sums) console.warn('警告：未能获取官方 SHASUMS256.txt，将只记录实际哈希')
  for (const file of files) {
    const ok = await fetchOne(file, sums)
    if (!ok) {
      console.error(`所有源下载失败：${file}`)
      process.exit(1)
    }
  }
}

main()
