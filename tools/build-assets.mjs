// build-assets.mjs — 生成跨平台图标并组装面板
//
// 图标来源：assets/deepseek-color.svg（彩色 DeepSeek 鲸鱼，官方品牌蓝 #4D6BFE），
// 托盘 / 窗口任务栏 / 打包 exe 统一使用彩色版，深浅色主题下都清晰，无需黑白切换逻辑。
// 面板标题栏内联鲸鱼仍从官方 FishLogo.tsx 提取路径（fill=currentColor，跟随面板主题）。
//
// 输出：
//   assets/ds.ico / blank.ico            —— Windows 托盘 + 窗口/打包图标（16/24/32/48/256 PNG 内嵌）
//   assets/dsTemplate.png / @2x          —— macOS 彩色托盘图标
//   assets/blankTemplate.png / @2x       —— macOS 闪烁空白图标
//   assets/ds.png / @2x / blank.png /@2x —— Linux 回退
//   assets/icon.png (512)                —— 打包用应用图标（mac dmg）
//   wwwroot/index.html                   —— ui-src 拷贝 + 鲸鱼路径内联
//   wwwroot/styles.css / app.js          —— ui-src 拷贝
//
// 运行：node tools/build-assets.mjs（sharp 优先从 DSH profile 解析，缺失时提示安装）
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const assets = join(root, 'assets')
const uiSrc = join(root, 'ui-src')
const wwwroot = join(root, 'wwwroot')

// ---------- sharp 解析：DSH profile 优先（DSH 自带的 sharp），其次项目 node_modules ----------
function loadSharp() {
  const bases = [join(homedir(), '.dsh', 'profiles', 'node_modules')]
  for (const base of bases) {
    try {
      const r = createRequire(join(base, 'index.js'))
      if (r('sharp')) { console.log('sharp resolved from:', base); return r }
    } catch { /* next */ }
  }
  try {
    const r = createRequire(join(root, 'node_modules', 'index.js'))
    if (r('sharp')) { console.log('sharp resolved from: project node_modules'); return r }
  } catch { /* fallthrough */ }
  console.error('sharp not found. Run: npm i -D sharp')
  process.exit(1)
}
const require = loadSharp()
const sharp = require('sharp')

// ---------- 鲸鱼路径来源 ----------
const fishLogoTsx = process.env.DSH_REPO
  ? join(process.env.DSH_REPO, 'packages', 'client', 'ui-primitives', 'src', 'FishLogo.tsx')
  : (existsSync('E:/deepseek-harness/packages/client/ui-primitives/src/FishLogo.tsx')
    ? 'E:/deepseek-harness/packages/client/ui-primitives/src/FishLogo.tsx'
    : join(homedir(), 'deepseek-harness', 'packages', 'client', 'ui-primitives', 'src', 'FishLogo.tsx'))

const tsx = readFileSync(fishLogoTsx, 'utf8')
const match = /<path d="([^"]+)"/.exec(tsx)
if (!match) { console.error('whale path not found in ' + fishLogoTsx); process.exit(1) }
const whalePath = match[1]
console.log('whale path extracted:', whalePath.length, 'chars')

mkdirSync(assets, { recursive: true })
mkdirSync(wwwroot, { recursive: true })

// ---------- ICO 打包（PNG 内嵌条目） ----------
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + 16 * entries.length
  const dirs = entries.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)])
}

const whaleSvgColor = readFileSync(join(assets, 'deepseek-color.svg'), 'utf8')

// 禁止拉伸：输出正方形画布（边长 = 最长边），图片按原始宽高比居中（contain），四周透明
async function whalePng(size) {
  return sharp(Buffer.from(whaleSvgColor), { density: 300 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

async function blankPng(size) {
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer()
}

// ---------- Windows .ico ----------
const sizes = [16, 24, 32, 48, 256] // 256 档供打包 exe 图标使用（electron-builder 要求 ≥256）
const whaleEntries = []
for (const s of sizes) whaleEntries.push({ size: s, data: await whalePng(s) })
const blankEntries = []
for (const s of sizes) blankEntries.push({ size: s, data: await blankPng(s) })
writeFileSync(join(assets, 'ds.ico'), buildIco(whaleEntries))
writeFileSync(join(assets, 'blank.ico'), buildIco(blankEntries))
console.log('ds.ico / blank.ico written (16/24/32/48/256, colored whale)')

// ---------- macOS 彩色托盘 PNG ----------
const w16 = await whalePng(16)
const w32 = await whalePng(32)
const b16 = await blankPng(16)
const b32 = await blankPng(32)
writeFileSync(join(assets, 'dsTemplate.png'), w16)
writeFileSync(join(assets, 'dsTemplate@2x.png'), w32)
writeFileSync(join(assets, 'blankTemplate.png'), b16)
writeFileSync(join(assets, 'blankTemplate@2x.png'), b32)
console.log('macOS tray icons written (16 + @2x, colored)')

// ---------- Linux 回退 ----------
writeFileSync(join(assets, 'ds.png'), w16)
writeFileSync(join(assets, 'ds@2x.png'), w32)
writeFileSync(join(assets, 'blank.png'), b16)
writeFileSync(join(assets, 'blank@2x.png'), b32)
console.log('linux fallback icons written')

// ---------- 应用图标 512（打包用；同样正方形画布 + contain 居中，不拉伸） ----------
const icon512 = await sharp(Buffer.from(whaleSvgColor), { density: 300 })
  .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer()
writeFileSync(join(assets, 'icon.png'), icon512)
console.log('icon.png (512) written')

// ---------- 组装 wwwroot：内联鲸鱼 + 拷贝样式/脚本 ----------
let html = readFileSync(join(uiSrc, 'index.html'), 'utf8')
if (!html.includes('__WHALE_PATH__')) { console.error('placeholder not found in ui-src/index.html'); process.exit(1) }
html = html.replace('__WHALE_PATH__', whalePath)
writeFileSync(join(wwwroot, 'index.html'), html)
copyFileSync(join(uiSrc, 'styles.css'), join(wwwroot, 'styles.css'))
copyFileSync(join(uiSrc, 'app.js'), join(wwwroot, 'app.js'))
copyFileSync(join(uiSrc, 'offline.html'), join(wwwroot, 'offline.html'))
copyFileSync(join(uiSrc, 'browser.html'), join(wwwroot, 'browser.html'))
copyFileSync(join(uiSrc, 'browser.css'), join(wwwroot, 'browser.css'))
copyFileSync(join(uiSrc, 'browser.js'), join(wwwroot, 'browser.js'))
console.log('wwwroot written (index.html + styles.css + app.js + offline.html + browser.*)')
console.log('ALL OK')
