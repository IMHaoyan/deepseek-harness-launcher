const fs = require('fs'), path = require('path')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const files = pkg.build.files
// 收集 main.js 及所有本地模块的 require('./x') 本地依赖闭包
const seen = new Set()
function collect(file) {
  if (seen.has(file)) return
  seen.add(file)
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)) {
    let p = path.join(path.dirname(file), m[1])
    if (!path.extname(p)) p += '.js'
    if (fs.existsSync(p)) collect(p)
  }
}
collect('main.js')
const missing = []
for (const f of seen) {
  const rel = f.replace(/\\/g, '/')
  const matched = files.some((pat) => {
    if (pat.startsWith('!')) return false
    const base = pat.replace(/\*\*\/\*$/, '').replace(/\*$/, '')
    return rel.startsWith(base) || rel === base
  })
  if (!matched) missing.push(rel)
}
console.log('local require closure:', [...seen].join(', '))
console.log('NOT covered by build.files:', missing.length ? missing.join(', ') : '(none)')
