// tests/hardening-wiring.test.js — 已确认问题的回归锁（原子写、信任边界、写锁、半装状态）
//
// 每一条都对应一次对抗性验证过的事实，不锁"实现长什么样"，只锁"这类错误不再回来"。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')

function sliceFunction(source, signature, tail = '\n}\n') {
  const start = source.indexOf(signature)
  assert.ok(start > 0, '找不到 ' + signature)
  const end = source.indexOf(tail, start) + tail.length
  return source.slice(start, end)
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-hardening-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('saveConfig：原子写（临时文件 + rename），不再直接截断 CONFIG_PATH', () => {
  const cfg = sliceFunction(main, 'function saveConfig() {')
  assert.match(cfg, /writeFileAtomicSync\(CONFIG_PATH/)
  assert.doesNotMatch(cfg, /writeFileSync\(CONFIG_PATH/)
  const atomic = sliceFunction(main, 'function writeFileAtomicSync(')
  assert.match(atomic, /\.tmp-/)
  assert.match(atomic, /fs\.renameSync\(temp, file\)/)
})

test('writeFileAtomicSync：落盘内容正确，不留临时文件', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'config.json')
  const atomic = new Function('fs', 'path', sliceFunction(main, 'function writeFileAtomicSync(') + '\nreturn writeFileAtomicSync')(fs, path)
  fs.writeFileSync(file, '{"before":true}')
  assert.equal(atomic(file, '{"after":true}'), undefined)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"after":true}')
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), [])
})

test('loadConfig：JSON 损坏时留备份、重建可用默认配置、并通知用户', (t) => {
  const dir = tempDir(t)
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, '{ broken json')
  const notes = []
  const atomic = sliceFunction(main, 'function writeFileAtomicSync(')
  const load = sliceFunction(main, 'function loadConfig() {')
  const run = new Function('fs', 'path', 'CONFIG_PATH', 'Config', 'notify', 'SELF_TEST', 'applyConfigJson', 'saveConfig', 'configMigrationPending', 'log', 'firstRun',
    atomic + '\n' + load + '\nreturn loadConfig')
  run(fs, path, configPath, {}, (...args) => notes.push(args), false, () => {}, () => true, false, () => {}, false)()
  assert.equal(notes.length, 1, '损坏要让用户知道，不能静默回默认值')
  assert.match(notes[0][1], /配置文件损坏/)
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('config.json.corrupt-')), '必须留一份损坏文件备份')
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(configPath, 'utf8')), '重建出来的配置必须可用')
})

test('IPC 信任：控制台/窗口壳只有停留本机 wwwroot 页面时才算自己人', () => {
  assert.match(main, /function isLocalWwwrootUrl\(url\)/)
  assert.match(main, /return \{ kind: isLocalWwwrootUrl\(url\) \? 'console' : 'none', url \}/)
  assert.match(main, /return \{ kind: isLocalWwwrootUrl\(url\) \? 'shell' : 'none', url \}/)
  assert.match(main, /guardChromeNavigation\(wc, 'console'\)/, '控制台要挂导航守卫')
  assert.match(main, /guardChromeNavigation\(webWin\.webContents, 'shell'\)/, '窗口壳要挂导航守卫')
  assert.match(main, /wc\.on\('will-navigate', check\)/)
  assert.match(main, /wc\.on\('will-redirect', check\)/)
})

test('网页权限：默认拒绝摄像头/麦克风等，只放行明确需要的几项', () => {
  assert.match(main, /const ALLOWED_PERMISSIONS = new Set\(\[[^\]]*'notifications'/)
  assert.match(main, /setPermissionRequestHandler\(/)
  assert.match(main, /setPermissionCheckHandler\(/)
  assert.match(main, /installPermissionPolicy\(\)\s*\n/)
  const init = main.slice(main.indexOf('function init() {'), main.indexOf('function init() {') + 4000)
  assert.match(init, /installPermissionPolicy\(\)/, '启动时必须装上权限策略')
})

test('文件打开桥：只认真实用户手势（isTrusted），合成事件一律放行给原页面', () => {
  const preload = fs.readFileSync(path.join(root, 'browser-preload.js'), 'utf8')
  assert.match(preload, /if \(event\.isTrusted !== true\) return false/)
})

test('插件卸载：先记「用户不要了」再清补丁层，清理失败不影响回执', () => {
  const start = main.indexOf("if (action === 'uninstall') {")
  assert.ok(start > 0)
  const block = main.slice(start, main.indexOf("\n  }\n", start))
  const declinedAt = block.indexOf('notePluginAutoDeclined(descriptor.id, true)')
  const rowsAt = block.indexOf('pluginSwitch.removeRows(descriptor.npm, beforeRows, beforeCarriers)')
  assert.ok(declinedAt > 0 && rowsAt > declinedAt, 'declined 必须先落盘：否则清理失败后下次启动会装回来')
  assert.match(block, /cleaned && cleaned\.ok === false/, '补丁层清理失败只记日志，不改卸载回执')
})

test('启动前 profile 写入：拿不到写锁就跳过，绝不与插件操作并发', () => {
  assert.match(main, /tryBeginProfileOp\('启动前 profile 写入', \{ skipSnapshot: true \}\)/)
  assert.match(main, /启动前 profile 写入跳过：另一个插件操作正在改写 profile/)
  const cases = main.match(/if \(profileOpBusy\(\)\) return JSON\.stringify\(profileBusyError\(\)\)/g) || []
  assert.ok(cases.length >= 3, 'start / restartDsh / browser:restartDsh 都要拒绝并发（实际 ' + cases.length + ' 处）')
})

test('插件安装半装状态：失败分支回读 profile，给出"依赖已装但未激活"的说明', () => {
  const market = fs.readFileSync(path.join(root, 'market.js'), 'utf8')
  assert.match(market, /partial = after\.installed && !after\.bundle/)
  assert.match(market, /依赖已写入 profile 但 bundle 未激活/)
  assert.match(market, /partial \}/)
})

test('自动重启自己失败：按额度重试或显式停止，不停在僵尸态', () => {
  assert.match(main, /if \(restartAttemptsInWindow\(\) >= RESTART_MAX\) haltAutoRestart\(\)/)
  assert.match(main, /else scheduleRestartRetry\(5000, 'auto-restart failed'\)/)
})
