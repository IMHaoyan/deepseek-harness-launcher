// tests/dsh-update-swap-safety.test.js — 改名切换/回滚的安全边界（真实临时目录，不触发真实安装）
//
// 锁住三条已经踩过的语义：
//   ① 恢复出来的旧树探测不到版本 → 必须报失败（不能把"空版本"当回滚成功）；
//   ② 清理暂存目录时，未完成事务记着的 old-* / 暂存版本目录必须保留（它们是唯一的回滚凭据）；
//   ③ 事务状态文件用原子写；文件损坏时不能被当成"没有事务"而删除。
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const dshUpdater = require('../dsh-update')

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-swap-safety-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writePkg(dir, version, withBin = false) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  if (withBin) {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), 'console.log("0.0.0")\n')
  }
}

test('restoreSwap：旧树探测不出可运行版本时如实报失败（并保留现场）', async (t) => {
  const prefix = tempDir(t)
  const installDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  const backupDir = path.join(prefix, '.dshl-stage', 'old-0.2.0')
  writePkg(installDir, '0.2.0', false) // 新版：连 bin 都没有
  writePkg(backupDir, '0.1.0', false) // 旧树：同样探测不出可运行版本
  const result = await dshUpdater.restoreSwap({ installDir, backupDir }, 'node')
  assert.equal(result.ok, false)
  assert.match(result.error, /不可用|探测失败/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')).version, '0.1.0',
    '改名本身仍要退回旧树，失败的是"它能跑"这个证明')
  assert.ok(fs.readdirSync(path.join(prefix, '.dshl-stage')).some((name) => name.startsWith('rejected-')),
    '换下来的新树要保留在 rejected-* 里供诊断')
})

test('cleanupStage：未完成事务记着的备份与暂存树必须保留', async (t) => {
  const prefix = tempDir(t)
  const stageRoot = path.join(prefix, '.dshl-stage')
  const installDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  const backupDir = path.join(stageRoot, 'old-0.2.0')
  const stagePkg = path.join(stageRoot, '0.3.0', 'node_modules', '@deepseek-ai', 'dsh')
  for (const dir of [backupDir, stagePkg, path.join(stageRoot, '0.4.0'), path.join(stageRoot, 'rejected-123')]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(path.join(stageRoot, 'junk.txt'), 'x')
  const statePath = path.join(prefix, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify({
    kind: 'global', phase: 'start', from: '0.1.0', to: '0.2.0',
    swap: true, installDir, backupDir, stagePkg,
  }))
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'latest' }, statePath, log: () => {}, notify: () => {} })

  const keep = dshUpdater.transactionKeepNames()
  assert.deepEqual(keep.sort(), ['0.3.0', 'old-0.2.0'])
  const removed = await dshUpdater.cleanupStage(stageRoot, '', keep)
  assert.deepEqual(removed.sort(), ['0.4.0', 'rejected-123'])
  assert.ok(fs.existsSync(backupDir), '待回滚的旧树不能被清掉')
  assert.ok(fs.existsSync(path.join(stageRoot, '0.3.0')), '预装树不能被清掉')
  assert.ok(fs.existsSync(path.join(stageRoot, 'junk.txt')), '不认识的条目一律不碰')
})

test('切换已完成但未经启动验证：旧树备份保留（留着当退路）', async (t) => {
  const prefix = tempDir(t)
  const stageRoot = path.join(prefix, '.dshl-stage')
  const installDir = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
  writePkg(installDir, '0.2.0', true)
  const backupDir = path.join(stageRoot, 'old-0.2.0')
  writePkg(backupDir, '0.1.0', true)
  fs.mkdirSync(path.join(stageRoot, '0.2.0'), { recursive: true })
  const statePath = path.join(prefix, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify({
    kind: 'global', phase: 'start', from: '0.1.0', to: '0.2.0', swap: true,
    installDir, backupDir, stagePkg: path.join(stageRoot, '0.2.0', 'node_modules', '@deepseek-ai', 'dsh'),
  }))
  const notes = []
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'latest' }, statePath, log: () => {}, notify: (...args) => notes.push(args) })
  const result = await dshUpdater.recoverInterruptedUpdate()
  assert.equal(result.mode, 'swap-done')
  assert.ok(fs.existsSync(backupDir), '新版本还没启动验证过，旧树备份不能被清理掉')
  assert.ok(!fs.existsSync(path.join(stageRoot, '0.2.0')), '预装树已无用，可以清理')
})

test('事务状态原子写：不留临时文件，内容可读', (t) => {
  const dir = tempDir(t)
  const statePath = path.join(dir, 'state.json')
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'latest' }, statePath, log: () => {}, notify: () => {} })
  assert.equal(dshUpdater.writeUpdateState({ kind: 'global', from: '0.1.0', to: '0.2.0', phase: 'start' }), true)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), [])
  assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).to, '0.2.0')
})

test('事务状态文件损坏：不当成"没有事务"删除，也不自动开工', async (t) => {
  const dir = tempDir(t)
  const statePath = path.join(dir, 'state.json')
  fs.writeFileSync(statePath, '{ not json')
  dshUpdater.initDshUpdater({ Config: { dshChannel: 'latest' }, statePath, log: () => {}, notify: () => {} })
  const result = await dshUpdater.recoverInterruptedUpdate()
  assert.equal(result.reason, 'no-pending')
  assert.ok(fs.existsSync(statePath), '损坏的事务文件必须留作取证')
  assert.equal(fs.readFileSync(statePath, 'utf8'), '{ not json')
})

// 2026-11-24 定位：检查更新/后台预装里的整树删除原来是 fs.rmSync —— 同步在 Electron 主线程上删
// 10 万+ 文件（实测一次 54 秒，日志 12:47:05 → 12:47:59），期间启动器窗口完全不响应（卡死）。
// 这两条把「必须异步」钉住：接口要返回 Promise，源码里不许再出现递归 rmSync。
test('cleanupStage 返回 Promise（整树删除不得同步阻塞主线程）', async (t) => {
  const prefix = tempDir(t)
  const stageRoot = path.join(prefix, '.dshl-stage')
  const tree = path.join(stageRoot, '0.4.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  fs.mkdirSync(tree, { recursive: true })
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(tree, 'f' + i + '.js'), 'x')
  const pending = dshUpdater.cleanupStage(stageRoot, '')
  assert.equal(typeof pending.then, 'function', '必须返回 Promise：同步删大目录会把窗口钉死')
  assert.deepEqual((await pending).sort(), ['0.4.0'])
  assert.ok(!fs.existsSync(path.join(stageRoot, '0.4.0')), 'Promise 结束时目录必须已经删掉')
})

test('更新路径里不再有递归 fs.rmSync（同步删整棵树 = 窗口卡死）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dsh-update.js'), 'utf8')
  const offenders = src.split('\n')
    .map((line, i) => line + '  // line ' + (i + 1))
    .filter((line) => /fs\.rmSync\(/.test(line) && /recursive/u.test(line))
  assert.deepEqual(offenders, [], '递归删除必须走 fs.promises.rm（异步）')
})
