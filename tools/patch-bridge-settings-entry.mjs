// Convert the bundled Agents Anywhere 2.0.0 client entry to a DSH settings section.
// Repack from a verified archive; preserve the original 2.0.0 asset as a rollback point.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKER, patchClient } from '../integrations/bridge-settings-entry/patch-client.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'assets', 'bridge-next')
const archive = join(assets, 'bridge-next.tgz')
const metadata = join(assets, 'version.json')
const meta = JSON.parse(readFileSync(metadata, 'utf8'))
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const beforeSha = sha(archive)
if (meta.sha256 !== beforeSha) throw new Error('Archive and metadata SHA mismatch; no files changed')
if (meta.version === '2.0.0+dshl.ui1' && meta.package?.version === meta.version) {
  const client = execFileSync('tar', ['-xOzf', archive, 'package/lib/client.js'], { maxBuffer: 2 * 1024 * 1024 }).toString('utf8')
  if (!client.includes(MARKER) || client.includes('sidebar.footer.action')) throw new Error('Patched metadata does not match client')
  console.log('Settings entry already patched; no files changed')
  process.exit(0)
}
if (meta.version !== '2.0.0' || meta.package?.version !== '2.0.0') {
  throw new Error('Expected the verified 2.0.0 baseline archive and metadata; no files changed')
}

const work = mkdtempSync(join(tmpdir(), 'dshl-bridge-settings-'))
if (dirname(work) !== resolve(tmpdir())) throw new Error('Unsafe temporary work path')
try {
  execFileSync('tar', ['-xzf', archive, '-C', work])
  const pkgDir = join(work, 'package')
  const clientPath = join(pkgDir, 'lib', 'client.js')
  const result = patchClient(readFileSync(clientPath, 'utf8'))
  if (!result.changed) {
    console.log('Settings entry already patched; no files changed')
    process.exit(0)
  }
  writeFileSync(clientPath, result.source)
  execFileSync(process.execPath, ['--check', clientPath], { stdio: 'inherit' })
  const pkgPath = join(pkgDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (pkg.name !== '@agents-anywhere/dsh-bridge-next' || pkg.version !== '2.0.0') throw new Error('Unexpected payload identity')
  pkg.version = '2.0.0+dshl.ui1'
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  const packedDir = join(work, 'packed')
  mkdirSync(packedDir)
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packedDir], {
    cwd: pkgDir, stdio: 'pipe', shell: process.platform === 'win32',
  })
  const candidates = readdirSync(packedDir).filter((name) => name.endsWith('.tgz'))
  if (candidates.length !== 1) throw new Error('Expected exactly one repacked archive')
  const nextArchive = join(packedDir, candidates[0])
  const verify = join(work, 'verify')
  mkdirSync(verify)
  execFileSync('tar', ['-xzf', nextArchive, '-C', verify])
  const actual = JSON.parse(readFileSync(join(verify, 'package', 'package.json'), 'utf8'))
  const client = readFileSync(join(verify, 'package', 'lib', 'client.js'), 'utf8')
  if (actual.version !== pkg.version || !client.includes(MARKER) || client.includes('sidebar.footer.action')) {
    throw new Error('Repacked UI registration did not verify; original archive untouched')
  }
  execFileSync(process.execPath, ['--check', join(verify, 'package', 'lib', 'client.js')])
  const backup = join(root, '.alpha-notes', `bridge-payload-backup-2.0.0-${beforeSha.slice(0, 12)}`)
  mkdirSync(backup, { recursive: true })
  const oldArchive = join(backup, 'bridge-next.tgz')
  if (existsSync(oldArchive) && sha(oldArchive) !== beforeSha) throw new Error('Backup collision; original archive untouched')
  if (!existsSync(oldArchive)) {
    copyFileSync(archive, oldArchive)
    copyFileSync(metadata, join(backup, 'version.json'))
  }
  const newSha = sha(nextArchive)
  const nextMeta = {
    ...meta, version: pkg.version, sha256: newSha,
    package: { ...meta.package, version: pkg.version },
    patched: {
      ...meta.patched,
      by: 'dshl tools/patch-bridge-settings-entry.mjs',
      why: '将手机连接从 sidebar.footer.action 迁至 settings.section；仅对本栏目呈现手机图标',
      appliedAt: new Date().toISOString(),
      inputSha256: beforeSha,
      history: [...(meta.patched?.history ?? []), {
        by: 'dshl tools/patch-bridge-settings-entry.mjs',
        inputSha256: beforeSha,
        version: pkg.version,
        sites: ['client.js settings.section', 'client.js settings.action phone icon'],
      }],
    },
  }
  const stage = join(assets, `.bridge-next-${process.pid}.tgz`)
  copyFileSync(nextArchive, stage)
  if (sha(stage) !== newSha) throw new Error('Staged archive checksum mismatch')
  renameSync(stage, archive)
  writeFileSync(metadata, JSON.stringify(nextMeta, null, 2) + '\n')
  if (sha(archive) !== nextMeta.sha256) throw new Error('Final checksum mismatch')
  console.log(`Patched ${pkg.name}@${pkg.version}; sha256=${newSha}; backup=${backup}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
