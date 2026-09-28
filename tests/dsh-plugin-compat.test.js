// tests/dsh-plugin-compat.test.js — 升级前的只读兼容性预判：
//   判定规则要与 DSH 一致（否则"预判兼容、升级后被拒"）、三类来源都要扫（漏一类就漏报）、
//   拿不准必须进 unknown（fail-closed）。用例数据取自 2026-09-28 那次真实升级。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const compat = require('../dsh-plugin-compat')

const TARGET = '0.2.0-rc.1'

test('isDshPeer：只认 @deepseek-ai/dsh 与 @deepseek-ai/dsh-*', () => {
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-experimental-agent-team']) {
    assert.equal(compat.isDshPeer(name), true, name + ' 属于 dsh 命名空间')
  }
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'react', '@deepseek-ai/dshl-x', '']) {
    assert.equal(compat.isDshPeer(name), false, name + ' 不属于 dsh 命名空间')
  }
})

test('evaluateManifestPeers：0.x 的 caret 不跨 minor —— dsh-rewind-plugin 的真实声明', () => {
  const rewind = { peerDependencies: { '@deepseek-ai/dsh-fs': '^0.1.7-rc.2', '@deepseek-ai/dsh-tools': '^0.1.7-rc.2' } }
  const bad = compat.evaluateManifestPeers(rewind, TARGET)
  assert.equal(bad.compatible, false, '^0.1.7-rc.2 落在 0.2.0-rc.1 之外')
  assert.deepEqual(bad.peers.map((p) => p.name), ['@deepseek-ai/dsh-fs', '@deepseek-ai/dsh-tools'])
  assert.equal(compat.evaluateManifestPeers(rewind, '0.1.7-rc.2').compatible, true, '同一份声明在 0.1.7-rc.2 下是兼容的')
})

test('evaluateManifestPeers：预发布参与比较 —— >=0.1.7-0 <0.2.0 接受 0.2.0-rc.1', () => {
  // dsh-mcp-panel 用的就是这种上界写法，实测在 0.2.0-rc.1 下通过门禁
  const panel = { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.7-0 <0.2.0' } }
  assert.equal(compat.evaluateManifestPeers(panel, TARGET).compatible, true)
})

test('evaluateManifestPeers：精确版本与通配', () => {
  const exactOk = { peerDependencies: { '@deepseek-ai/dsh-brand': '0.2.0-rc.1' } }
  const exactBad = { peerDependencies: { '@deepseek-ai/dsh-brand': '0.1.6-alpha.2' } }
  const star = { peerDependencies: { '@deepseek-ai/dsh-tools': '*' } }
  const pin = { peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2' } }
  assert.equal(compat.evaluateManifestPeers(exactOk, TARGET).compatible, true)
  assert.equal(compat.evaluateManifestPeers(exactBad, TARGET).compatible, false)
  assert.equal(compat.evaluateManifestPeers(star, TARGET).compatible, true)
  assert.equal(compat.evaluateManifestPeers(pin, TARGET).compatible, false, 'dshmarket 的真实声明在 0.2.0-rc.1 下不满足')
})

test('evaluateManifestPeers：workspace 协议跟随运行时；非 dsh peer 不参与；没有 peer 段视为兼容', () => {
  assert.equal(compat.evaluateManifestPeers({ peerDependencies: { '@deepseek-ai/dsh-tools': 'workspace:^' } }, TARGET).compatible, true)
  assert.equal(compat.evaluateManifestPeers({ peerDependencies: { react: '^18.2.0' } }, TARGET).compatible, true)
  assert.equal(compat.evaluateManifestPeers({}, TARGET).compatible, true)
  assert.equal(compat.evaluateManifestPeers(undefined, TARGET).compatible, true)
})

test('collectTargets：三类来源合并去重，补丁里只认合法包名', () => {
  const patchText = [
    '- insert:',
    '    - id: panel-mcp-rider',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: rider',
    '- id: ui-sidebar',
    '  disabled: false',
  ].join('\n')
  const targets = compat.collectTargets({
    dependencies: { dshmarket: '1.66.3', '@deepseek-ai/dsh-mcp-client': '0.2.0-rc.1' },
    bundles: ['@deepseek-ai/dsh-base', 'dshmarket'],
    patchText,
  })
  const byName = Object.fromEntries(targets.map((t) => [t.name, t.sources]))
  assert.deepEqual(byName['dshmarket'], ['dep', 'bundle'], '同一包出现在两处要合并来源')
  assert.deepEqual(byName['@deepseek-ai/dsh-mcp-client'], ['dep', 'patch'])
  assert.ok(byName['@deepseek-ai/dsh-base'], 'bundle 也算目标')
  assert.equal(byName.rider, undefined, 'serverName 不是包名，不能被当成目标')
  assert.equal(byName['ui-sidebar'], undefined, '纯 id 行不带 name，不产生目标')
})

test('judgeTargets：内置 bundle（解析自安装树）跳过；权威来源解析不到才进 unknown', () => {
  const targets = [
    { name: '@deepseek-ai/dsh-base', sources: ['bundle'] },
    { name: 'dsh-rewind-plugin', sources: ['dep', 'bundle'] },
    { name: 'dsh-not-installed', sources: ['dep'] },
  ]
  const readManifest = (name) => {
    if (name === '@deepseek-ai/dsh-base') return { from: 'install', manifest: { version: '0.1.7-rc.2', peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.7-rc.2' } } }
    if (name === 'dsh-rewind-plugin') return { from: 'profile', manifest: { version: '0.14.0', peerDependencies: { '@deepseek-ai/dsh-fs': '^0.1.7-rc.2' } } }
    return undefined
  }
  const r = compat.judgeTargets({ targets, targetVersion: TARGET, readManifest })
  assert.deepEqual(r.skippedInBox, ['@deepseek-ai/dsh-base'], '内置 bundle 随 dsh 一起换，不能拿旧副本判它失效')
  assert.deepEqual(r.incompatible.map((x) => x.name), ['dsh-rewind-plugin'])
  assert.equal(r.incompatible[0].version, '0.14.0')
  assert.deepEqual(r.unknown.map((x) => x.name), ['dsh-not-installed'], 'dependencies 解析不到就是 unknown，不能算兼容')
})

test('judgeTargets：注入的读取器抛错也不能把整轮判成兼容', () => {
  const r = compat.judgeTargets({
    targets: [{ name: 'dsh-rewind-plugin', sources: ['dep'] }],
    targetVersion: TARGET,
    readManifest: () => { throw new Error('boom') },
  })
  assert.equal(r.incompatible.length, 0)
  assert.deepEqual(r.unknown.map((x) => x.name), ['dsh-rewind-plugin'])
})

test('modulesDirFromDshBin：从 dsh 入口反推安装树的 node_modules', () => {
  assert.equal(
    compat.modulesDirFromDshBin('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'),
    'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules',
  )
  assert.equal(compat.modulesDirFromDshBin('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'), '/usr/local/lib/node_modules')
  assert.equal(compat.modulesDirFromDshBin(''), '')
  assert.equal(compat.modulesDirFromDshBin('C:\\weird\\path\\dsh.js'), '')
})

test('checkProfileCompat：目标版本非法 / profile 读不到 → ok:false（fail-closed）', () => {
  assert.deepEqual(
    compat.checkProfileCompat({ profileDir: 'C:\\nope', targetVersion: 'latest' }),
    { ok: false, reason: 'invalid-target', targetVersion: 'latest' },
  )
  assert.equal(compat.checkProfileCompat({ profileDir: path.join(os.tmpdir(), 'dsh-compat-missing-dir'), targetVersion: TARGET }).reason, 'profile-unreadable')
})

test('judgeTargets：已授权的精确版本豁免要被算进去（DSH 是"不兼容且未豁免才拒绝"）', () => {
  const targets = [{ name: 'dsh-rewind-plugin', sources: ['dep'] }]
  const readManifest = () => ({ from: 'profile', manifest: { version: '0.14.0', peerDependencies: { '@deepseek-ai/dsh-fs': '^0.1.7-rc.2' } } })
  const without = compat.judgeTargets({ targets, targetVersion: TARGET, readManifest })
  assert.deepEqual(without.incompatible.map((x) => x.name), ['dsh-rewind-plugin'])
  const withEx = compat.judgeTargets({
    targets,
    targetVersion: TARGET,
    readManifest,
    exemptions: { 'dsh-rewind-plugin@0.14.0': ['0.2.0-rc.1'] },
  })
  assert.deepEqual(withEx.incompatible, [], '豁免过的插件不该继续报——否则每次升级都在喊一件不会发生的事')
  assert.deepEqual(withEx.exempted, ['dsh-rewind-plugin@0.14.0'])
  // 豁免只对精确版本生效：换成别的版本就重新开始报
  const otherVersion = compat.judgeTargets({
    targets,
    targetVersion: '0.3.0',
    readManifest,
    exemptions: { 'dsh-rewind-plugin@0.14.0': ['0.2.0-rc.1'] },
  })
  assert.deepEqual(otherVersion.incompatible.map((x) => x.name), ['dsh-rewind-plugin'])
})

test('readProfileExemptions：缺文件/坏文件给空表，非法版本条目被丢掉', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-ex-'))
  try {
    assert.deepEqual(compat.readProfileExemptions(root), {}, '没有 compatibility.json 就是不授权任何东西')
    fs.writeFileSync(path.join(root, 'compatibility.json'), '{ not json')
    assert.deepEqual(compat.readProfileExemptions(root), {}, '坏文件不能把整轮预判带崩')
    fs.writeFileSync(path.join(root, 'compatibility.json'), JSON.stringify({
      'pkg-a@1.0.0': ['0.2.0-rc.1', 'latest'],
      'pkg-b@2.0.0': 'not-an-array',
      'pkg-c@3.0.0': [],
    }))
    assert.deepEqual(compat.readProfileExemptions(root), { 'pkg-a@1.0.0': ['0.2.0-rc.1'] })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkProfileCompat：按 2026-09-28 那次升级的真实形态做回归', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-'))
  const profileDir = path.join(root, 'profiles', 'web')
  const installModules = path.join(root, 'install', 'node_modules')
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  }
  try {
    write(path.join(profileDir, 'package.json'), {
      name: 'dsh-profile-web',
      dependencies: {
        dshmarket: '1.66.3',
        '@michengai/dsh-skills-manager': '1.1.4',
        'dsh-rewind-plugin': '0.14.0',
        '@deepseek-ai/dsh-browser-use': '0.2.0-rc.1',
        '@kenz1117/dsh-ui-usage-billing': '1.4.12',
        'dsh-not-installed': '1.0.0',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@michengai/dsh-skills-manager', 'dsh-rewind-plugin'] } },
    })
    // 用户层补丁：两个 MCP 行按包名引用底包（不在 dependencies 里，只能从 insert 行发现）
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: panel-mcp-rider',
      '      name: "@deepseek-ai/dsh-mcp-client"',
      '      config:',
      '        serverName: rider',
      '    - id: browser-use',
      '      name: "@deepseek-ai/dsh-browser-use"',
    ].join('\n'))

    write(path.join(profileDir, 'node_modules', 'dshmarket', 'package.json'), {
      name: 'dshmarket', version: '1.66.3',
      peerDependencies: { '@deepseek-ai/dsh-settings': '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2' },
    })
    write(path.join(profileDir, 'node_modules', '@michengai', 'dsh-skills-manager', 'package.json'), {
      name: '@michengai/dsh-skills-manager', version: '1.1.4',
      peerDependencies: { '@deepseek-ai/dsh-skill': '0.1.0-rc.8 || 0.1.7-rc.2', react: '^18.2.0' },
    })
    write(path.join(profileDir, 'node_modules', 'dsh-rewind-plugin', 'package.json'), {
      name: 'dsh-rewind-plugin', version: '0.14.0',
      peerDependencies: { '@deepseek-ai/dsh-fs': '^0.1.7-rc.2' },
    })
    write(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json'), {
      name: '@deepseek-ai/dsh-mcp-client', version: '0.1.6-alpha.2',
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.6-alpha.2' },
    })
    write(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-browser-use', 'package.json'), {
      name: '@deepseek-ai/dsh-browser-use', version: '0.2.0-rc.1',
      peerDependencies: { '@deepseek-ai/dsh-brand': '0.2.0-rc.1' },
    })
    write(path.join(profileDir, 'node_modules', '@kenz1117', 'dsh-ui-usage-billing', 'package.json'), {
      name: '@kenz1117/dsh-ui-usage-billing', version: '1.4.12',
      peerDependencies: { '@deepseek-ai/dsh-tools': '*' },
    })
    // 内置 bundle 只在安装树里
    write(path.join(installModules, '@deepseek-ai', 'dsh-base', 'package.json'), {
      name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.1',
      peerDependencies: { '@deepseek-ai/dsh-tools': '0.1.7-rc.2' },
    })

    const r = compat.checkProfileCompat({ profileDir, installModulesDirs: [installModules], targetVersion: TARGET })
    assert.equal(r.ok, true)
    assert.deepEqual(
      r.incompatible.map((x) => x.name).sort(),
      ['@deepseek-ai/dsh-mcp-client', '@michengai/dsh-skills-manager', 'dsh-rewind-plugin', 'dshmarket'],
      '四条会被 DSH 拒绝的插件必须全部报出来（含只在补丁里出现的 MCP 底包）',
    )
    assert.deepEqual(r.unknown.map((x) => x.name), ['dsh-not-installed'])
    assert.deepEqual(r.skippedInBox, ['@deepseek-ai/dsh-base'], '内置 bundle 不参与预判')

    // 给其中一个写上精确版本豁免：它就该从清单里消失（DSH 那边也不会再拒它）
    fs.writeFileSync(path.join(profileDir, 'compatibility.json'), JSON.stringify({ 'dsh-rewind-plugin@0.14.0': [TARGET] }))
    const exempted = compat.checkProfileCompat({ profileDir, installModulesDirs: [installModules], targetVersion: TARGET })
    assert.deepEqual(
      exempted.incompatible.map((x) => x.name).sort(),
      ['@deepseek-ai/dsh-mcp-client', '@michengai/dsh-skills-manager', 'dshmarket'],
    )
    assert.deepEqual(exempted.exempted, ['dsh-rewind-plugin@0.14.0'])

    // 换成当前还在用的版本时，同一份数据里只剩"声明被钉死在 0.2.0-rc.1 上的那个内置插件"——
    // 这正是 dsh 0.2.0-rc.1 自带的 builtin 声明的真实形态（peer 是精确版本，不跟随运行时）
    const now = compat.checkProfileCompat({ profileDir, installModulesDirs: [installModules], targetVersion: '0.1.7-rc.2' })
    assert.deepEqual(now.incompatible.map((x) => x.name), ['@deepseek-ai/dsh-browser-use'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('installModulesDirsFromDshBin：带上 dsh 自己的 node_modules（内置 bundle 住在那里）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-inst-'))
  try {
    const top = path.join(root, 'node_modules')
    fs.mkdirSync(path.join(top, '@deepseek-ai', 'dsh', 'node_modules'), { recursive: true })
    const bin = path.join(top, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const dirs = compat.installModulesDirsFromDshBin(bin)
    assert.deepEqual(dirs, [top, path.join(top, '@deepseek-ai', 'dsh', 'node_modules')])
    // 没有嵌套布局时只给顶层，不能凭猜测返回不存在的目录
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-bare-'))
    fs.mkdirSync(path.join(bare, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    assert.deepEqual(
      compat.installModulesDirsFromDshBin(path.join(bare, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
      [path.join(bare, 'node_modules')],
    )
    fs.rmSync(bare, { recursive: true, force: true })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('judgeTargets：只来自补丁且解析不到的名字要忽略（模型名不是包），权威来源仍 fail-closed', () => {
  const targets = [
    { name: 'gpt-6-luna', sources: ['patch'] },
    { name: 'dsh-better-sidebar', sources: ['patch'] },
    { name: 'dsh-rewind-plugin', sources: ['dep', 'bundle'] },
  ]
  const r = compat.judgeTargets({ targets, targetVersion: TARGET, readManifest: () => undefined })
  assert.deepEqual(r.skippedUnresolved, ['gpt-6-luna', 'dsh-better-sidebar'], '补丁里的模型名/未装插件不该报成"未能确认"')
  assert.deepEqual(r.unknown.map((x) => x.name), ['dsh-rewind-plugin'], '解析不到的 dependencies/bundles 才进 unknown')
  const r2 = compat.judgeTargets({ targets: [{ name: 'dsh-rewind-plugin', sources: ['dep'] }], targetVersion: TARGET, readManifest: () => undefined })
  assert.deepEqual(r2.unknown.map((x) => x.name), ['dsh-rewind-plugin'], 'dependencies 解析不到必须报出来')
})

test('接线：main.js 只读预判并注入 state.dshUpdate，不动 compatibility.json', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /require\('\.\/dsh-plugin-compat'\)/, 'main.js 应引入判定模块')
  assert.match(main, /pluginCompat:\s*dshPluginCompat\(\)/, '应把预判结果注入推给界面的 dshUpdate')
  assert.doesNotMatch(main, /dsh-plugin-compat[^\n]*setProfileVersionExemption/, '预判必须是只读的，不能顺手写豁免')
})

test('接线：界面只在真有插件会失效（或拿不准）时才显示那行', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui-src', 'index.html'), 'utf8')
  const app = fs.readFileSync(path.join(__dirname, '..', 'ui-src', 'app.js'), 'utf8')
  assert.match(html, /id="dshUpdCompat"/, '应有升级代价提示行的容器')
  assert.match(app, /dshUpdCompat/, '渲染函数应更新该容器')
  assert.match(app, /升级后 \$\{bad\.length\} 个插件会失效/, '文案要给出数量')
  assert.match(app, /未能确认/, '拿不准时要说"未能确认"，不能假装兼容')
})
