// tests/dsh-desktop-shell-gating.test.js — dshDesktop 标记必须由主进程门控（默认关闭 → web runtime）
//
// 背景（2026-10-20 决策 → 2026-10-27 修订）：
//   2026-10-20 决定"无条件不暴露 dshDesktop"，因为桌面分支要求壳自己打开授权页，而 dshl 没有这条链路。
//   2026-10-27 起改为可选的桌面壳（Config.desktopShell），2026-10-28 起默认开启并加"激活闸门"：
//     · 页面拿 data-platform + dshDesktop.keyboard/shortcuts 的前提是三件事同时成立：
//       开关打开 + 快捷键桥就绪 + 登录辅助已被当前服务加载（adopted 服务没加载过 → 本次保持 web）；
//     · 关闭 / 桥未就绪 / 辅助未加载 / 来源不是本机 DSH → 一律不暴露，登录保持网页模式（不退化）。
//   这里把"门控"钉成契约：preload 只能同步问主进程，不能自己猜。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { URL } = require('node:url')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const preloadSrc = read('browser-preload.js')
const mainJs = read('main.js')
const indexHtml = read('ui-src/index.html')
const appJs = read('ui-src/app.js')

/**
 * 在沙箱里执行真实 preload 源码，收集暴露到主世界的键与 <html> 上的属性。
 * @param {{config: object|null, sendSyncThrows?: boolean, href?: string, withDocument?: boolean}} options
 */
function runPreload(options = {}) {
  const exposed = {}
  const attributes = {}
  const sandbox = {
    require(name) {
      if (name !== 'electron') throw new Error('sandbox preload 不允许 require：' + name)
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value } },
        ipcRenderer: {
          sendSync: () => {
            if (options.sendSyncThrows) throw new Error('ipc unavailable')
            return options.config === undefined ? null : options.config
          },
          on: () => undefined,
          removeListener: () => undefined,
          invoke: async () => undefined,
        },
      }
    },
    process: { platform: 'win32', argv: ['electron'] },
    location: { href: options.href || 'http://127.0.0.1:3080/' },
    URL,
    console,
  }
  if (options.withDocument !== false) {
    sandbox.document = {
      documentElement: { setAttribute: (key, value) => { attributes[key] = value } },
    }
  } else {
    sandbox.document = {}
    sandbox.MutationObserver = class { observe() {} disconnect() {} }
  }
  vm.runInNewContext(preloadSrc, sandbox, { filename: 'browser-preload.js' })
  return { exposed, attributes }
}

const ENABLED = { enabled: true, host: '127.0.0.1', port: 3080, platform: 'win32' }

test('默认（配置关闭/主进程不可用）：不暴露 dshDesktop、不写 data-platform', () => {
  for (const config of [{ enabled: false }, null, {}]) {
    const { exposed, attributes } = runPreload({ config })
    assert.ok(!('dshDesktop' in exposed), '关闭时不能暴露 dshDesktop')
    assert.equal(attributes['data-platform'], undefined, '关闭时不能写 data-platform')
    assert.ok('browserBridge' in exposed, '安全桥不能被这件事挤掉')
  }
  const { exposed } = runPreload({ sendSyncThrows: true })
  assert.ok(!('dshDesktop' in exposed), '同步 IPC 失败必须 fail-closed')
})

test('开启且来源是本机 DSH 页：暴露 keyboard/shortcuts，并写 data-platform', () => {
  const { exposed, attributes } = runPreload({ config: ENABLED })
  assert.ok('dshDesktop' in exposed, '开启后应暴露 dshDesktop')
  assert.equal(typeof exposed.dshDesktop.keyboard.subscribe, 'function')
  assert.equal(typeof exposed.dshDesktop.keyboard.closeWindow, 'function')
  assert.equal(typeof exposed.dshDesktop.shortcuts.get, 'function')
  assert.equal(typeof exposed.dshDesktop.shortcuts.edit, 'function')
  assert.equal(typeof exposed.dshDesktop.shortcuts.subscribe, 'function')
  assert.equal(typeof exposed.dshDesktop.shortcuts.recording, 'function')
  assert.equal(typeof exposed.dshDesktop.shortcuts.dispose, 'function')
  assert.equal(attributes['data-platform'], 'win32', 'detectEnvironment 依赖这个属性')
  assert.ok('browserBridge' in exposed)
})

test('开启但来源不是本机 DSH 页：一律不暴露（说明页/外部站点/换端口）', () => {
  for (const href of [
    'http://127.0.0.1:3081/',
    'http://localhost:3080/',
    'https://example.com/',
    'file:///C:/app/wwwroot/loading.html?reason=start',
    'http://127.0.0.1:3080.evil/',
  ]) {
    const { exposed, attributes } = runPreload({ config: ENABLED, href })
    assert.ok(!('dshDesktop' in exposed), `${href} 不能拿到 dshDesktop`)
    assert.equal(attributes['data-platform'], undefined, `${href} 不能写 data-platform`)
  }
})

test('preload 不依赖 argv 注入：门控只走同步 IPC', () => {
  assert.doesNotMatch(preloadSrc, /process\.argv/u, 'preload 不应再读 argv 判断来源')
  assert.doesNotMatch(preloadSrc, /--dshl-dsh-origin/u, '旧标记链路应保持移除')
  assert.match(preloadSrc, /sendSync\(DESKTOP_SHELL\.CONFIG\)/u, '门控必须同步问主进程')
})

test('main.js：桌面快捷键模式默认开启，旧配置按"一次性自动开启"迁移', () => {
  assert.match(mainJs, /tabsEnabled: false, desktopShell: !SELF_TEST/u, 'Config 默认必须开启（SELF_TEST 恒关，避免自检动 profile）')
  assert.match(mainJs, /desktopShellAutoEnabledFor: ''/u, '迁移记账字段存在')
  assert.match(mainJs, /cfg\.desktopShell === undefined[\s\S]{0,220}Config\.desktopShell = true/u, '旧配置没有开关字段 → 自动开启')
  assert.match(mainJs, /Config\.desktopShellAutoEnabledFor = app\.getVersion\(\)/u, '自动开启要留痕（版本号）')
  assert.match(mainJs, /if \(typeof cfg\.desktopShell === 'boolean'\)/u, '用户显式设置优先（含 false）')
  assert.match(mainJs, /desktopShell\.init\(\{/u, 'init 注册桥')
  assert.match(mainJs, /isEnabled: \(\) => Config\.desktopShell === true/u, 'enabled 只认配置开关')
  assert.match(mainJs, /isLoginReady: \(\) => desktopShellModeActive\(\)/u, 'preload 的登录就绪门控来自激活闸门')
  assert.match(mainJs, /isTrustedSender:/u, 'IPC 必须有发送方判定')
  assert.match(mainJs, /ensureDesktopShellPrepared\(\)/u, '启动前要连接快捷键持久化桥')
  assert.match(mainJs, /ensureDesktopSigninInstalled\(\)/u, '启动前要安装 Host 登录辅助 bundle')
  assert.match(mainJs, /desktopShell\.forwardKey\(wc, input\)/u, 'DSH 不接管的键要转发给原生键盘桥')
  assert.match(mainJs, /trust\.isDshAppUrl\(wc\.getURL\(\), WEB_URL\)/u, '转发前必须限定在 DSH 应用页')
})

test('main.js：激活闸门——桥/登录辅助/服务世代三条件不满足时保持 web runtime', () => {
  assert.match(mainJs, /function desktopShellModeActive\(\)/u, '闸门查询函数存在')
  assert.match(mainJs, /async function refreshDesktopShellGate\(/u, '闸门刷新函数存在')
  assert.match(mainJs, /setDesktopShellGate\(false, 'bridge-not-ready'/u, '桥未就绪 → 不激活')
  assert.match(mainJs, /setDesktopShellGate\(false, 'signin-install-failed'/u, '登录辅助安装失败 → 不激活（登录不退化）')
  assert.match(mainJs, /setDesktopShellGate\(true, 'managed-service'/u, '自管服务启动成功 → 激活')
  assert.match(mainJs, /helperLoadedByService\(\{/u, 'adopted/claimed 世代要用"进程启动时刻 vs 安装时刻"取证')
  assert.match(mainJs, /void refreshDesktopShellGate\('adopt'\)/u, '接管外部服务后要重算闸门')
  assert.match(mainJs, /void refreshDesktopShellGate\('service-exited'\)/u, '服务意外退出要撤销激活')
  assert.match(mainJs, /setDesktopShellGate\(false, 'service-not-running', 'stop'\)/u, '停止服务后闸门必须落下')
  assert.match(mainJs, /void refreshDesktopShellGate\('claim-successor'\)/u, '认领自重启后继后要重算闸门')
})

test('main.js + 设置页：开关落盘、重启生效（不改当前页面 runtime）', () => {
  assert.match(mainJs, /case 'setDesktopShell':/u, '主进程要有 setDesktopShell 命令')
  assert.match(mainJs, /desktopShellTogglePending = true/u, '切换后要标记"待重启生效"')
  assert.match(mainJs, /关闭也不立即改当前页面/u, '关闭语义必须是"重启启动器后生效"（与 preload 读一次配置一致）')
  assert.match(mainJs, /restartRequired: true/u, '返回体明确"需重启启动器生效"')
  assert.match(mainJs, /restartPending: desktopShellTogglePending/u, 'stateJson 要下发待重启标记')
  assert.match(mainJs, /desktopShell: \(\(\) => \{/u, 'stateJson 要下发桌面快捷键模式状态')
  assert.match(indexHtml, /id="btnDesktopShell"/u, '设置页要有开关按钮')
  assert.match(indexHtml, /id="desktopShellHint"/u, '设置页要有状态提示（不能只写"已开启"）')
  assert.match(appJs, /function renderDesktopShell\(/u, '渲染函数存在')
  assert.match(appJs, /cmd\('setDesktopShell'/u, '点击开关要走命令')
  assert.match(appJs, /'signin-not-loaded': '服务重启后生效'/u, '未生效原因要如实提示')
})

test('main.js：标记文件只在真正激活时存在（启动/退出都清理）', () => {
  assert.match(mainJs, /function writeDesktopShellMarker\(active\)/u, '主进程统一维护标记')
  assert.match(mainJs, /writeDesktopShellMarker\(desktopShellModeActive\(\)\)/u, '标记跟随激活闸门')
  assert.match(mainJs, /启动即清掉上一次运行遗留的就绪标记[\s\S]{0,220}rmSync\(DESKTOP_SHELL_MARKER/u, '启动要无条件清残留标记')
  assert.match(mainJs, /app\.on\('will-quit'[\s\S]{0,240}rmSync\(DESKTOP_SHELL_MARKER/u, '退出要撤标记')
  assert.match(mainJs, /app\.on\('will-quit'[\s\S]{0,240}desktopShell\.dispose\(\)/u, '退出要释放桥')
})

test('main.js：同步配置通道与桥 init 都早于 SELF_TEST 建窗（否则 sendSync 会卡死渲染进程）', () => {
  const register = mainJs.indexOf('desktopShell.registerConfigChannel')
  const init = mainJs.indexOf('desktopShell.init({')
  const initFn = mainJs.indexOf('function init() {')
  const selfTestBranch = mainJs.indexOf('if (SELF_TEST) {', initFn)
  assert.ok(register > 0, '模块加载期要注册同步配置通道')
  assert.ok(init > 0, 'init 要在 SELF_TEST 早退分支之前完成')
  assert.ok(initFn > 0 && selfTestBranch > initFn, '找不到 init() 里的 SELF_TEST 早退分支')
  assert.ok(register < initFn, 'registerConfigChannel 必须在模块加载期就注册（早于任何窗口创建）')
  assert.ok(init < selfTestBranch, 'desktopShell.init 必须早于 init() 里的 SELF_TEST 建窗分支')
  assert.match(mainJs, /desktopShell\.forwardKey\(wc, input\)/u, '不接管的键要转发')
})
