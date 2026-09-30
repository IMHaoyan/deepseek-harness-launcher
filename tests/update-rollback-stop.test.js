'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '..', 'dsh-update.js'), 'utf8')
const body = source.slice(source.indexOf('async function updateNow()'), source.indexOf('module.exports ='))

for (const branch of ['verification', 'outcome']) {
  for (const failedStop of [false, 'throw']) {
    test(`回滚 ${branch} 二次停服 ${failedStop}：不换文件、不报成功、保留切换事务`, async () => {
      const events = [], states = []
      let stops = 0
      const state = { status: 'available', latest: '0.2.0', latestChannel: 'latest' }
      const ctx = {
        updating: false, rollbackUsed: false, state, userSwitchedChannel: '',
        Config: {}, saveConfig: () => {}, log: () => {}, notify: () => {},
        channelOf: () => 'latest', decideUpdateTarget: () => ({ action: 'install' }),
        envDetect: { detectEnv: async () => ({ plan: { kind: 'global', dshVersion: '0.1.0', nodeCmd: 'mock' }, dsh: { dir: 'mock' } }) },
        getServerState: () => ({ running: true }),
        stopService: async () => {
          events.push('stop'); stops++
          if (stops === 1) return true
          if (failedStop === 'throw') throw new Error('second stop denied')
          return false
        },
        startService: async () => { events.push('start'); return true },
        setState: (patch) => Object.assign(state, patch),
        emitLifecycle: () => {}, writeUpdateState: (value) => states.push(value),
        envInstall: { resolveGlobalRoot: async () => 'mock' },
        loadWebTabs: () => {}, reloadWebTabs: () => {}, markProgress: () => {}, refreshEnv: async () => {},
        swapStagedInto: async () => { events.push('swap'); return { ok: true, backupDir: 'kept-backup' } },
        decideRollback: () => branch === 'verification' ? { action: 'rollback', reason: 'version-mismatch' } : { action: 'none' },
        decideUpdateOutcome: () => ({ ok: false, reason: 'start-failed', message: 'mock failure' }),
        readPageCredential: () => ({ hasToken: true }),
        restoreSwap: async () => { events.push('restore'); throw new Error('must not restore') },
        runGlobalUpdate: async () => { events.push('install'); throw new Error('must not install') },
      }
      const update = new Function(...Object.keys(ctx), body + ';return updateNow')(...Object.values(ctx))
      await update()
      assert.deepEqual(events, ['stop', 'swap', 'start', 'stop'])
      assert.equal(state.status, 'error')
      assert.deepEqual(states.map((s) => s.phase), ['start'], '切换备份与事务不得因停服失败被清掉')
    })
  }
}
