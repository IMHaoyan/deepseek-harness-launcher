// recovery-plan.js — 启动失败 → 恢复界面「一个状态一个动作」的判定（纯函数，无 IO、可单测）
//
// 为什么需要它：boot-failure.js 早就把失败分类成了 kind/target（plugin-tree / module-missing /
// bundle-missing / settings-invalid / bind / unknown），但那份结果此前只喂了两处 —— 通知里的一句
// reason，和「是不是确定性失败、要不要提前停重试」的判定。用户面对的状态页永远只有一句
// 「服务未启动」和一个「启动服务」按钮：对一个插件树挂掉的服务，点下去必然还是同样的失败。
//
// 本模块只做判定，不做任何 IO，也不执行动作：
//   planRecovery({ failure, capabilities }) → { scenario, reason, title, sub, detail, primary, secondary, blocked }
//
// ── 借鉴自 dsh-desktop 的三条 ──────────────────────────────────────────────────────────────
// 出处：anywhere-labs/dsh-desktop 的 `dsh-plugin-desktop/src/recovery-copy.ts`（一张 100+ 字段的
// 中英文案表）与 `src/startup-failure-routing.ts`（21 行路由）。三条里第 2 条最容易被做反。
//
// 1) **一个状态一个动作**：状态页只留一个"该做的事"，其余（看日志、导出诊断）退到次级按钮或
//    tooltip。dshl 的说明页已经守着这条（见 ui-src/loading.js 顶部与 page-keys.js 的三条铁律），
//    这里只是把"该做的事"从写死的按钮变成按失败分类派生。
//
// 2) **"能不能修"问权威账本，不问错误文本**。
//    dsh-desktop 的原话：`Error strings are diagnostics, never authority for deciding whether
//    Desktop may mutate state.` 报错行是**给人看的证据**，不能拿来决定"要不要给写权限"。
//    所以 primary 的存废只看 capabilities —— 而 capabilities 由 main.js 从插件补丁层
//    （plugin-switch.canToggle）、profile 清单、健康快照这些权威来源算出来；算不出来一律 false。
//    fail-closed 的形态是**不给按钮**（而不是给一个灰按钮）：灰按钮既没有解释力，又会让
//    「界面文案 = 真实动作」这条契约多出第三个状态（可见 / 可点 / 点了没用），而 dshl 恰恰
//    为这条契约写过一次事故复盘（ui-src/loading.js「按钮文案必须等于真实动作」）。
//
// 3) **文案里必须出现 target**。复现失败的人需要看到是哪个包、哪个文件，否则无法判断该不该点。
//    但只给"人话"：kind / eligible / signature / streak 这些内部概念不进版面（进日志与 tooltip）。
//
// ── fail-open / fail-closed 的分工 ────────────────────────────────────────────────────────
// boot-failure.js 对**识别不出**的失败是 fail-open（宁可多试一次）；本模块对**动作**是
// fail-closed（证明不了能做，就只给"看日志"）。两者不矛盾：前者管"要不要放弃看护"，
// 后者管"要不要替用户改状态"。后者必须更严 —— 看护多跑一轮是可恢复的，改错状态不是。
'use strict'

/** 与 plugin-switch.js / market.js 同一份包名判据：target 可能退化成 loader entry id，必须挡掉。 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

/** 这三类失败的共同点是"某个包"，区别只在它坏成什么样。 */
const PLUGIN_KINDS = new Set(['plugin-tree', 'module-missing', 'bundle-missing'])

/** 出错原文进版面的长度上限（与 boot-failure.js 的 LINE_MAX 一致）。 */
const DETAIL_MAX = 200
/** 连续失败几次才值得在版面上提"已经第 N 次"。低于这个数属于噪音。 */
const STREAK_MENTION = 2

/**
 * 说明页唯一可以回传的动作 id（恢复界面的全部写入口）。
 * main.js 在派发前先按这份清单校验：白名单以外的 id 一律拒绝，且**先校验再谈其他**。
 *
 * 这里**刻意没有**"打开控制台"这类导航动作：2026-09 用户明确要求把说明页上的「打开控制台」
 * 按钮删掉（配套收紧了 trust.js 的说明页白名单：界面不动用的权限就不该给）。说明页的退路是
 * 它自己那颗「重新检测」按钮（走既有的 fixPane），不需要新增权限。
 */
const ACTION_IDS = Object.freeze([
  'disable-plugin',
  'uninstall-plugin',
  'restore-checkpoint',
  'retry',
])

/**
 * 说明页可以跳转到的控制台页面（白名单，页面只发 key，主进程再映射成真实页面）。
 *
 * 为什么恢复界面需要**一个**导航入口：失败页能给的只有"一个动作"，而当前 Profile 里可能同时
 * 有好几个插件坏掉（DSH 把多插件失败聚合成一条 AggregateError，见 boot-failure.js 的
 * pluginTargets）。逐个重启去处理是 N 次循环，而控制台的插件页是**整份清单**，一次就能看完、
 * 想关哪个关哪个 —— dsh-desktop 的恢复窗口正是这么做的（它的「插件管理」页不是推荐列表，
 * 是 readDesktopRecoveryBundleInventory() 给出的 Profile 完整清单）。
 *
 * 历史：2026-09 用户明确要求删掉过说明页上的「打开控制台」按钮 —— 那颗按钮的问题是**说了不做**
 * （文案写"更换端口"，点下去跑的是 fixPane）。现在的入口不存在那个问题：它做的就是要做的事，
 * 而且只认下面这个白名单里的 key，不接受 URL / 路径。
 */
const CONSOLE_PAGES = Object.freeze(['plugins'])

function isPackageName(value) {
  return typeof value === 'string' && PACKAGE_NAME_RE.test(value)
}

/** target 在 settings 场景里是文件路径而不是包名：只判非空，避免把空串拼进句子。 */
function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** 取一个安全的布尔能力位（capabilities 由 main.js 组装；任何字段缺失都按"证明不了"处理）。 */
function flag(capabilities, key) {
  return capabilities && capabilities[key] === true
}

/**
 * 组装一条动作。label 由调用方给全（必须能在脱离上下文时读懂 —— 说明页没有其他解释）。
 * @param {string} id
 * @param {string} label
 * @returns {{id: string, label: string}}
 */
function action(id, label) {
  return { id, label }
}

/** 空计划：不接管状态页（交回既有的 offline / failed 行为）。 */
function noPlan() {
  return { scenario: 'none', reason: '', title: '', sub: '', detail: '', primary: null, entry: null, blocked: '' }
}

/**
 * 把「已连续失败 N 次」「自动恢复已停止」「本次已自动回退」这几条**本次运行的事实**追加到副文案。
 * 为什么放在这里而不是让界面自己拼：说明页拿不到这些状态，而它们恰恰决定用户该不该继续等。
 * 按需降噪 —— 没有这些事发生时不产生任何字。
 * @param {string} base
 * @param {object} failure
 * @param {object} capabilities
 * @returns {string}
 */
function withRunFacts(base, failure, capabilities) {
  const facts = []
  const count = failure && Number.isFinite(Number(failure.count)) ? Math.floor(Number(failure.count)) : 0
  if (count >= STREAK_MENTION) facts.push('同样的失败已经连续出现 ' + count + ' 次')
  if (flag(capabilities, 'autoRestartStopped')) facts.push('自动恢复已停止，不会再自动重试')
  if (capabilities && capabilities.recoveredAt) {
    facts.push('本次运行已自动回退到健康检查点'
      + (capabilities.backupFile ? '（原配置备份为 ' + capabilities.backupFile + '）' : ''))
  }
  if (!facts.length) return base
  // 中文排版：句号后直接接下一句，不加空格。base 自带句末标点，所以这里只做拼接。
  const sentence = facts.join('；') + '。'
  return base ? base + sentence : sentence
}

/**
 * 本次失败里**还有哪些**包也坏了。
 * 为什么要说：DSH 把多插件激活失败聚合成一个 AggregateError 并逐条打印，但分类只返回一个
 * target。不说的话，用户禁用掉这一个、重启、又被下一个拦住 —— 看起来像"修了没用"的循环。
 * 只是把事实摆出来，**不新增动作**（一个状态一个动作不变）。
 * @returns {string} 需要时返回一句可拼接的话；只有一个目标时返回 ''
 */
function otherPluginsNote(failure, target, primaryId) {
  const all = failure && Array.isArray(failure.targets) ? failure.targets : []
  const others = all.filter((n) => typeof n === 'string' && n && n !== target)
  if (!others.length) return ''
  const shown = others.slice(0, 3).join('、') + (others.length > 3 ? ' 等' : '')
  const head = others.length === 1 ? '另外还有 1 个插件也加载失败（' : '另外还有 ' + others.length + ' 个插件也加载失败（'
  // 只有"定点处理一个包"的动作才需要交代先后顺序；退到回退检查点时不存在"下一个"的问题。
  const tail = (primaryId === 'disable-plugin' || primaryId === 'uninstall-plugin')
    ? '）；本次先处理 ' + target + '，处理完若还有别的插件失败，这里会给出下一个。'
    : '）。'
  return head + shown + tail
}

/**
 * 判定一次启动失败在恢复界面上该怎么呈现。
 *
 * @param {{
 *   failure?: {kind?: string, target?: string, reason?: string, line?: string, count?: number}|null,
 *   capabilities?: {
 *     envReady?: boolean,
 *     autoRestartStopped?: boolean,
 *     recoveredAt?: string,
 *     backupFile?: string,
 *     checkpoint?: {slotId: string, capturedAt?: string}|null,
 *     plugin?: {name?: string, toggleable?: boolean, disabled?: boolean, installed?: boolean}|null
 *   }
 * }} input
 * @returns {{
 *   scenario: 'none'|'env'|'plugin'|'settings'|'unknown',
 *   reason: string,
 *   title: string,
 *   sub: string,
 *   detail: string,
 *   primary: {id: string, label: string}|null,
 *   entry: {page: string, label: string}|null,
 *   blocked: string
 * }} primary 为 null 且 scenario 不为 'none' 时，blocked 必须非空（解释为什么没有动作）。
 *   **动作只有 primary 一个**（一个状态一个动作）。entry 不是动作，是**导航入口**：它不改任何
 *   状态，只是把人送到控制台里能一次看完的那一页（见 CONSOLE_PAGES 的说明）。
 */
function planRecovery(input) {
  const failure = (input && input.failure) || null
  const capabilities = (input && input.capabilities) || {}
  const kind = failure && typeof failure.kind === 'string' ? failure.kind : ''
  const target = failure && typeof failure.target === 'string' ? failure.target : ''
  const detail = failure && typeof failure.line === 'string' ? failure.line.slice(0, DETAIL_MAX) : ''
  const reasonText = failure && typeof failure.reason === 'string' ? failure.reason : ''

  const checkpoint = capabilities.checkpoint && capabilities.checkpoint.slotId
    ? capabilities.checkpoint
    : null
  const checkpointAction = checkpoint
    ? action('restore-checkpoint', '回退到检查点 ' + checkpoint.slotId)
    : null

  // ① 运行环境未就绪：此时"启动服务"必然失败，后面所有判断都失去意义（插件修好了也起不来）。
  //    这里**不给按钮**：环境页是控制台里的一页，而失败页能承诺的只有"该去哪儿"。
  if (!flag(capabilities, 'envReady')) {
    return {
      scenario: 'env',
      reason: 'envMissing',
      title: '运行环境未就绪',
      sub: '启动器还没有可用的 dsh 运行环境，服务无法启动。',
      detail: '',
      primary: null,
      entry: null,
      blocked: '请在 DSHL 控制台「运行环境」页一键安装/修复运行环境；装好后启动器会自动补启动服务。',
    }
  }

  // ② 插件类失败：这是唯一能"定点修"的一类。
  if (PLUGIN_KINDS.has(kind)) {
    const plugin = capabilities.plugin || {}
    const named = isPackageName(target) && plugin.name === target
    const what = {
      'plugin-tree': {
        title: '服务因插件启动失败',
        sub: named ? '插件 ' + target + ' 加载失败，多半与当前 DSH 版本不兼容。' : '当前 Profile 里有插件加载失败，多半与当前 DSH 版本不兼容。',
      },
      'module-missing': {
        title: '插件依赖缺失',
        sub: named ? '插件 ' + target + ' 依赖的包没有安装，服务因此起不来。' : '某个插件依赖的包没有安装，服务因此起不来。',
      },
      'bundle-missing': {
        title: 'Profile 声明的插件未安装',
        sub: named ? '当前 Profile 声明了 ' + target + '，但它不在 node_modules 里。' : '当前 Profile 声明了尚未安装的插件。',
      },
    }[kind]

    let primary = null
    let blocked = ''
    if (kind === 'bundle-missing') {
      // 声明与安装不一致：没有可禁用的加载项（包根本不在），能安全修的是"回到一份声明与安装一致的配置"。
      primary = checkpointAction
      if (!primary) blocked = '没有可用的健康检查点，无法自动对账这条失效声明。'
    } else if (named && flag(plugin, 'toggleable') && !flag(plugin, 'disabled')) {
      // 可逆优先：禁用保留安装内容，用户随时能在控制台装回来。
      primary = action('disable-plugin', '禁用 ' + target + ' 并重启服务')
    } else if (named && flag(plugin, 'installed')) {
      primary = action('uninstall-plugin', '卸载 ' + target + ' 并重启服务')
    } else if (named && flag(plugin, 'disabled')) {
      blocked = target + ' 已经被禁用，但服务仍然起不来；请查看日志确认是否还有别的插件。'
    } else if (checkpointAction) {
      // 认不出是哪个包时退到"回到上一个能起来的配置"——这是一条不需要先知道根因的路。
      primary = checkpointAction
    } else {
      blocked = '没能确认出问题的插件在当前 Profile 里的加载项，无法自动处理。'
    }

    return {
      scenario: 'plugin',
      reason: 'pluginFailed',
      title: what.title,
      sub: withRunFacts(what.sub + otherPluginsNote(failure, target, primary ? primary.id : ''), failure, capabilities),
      detail: primary ? '' : (detail || reasonText),
      primary,
      // 插件类失败一律给「管理插件」入口：这里的动作只能处理**一个**包，而清单能一次看完。
      // 特别是"还有 N 个插件也加载失败"时，逐个重启去处理本来就是错的路。
      entry: { page: 'plugins', label: '管理插件' },
      blocked,
    }
  }

  // ③ 设置文件解析失败：检查点里带 settings.yaml，所以回退是现成的定点修复。
  if (kind === 'settings-invalid') {
    const primary = checkpointAction
    return {
      scenario: 'settings',
      reason: 'settingsInvalid',
      title: 'DSH 设置文件解析失败',
      sub: withRunFacts(hasText(target) ? '设置文件 ' + target + ' 解析失败，服务因此起不来。' : '设置文件无法解析，服务因此起不来。', failure, capabilities),
      detail: primary ? '' : (detail || reasonText),
      primary,
      entry: null,
      blocked: primary ? '' : '没有可用的健康检查点，无法自动回退这份设置文件。',
    }
  }

  // ④ bind（端口类）**刻意不在这里处理**：它已经有单一来源 server.blockedReason 与
  //    "换到端口 N 并启动"的既有链路（main.js 的 reasonForPhase 把 blocked 判在最前面）。
  //    在这里再判一次就会出现两处口径，正是我们要避免的东西。
  if (kind === 'bind') return noPlan()

  // ⑤ 有失败但识别不出原因：保留原有的"再起一次"（这是唯一还值得一试的动作）。
  if (failure) {
    // ★ 文案不能说"没有输出错误" —— 实测（沙箱里把 profile 的 package.json 写成非法 JSON）：
    //   日志里明明白白有 `SyntaxError: Unexpected token '}'`，而 kind 仍是 unknown（没有对应规则）。
    //   这两件事必须分开说：**认不出**是 DSHL 的能力边界，**没有输出**是子进程的事实。
    //   说反了最伤：用户拿着日志来对照，发现界面在撒谎。
    const hasLine = detail !== ''
    return {
      scenario: 'unknown',
      reason: 'bootUnknown',
      title: '服务启动失败',
      sub: withRunFacts(hasLine
        ? '服务报了一个 DSHL 还认不出的错误，下面那行就是它。'
        : '服务没有输出任何错误就退出了。', failure, capabilities),
      detail,
      primary: action('retry', '重新启动服务'),
      entry: null,
      blocked: '',
    }
  }

  // ⑥ 没有分类结果：交回既有的 offline / failed 状态页，保持行为不变。
  return noPlan()
}

module.exports = {
  planRecovery,
  ACTION_IDS,
  CONSOLE_PAGES,
  PLUGIN_KINDS,
  PACKAGE_NAME_RE,
  DETAIL_MAX,
  STREAK_MENTION,
}
