// verify-package-files.cjs — 打包前校验（缺一即失败退出，可接进发布流程）
// 检查三件事：
//   1) main.js 的本地 require 闭包是否都被 build.files 覆盖（防止打包后 require 失败）
//   2) ui-src 下的面板文件是否都已同步到 wwwroot（除 index.html：它由构建内联鲸鱼路径后生成）
//   3) extraResources 的源目录是否存在（缺失时 electron-builder 只 warn 不报错，会静默产出降级包）
'use strict'
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const files = pkg.build.files || []
const problems = []

// ---------- 1) 本地 require 闭包 ----------
const seen = new Set()
function collect(file) {
  if (seen.has(file)) return
  seen.add(file)
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  for (const m of text.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
    let p = path.join(path.dirname(file), m[1])
    if (!path.extname(p)) p += '.js'
    if (fs.existsSync(path.join(root, p))) collect(p)
  }
}
collect('main.js')

function coveredByFiles(rel) {
  return files.some((pat) => {
    if (pat.startsWith('!')) return false
    const base = pat.replace(/\*\*\/\*$/, '').replace(/\*$/, '')
    return rel.startsWith(base) || rel === base
  })
}

const notCovered = [...seen].filter((f) => !coveredByFiles(f.replace(/\\/g, '/')))
if (notCovered.length) problems.push('build.files 未覆盖本地模块：' + notCovered.join(', '))

// ---------- 2) ui-src → wwwroot 同步 ----------
const uiSrc = path.join(root, 'ui-src')
const wwwroot = path.join(root, 'wwwroot')
const uiFiles = fs.readdirSync(uiSrc).filter((n) => fs.statSync(path.join(uiSrc, n)).isFile())
const stale = []
for (const name of uiFiles) {
  if (name === 'index.html') continue // 产物由 index.html + 内联鲸鱼路径生成，不逐字节相等
  const a = path.join(uiSrc, name)
  const b = path.join(wwwroot, name)
  if (!fs.existsSync(b)) { stale.push(name + '（wwwroot 缺失）'); continue }
  if (Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) !== 0) stale.push(name + '（内容不一致）')
}
const orphan = fs.readdirSync(wwwroot).filter((n) => !uiFiles.includes(n))
if (stale.length) problems.push('ui-src 与 wwwroot 不同步：' + stale.join('、') + '（执行 npm run build:assets）')
if (orphan.length) problems.push('wwwroot 有 ui-src 中已不存在的文件：' + orphan.join('、'))

// ---------- 3) extraResources 源目录 ----------
for (const r of pkg.build.extraResources || []) {
  const from = typeof r === 'string' ? r : r.from
  if (from && !fs.existsSync(path.join(root, from))) {
    problems.push('extraResources 源目录缺失：' + from + '（打包会静默跳过，产物将缺少该内容）')
  }
}

console.log('local require closure:', [...seen].join(', '))
console.log('ui-src → wwwroot:', uiFiles.filter((n) => n !== 'index.html').join(', '))
if (problems.length) {
  console.error('\n打包前校验失败：')
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(1)
}
console.log('打包前校验通过：require 闭包 / wwwroot 同步 / extraResources 源目录均无问题')
