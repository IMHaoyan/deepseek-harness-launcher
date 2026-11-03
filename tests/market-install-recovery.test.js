'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const market = require('../market')

for (const failFirst of [false, true]) {
  test(failFirst ? 'failed install then retry repairs the retained dependency' : 'clean install completes bundle registration', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-install-retry-'))
    t.after(() => fs.rmSync(home, { recursive: true, force: true }))
    const dir = path.join(home, 'profiles', 'web')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'package.json')
    fs.writeFileSync(file, JSON.stringify({ dependencies: { disabled: '1.0.0' }, dsh: { profile: { bundles: ['base'] } } }))
    const bin = path.join(home, 'fake-dsh.cjs')
    // Model pnpm persisting its dependency before a blocked postinstall. On a
    // retry, DSH leaves retained dependencies out of its new-bundle reconcile.
    fs.writeFileSync(bin, `
      const fs = require('node:fs'); const path = require('node:path');
      const file = path.join(process.cwd(), 'package.json');
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      const first = !m.dependencies['recovery-pkg'];
      m.dependencies['recovery-pkg'] = '1.0.0';
      fs.writeFileSync(file, JSON.stringify(m));
      const pkgDir = path.join(process.cwd(), 'node_modules', 'recovery-pkg');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({name:'recovery-pkg', version:'1.0.0', dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
      fs.writeFileSync(path.join(pkgDir, 'cordis.patch.yml'), '- insert: []');
      if (${failFirst} && first) {
        console.error('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @dataiku/uv@0.12.0');
        console.error('x'.repeat(1200));
        console.error('UND_ERR_DESTROYED'); process.exitCode = 1;
      } else console.log('Done');
    `)
    t.mock.method(globalThis, 'fetch', async () => ({ status: 200,
      url: 'https://registry.npmjs.org/recovery-pkg/latest',
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ name: 'recovery-pkg', version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } } })).buffer }))
    const logs = []
    market.initMarket({ home, log: (line) => logs.push(line), envDetect: { detectEnv: async () => ({
      plan: { nodeCmd: process.execPath, dshBin: bin }, pnpm: { status: 'ok', path: process.execPath },
    }) } })
    if (failFirst) {
      const failed = await market.installByName('recovery-pkg', { force: true })
      assert.equal(failed.ok, false)
      assert.equal(failed.env.kind, 'build-approval')
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dsh.profile.bundles, ['base'])
      assert.ok(logs.some((line) => line.includes('IGNORED_BUILDS') && line.includes('UND_ERR_DESTROYED') && line.includes('x'.repeat(1200))))
    }
    const installed = await market.installByName('recovery-pkg', { force: true })
    assert.equal(installed.ok, true, installed.error)
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['base', 'recovery-pkg'])
    assert.equal(manifest.dependencies.disabled, '1.0.0')
    assert.equal(market.getState('recovery-pkg').error, '')
  })
}
