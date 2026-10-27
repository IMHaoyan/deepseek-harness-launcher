// tests/launcher-update-fallback.test.js — 「GitHub 失败 → 自动换国内加速源重试」的运行时行为。
//
// 单测不止钉源码文本：这里用假 electron-updater 跑真实的 updater.js，模拟
// 「GitHub 检查失败 → error 事件 → 切到下一个源 → 重新检查成功」这条链路，
// 确认确实发生了 setFeedURL 切换、成功源被记账、最终状态不是 error。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const updaterSrc = fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8')

function harness(opts = {}) {
  const autoUpdater = new EventEmitter()
  const feeds = []
  const records = []
  const logs = []
  let calls = 0
  autoUpdater.setFeedURL = (feed) => feeds.push(feed)
  autoUpdater.quitAndInstall = () => {}
  autoUpdater.checkForUpdates = async () => {
    calls += 1
    if (calls === 1) {
      const err = new Error(opts.firstError || 'getaddrinfo ENOTFOUND github.com')
      autoUpdater.emit('error', err) // electron-updater 先派发 error、再把 checkForUpdates 的 promise 拒掉
      throw err
    }
    autoUpdater.emit('update-not-available', { version: '1.4.12' })
    return {}
  }
  const app = { isPackaged: true, getVersion: () => '1.0.0', getPath: () => 'unused', quit: () => {} }
  const context = {
    module: { exports: {} },
    setTimeout,
    clearTimeout,
    setImmediate,
    URL,
    require: (id) => {
      if (id === 'electron') return { app }
      if (id === 'electron-updater') return { autoUpdater }
      if (id === 'fs') return { readFileSync: () => { throw new Error('no receipt') }, unlinkSync: () => {}, writeFileSync: () => {} }
      return require(id)
    },
  }
  vm.runInNewContext(updaterSrc, context)
  const api = context.module.exports
  api.initUpdater({
    log: (m) => logs.push(m),
    getSource: () => opts.source || 'auto',
    getMirror: () => opts.mirror || '',
    getLastSource: () => opts.lastOk || '',
    recordSource: (id) => records.push(id),
  })
  return { api, autoUpdater, feeds, records, logs, calls: () => calls }
}

const stateOf = (api) => JSON.parse(api.getState())
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('auto：GitHub 检查失败后自动切到国内加速源重试，并记住成功的源', async () => {
  const h = harness()
  await h.api.check()
  await wait(250) // 回退重试用 100ms 延迟：等 electron-updater 清掉旧 downloadPromise
  assert.equal(h.calls(), 2, '失败后必须真的再检查一次（换源重试）')
  const last = h.feeds[h.feeds.length - 1]
  assert.equal(last.provider, 'generic', '要发生一次 setFeedURL 切换')
  assert.equal(h.feeds[0].provider, 'github', '第一次检查走官方源')
  assert.equal(h.feeds[0].repo, 'deepseek-harness-launcher')
  assert.match(last.url, /^https:\/\/ghfast\.top\/https:\/\/github\.com\/IMHaoyan\/deepseek-harness-launcher\/releases\/latest\/download\/$/)
  assert.deepEqual(h.records, ['proxy:ghfast.top'], '成功的源要记账（下次自动检查优先用它）')
  const state = stateOf(h.api)
  assert.equal(state.status, 'up-to-date', '换源成功后不能留下失败态')
  assert.equal(state.activeSource, 'proxy:ghfast.top')
  assert.ok(h.logs.some((line) => line.includes('回退到 proxy:ghfast.top')), '换源要留可解释日志')
})

test('显式 github：失败就是失败，不偷偷走第三方', async () => {
  const h = harness({ source: 'github' })
  await h.api.check()
  await wait(250)
  assert.equal(h.calls(), 1, '显式 github 不做跨源回退')
  assert.equal(h.feeds.length, 2, '初始化 + 本次检查各设一次源，没有第三个')
  const state = stateOf(h.api)
  assert.equal(state.status, 'error')
  assert.match(state.error, /网络不可达/)
  assert.match(state.errorHint, /手动下载/, '失败仍要给「手动下载」这条出路')
})

test('显式 domestic：直接走国内加速源；失败则依次换下一个代理', async () => {
  const h = harness({ source: 'domestic' })
  await h.api.check()
  await wait(250)
  assert.equal(h.calls(), 2)
  const last = h.feeds[h.feeds.length - 1]
  assert.match(h.feeds[0].url, /^https:\/\/ghfast\.top\//, '显式国内源从第一个代理开始')
  assert.match(last.url, /^https:\/\/gh-proxy\.com\//, '失败后换下一个代理')
  assert.equal(stateOf(h.api).status, 'up-to-date')
})

test('自建镜像：auto 下 GitHub 失败后切到镜像（两渠道都可用）', async () => {
  const h = harness({ mirror: 'https://m.example.com/dshl' })
  await h.api.check()
  await wait(250)
  const last = h.feeds[h.feeds.length - 1]
  assert.equal(last.provider, 'generic')
  assert.equal(last.url, 'https://m.example.com/dshl/')
  assert.deepEqual(h.records, ['mirror'])
})
