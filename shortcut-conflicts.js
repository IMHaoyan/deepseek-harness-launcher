// shortcut-conflicts.js — 从插件 client bundle 的源码字面量里找「默认快捷键冲突」（纯函数）
//
// 为什么需要它：DSH 的快捷键服务在注册命令时，会把新命令的默认绑定和已注册命令逐平台比对，
// 重叠就抛 `Conflicting shortcut defaults: <新命令> and <已有命令> (<runtime>:<platform>)`。
// 但这条错误**未必出现在任何可达日志里**：
//   - 第三方插件常把 register 放进 try/catch，用 console.info 吞掉（用量与计费就是这样）；
//   - 如果失败发生在 effect 里，cordis 只更新内部状态，控制台和 stderr 都可能什么都没有，
//     失败页只剩 `pending (waiting for service: uiWorkspace)`。
// 这时 dshl 能拿到的唯一事实是**插件自己声明的默认绑定**。本模块只做两件事：
//   1) 从 client bundle 里提取 [{id, defaults:{<runtime:platform>: {code, modifiers}}}]
//   2) 找同一平台下绑定完全相同的两条命令
// 归因只认“命令 id + 平台 + 按键”三件事，不猜插件语义。
//
// 边界：只解析 minified 代码里 `defaults:{...}` 这种对象字面量（官方 client 与主流量三方插件
// 都是这个形态）。解析不到就返回空数组 —— 宁可少报，不误报。
'use strict'

const DEFAULT_KEY_RE = /["']((?:desktop|web):(?:macos|windows|linux))["']\s*:\s*\{code\s*:\s*['"`]([^'"`]+)['"`]\s*,\s*modifiers\s*:\s*\[([^\]]*)\]\s*\}/gu
const ID_BEFORE_RE = /id\s*:\s*['"`]([^'"`]+)['"`]/gu
const DEFAULT_START_RE = /defaults\s*:\s*\{/gu

/** 按花括号配对截出 defaults 的对象字面量（不 eval 任何插件代码）。 */
function sliceObject(text, openAt) {
  let depth = 0
  for (let i = openAt; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(openAt, i + 1)
    }
  }
  return ''
}

/** 修饰键归一化：顺序无关，去空白与引号。 */
function normalizedMods(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.replace(/['"`\s]/gu, ''))
    .filter(Boolean)
    .sort()
    .join('+')
}

/**
 * 提取一个 client bundle 里的快捷键命令。
 * 命令 id 必须在 defaults 之前 800 字符内 —— minified 的 `register({id:…, label:…, defaults:{…}})`
 * 都满足；找不到 id 的条目直接丢弃（无法归因的东西不进结果）。
 * @param {string} text
 * @returns {Array<{id: string, bindings: Array<{combo: string, key: string}>}>}
 */
function extractShortcutCommands(text) {
  const src = String(text || '')
  if (!src || src.length > 8 * 1024 * 1024) return []
  const out = []
  DEFAULT_START_RE.lastIndex = 0
  let m
  while ((m = DEFAULT_START_RE.exec(src))) {
    const openAt = src.indexOf('{', m.index)
    const obj = sliceObject(src, openAt)
    if (!obj) continue
    const before = src.slice(Math.max(0, m.index - 800), m.index)
    const ids = [...before.matchAll(ID_BEFORE_RE)]
    const id = ids.length ? String(ids[ids.length - 1][1] || '') : ''
    if (!id) continue
    const bindings = []
    const seen = new Set()
    DEFAULT_KEY_RE.lastIndex = 0
    let b
    while ((b = DEFAULT_KEY_RE.exec(obj))) {
      const combo = b[1]
      const key = b[2] + '|' + normalizedMods(b[3])
      if (seen.has(combo + '\u0000' + key)) continue
      seen.add(combo + '\u0000' + key)
      bindings.push({ combo, key })
    }
    if (bindings.length) out.push({ id, bindings })
  }
  return out
}

/**
 * 找默认绑定冲突。
 * @param {Array<{npm: string, official: boolean, commands: Array<{id:string,bindings:Array}>}>} entries
 * @returns {Array<{npm: string, otherNpm: string, commandId: string, otherId: string, combo: string, key: string}>}
 *   每个涉事的三方插件只报一条（同一对命令、同一平台）。
 */
function findDefaultConflicts(entries) {
  const list = Array.isArray(entries) ? entries : []
  const flat = []
  for (const e of list) {
    const npm = String((e && e.npm) || '')
    if (!npm || !Array.isArray(e.commands)) continue
    for (const c of e.commands) {
      if (!c || !c.id || !Array.isArray(c.bindings)) continue
      const map = new Map()
      for (const b of c.bindings) if (b && b.combo && b.key) map.set(b.combo, b.key)
      if (map.size) flat.push({ npm, official: e.official === true, id: c.id, map })
    }
  }
  const out = []
  const seen = new Set()
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i]
      const b = flat[j]
      if (a.official && b.official) continue // 官方内部不可能冲突（DSH 自己就会先炸）
      const third = a.official ? b : a
      const other = a.official ? a : b
      if (!a.official && !b.official) {
        // 两个三方插件互撞：各自都可能成为“后注册失败”的那一个，两边都列为排查对象
      }
      for (const [combo, key] of a.map) {
        if (b.map.get(combo) !== key) continue
        // 同一对命令在多个平台可能都撞（插件通常给所有平台同一个默认值）。
        // 归因只需要一条可读理由，这里只保留第一个平台，避免卡片重复三遍同一件事。
        const pairKey = [third.npm, other.npm, third.id, other.id].join('\u0000')
        if (seen.has(pairKey)) continue
        seen.add(pairKey)
        out.push({
          npm: third.npm,
          otherNpm: other.npm,
          commandId: third.id,
          otherId: other.id,
          combo,
          key,
        })
        if (!a.official && !b.official) {
          const reverse = [b.npm, a.npm, b.id, a.id].join('\u0000')
          if (!seen.has(reverse)) {
            seen.add(reverse)
            out.push({
              npm: b.npm,
              otherNpm: a.npm,
              commandId: b.id,
              otherId: a.id,
              combo,
              key,
            })
          }
        }
      }
    }
  }
  return out
}

module.exports = { extractShortcutCommands, findDefaultConflicts, normalizedMods }
