// tests/recovery-plan.test.js — 恢复界面「一个状态一个动作」的判定（node --test）
//
// 这些用例钉的是**契约**，不是实现：
//   ① 可逆优先（能禁用就不卸载）；
//   ② 证明不了能做就不给按钮，且必须解释为什么（blocked 非空）—— 不许出现灰按钮；
//   ③ 动作只能来自 ACTION_IDS；
//   ④ 插件类文案必须点名 target（用户要能判断该不该点）；
//   ⑤ **错误原文不参与决定动作**（dsh-desktop 的 "Error strings are diagnostics, never
//      authority for deciding whether Desktop may mutate state."）。⑤ 用"改 line 不改 primary"
//      的形式钉死：以后谁把报错文本接进判定，这条会红。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const plan = require('../recovery-plan')

const OK_ENV = { envReady: true }

/** 造一个"目标包可禁用"的能力面。 */
function pluginCap(over) {
  return Object.assign({ envReady: true, plugin: { name: 'dsh-ui-kit', toggleable: false, disabled: false, installed: false } }, over)
}
function checkpoint(slotId = 'slot-1') {
  return { slotId, capturedAt: '2026-10-11T00:00:00.000Z' }
}

// ---------- ⑤ 最重要的一条：动作由账本决定，不由报错文本决定 ----------
test('错误原文不参与决定动作（同 capabilities 下换 line，primary 必须一致）', () => {
  const cap = pluginCap({ plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: false, installed: true } })
  const a = plan.planRecovery({ failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', line: 'failed to import loader entry x (dsh-ui-kit)', count: 1 }, capabilities: cap })
  const b = plan.planRecovery({ failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', line: 'does not provide an export named \'Foo\'', count: 1 }, capabilities: cap })
  assert.deepEqual(a.primary, b.primary, '报错原文不同不能改变动作')
  assert.equal(a.primary.id, 'disable-plugin')
  assert.equal(b.primary.id, 'disable-plugin')
})

// ---------- ① 可逆优先 ----------
test('插件可禁用时优先给「禁用」，而不是「卸载」', () => {
  const p = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', count: 1 },
    capabilities: pluginCap({ plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: false, installed: true } }),
  })
  assert.equal(p.scenario, 'plugin')
  assert.equal(p.primary.id, 'disable-plugin')
  assert.ok(p.primary.label.includes('dsh-ui-kit'), '按钮文案必须点名插件：' + p.primary.label)
  assert.match(p.primary.label, /重启服务/, '禁用后必须重启才生效，文案要写出来')
})

test('不可禁用但确实装着 → 才退到「卸载」', () => {
  const p = plan.planRecovery({
    failure: { kind: 'module-missing', target: 'dsh-heavy', count: 1 },
    capabilities: pluginCap({ plugin: { name: 'dsh-heavy', toggleable: false, disabled: false, installed: true } }),
  })
  assert.equal(p.primary.id, 'uninstall-plugin')
  assert.ok(p.primary.label.includes('dsh-heavy'))
})

test('已经禁用过了就不再给「禁用」（重复点同一个按钮等于没动作）', () => {
  const p = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', count: 3 },
    capabilities: pluginCap({ plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: true, installed: true } }),
  })
  assert.notEqual(p.primary.id, 'disable-plugin')
  assert.equal(p.primary.id, 'uninstall-plugin')
})

// ---------- ② fail-closed：证明不了就不给按钮 ----------
test('target 认不出是哪个包且没有检查点 → 不给插件按钮，但必须解释原因', () => {
  const p = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'K2Node_SomeEntry', line: 'failed to import loader entry x (K2Node_SomeEntry)', count: 1 },
    capabilities: pluginCap({}),
  })
  assert.equal(p.primary, null)
  assert.notEqual(p.blocked, '', '没有动作时必须给出原因，否则用户只看到一个空状态页')
  assert.notEqual(p.detail, '', '没有动作时要把出错原文露出来给反馈用')
})

test('认不出包但有检查点 → 退到「回退」，不假装知道是哪个插件', () => {
  const p = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'K2Node_SomeEntry', count: 1 },
    capabilities: pluginCap({ checkpoint: checkpoint() }),
  })
  assert.equal(p.primary.id, 'restore-checkpoint')
  assert.ok(p.primary.label.includes('slot-1'), '回退按钮必须点名槽位：' + p.primary.label)
})

test('settings-invalid 没有检查点 → 无动作且解释清楚', () => {
  const p = plan.planRecovery({
    failure: { kind: 'settings-invalid', target: 'C:/Users/x/.dsh/settings.yaml', reason: 'DSH 设置文件解析失败', count: 3 },
    capabilities: { envReady: true, autoRestartStopped: true },
  })
  assert.equal(p.scenario, 'settings')
  assert.equal(p.primary, null)
  assert.match(p.blocked, /检查点/)
})

test('settings-invalid 有检查点 → 回退是定点修复', () => {
  const p = plan.planRecovery({
    failure: { kind: 'settings-invalid', target: 'C:/Users/x/.dsh/settings.yaml', count: 1 },
    capabilities: { envReady: true, checkpoint: checkpoint('slot-2') },
  })
  assert.equal(p.primary.id, 'restore-checkpoint')
  assert.match(p.sub, /settings\.yaml/, '文案要点名是哪个文件')
})

// ---------- 分类到场景的映射 ----------
test('bundle-missing 给的是「回退」而不是「禁用」（包根本不在，没有可禁用的加载项）', () => {
  const p = plan.planRecovery({
    failure: { kind: 'bundle-missing', target: 'dsh-x', count: 1 },
    capabilities: { envReady: true, checkpoint: checkpoint(), plugin: { name: 'dsh-x', toggleable: false, disabled: false, installed: false } },
  })
  assert.equal(p.scenario, 'plugin')
  assert.equal(p.primary.id, 'restore-checkpoint')
  assert.match(p.sub, /dsh-x/)
})

test('运行环境未就绪优先于一切（插件修好了也起不来）', () => {
  const p = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', count: 5 },
    capabilities: { envReady: false, plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: false, installed: true } },
  })
  assert.equal(p.scenario, 'env')
  assert.equal(p.reason, 'envMissing')
  assert.equal(p.primary, null, '说明页没有"打开控制台"的权限，就不该给一颗做不到的按钮')
  assert.match(p.blocked, /运行环境/, '没有按钮就必须把该去哪儿写清楚')
})

test('bind（端口类）刻意交回既有链路，这里不产生第二个口径', () => {
  const p = plan.planRecovery({
    failure: { kind: 'bind', target: '', reason: '端口已被占用（listen EADDRINUSE）', count: 2 },
    capabilities: { envReady: true },
  })
  assert.equal(p.scenario, 'none')
  assert.equal(p.primary, null)
})

test('没有分类结果时不接管状态页（保持 offline/failed 原行为）', () => {
  const p = plan.planRecovery({ failure: null, capabilities: { envReady: true } })
  assert.equal(p.scenario, 'none')
  assert.equal(p.reason, '')
  assert.equal(p.primary, null)
  assert.equal(p.blocked, '', '没接管就不该产生任何解释文案')
})

test('识别不出的失败保留「再起一次」', () => {
  const p = plan.planRecovery({
    failure: { kind: 'unknown', line: 'boom', reason: '服务启动失败（原因未识别）', count: 1 },
    capabilities: { envReady: true },
  })
  assert.equal(p.scenario, 'unknown')
  assert.equal(p.primary.id, 'retry')
  assert.equal(p.detail, 'boom', '认不出原因时把原文露出来')
})

// 真机实测（沙箱里把 profile 的 package.json 写成非法 JSON）：
// 日志里明明有 `SyntaxError: Unexpected token '}'`，页面上却写着「服务没有输出可识别的错误。」
// ——用户拿着日志一对照就发现界面在撒谎。认不出（DSHL 的能力边界）与没输出（子进程的事实）
// 必须分开说。
test('认不出 ≠ 没输出：有原文时不许说"没有输出错误"', () => {
  const withLine = plan.planRecovery({
    failure: { kind: 'unknown', line: "SyntaxError: Unexpected token '}'", count: 1 },
    capabilities: { envReady: true },
  })
  assert.ok(!/没有输出/.test(withLine.sub), '有原文却声称没输出：' + withLine.sub)
  assert.match(withLine.sub, /认不出/, '要说清是"认不出"，不是"没有"')
  // 原文走 detail 字段（说明页渲染成「原始报错：…」那一行），不在副文案里重复
  assert.ok(withLine.detail.includes('SyntaxError'), '原文必须带出来：' + withLine.detail)

  const noLine = plan.planRecovery({
    failure: { kind: 'unknown', line: '', count: 1 },
    capabilities: { envReady: true },
  })
  assert.match(noLine.sub, /没有输出/, '确实没有输出时才这么写')
  assert.equal(noLine.detail, '')
})

// ---------- 本次运行的事实（dshl 决策 1：把自动回退显式化；G7：失败次数透明） ----------
test('单次失败不提升级（噪音），连续 >=2 次才说；自动回退与停止也要说出来', () => {
  const one = plan.planRecovery({
    failure: { kind: 'unknown', line: '', count: 1 },
    capabilities: { envReady: true },
  })
  assert.ok(!/连续出现/.test(one.sub), '第 1 次失败不该提"连续 N 次"')

  const many = plan.planRecovery({
    failure: { kind: 'unknown', line: '', count: 3 },
    capabilities: { envReady: true, autoRestartStopped: true, recoveredAt: '2026-10-11T01:00:00.000Z', backupFile: 'bak-20261011' },
  })
  assert.match(many.sub, /连续出现 3 次/)
  assert.match(many.sub, /自动恢复已停止/)
  assert.match(many.sub, /已自动回退到健康检查点/)
  assert.match(many.sub, /bak-20261011/, '要告诉用户原配置备份在哪，否则"已回退"不可复核')
})

// ---------- 多插件失败：必须告诉用户"还有别的"，否则看起来像修了没用 ----------
test('多插件失败时点名其余的包，并交代先后顺序（不新增动作）', () => {
  const p = plan.planRecovery({
    failure: {
      kind: 'plugin-tree',
      target: 'dsh-ui-kit',
      targets: ['dsh-ui-kit', 'dsh-charts', 'dsh-theme-pack'],
      line: 'x',
      count: 1,
    },
    capabilities: pluginCap({ plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: false, installed: true } }),
  })
  assert.equal(p.primary.id, 'disable-plugin', '仍然只有一个动作')
  assert.match(p.sub, /另外还有 2 个插件也加载失败/, '要点名"还有别的"：' + p.sub)
  assert.match(p.sub, /dsh-charts、dsh-theme-pack/, '要列出是哪些：' + p.sub)
  assert.match(p.sub, /本次先处理 dsh-ui-kit/, '要交代这次处理的是哪个')
  assert.match(p.sub, /这里会给出下一个/, '要交代后面还会再来一次，否则用户以为是循环')
  assert.ok(!/dsh-ui-kit、/.test(p.sub.replace('本次先处理 dsh-ui-kit', '')), '列"其余的"时不该把当前这个再列一遍')
})

test('只有一个插件失败时不提"还有别的"（避免无中生有的噪音）', () => {
  const p = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', targets: ['dsh-ui-kit'], count: 1 },
    capabilities: pluginCap({ plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: false, installed: true } }),
  })
  assert.ok(!/另外还有/.test(p.sub), '只有一个目标时不该出现"还有别的"：' + p.sub)
})

test('超过 3 个只列前 3 个并加"等"；退到回退检查点时不谈"下一个"', () => {
  const many = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'p0', targets: ['p0', 'p1', 'p2', 'p3', 'p4'], count: 1 },
    capabilities: pluginCap({ plugin: { name: 'p0', toggleable: true, disabled: false, installed: true } }),
  })
  assert.match(many.sub, /另外还有 4 个插件也加载失败（p1、p2、p3 等）/, many.sub)

  const fallback = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'K2Node_X', targets: ['K2Node_X', 'dsh-charts'], count: 1 },
    capabilities: pluginCap({ checkpoint: checkpoint() }),
  })
  assert.equal(fallback.primary.id, 'restore-checkpoint')
  assert.match(fallback.sub, /另外还有 1 个插件也加载失败（dsh-charts）/, fallback.sub)
  assert.ok(!/这里会给出下一个/.test(fallback.sub), '回退检查点不是"逐个处理包"，不该承诺下一个')
})

test('targets 缺字段 / 非数组 / 含垃圾值都不炸（main.js 的兜底路径会给不完整的对象）', () => {
  for (const targets of [undefined, null, 'dsh-x', [null, '', 0, {}], ['dsh-x', 'dsh-x']]) {
    const p = plan.planRecovery({
      failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', targets, count: 1 },
      capabilities: pluginCap({ plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: false, installed: true } }),
    })
    assert.equal(p.primary.id, 'disable-plugin', 'targets 异常不该影响动作：' + JSON.stringify(targets))
  }
})

// ---------- 导航入口（「管理插件」）：只给插件类失败 ----------
// 为什么插件类要给：失败页的动作只能处理**一个**包（分类只返回一个 target），而当前 Profile 里
// 可能同时有好几个坏的（DSH 的 AggregateError 逐条打印，见 boot-failure.js 的 pluginTargets）。
// 逐个重启去处理是 N 次循环；控制台的插件页是整份清单，一次就能看完。
// 为什么别的场景不给：设置文件坏了、运行环境没装好，去看插件清单没有用 —— 按钮必须对应真能解决
// 当前问题的动作，否则就是"说了不做"。
test('插件类失败给「管理插件」入口，其他场景不给', () => {
  const plugin = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', count: 1 },
    capabilities: pluginCap({ plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: false, installed: true } }),
  })
  assert.deepEqual(plugin.entry, { page: 'plugins', label: '管理插件' })
  assert.ok(plan.CONSOLE_PAGES.includes(plugin.entry.page), '页面 key 必须在白名单里')

  // 认不出是哪个包、连动作都没有时，入口更要有（那是用户唯一的出路）
  const noAction = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'K2Node_X', count: 1 },
    capabilities: pluginCap({}),
  })
  assert.equal(noAction.primary, null)
  assert.deepEqual(noAction.entry, { page: 'plugins', label: '管理插件' }, '没有动作时入口是唯一的出路')

  for (const [name, input] of [
    ['settings', { failure: { kind: 'settings-invalid', target: 'x', count: 1 }, capabilities: { envReady: true, checkpoint: checkpoint() } }],
    ['env', { failure: { kind: 'plugin-tree', target: 'a', count: 1 }, capabilities: { envReady: false } }],
    ['unknown', { failure: { kind: 'unknown', line: 'x', count: 1 }, capabilities: { envReady: true } }],
    ['none', { failure: null, capabilities: { envReady: true } }],
  ]) {
    assert.equal(plan.planRecovery(input).entry, null, name + ' 场景不该给插件入口')
  }
})

test('入口是**导航**不是动作：id 不许混进 ACTION_IDS，也不能带路径', () => {
  const p = plan.planRecovery({
    failure: { kind: 'plugin-tree', target: 'dsh-ui-kit', count: 1 },
    capabilities: pluginCap({ plugin: { name: 'dsh-ui-kit', toggleable: true, disabled: false, installed: true } }),
  })
  assert.ok(!plan.ACTION_IDS.includes(p.entry.page), '入口的 page 不是动作 id')
  assert.ok(!/[\\/]/.test(p.entry.page), 'page 只能是 key，不许出现路径分隔符（说明页没有指定 URL 的能力）')
  assert.match(p.entry.page, /^[a-z]+$/, 'page 必须是纯小写标识')
  assert.ok(Object.isFrozen(plan.CONSOLE_PAGES), '白名单必须冻结')
})

// ---------- ③④ 全局不变量：对每一种输入都成立 ----------
test('对任意输入：动作只能来自 ACTION_IDS 且只有一个动作位；无动作时 blocked 必非空；插件动作必点名 target', () => {
  const kinds = ['plugin-tree', 'module-missing', 'bundle-missing', 'settings-invalid', 'bind', 'unknown', '']
  const caps = [
    { envReady: true },
    { envReady: false },
    { envReady: true, checkpoint: checkpoint() },
    { envReady: true, plugin: { name: 'p', toggleable: true, disabled: false, installed: true }, checkpoint: checkpoint() },
    { envReady: true, plugin: { name: 'p', toggleable: false, disabled: false, installed: true } },
    { envReady: true, plugin: { name: 'other', toggleable: true, disabled: false, installed: true } },
  ]
  for (const kind of kinds) {
    for (const c of caps) {
      const p = plan.planRecovery({ failure: kind ? { kind, target: 'p', line: 'x', count: 2 } : null, capabilities: c })
      // 界面契约：只有一个动作位（"一个状态一个动作"）；导航入口不是动作，单独一个字段
      assert.deepEqual(Object.keys(p).sort(), ['blocked', 'detail', 'entry', 'primary', 'reason', 'scenario', 'sub', 'title'],
        '计划的字段集固定；多一个字段就意味着界面多一处要同步的地方')
      if (p.primary) {
        assert.ok(plan.ACTION_IDS.includes(p.primary.id), `未知动作 id：${p.primary.id}（kind=${kind}）`)
        assert.ok(p.primary.label && p.primary.label.length > 0, `动作缺文案：${p.primary.id}`)
        assert.ok(!/控制台|目录|文件夹/.test(p.primary.label),
          '说明页没有导航类权限（用户删过那颗按钮），文案不该承诺打开某个界面：' + p.primary.label)
      }
      if (p.scenario !== 'none' && p.primary === null) {
        assert.notEqual(p.blocked, '', `scenario=${p.scenario} 没有主按钮却没解释：kind=${kind}`)
      }
      if (p.primary !== null && p.primary !== undefined
        && (p.primary.id === 'disable-plugin' || p.primary.id === 'uninstall-plugin')) {
        assert.match(p.primary.label, /p/, '插件动作的按钮文案必须点名 target：' + p.primary.label)
      }
      // 界面契约：reason 必须是纯字母（说明页用 reason 做 key，见 tests/loading-texts.test.js）
      if (p.reason) assert.match(p.reason, /^[A-Za-z]+$/, 'reason 必须是纯字母：' + p.reason)
    }
  }
})

test('ACTION_IDS 与实现同源：冻结、无重复、且不含导航类动作', () => {
  assert.ok(Object.isFrozen(plan.ACTION_IDS))
  assert.equal(new Set(plan.ACTION_IDS).size, plan.ACTION_IDS.length)
  assert.deepEqual([...plan.ACTION_IDS].sort(),
    ['disable-plugin', 'restore-checkpoint', 'retry', 'uninstall-plugin'])
})
