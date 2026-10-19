// tests/dsh-update-manual-feedback.test.js — 「点了检查更新没反应」的回归护栏。
//
// 2026-10 实测反馈：同事在 DSH 版本行点「检查更新」，界面上什么都没发生。
// 根因是这几条静默路径叠在一起：
//   ① 手动点击撞上在途检查时，checkOnce 开头的 if (checking) 直接 return —— 0 日志、0 状态推送；
//   ② 一次检查最坏要等两个 npm 源各 90 秒（慢网/代理），"正在检查更新…"却 8 秒就被清掉了；
//   ③ 检查若卡死，checking 永远为 true，之后每次点击都走 ①（永久没反应）。
// 这里把三条都用可执行断言钉住：在途点击必须留日志且在静默收场后补查、超时看门狗必须复位状态、
// 渲染层必须点击当刻就反馈并把"检查中"提示保持到结果到达。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const dshUpdater = require('../dsh-update.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(pred, label, timeoutMs = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return
    await sleep(5)
  }
  throw new Error('等待超时：' + label)
}

/** 初始化一份只读 mock：不联网、不写盘，只记录日志与状态推送。 */
function makeHarness(opts = {}) {
  const logs = []
  const pushes = []
  dshUpdater.initDshUpdater({
    Config: { dshUpdateCheckedAt: 0, dshChannel: 'alpha' },
    saveConfig: () => {},
    log: (m) => logs.push(String(m)),
    envInstall: { getJob: () => ({ job: null }) },
    envDetect: { detectEnv: opts.detectEnv || (async () => null) },
    onState: () => pushes.push(dshUpdater.getState()),
    checkTimeoutMs: opts.checkTimeoutMs,
  })
  return { logs, pushes }
}

test('手动点击撞上在途自动检查：留日志、不假装没发生，且在其静默收场后补查一次', async () => {
  let detectCalls = 0
  let releaseFirst
  const firstDetect = new Promise((resolve) => { releaseFirst = resolve })
  const { logs, pushes } = makeHarness({
    detectEnv: () => {
      detectCalls += 1
      return detectCalls === 1 ? firstDetect : Promise.resolve(null)
    },
  })

  const auto = dshUpdater.checkOnce('startup') // 自动检查在途（挂起在第一处 await）
  await waitFor(() => dshUpdater.getState().status === 'checking', '自动检查进入 checking')
  const pushesBefore = pushes.length

  const result = await dshUpdater.checkOnce('manual', true) // 用户此刻点了「检查更新」
  assert.equal(result && result.joined, true, '在途时手动检查应明确返回 joined（而不是静默 undefined）')
  assert.equal(pushes.length, pushesBefore, '并入时不应该重复推一个相同状态')
  assert.ok(logs.some((l) => l.includes('已有检查在途')), '必须留日志：' + logs.join(' | '))
  assert.ok(logs.some((l) => l.includes('本次点击并入')), '日志要能看出这次点击被并入了')

  // 在途的自动检查静默收场（环境未就绪 → idle，界面上没有任何结果）→ 必须补查，点击才有结果
  releaseFirst(null)
  await auto
  await waitFor(() => dshUpdater.getState().status === 'error', '补查后的手动结果')
  assert.ok(logs.some((l) => l.includes('静默收场')), '补查要留日志：' + logs.join(' | '))
  assert.ok(logs.some((l) => l.includes('手动检查开始')), '补查必须真的发起手动检查：' + logs.join(' | '))
  assert.match(dshUpdater.getState().error, /运行环境未就绪/, '手动检查的结果要如实呈现给界面')
  assert.equal(pushes[pushes.length - 1].status, 'error', '最终状态必须推给界面（否则还是"没反应"）')
})

test('检查卡死：看门狗超时给错误态并复位 checking，之后的点击不会被永久吞掉', async () => {
  let detectCalls = 0
  const { logs } = makeHarness({
    checkTimeoutMs: 40,
    detectEnv: () => {
      detectCalls += 1
      // 第一轮永远不返回（模拟 npm 挂死/网络黑洞），之后正常返回"环境未就绪"
      return detectCalls === 1 ? new Promise(() => {}) : Promise.resolve(null)
    },
  })

  const hung = dshUpdater.checkOnce('manual', true)
  hung.catch(() => {}) // 永远挂住的 promise：不要让它变成未处理拒绝影响测试进程
  await waitFor(() => dshUpdater.getState().status === 'error', '看门狗把挂住的检查收尾')
  assert.match(dshUpdater.getState().error, /检查超时/, '超时要给可读原因')
  assert.ok(logs.some((l) => l.includes('检查超时')), '超时要留日志：' + logs.join(' | '))

  // 关键：checking 已复位 —— 再点一次必须真的开始检查，而不是又被 if (checking) 吞掉
  const before = logs.filter((l) => l.includes('手动检查开始')).length
  await dshUpdater.checkOnce('manual', true)
  const after = logs.filter((l) => l.includes('手动检查开始')).length
  assert.equal(after, before + 1, '超时复位后，下一次手动点击必须真正开始检查')
  assert.match(dshUpdater.getState().error, /运行环境未就绪/, '第二轮照常给出结果')
})

test('渲染层：点击当刻就反馈，且"检查中"提示不参与 8 秒自动清除', () => {
  const app = read('ui-src/app.js')
  const built = read('wwwroot/app.js')

  // 提示函数支持 sticky：只有终态才挂 8 秒定时器
  assert.match(app, /function flashVersionHint\(el, text, title, key, opts\)/, 'flashVersionHint 要能区分"还没结束"的提示')
  assert.match(app, /if \(text && !\(opts && opts\.sticky\)\)/, 'sticky 提示不能被 8 秒定时器清掉')

  // 点击处理：先显示"正在检查更新…"，再发 IPC（顺序不能反，否则慢检查又会出现空窗期）
  const clickStart = app.indexOf("$('btnDshCheckHover').addEventListener")
  assert.ok(clickStart > 0, '找不到 DSH 检查按钮的点击处理')
  const clickBlock = app.slice(clickStart, clickStart + 900)
  const hintPos = clickBlock.indexOf("flashVersionHint(rowHint, '正在检查更新…'")
  const ipcPos = clickBlock.indexOf("cmd('dshCheckNow')")
  assert.ok(hintPos > 0, '点击处理里要先给即时反馈')
  assert.ok(ipcPos > hintPos, '即时反馈必须发在 IPC 之前')
  assert.match(clickBlock, /r && r\.ok === false/, '主进程侧拒绝也要给出可读结果，不能静默')
  assert.match(clickBlock, /hoverCheck\.disabled = false/, '失败路径要恢复按钮，不能永远停在「检查中…」')

  // 两个版本行的 checking 分支都走 sticky
  assert.match(app, /if \(status === 'checking'\) \{ text = '正在检查更新…'; sticky = true; \}/, 'DSH 行"检查中"提示要 sticky')
  assert.match(app, /if \(u\.status === 'checking'\) \{ text = '正在检查更新…'; sticky = true; \}/, '启动器行"检查中"提示要 sticky')

  // 打包产物就是线上那份：src 改了必须同步 build:assets
  assert.equal(built, app, 'wwwroot/app.js 未同步：请执行 npm run build:assets')
})

test('主进程：两处 dshCheckNow 都必须接住异步检查的 rejection（否则界面永远等不到反馈）', () => {
  const mainJs = read('main.js')
  const wired = mainJs.match(/dshUpdater\.checkOnce\('manual', true\)\.catch\(/g) || []
  assert.equal(wired.length, 2, 'dsh:cmd 与 update:cmd 两个入口都要接住 rejection')
  assert.doesNotMatch(mainJs, /void dshUpdater\.checkOnce\('manual', true\);\s*return '\{\}'/,
    '不能再保留"发出去就不管"的旧写法')
})

test('dsh-update：手动点击的每个早退分支都留痕（日志里能区分"没点"和"被吞"）', () => {
  const src = read('dsh-update.js')
  for (const msg of ['手动检查时已有检查在途', '手动检查未执行：DSH 正在更新中', '手动检查未执行：更新器尚未初始化']) {
    assert.ok(src.includes(msg), '缺少日志：' + msg)
  }
  assert.match(src, /if \(manual\) log\(`dsh-update: 手动检查开始/, '手动检查真正开始时要有开始日志（耗时/结果才能对上）')
  assert.match(src, /const CHECK_TIMEOUT_MS = 5 \* 60 \* 1000/, '检查必须有总时限兜底')
})
