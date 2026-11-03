'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ensureProfileBundle } = require('../profile-bundle')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bundle-repair-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'package.json')
  const manifest = { name: 'profile', private: true, dependencies: { pkg: '1.0.0', disabled: '2.0.0' },
    dsh: { custom: true, profile: { extra: 1, bundles: ['base'] } } }
  fs.writeFileSync(file, JSON.stringify(manifest))
  const pkgDir = path.join(dir, 'node_modules', 'pkg')
  fs.mkdirSync(pkgDir, { recursive: true })
  const pkg = { name: 'pkg', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg))
  fs.writeFileSync(path.join(pkgDir, 'cordis.patch.yml'), '- insert: []\n')
  return { dir, file, pkgDir, pkg, manifest }
}

test('retry repairs a retained dependency without enabling unrelated dependencies; second call is a no-op', (t) => {
  const { dir, file, manifest } = fixture(t)
  assert.equal(ensureProfileBundle(dir, 'pkg'), true)
  const repaired = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(repaired.dependencies, manifest.dependencies)
  assert.equal(repaired.dsh.custom, true)
  assert.equal(repaired.dsh.profile.extra, 1)
  assert.deepEqual(repaired.dsh.profile.bundles, ['base', 'pkg'])
  const bytes = fs.readFileSync(file, 'utf8')
  assert.equal(ensureProfileBundle(dir, 'pkg'), false)
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['node_modules', 'package.json'])
})

test('missing dependency, payload or patch cannot leave a partially enabled bundle', (t) => {
  const { dir, file, pkgDir } = fixture(t)
  const bytes = fs.readFileSync(file, 'utf8')
  assert.throws(() => ensureProfileBundle(dir, 'absent'), /尚未安装/)
  fs.unlinkSync(path.join(pkgDir, 'cordis.patch.yml'))
  assert.throws(() => ensureProfileBundle(dir, 'pkg'), /ENOENT/)
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
})

test('identity mismatch and escaping bundle patches are rejected without changing the profile', (t) => {
  const { dir, file, pkgDir, pkg } = fixture(t)
  const bytes = fs.readFileSync(file, 'utf8')
  for (const candidate of [{ ...pkg, name: 'other' }, { ...pkg, dsh: { bundle: { patch: '../outside.yml' } } }]) {
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(candidate))
    assert.throws(() => ensureProfileBundle(dir, 'pkg'), /bundle/)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  }
})

test('link-style installed packages can be registered', (t) => {
  const { dir, file, pkgDir } = fixture(t)
  const target = path.join(dir, 'payload')
  fs.renameSync(pkgDir, target)
  fs.symlinkSync(target, pkgDir, process.platform === 'win32' ? 'junction' : 'dir')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.dependencies.pkg = 'link:' + target.replace(/\\/gu, '/')
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.equal(ensureProfileBundle(dir, 'pkg'), true)
})
