'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

/** Complete an explicitly requested install/enable, never a background inventory scan.
 * Callers hold the launcher's profile-operation lock. Read again after pnpm exits
 * so its dependency changes and unrelated bundle selections are preserved.
 */
function ensureProfileBundle(profileDir, name) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)) {
    throw new Error('无效的插件包名')
  }
  const file = path.join(profileDir, 'package.json')
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('profile manifest 不可安全读取')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!Array.isArray(bundles) || bundles.some((entry) => typeof entry !== 'string')) throw new Error('profile bundles 格式错误')
  if (bundles.includes(name)) return false
  if (typeof manifest.dependencies?.[name] !== 'string') throw new Error('插件依赖尚未安装：' + name)
  // link: packages are supported, but a patch must stay inside the real package.
  const packageDir = fs.realpathSync(path.join(profileDir, 'node_modules', ...name.split('/')))
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  const patch = pkg.dsh?.bundle?.patch
  if (pkg.name !== name || typeof patch !== 'string' || !patch || patch.includes('\\') || patch.includes('\0')) {
    throw new Error('插件未声明有效的 bundle：' + name)
  }
  const relative = patch.startsWith('./') ? patch.slice(2) : patch
  if (relative.split('/').some((part) => !part || part === '..' || part === '.' || part.includes(':'))) {
    throw new Error('插件 bundle patch 路径无效：' + name)
  }
  const patchFile = fs.realpathSync(path.join(packageDir, relative))
  const resolvedRelative = path.relative(packageDir, patchFile)
  if (resolvedRelative.startsWith('..' + path.sep) || resolvedRelative === '..' || path.isAbsolute(resolvedRelative)
    || !fs.statSync(patchFile).isFile()) throw new Error('插件 bundle patch 超出包目录：' + name)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, name] } }
  const temp = file + '.tmp-' + randomUUID()
  try {
    fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: stat.mode & 0o777 })
    fs.renameSync(temp, file)
  } finally {
    try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return true
}

module.exports = { ensureProfileBundle }
