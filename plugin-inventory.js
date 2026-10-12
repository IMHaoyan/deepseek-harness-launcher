// plugin-inventory.js — "Profile 里真实存在、但不在 DSHL 注册表里"的插件 → 插件页卡片（纯函数）
//
// 为什么需要它：插件页的卡片来自 MANAGED_NPM_PLUGINS 这份**注册表**，而能导致启动失败的是
// Profile 里真实存在的**任何**包 —— 手动 `dsh plugin --profile web add` 装的、在 DSH 自己的
// 市场里装的、或者从某版起被 DSHL 从注册表移除的。这些包以前在界面上根本不存在：用户在启动
// 失败页看到"插件 X 加载失败"，却在**整个控制台里找不到能关掉 X 的地方**。
//
// 参考实现（anywhere-labs/dsh-desktop 的恢复窗口）解决的是同一个问题：它的「插件管理」页不是
// 一张推荐清单，而是**当前 Profile 的完整清单** —— `readDesktopRecoveryBundleInventory()` 给出
// 每个 bundle，再逐行算出这个 bundle 上能做什么：
//   owner  = !mutable ? 'core' : uninstallable ? 'profile' : 'external'
//   action = uninstallable ? 'uninstall' : null
//   toggle = !uninstallable ? null : deselected ? 'enable' : status === 'active' ? 'disable' : null
// 并在 `action`/`toggle` 为 null 时**不渲染那个按钮**。
// 本模块照搬这条：可执行性由调用方传进来的**权威探针**现算，算不出就不给。
//
// 与它们的一处刻意差异：**不提供安装/更新**。它们每个 bundle 都带着完整的版本/来源语义，
// 而我们只知道"这个包在 profile 里"——"它当初从哪装的"并不知道，编一个来源就是界面与真实动作
// 不符。所以这里只给三个能让服务先起来的动作：停用 / 启用 / 卸载。
'use strict'

/** 插件 id 前缀：让插件页完全不必区分来源（卡片同构、动作走同一条分发）。 */
const INVENTORY_ID_PREFIX = 'profile:'

/** 排在注册表卡片之后的 order：这是"其余"，不该抢推荐位。 */
const INVENTORY_ORDER = 900

/** 与 plugin-switch.js / market.js 同一份包名判据。 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** 显示名：@scope/name 在窄卡片上只显示 name，全名进 subtitle。 */
function shortName(npm) {
  return npm.includes('/') ? npm.slice(npm.indexOf('/') + 1) : npm
}

/**
 * @param {{
 *   targets?: Array<{name?: string, sources?: string[]}>,
 *   known?: Iterable<string>,          // 注册表 / 市场 / 手机连接已经覆盖的包名
 *   stateOf?: (npm: string) => {version?: string},   // 权威：profile 清单里的版本
 *   isDisabled?: (npm: string) => boolean,           // 权威：补丁层的启停状态
 *   canToggle?: (npm: string) => boolean,            // 权威：能不能安全停用
 *   busyOf?: (id: string) => string,                 // 正在进行的动作（''=空闲）
 *   busyLabel?: (action: string) => string
 * }} input
 * @returns {Array<object>} 与 buildPluginCatalog 其余卡片同构的卡片
 */
function inventoryCards(input = {}) {
  const targets = Array.isArray(input.targets) ? input.targets : []
  const known = input.known instanceof Set ? input.known : new Set(input.known || [])
  // 探针缺失/抛错一律按"证明不了"处理（fail-closed）：不给开关、也不给版本，而不是猜一个。
  // 为什么抛错也要在这里兜住：buildPluginCatalog 每次状态推送都会被调用，
  // 一个坏探针冒泡上去就是**整个插件页渲染不出来** —— 故障面远大于它想表达的那一条信息。
  const probe = (fn, fallback) => (...args) => {
    if (typeof fn !== 'function') return fallback
    try { return fn(...args) } catch { return fallback }
  }
  const stateOf = probe(input.stateOf, {})
  const isDisabled = probe(input.isDisabled, false)
  const canToggle = probe(input.canToggle, false)
  const busyOf = probe(input.busyOf, '')
  // ★ 「未生效」的证据必须也接给这一类卡片：DSH 对"bundle 被跳过 / 行没激活"只写 stderr、
  //   退出码 0，服务照常起 —— 而**能出这种事的恰恰多半是第三方插件**，正是本分组覆盖的那批。
  //   不接的话，插件页会对一个根本没加载起来的插件显示「已启用」，是最糟的那种谎。
  const activationOf = probe(input.activationOf, '')
  const busyLabel = typeof input.busyLabel === 'function' ? input.busyLabel : (a) => String(a || '')

  const out = []
  for (const t of targets) {
    const npm = String((t && t.name) || '')
    if (!PACKAGE_NAME_RE.test(npm)) continue // 认不出是包名就不上界面（readProfileTargets 已过滤，这里是第二道）
    if (known.has(npm)) continue             // 注册表已经有一张卡了，不重复
    // ★ 只收**真的装在 profile 里**的（sources 含 'dep'）。这条是实测补的，而且很要紧：
    //   profile 的 bundles 里还躺着 DSH **安装自带**的核心 bundle（@deepseek-ai/dsh-base、
    //   @deepseek-ai/dsh-web-app …）—— 它们不在 DSHL 注册表里，但绝不该出现在这张"可以卸载"的
    //   清单上。真跑一次沙箱就看见它俩被列了出来，还各带一个「卸载」按钮。
    //   判据用 sources 而不是硬编码包名前缀：它来自 readProfileTargets 的权威归类。
    const sources = Array.isArray(t && t.sources) ? t.sources : []
    if (!sources.includes('dep')) continue

    const id = INVENTORY_ID_PREFIX + npm
    const busy = String(busyOf(id) || '')
    const disabled = isDisabled(npm) === true
    const toggle = canToggle(npm) === true
    const short = shortName(npm)
    // 来源只用于解释"它为什么在这儿"，不参与判定
    const why = sources.includes('bundle')
      ? '它被声明在当前 Profile 的 dsh.profile.bundles 里'
      : '它是当前 Profile 的直接依赖'

    out.push({
      note: '',
      id,
      order: INVENTORY_ORDER,
      preset: false,
      name: short,
      subtitle: npm,
      description: '在当前 Profile 里，但不在 DSHL 的插件清单中（手动安装，或由 DSH 内的市场安装）。'
        + '可以停用它让服务先起来，或彻底卸载。',
      icon: '📦',
      category: 'Profile 中的其他插件',
      sourceLabel: 'Profile',
      repo: '',
      installed: true, // 它就在 profile 里 —— 这是这个分组的定义，不是探测结果
      enabled: !disabled,
      version: String((stateOf(npm) || {}).version || ''),
      latestVersion: '',
      outdated: false, // 不做更新预判：版本策略属于"当初从哪装"，我们不知道
      payloadReady: true,
      busy,
      error: '',
      activation: String(activationOf(npm) || ''),
      lastChange: '',
      autoInstall: false, // 不是 DSHL 代管的，永不参与自动安装/自动维护
      tags: [],
      // 拿不到加载项就不给开关（**不给灰开关**）：灰开关既没解释力，又让"界面文案=真实动作"
      // 多出第三个状态。理由与 recovery-plan.js 里那条一致。
      toggleAction: toggle ? 'toggle' : '',
      status: busy
        ? { label: busyLabel(busy), tone: 'busy' }
        : (disabled
          ? { label: '已关闭', tone: 'muted', title: '仍已安装，启动时不加载' }
          : (toggle
            ? { label: '已启用', tone: 'ok', title: why }
            : { label: '无法停用', tone: 'warn', title: '找不到它在 Profile 补丁层里的加载项，DSHL 无法安全地停用它' })),
      // 卸载永远可用（market 会走官方 dsh plugin remove 并回读校验）；
      // 但**认不出包名或它已不在清单里**时会失败，那时错误由执行层如实返回。
      actions: [{
        action: 'uninstall',
        label: '卸载',
        tone: 'danger',
        confirmTitle: '卸载「' + short + '」？',
        confirmBody: '会从当前 Profile 移除 ' + npm + ' 并重启 DSH 服务，正在运行的会话会中断；之后需要重新安装才能使用。',
      }],
    })
  }
  return out
}

module.exports = { inventoryCards, INVENTORY_ID_PREFIX, INVENTORY_ORDER, PACKAGE_NAME_RE, shortName }
