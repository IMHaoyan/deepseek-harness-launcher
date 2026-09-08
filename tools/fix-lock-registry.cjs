// 一次性脚本（可删）：把 package-lock.json 里指向内网 npm 源的 resolved URL 换成官方源。
// 只改 URL 前缀，保留 integrity（内容哈希与源无关），不动版本与依赖树。
'use strict'
const fs = require('fs')

const INTERNAL = 'http://qa.leihuo.netease.com/npm/'
const OFFICIAL = 'https://registry.npmjs.org/'
const file = 'package-lock.json'
const text = fs.readFileSync(file, 'utf8')

let count = 0
const out = text.replace(/"resolved": "http:\/\/qa\.leihuo\.netease\.com\/npm\//g, () => {
  count += 1
  return '"resolved": "https://registry.npmjs.org/'
})

if (count === 0) {
  console.log('没有需要替换的条目')
  process.exit(0)
}
fs.writeFileSync(file, out)

// 复核
const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
const entries = Object.entries(lock.packages || {}).filter(([k]) => k)
const stillInternal = entries.filter(([, v]) => v.resolved && /qa\.leihuo/.test(v.resolved))
const noIntegrity = entries.filter(([k, v]) => !v.integrity && !v.link)
console.log(`替换 ${count} 条 → 官方源`)
console.log(`剩余内网源: ${stillInternal.length}`)
console.log(`缺 integrity: ${noIntegrity.length}`)
console.log(`条目总数: ${entries.length}`)
