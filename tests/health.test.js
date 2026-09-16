// tests/health.test.js — 健康快照/恢复测试（node --test）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const health = require('../health')

function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-health-'))
  const configPath = path.join(root, 'config.json')
  const snapshotDir = path.join(root, 'health-snapshots')
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } })
  return { root, configPath, snapshotDir }
}

function initH(t, cfg) {
  const env = makeEnv(t)
  fs.writeFileSync(env.configPath, JSON.stringify(cfg || { port: 3080, theme: 'light' }, null, 2))
  health.initHealth({ configPath: env.configPath, snapshotDir: env.snapshotDir, log: () => {} })
  return env
}

const meta = { dshlVersion: '1.1.6', dshKind: 'global', dshVersion: '0.1.0', nodeVersion: 'v22', port: 3080, reason: 'page-loaded' }

test('captureHealthy 写入快照并校验', (t) => {
  const env = initH(t)
  const r = health.captureHealthy(meta)
  assert.equal(r.status, 'captured')
  const slots = health.listSlots()
  const valid = slots.filter((s) => s.valid)
  assert.equal(valid.length, 1)
  assert.equal(valid[0].configSha, health.configHash())
})

test('三槽轮转：第 1 槽为最旧，满后覆盖最旧', (t) => {
  const env = initH(t)
  for (let i = 0; i < 4; i++) {
    fs.writeFileSync(env.configPath, JSON.stringify({ port: 3080 + i }, null, 2))
    health.captureHealthy({ ...meta, port: 3080 + i })
    // 同一次轮转内时间戳可能相同：用 meta 排序仍保证 slot-1 最旧（先写），第 4 次覆盖 slot-1
  }
  const slots = health.listSlots()
  const valid = slots.filter((s) => s.valid)
  assert.equal(valid.length, 3)
  // 第 4 次捕获应当覆盖最旧的 slot-1（config 应为 port=3083）
  const slot1 = slots.find((s) => s.slotId === 'slot-1')
  const cfg = JSON.parse(fs.readFileSync(path.join(env.snapshotDir, 'slot-1', 'config.json'), 'utf8'))
  assert.equal(cfg.port, 3083)
})

test('篡改快照 config → 槽无效（sha256 校验）', (t) => {
  const env = initH(t)
  health.captureHealthy(meta)
  const cfgFile = path.join(env.snapshotDir, 'slot-1', 'config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ port: 9999 }, null, 2))
  const slots = health.listSlots()
  assert.equal(slots.filter((s) => s.valid).length, 0)
  assert.equal(health.pickRestoreTarget(health.configHash()), null)
})

test('pickRestoreTarget 选最新差异槽；当前=最新快照时 null', (t) => {
  const env = initH(t)
  health.captureHealthy(meta) // 槽：port 3080
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 3999 }, null, 2))
  health.captureHealthy({ ...meta, port: 3999 }) // 槽：port 3999（最新）
  // 当前配置 == 最新快照（known-good）：无回退目标
  assert.equal(health.pickRestoreTarget(health.configHash()), null)
  // 用户改了配置（5000）但从未健康启动：回退到最新 known-good = slot-2（3999）
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 5000 }, null, 2))
  assert.equal(health.pickRestoreTarget(health.configHash()), 'slot-2')
  // excludeSlotId 排除后回退到更早的 slot-1
  assert.equal(health.pickRestoreTarget(health.configHash(), 'slot-2'), 'slot-1')
})

test('restore 备份 broken 配置 + 原子写回 + skip marker 生效', (t) => {
  const env = initH(t)
  health.captureHealthy(meta)
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 7777 }, null, 2))
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  const cfg = JSON.parse(fs.readFileSync(env.configPath, 'utf8'))
  assert.equal(cfg.port, 3080) // 恢复为快照值
  assert.ok(fs.existsSync(r.backupPath))
  const backup = JSON.parse(fs.readFileSync(r.backupPath, 'utf8'))
  assert.equal(backup.port, 7777)
  // skip marker 存在：下次健康启动只消费、不覆盖
  const r2 = health.captureHealthy({ ...meta, port: 3080 })
  assert.equal(r2.status, 'skipped')
  assert.equal(r2.restoredSlotId, 'slot-1')
  // 再下一次恢复捕获
  const r3 = health.captureHealthy({ ...meta, port: 3080 })
  assert.equal(r3.status, 'captured')
})

test('shouldRecover 决策表', () => {
  assert.equal(health.shouldRecover(5, true), true)
  assert.equal(health.shouldRecover(4, true), false)
  assert.equal(health.shouldRecover(5, false), false)
  assert.equal(health.shouldRecover(5, null), false)
})

test('无快照时恢复 no-op；restore 未知槽抛错', (t) => {
  const env = initH(t)
  assert.equal(health.pickRestoreTarget(health.configHash()), null)
  assert.equal(health.restore('slot-1').status, 'noop')
  assert.throws(() => health.restore('slot-9'))
})

// —— 回归：审计发现的三处缺陷 ——

test('备份保留：broken 备份超过 3 份时按时间删最旧（此前正则不匹配，永不清理）', (t) => {
  const env = initH(t)
  health.captureHealthy(meta)
  const dir = path.dirname(env.configPath)
  const base = path.basename(env.configPath)
  // 预置 6 份历史备份（时间戳递增）
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(dir, `${base}.broken-2026-01-0${i + 1}-00-00-00-aaaa000${i}.json`), `{"n":${i}}`)
  }
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 7777 }, null, 2))
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  const left = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.broken-`))
  assert.equal(left.length, 3, '只保留最近 3 份，实际 ' + left.length)
  // 保留的应是最新的三份（2026-01-04/05/06 与本次恢复各占一份）
  assert.ok(left.some((n) => n.includes('2026-01-06')), '最新备份必须保留')
  assert.ok(!left.some((n) => n.includes('2026-01-01')), '最旧备份必须删除')
})

test('skip marker 与配置内容绑定：恢复后又改配置 → 标记失效并正常捕获新快照', (t) => {
  const env = initH(t)
  health.captureHealthy(meta) // 快照 A（port 3080）
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 7777 }, null, 2))
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  // 用户改成另一份健康配置 Z
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 4321 }, null, 2))
  const r2 = health.captureHealthy({ ...meta, port: 4321 })
  assert.equal(r2.status, 'captured', '恢复后又改配置时不应再被 skip marker 吃掉')
  // Z 已入槽，且是最新 known-good
  const cfg = JSON.parse(fs.readFileSync(path.join(env.snapshotDir, r2.slotId, 'config.json'), 'utf8'))
  assert.equal(cfg.port, 4321)
})

test('孤儿槽恢复：按 mtime 取最新（此前按随机 UUID 排序会取到旧的）', (t) => {
  const env = initH(t)
  health.captureHealthy(meta)
  const slotDir = path.join(env.snapshotDir, 'slot-1')
  // 把有效槽改名成"旧的孤儿"，再手工造一个"新的孤儿"
  const oldOrphan = path.join(env.snapshotDir, 'slot-1.old-00000000-0000-0000-0000-000000000000')
  fs.renameSync(slotDir, oldOrphan)
  const newOrphan = path.join(env.snapshotDir, 'slot-1.old-ffffffff-ffff-ffff-ffff-ffffffffffff')
  fs.mkdirSync(newOrphan, { recursive: true })
  const cfg = JSON.parse(fs.readFileSync(path.join(oldOrphan, 'config.json'), 'utf8'))
  fs.writeFileSync(path.join(newOrphan, 'config.json'), JSON.stringify({ ...cfg, port: 2222 }, null, 2))
  // 复制 meta 并同步 sha256/size（让新孤儿成为一个有效槽）
  const metaRaw = JSON.parse(fs.readFileSync(path.join(oldOrphan, 'meta.json'), 'utf8'))
  const bytes = fs.readFileSync(path.join(newOrphan, 'config.json'))
  metaRaw.sha256 = health.sha256(bytes)
  metaRaw.size = bytes.byteLength
  fs.writeFileSync(path.join(newOrphan, 'meta.json'), JSON.stringify(metaRaw, null, 2))
  // 让新孤儿的 mtime 明确晚于旧的
  const past = new Date(Date.now() - 60 * 1000)
  fs.utimesSync(oldOrphan, past, past)
  const slots = health.listSlots()
  const restored = slots.find((s) => s.slotId === 'slot-1')
  assert.ok(restored && restored.valid, 'slot-1 应从孤儿恢复为有效槽')
  const got = JSON.parse(fs.readFileSync(path.join(env.snapshotDir, 'slot-1', 'config.json'), 'utf8'))
  assert.equal(got.port, 2222, '应恢复 mtime 最新的孤儿（2222），而不是随机名排序后的旧槽')
})

// —— extraFiles：把 ~/.dsh 侧的声明式状态也纳入快照与回退 ——
//
// 背景（实测）：崩溃循环里坏掉的是 settings.yaml / cordis.patch.yml / profile package.json，
// 而主配置 config.json 从头到尾没变过 —— 只快照主配置时 pickRestoreTarget 永远返回 null。

function initHExtras(t, extras, cfg) {
  const env = makeEnv(t)
  fs.writeFileSync(env.configPath, JSON.stringify(cfg || { port: 3080, theme: 'light' }, null, 2))
  health.initHealth({ configPath: env.configPath, snapshotDir: env.snapshotDir, extraFiles: extras, log: () => {} })
  return env
}

test('extraFiles：extra 内容进快照，恢复时写回并留下 broken 备份', (t) => {
  const settings = path.join(os.tmpdir(), `dshl-extra-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`)
  t.after(() => { try { fs.unlinkSync(settings) } catch { /* noop */ } })
  const env = initHExtras(t, [{ id: 'settings', path: settings }])
  fs.writeFileSync(settings, 'theme: dark\n')
  health.captureHealthy(meta)
  // 坏掉：缩进写坏 / 内容被改
  fs.writeFileSync(settings, 'theme: dark\n  bad: indent\n')
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  assert.equal(fs.readFileSync(settings, 'utf8'), 'theme: dark\n', 'extra 应被写回快照内容')
  const one = r.extras.find((e) => e.id === 'settings')
  assert.equal(one.status, 'restored')
  assert.ok(one.backupPath && fs.existsSync(one.backupPath), '原内容必须留备份')
  assert.match(fs.readFileSync(one.backupPath, 'utf8'), /bad: indent/u)
})

test('extraFiles：只有 extra 变化（主配置未变）时也必须选得出回退目标', (t) => {
  const settings = path.join(os.tmpdir(), `dshl-extra2-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`)
  t.after(() => { try { fs.unlinkSync(settings) } catch { /* noop */ } })
  const env = initHExtras(t, [{ id: 'settings', path: settings }])
  fs.writeFileSync(settings, 'a: 1\n')
  health.captureHealthy(meta)
  // 主配置一字未动，只把 settings 改坏 —— 这正是实测里最常见的形态
  fs.writeFileSync(settings, 'a: 1\n  broken\n')
  assert.equal(health.configHash(), health.listSlots().find((s) => s.valid).configSha, '前提：主配置确实没变')
  assert.equal(health.pickRestoreTarget(health.configHash()), 'slot-1', '只看主配置会误判成 known-good，必须能选出目标')
  assert.deepEqual(health.extraDriftOfSlot('slot-1'), ['settings'])
})

test('extraFiles：校验不通过的文件被跳过并说明原因，主配置照常恢复', (t) => {
  const pkg = path.join(os.tmpdir(), `dshl-extra3-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => { try { fs.unlinkSync(pkg) } catch { /* noop */ } })
  const env = initHExtras(t, [{
    id: 'profile-package',
    path: pkg,
    validate: () => ({ ok: false, reason: '快照声明的插件当前未安装' }),
  }])
  fs.writeFileSync(pkg, '{"v":1}')
  health.captureHealthy(meta)
  fs.writeFileSync(pkg, '{"v":2}')
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 7777 }, null, 2))
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  const one = r.extras.find((e) => e.id === 'profile-package')
  assert.equal(one.status, 'skipped')
  assert.match(one.reason, /当前未安装/u)
  assert.equal(fs.readFileSync(pkg, 'utf8'), '{"v":2}', '被跳过的文件绝不能被动过')
  assert.equal(JSON.parse(fs.readFileSync(env.configPath, 'utf8')).port, 3080, '主配置仍然恢复')
})

test('extraFiles：校验函数抛错也按"跳过"处理（fail-closed，不炸掉整次恢复）', (t) => {
  const f = path.join(os.tmpdir(), `dshl-extra4-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => { try { fs.unlinkSync(f) } catch { /* noop */ } })
  const env = initHExtras(t, [{ id: 'x', path: f, validate: () => { throw new Error('boom') } }])
  fs.writeFileSync(f, 'one')
  health.captureHealthy(meta)
  fs.writeFileSync(f, 'two')
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 7777 }, null, 2))
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  assert.equal(r.extras.find((e) => e.id === 'x').status, 'skipped')
  assert.equal(fs.readFileSync(f, 'utf8'), 'two')
})

test('extraFiles：快照当时不存在的文件，恢复时不得被创建', (t) => {
  const f = path.join(os.tmpdir(), `dshl-extra5-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => { try { fs.unlinkSync(f) } catch { /* noop */ } })
  const env = initHExtras(t, [{ id: 'later', path: f }])
  health.captureHealthy(meta) // 此刻文件不存在
  fs.writeFileSync(f, 'user-created')
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 7777 }, null, 2))
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  assert.equal(fs.readFileSync(f, 'utf8'), 'user-created', '快照里没有的东西不许凭空造出来')
  assert.equal(r.extras.some((e) => e.id === 'later'), false)
})

test('extraFiles：快照里的 extra 被篡改 → 跳过它，其余照常恢复', (t) => {
  const a = path.join(os.tmpdir(), `dshl-extra6a-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const b = path.join(os.tmpdir(), `dshl-extra6b-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => { try { fs.unlinkSync(a); fs.unlinkSync(b) } catch { /* noop */ } })
  const env = initHExtras(t, [{ id: 'a', path: a }, { id: 'b', path: b }])
  fs.writeFileSync(a, 'A1')
  fs.writeFileSync(b, 'B1')
  health.captureHealthy(meta)
  fs.writeFileSync(path.join(env.snapshotDir, 'slot-1', 'files', 'a'), 'TAMPERED')
  fs.writeFileSync(a, 'A2')
  fs.writeFileSync(b, 'B2')
  fs.writeFileSync(env.configPath, JSON.stringify({ port: 7777 }, null, 2))
  const r = health.restore(health.pickRestoreTarget(health.configHash()))
  assert.equal(r.status, 'restored')
  assert.equal(r.extras.find((e) => e.id === 'a').status, 'skipped')
  assert.match(r.extras.find((e) => e.id === 'a').reason, /损坏/u)
  assert.equal(fs.readFileSync(a, 'utf8'), 'A2', '被篡改的那份不能拿来覆盖用户文件')
  assert.equal(r.extras.find((e) => e.id === 'b').status, 'restored')
  assert.equal(fs.readFileSync(b, 'utf8'), 'B1')
})

test('extraFiles：未声明任何 extra 时行为与旧版一致（不生成 files 目录、不误判漂移）', (t) => {
  const env = initH(t)
  health.captureHealthy(meta)
  assert.equal(fs.existsSync(path.join(env.snapshotDir, 'slot-1', 'files')), false)
  assert.deepEqual(health.extraDriftOfSlot('slot-1'), [])
  const metaRaw = JSON.parse(fs.readFileSync(path.join(env.snapshotDir, 'slot-1', 'meta.json'), 'utf8'))
  assert.deepEqual(metaRaw.extras, [], '旧槽语义：extras 为空数组')
})

test('extraFiles：形状不合法的声明被忽略（id 不能当文件名用的直接丢掉）', (t) => {
  const env = makeEnv(t)
  fs.writeFileSync(env.configPath, '{}')
  health.initHealth({
    configPath: env.configPath,
    snapshotDir: env.snapshotDir,
    extraFiles: [{ id: '../../evil', path: 'x' }, { id: '', path: 'y' }, { id: 'ok', path: '' }, null, 'nope'],
    log: () => {},
  })
  health.captureHealthy(meta)
  const metaRaw = JSON.parse(fs.readFileSync(path.join(env.snapshotDir, 'slot-1', 'meta.json'), 'utf8'))
  assert.deepEqual(metaRaw.extras, [])
})
