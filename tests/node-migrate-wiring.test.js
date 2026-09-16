// tests/node-migrate-wiring.test.js — 「迁移到官方安装」入口的接线护栏
//
// 反面教材（本仓库一再强调的）：按钮画出来了却没接事件、或文案承诺的动作与实际 payload 不一致。
// 这条链有四段，缺一段用户就点了没反应或做了别的事：
//   ① 主进程 envSummary 带出 legacyNode 事实（ui-src 才有得判断）
//   ② 卡片只在 legacyNode 存在时出现，且文案说清"要一次管理员授权 / 只清理 DSH / 其他全局包不动"
//   ③ 点击走事件委托（卡片是重建的），payload 必须是 { items:['node'], forceNodeInstall:true, nodeInstallMode:'msi' }
//   ④ main.js 的 envInstall 分支把 opts 原样透传给 startInstall（否则 forceNodeInstall 传不到后端）
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const appJs = read('ui-src/app.js')
const builtAppJs = read('wwwroot/app.js')
const mainJs = read('main.js')
const envDetect = read('env-detect.js')
const envInstall = read('env-install.js')
const html = read('ui-src/index.html')

test('① 探测侧把旧布局事实带进 envSummary（UI 才有判断依据）', () => {
  assert.match(envDetect, /legacyNode: legacyUserNodeLayout\(\)/, '报告要带 legacyNode')
  assert.match(envDetect, /legacyNode: report\.legacyNode \|\| null/, 'envSummary 要透出 legacyNode')
})

test('② 迁移卡片只在有旧布局时出现，且文案与真实动作一致', () => {
  assert.match(appJs, /if \(env\.legacyNode && env\.legacyNode\.dir\)/, '卡片必须以 legacyNode 为条件')
  const block = appJs.slice(appJs.indexOf('if (env.legacyNode && env.legacyNode.dir)'))
  const card = block.slice(0, block.indexOf('$(\'envCards\').innerHTML'))
  assert.match(card, /迁移到官方安装（需一次管理员授权）/, '按钮文案要点明需要管理员授权')
  assert.match(card, /只清理旧目录里 DSH 自己那份/, '文案要说清只清理 DSH 自己那份')
  assert.match(card, /不会被迁移、也不会被删除/, '有别的全局包时必须说明不动它们')
  assert.match(card, /data-env-act="migrate-msi"/, '按钮要带可识别的动作标记')
})

test('③ 点击走事件委托，payload 与后端约定一致（forceNodeInstall + msi）', () => {
  const handler = appJs.slice(appJs.indexOf("$('envCards').addEventListener('click'"))
  const seg = handler.slice(0, handler.indexOf("button[data-env-item]"))
  assert.match(seg, /closest\('button\[data-env-act\]'\)/, '要处理 data-env-act（委托，卡片会重建）')
  assert.match(seg, /cmd\('envInstall', \{ items: \['node'\], forceNodeInstall: true, nodeInstallMode: 'msi' \}\)/,
    'payload 必须是 items:[node] + forceNodeInstall + nodeInstallMode=msi')
})

test('④ 主进程 envInstall 分支把 opts 原样透传（含 forceNodeInstall）', () => {
  const seg = mainJs.slice(mainJs.indexOf("case 'envInstall':"))
  const body = seg.slice(0, seg.indexOf("case 'envCancel'"))
  assert.match(body, /const opts = value && typeof value === 'object' \? value : \{\}/, '要取到 opts')
  assert.match(body, /delete opts\.items/, 'items 与 opts 要分开')
  assert.match(body, /envInstall\.startInstall\(items, opts\)/, 'opts 必须透传给 startInstall')
})

test('⑤ 后端认这两个开关（否则 payload 传到也白传）', () => {
  assert.match(envInstall, /job\.opts\.forceNodeInstall/, 'runJob 要读 forceNodeInstall（强制重装，跳过复用）')
  assert.match(envInstall, /DSHL_NODE_INSTALL/, '要支持 nodeInstallMode / DSHL_NODE_INSTALL 选择安装方式')
  // 安装项补全：旧目录里有 DSH 时自动带上 dsh，否则迁移完旧的那份被删、新的没装
  assert.match(envInstall, /out\.dshInNodeDir = globals\.includes\('@deepseek-ai\/dsh'\)/, 'nodeReplacePlan 要识别旧 DSH')
})

test('⑥ 打包用的 wwwroot 与 ui-src 同步（改了源码别忘了同步产物）', () => {
  assert.match(builtAppJs, /迁移到官方安装（需一次管理员授权）/, 'wwwroot/app.js 也要有迁移入口')
  assert.match(builtAppJs, /forceNodeInstall: true, nodeInstallMode: 'msi'/, 'wwwroot/app.js 的 payload 要一致')
})

test('⑦ 文案不再承诺"解压"：官方 MSI 是 msiexec 安装，只有 zip 兜底才解压', () => {
  assert.doesNotMatch(html, /解压/, 'index.html 不该提解压')
  const from = envInstall.indexOf('const STAGE_LABELS = {')
  const labels = envInstall.slice(from, envInstall.indexOf('}', from))
  assert.match(labels, /'node-ex': '校验并安装 Node\.js'/, '阶段名要与真实动作一致：' + labels)
  const wizard = appJs.split('\n').filter((l) => l.includes("'node-ex':"))
  for (const l of wizard) assert.doesNotMatch(l, /解压/, '向导阶段文案不该提解压：' + l)
})
