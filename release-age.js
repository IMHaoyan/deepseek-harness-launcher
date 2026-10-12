// release-age.js — pnpm 11 「24h 新版本观察期」的判定（纯函数，无 IO，可单测）
//
// 为什么单独一个模块：这段逻辑原来在 market.js 与 bridge.js 里各有一份**复制粘贴**的副本，
// bridge.js 那份的注释还写着「判定口径与 market.js 一致」—— 实际是两份各自会漂移的常量。
// 2026-10-12 就漂移出了后果：pnpm 11.8 对「点名安装的精确版本被观察期挡掉」打的是
// `ERR_PNPM_NO_MATCHING_VERSION` + `does not meet the minimumReleaseAge constraint`，
// 两份标记表都不认，于是**自动放行兜底永远不触发**，用户看到的是两个插件更新直接失败：
//
//   dsh plugin 退出码 1：TCHING_VERSION] 1 version does not meet the minimumReleaseAge constraint:
//   @michengai/dsh-skills-manager@1.1.16 was published at 2026-10-12T05:30:14.858Z,
//   within the minimumReleaseAge cutoff (2026-10-11T06:26:52.060Z)
//
// 注意那行开头的 `TCHING_VERSION]` —— 它是 `ERR_PNPM_NO_MATCHING_VERSION]` 被
// `output.slice(-400)` 从左边切掉后的残骸。错误码恰恰是最有辨识度的 token，却总在开头，
// 所以文案改成"头 + 尾"省略（keepErrorCodeVisible）。
//
// 三件事在这里定义一次，market.js 与 bridge.js 都从这里取：
//   ① 怎么判定「被观察期拒绝」；② 怎么抠出被拒条目；③ 什么时候自动恢复。
'use strict'

/** 一次性放行参数（`add` / `remove` 前注入一次）。 */
const RELEASE_AGE_OVERRIDE = '--config.minimumReleaseAge=0'

/**
 * 「被 24h 观察期拒绝」的稳定标记。
 *
 * 为什么用**散文**而不只是错误码：pnpm 在不同操作路径上打的码不一样，而且错误码经常出现在
 * 输出的最开头 —— 一旦上游做任何截断/包裹就先没了。散文是它稳定打印的、离被拒事实最近的那句。
 */
const RELEASE_AGE_MARKERS = [
  'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION',
  'failed supply-chain policy check',
  'bypassed the policy locally',
  // pnpm 11.8 的 remove 路径没有 wire 观察期处理器：只要树里存在任何新鲜条目就直接硬失败，
  // 连"违规的是谁"都不打印（2026-09-20 实测：同一棵树 add 会自愈写 minimumReleaseAgeExclude、
  // remove 报这个码）。它同样属于「被 24h 观察期拒绝」，放行一次即可通过；
  // 不认这个码的话，卸载路径的兜底重试永远不会触发，用户只会看到一句 pnpm 内部错误。
  'ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED',
  // ★ 2026-10-12 补：点名安装**精确版本**时，pnpm 把被观察期挡掉的版本报成「没有匹配的版本」，
  // 并在后面附上这句解释。同一个坑第二次踩（前一次是 remove 路径），所以这次记下规律：
  //   观察期的三种表现（整份 lockfile 被拒 / remove 硬失败 / 精确版本无匹配）各有一个码，
  //   而它们的共同点是**都会打印这句散文**。
  'does not meet the minimumReleaseAge constraint',
]

/** 这次失败是不是「24h 观察期拒绝」。output 必须是**完整输出**（不是截断后的错误文案）。 */
function isViolation(output) {
  const text = String(output == null ? '' : output)
  return RELEASE_AGE_MARKERS.some((marker) => text.includes(marker))
}

/** 只知道命令名时，把一次性放行参数注入到 add / remove 之前；其它子命令原样透传。 */
function withOverride(args) {
  const list = Array.isArray(args) ? args : []
  const command = list[0]
  if (command !== 'add' && command !== 'remove') return list
  if (list.includes(RELEASE_AGE_OVERRIDE)) return list
  return [command, RELEASE_AGE_OVERRIDE, ...list.slice(1)]
}

/**
 * 从 pnpm 的判定里抠出被拒条目（名字 + 发布时间）。
 *
 * pnpm 打印的是 `<name>@<version> was published at <ISO>, within the minimumReleaseAge cutoff (<ISO>)`，
 * 但**两种形态的行内位置不同**：
 *   - 整份 lockfile 被拒：一条一行，名字在行首（前面可能有缩进）；
 *   - 精确版本无匹配：`… constraint: <name>@<version> was published at …` —— 名字在**行中**。
 * 所以这里不能用 `^\s*` 锚行首（2026-10-12 就是它让 entries 抠成空数组，
 * 于是界面上「等 X 后才不再被拒」那句话永远不显示）。
 * `\S+` 无法跨越 ` was published at ` 里的空格，所以它天然只会吃下紧邻的那个包规格。
 */
function parseEntries(output) {
  const text = String(output == null ? '' : output)
  const out = []
  const re = /(\S+) was published at ([^,\s]+), within the minimumReleaseAge cutoff/gu
  let m = re.exec(text)
  while (m !== null) {
    if (!out.some((e) => e.name === m[1])) out.push({ name: m[1], publishedAt: m[2] })
    m = re.exec(text)
  }
  return out
}

/** 全部条目满 24h 后策略自动放行：取最晚的发布时间 + 24h（本地时间由界面负责展示）。 */
function recoversAt(entries) {
  const times = (Array.isArray(entries) ? entries : [])
    .map((e) => Date.parse(e && e.publishedAt))
    .filter((t) => Number.isFinite(t))
  if (!times.length) return ''
  return new Date(Math.max(...times) + 24 * 60 * 60 * 1000).toISOString()
}

/**
 * 命令行失败的文案：**保留头部**的省略。
 *
 * 原实现是 `output.slice(-400)`（只留尾部），对 pnpm 的报错恰好最糟 —— 错误码在最前面，
 * 于是界面上出现 `TCHING_VERSION]` 这种残骸：用户既看不出是什么错，也没法拿去搜。
 * 这里改成"头 240 + 尾 200"，头部够容纳错误码与第一句话，尾部保留进度/诊断路径。
 * 输出本来就不长时原样返回（不做无意义的省略号）。
 */
const HEAD_KEEP = 240
const TAIL_KEEP = 200
function quoteForError(output) {
  const text = String(output == null ? '' : output).trim()
  if (!text) return ''
  if (text.length <= HEAD_KEEP + TAIL_KEEP + 8) return text
  return text.slice(0, HEAD_KEEP) + ' …（中略）… ' + text.slice(-TAIL_KEEP)
}

module.exports = {
  RELEASE_AGE_OVERRIDE,
  RELEASE_AGE_MARKERS,
  isViolation,
  withOverride,
  parseEntries,
  recoversAt,
  quoteForError,
}
