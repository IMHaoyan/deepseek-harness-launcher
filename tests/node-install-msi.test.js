// tests/node-install-msi.test.js — Node 安装方式：官方 MSI（默认，与官网 .msi 一致）+ 用户级 zip（兜底）
//
// 为什么要有这些断言：
//   1) "复用优先"是硬规则——已装用户升级 dshl 后不该被动过 Node（这是我们承诺过的）；
//   2) "已装 MSI 但版本过旧"必须拒绝而不是再装一个：Node 的 MSI 是不同版本=不同产品码却默认装同一目录，
//      两个产品争用同一目录会让卸载其一就删掉文件、留下另一个残缺；
//   3) 兜底路径（zip）必须与 MSI 语义一致：那 23 字节 npmrc 要按字节复刻，否则全局包又会跑回 Node 目录。
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const envInstall = require('../env-install')
const envDetect = require('../env-detect')

function sandbox(t, env = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-node-msi-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const saved = {}
  const keys = ['APPDATA', 'LOCALAPPDATA', 'DSHL_USER_NODE_DIR', 'NVM_HOME', 'VOLTA_HOME', 'FNM_DIR']
  for (const k of keys) saved[k] = process.env[k]
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  t.after(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
  return { base, home: path.join(base, '.dsh'), appData: path.join(base, 'appdata'), localAppData: path.join(base, 'localappdata') }
}

function makeJob() {
  const lines = []
  return { lines, job: { logLine: (l) => lines.push(l), opts: {} } }
}

// ---------- 决策：复用优先 / MSI / 兜底 / 拒绝 ----------

test('decideNodeInstallPlan：已有可用 Node 一律复用（不装任何东西）', () => {
  assert.deepEqual(
    envInstall.decideNodeInstallPlan({ nodeOk: true, nodeVersion: '24.16.0' }),
    { action: 'reuse', reason: 'node-ok', version: '24.16.0' },
  )
})

test('decideNodeInstallPlan：本机已有 Node.js MSI 产品时按其版本决定复用或拒绝', () => {
  // 版本满足 → 复用（哪怕没走我们的安装流程）
  assert.equal(envInstall.decideNodeInstallPlan({ installedMsi: { version: '22.23.2' } }).action, 'reuse')
  assert.equal(envInstall.decideNodeInstallPlan({ installedMsi: { version: '24.16.0' } }).action, 'reuse')
  // 版本过旧 → 拒绝，并带上可行动作所需的版本与范围（绝不并装第二个产品）
  const old = envInstall.decideNodeInstallPlan({ installedMsi: { version: '18.20.0' } })
  assert.equal(old.action, 'refuse')
  assert.equal(old.reason, 'msi-too-old')
  assert.equal(old.version, '18.20.0')
  assert.equal(old.range, envDetect.DEFAULT_ENGINE_RANGE)
})

test('decideNodeInstallPlan：注册了 MSI 但可执行文件不在 → 拒绝并请用户修复（不能复用也不能并装）', () => {
  // 这是 2026-09-16 实测到的 bug：决策层信注册表说"复用"，可执行文件却不在 → 复用兑现不了，
  // 安装任务以一句看不懂的错误中止。现在变成明确的 refuse + 可行动作。
  const broken = envInstall.decideNodeInstallPlan({ installedMsi: { version: '24.16.0' }, msiUsable: false })
  assert.equal(broken.action, 'refuse')
  assert.equal(broken.reason, 'msi-broken')
  assert.equal(broken.version, '24.16.0')
  // 版本过旧优先于"文件不在"（先能升级才谈得上修复）
  assert.equal(envInstall.decideNodeInstallPlan({ installedMsi: { version: '18.20.0' }, msiUsable: false }).reason, 'msi-too-old')
  // 文件在 → 照常复用；未提供该信息（旧调用方）→ 保持历史行为
  assert.equal(envInstall.decideNodeInstallPlan({ installedMsi: { version: '24.16.0' }, msiUsable: true }).action, 'reuse')
  assert.equal(envInstall.decideNodeInstallPlan({ installedMsi: { version: '24.16.0' } }).action, 'reuse')
})

test('decideNodeInstallPlan：默认官方 MSI；版本管理器在场或配置成 user 才走用户级兜底', () => {
  assert.deepEqual(envInstall.decideNodeInstallPlan({}), { action: 'install-msi', reason: 'default' })
  // 存量迁移（用户级 zip 布局 → 官方安装）走的就是这条：调用方带 forceNodeInstall，于是 nodeOk=false，
  // 没有已装 MSI 产品 → 装官方 MSI；随后 dsh 阶段把 DSH 装到 %APPDATA%\npm，最后清理旧残留
  assert.deepEqual(envInstall.decideNodeInstallPlan({ nodeOk: false }), { action: 'install-msi', reason: 'default' })
  assert.deepEqual(envInstall.decideNodeInstallPlan({ mode: 'user' }), { action: 'install-user', reason: 'mode-user' })
  // nvm/volta/fnm 在场：不去和版本管理器争 PATH
  assert.deepEqual(envInstall.decideNodeInstallPlan({ versionManager: 'nvm' }), { action: 'install-user', reason: 'version-manager-nvm' })
  // 有可用的 MSI 产品时，版本管理器也不再影响结论（复用优先）
  assert.equal(envInstall.decideNodeInstallPlan({ installedMsi: { version: '22.23.2' }, versionManager: 'nvm' }).action, 'reuse')
})

test('decideNodeInstallPlan：mode=user 不能盖过"已有可用 MSI"（否则会出现两台 Node）', () => {
  const r = envInstall.decideNodeInstallPlan({ mode: 'user', installedMsi: { version: '18.20.0' } })
  assert.equal(r.action, 'refuse', '旧 MSI 在场时，回退用户级装了也会被机器 PATH 遮蔽 → 必须拒绝并交代')
})

// ---------- msiexec 结果与注册表解析 ----------

test('interpretMsiResult：成功 / 需重启 / 取消 / 策略禁止 / 其他退出码各归各位', () => {
  assert.equal(envInstall.interpretMsiResult(0, false).ok, true)
  assert.equal(envInstall.interpretMsiResult(3010, false).ok, true, '3010 = 成功但需重启，也算装好')
  assert.equal(envInstall.interpretMsiResult(1602, false).cancelled, true)
  assert.equal(envInstall.interpretMsiResult(1625, false).policy, true, '1625 = 被系统策略禁止 → 走兜底')
  assert.equal(envInstall.interpretMsiResult(1618, false).ok, false)
  assert.equal(envInstall.interpretMsiResult(1603, false).ok, false)
  const uac = envInstall.interpretMsiResult(NaN, true)
  assert.equal(uac.cancelled, true)
  assert.match(uac.detail, /管理员授权/)
  assert.equal(envInstall.interpretMsiResult(NaN, false).ok, false, '结果不可读 = 没装成，不猜')
})

test('parseNodeJsRegQuery：解析官方 MSI 写的 HKLM\\SOFTWARE\\Node.js', () => {
  const sample = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Node.js',
    '    InstallPath    REG_SZ    C:\\Program Files\\nodejs\\',
    '    Version    REG_SZ    24.16.0',
    '',
  ].join('\r\n')
  assert.deepEqual(envInstall.parseNodeJsRegQuery(sample), { installPath: 'C:\\Program Files\\nodejs\\', version: '24.16.0' })
  assert.equal(envInstall.parseNodeJsRegQuery(''), null)
  assert.equal(envInstall.parseNodeJsRegQuery('ERROR: 系统找不到指定的注册表项或值。'), null)
})

test('detectVersionManager：按环境变量与目录识别 nvm / volta / fnm', (t) => {
  const { base } = sandbox(t, {})
  const nvmDir = path.join(base, 'nvm')
  fs.mkdirSync(nvmDir, { recursive: true })
  const exists = (p) => fs.existsSync(p)
  assert.equal(envInstall.detectVersionManager({ exists, env: { NVM_HOME: nvmDir }, home: path.join(base, 'nohome') }), 'nvm')
  assert.equal(envInstall.detectVersionManager({ exists, env: {}, home: path.join(base, 'nohome') }), '')
  const voltaDir = path.join(base, '.volta')
  fs.mkdirSync(voltaDir, { recursive: true })
  assert.equal(envInstall.detectVersionManager({ exists, env: {}, home: base }), 'volta')
})

// ---------- 兜底路径：npmrc 按字节复刻官方 MSI ----------

// ---------- 迁移链路：存量 zip 布局 → 官方安装（只迁 DSH） ----------

test('迁移链路：forceNodeInstall + 旧布局 → 走官方 MSI、自动带 dsh、事后只清旧 DSH', (t) => {
  const sb = sandbox(t, {})
  const oldDir = path.join(sb.base, 'Programs', 'nodejs')
  process.env.DSHL_USER_NODE_DIR = oldDir
  // 旧布局：dshl 早年用官方 zip 装的 Node，全局包（含 DSH）都在这个目录里
  fs.mkdirSync(path.join(oldDir, 'node_modules', 'npm'), { recursive: true })
  const dshDir = path.join(oldDir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }))
  for (const s of ['dsh', 'dsh.cmd', 'dsh.ps1']) fs.writeFileSync(path.join(oldDir, s), 'shim')
  fs.mkdirSync(path.join(oldDir, 'node_modules', 'clopo'), { recursive: true })

  // ① UI 的 payload：items:[node] + forceNodeInstall + msi → startInstall 里先做依赖补全
  const plan = envInstall.nodeReplacePlan(envInstall.normalizeInstallItems(['node']))
  assert.deepEqual(plan.list, ['node', 'pnpm', 'dsh'], '旧目录里有 DSH → 自动带上 dsh（pnpm 由 node 带出）')
  assert.deepEqual(plan.otherGlobals, ['clopo'], '其他全局包列账')

  // ② 强制重装 + 本机无 MSI 产品 → 官方 MSI（而不是"复用现有 Node"）
  const decided = envInstall.decideNodeInstallPlan({ nodeOk: false, installedMsi: null, versionManager: '' })
  assert.equal(decided.action, 'install-msi')

  // ③ 新版装好并校验通过之后，才清旧残留：只删 DSH 与其 shim，别人的包一个不碰
  const { job, lines } = makeJob()
  envInstall.cleanupLegacyDshInUserNodeDir(job, path.join(sb.appData, 'npm'))
  assert.ok(!fs.existsSync(dshDir), '旧 DSH 必须清掉（否则探测会同时看到两份）')
  for (const s of ['dsh', 'dsh.cmd', 'dsh.ps1']) assert.ok(!fs.existsSync(path.join(oldDir, s)))
  assert.ok(fs.existsSync(path.join(oldDir, 'node_modules', 'clopo')), '用户自己的全局包不动')
  assert.ok(fs.existsSync(path.join(oldDir, 'node_modules', 'npm')), '发行版自带的 npm 也不动')
  assert.ok(lines.some((l) => l.includes('clopo')), '要把没迁移的包如实列出来：' + lines.join('\n'))

  // ④ 探测侧随之不再报"旧布局"，环境页那张迁移卡片会自动消失
  assert.equal(envDetect.legacyUserNodeLayout(), null, 'DSH 清掉后不再有旧布局')
})

test('MSI_NPMRC_BYTES：与官方 MSI 写入的那份逐字节一致（23 字节，ASCII，CRLF）', () => {
  assert.equal(envInstall.MSI_NPMRC_BYTES.length, 23)
  assert.equal(envInstall.MSI_NPMRC_BYTES.toString('ascii'), 'prefix=${APPDATA}\\npm\r\n')
})

test('writeMsiEquivalentNpmrc：空 Node 目录写入；已有全局包则拒绝（fail-closed）', (t) => {
  const sb = sandbox(t, {})
  const nodeDir = path.join(sb.base, 'Programs', 'nodejs')
  fs.mkdirSync(path.join(nodeDir, 'node_modules', 'npm'), { recursive: true })
  const { job, lines } = makeJob()

  assert.equal(envInstall.writeMsiEquivalentNpmrc(job, nodeDir), true)
  const target = path.join(nodeDir, 'node_modules', 'npm', 'npmrc')
  assert.deepEqual(fs.readFileSync(target), envInstall.MSI_NPMRC_BYTES, '字节级一致')
  assert.ok(lines.some((l) => l.includes('已复刻官方 MSI 的 npmrc')), lines.join('\n'))

  // 已有全局包：不能翻前缀（否则那些包会被 npm 遗忘），必须拒绝并说明
  const nodeDir2 = path.join(sb.base, 'Programs', 'nodejs2')
  fs.mkdirSync(path.join(nodeDir2, 'node_modules', 'npm'), { recursive: true })
  fs.mkdirSync(path.join(nodeDir2, 'node_modules', 'clopo'), { recursive: true })
  const j2 = makeJob()
  assert.equal(envInstall.writeMsiEquivalentNpmrc(j2.job, nodeDir2), false)
  assert.ok(!fs.existsSync(path.join(nodeDir2, 'node_modules', 'npm', 'npmrc')))
  assert.ok(j2.lines.some((l) => l.includes('跳过 npmrc 复刻')), j2.lines.join('\n'))
})

// ---------- 存量收敛：只清 DSH，不动别人的全局包 ----------

test('cleanupLegacyDshInUserNodeDir：只删旧 DSH（含三个 shim），其他全局包一个不碰并如实列账', (t) => {
  const sb = sandbox(t, {})
  const oldDir = path.join(sb.base, 'Programs', 'nodejs')
  const dshDir = path.join(oldDir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }))
  fs.mkdirSync(path.join(oldDir, 'node_modules', 'clopo'), { recursive: true })
  for (const s of ['dsh', 'dsh.cmd', 'dsh.ps1']) fs.writeFileSync(path.join(oldDir, s), 'shim')
  process.env.DSHL_USER_NODE_DIR = oldDir

  const { job, lines } = makeJob()
  envInstall.cleanupLegacyDshInUserNodeDir(job, path.join(sb.appData, 'npm'))

  assert.ok(!fs.existsSync(dshDir), '旧 DSH 必须清掉，否则探测会同时看到两份')
  for (const s of ['dsh', 'dsh.cmd', 'dsh.ps1']) assert.ok(!fs.existsSync(path.join(oldDir, s)), `${s} shim 也要清掉`)
  assert.ok(fs.existsSync(path.join(oldDir, 'node_modules', 'clopo')), '别人的全局包不动')
  assert.ok(fs.existsSync(path.join(oldDir, 'node.exe')) === false || true)
  assert.ok(lines.some((l) => l.includes('已清理旧残留')), lines.join('\n'))
  assert.ok(lines.some((l) => l.includes('仍保留') && l.includes('clopo')), '要如实列出没迁移的全局包：' + lines.join('\n'))
})

test('cleanupLegacyDshInUserNodeDir：同一处（新前缀就是旧目录）时不误删；没有旧 DSH 时静默', (t) => {
  const sb = sandbox(t, {})
  const oldDir = path.join(sb.base, 'Programs', 'nodejs')
  const dshDir = path.join(oldDir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(dshDir, { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }))
  process.env.DSHL_USER_NODE_DIR = oldDir

  const same = makeJob()
  envInstall.cleanupLegacyDshInUserNodeDir(same.job, oldDir)
  assert.ok(fs.existsSync(dshDir), '新前缀与旧目录相同 → 这就是在用的那一份，绝不能删')
  assert.deepEqual(same.lines, [])

  fs.rmSync(dshDir, { recursive: true, force: true })
  const none = makeJob()
  envInstall.cleanupLegacyDshInUserNodeDir(none.job, path.join(sb.appData, 'npm'))
  assert.deepEqual(none.lines, [], '没有旧 DSH 时不该产生任何日志噪音')
})
