// bridge-patch.js — 「手机连接」npm 版的运行时补丁
//
// 背景（2026-10-27）：dshl 不再随包分发 @agents-anywhere/dsh-bridge-next，改成像其它预装插件一样
// 从 npm 安装。但 npm 2.0.2 的 UI 还带着三个上游问题，直接装上会变成：
//   ① 入口注册回左侧边栏（期望：设置左栏「手机连接」，并直接铺开面板）；
//   ② close() 在页面里出现 >1 个 role="dialog" 时直接 return → 放进设置弹层后 X/ESC/遮罩全失效；
//   ③ 查询 Agents Anywhere 桌面端进程时，PowerShell 无匹配会输出空串，插件 JSON.parse("") 抛错，
//      误报「无法确认…请检查进程查询权限」，登录表单不出现。
//
// 本模块在「安装/更新后」与「每次启动服务前」幂等重打这三个补丁；只做最小文本替换 + 写回前
// node --check 语法自检，任何一步失败都只记日志、保留原文件（fail-open：最坏情况回到上游原行为，
// 不会让插件装不上）。上游修复后锚点消失，对应补丁自动跳过。
'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const PACKAGE = '@agents-anywhere/dsh-bridge-next'

// ---------- ① 入口：sidebar.footer.action → settings.section（直接铺开面板 + 叫「手机连接」） ----------
const MARKER_SETTINGS_SECTION = 'services.slots.inject("settings.section"'
const ENTRY_RE = /services\.slots\.inject\("sidebar\.footer\.action"[\s\S]*?"agentsAnywhereOnboarding\.sidebar"\);/
const ENTRY_REPLACEMENT = `services.slots.inject("settings.section", () => services.slots.register({
				name: "settings.section",
				id: "agents-anywhere",
				order: 120,
				locale: LOCALE_NS,
				label: () => t("手机连接"),
				inject: () => ({ host })
			}, SettingsSectionEntry)), "agentsAnywhereOnboarding.settings");
			function SettingsSectionEntry({ host: h, t: tt }) {
				return (0, react_jsx_runtime.jsx)(ConnectionEntry, {
					t: tt,
					host: h,
					wide: true,
					page: true,
					renderTrigger: () => null
				});
			}`

// ---------- ④ 设置页里直接铺开面板（不弹 Modal） ----------
const PAGE_PANEL = `\t\tfunction ConnectionPagePanel({ page, open, onClose, title, closeLabel, className, contentClassName, children }) {
			if (page) {
				return (0, react_jsx_runtime.jsx)("div", {
					className: entry_module_css_default.dialogContent,
					children
				});
			}
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose,
				title,
				closeLabel,
				className,
				contentClassName,
				children
			});
		}
`

// ---------- ② 嵌套在设置弹层里也能关闭 ----------
const DIALOG_GUARD = 'if (document.querySelectorAll("[role=\\"dialog\\"]").length > 1) return;'
const DIALOG_GUARD_REPLACEMENT = '/* [dshl] 嵌套在设置弹层里时也允许关闭（不再按页面 dialog 数量拒绝） */'

// ---------- ③ 进程查询空输出按空列表处理 ----------
const EMPTY_JSON_PARSE = 'const result = JSON.parse(stdout.replace(/^\\uFEFF/, "").trim());'
const EMPTY_JSON_REPLACEMENT = 'const outputText = stdout.replace(/^\\uFEFF/, "").trim(); const result = outputText === "" ? [] : JSON.parse(outputText);'
const EMPTY_JSON_MARKER = 'outputText === "" ? [] : JSON.parse(outputText)'

function packageDir(profileDir) {
  return path.join(String(profileDir || ''), 'node_modules', ...PACKAGE.split('/'))
}

function readVersion(dir) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}

/** 写回前的语法自检：client 按 CJS、host 按 ESM。 */
function syntaxCheck(text, dir, ext) {
  const tmp = path.join(dir, `.bridge-patch-check-${process.pid}.${ext}`)
  try {
    fs.writeFileSync(tmp, text)
    const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
    if (check.status === 0) return { ok: true }
    const lines = String(check.stderr || '').split('\n').map((line) => line.trim())
    const reason = lines.find((line) => line.includes('SyntaxError'))
      || lines.find((line) => line !== '' && line !== '^')
      || 'syntax check failed'
    return { ok: false, reason }
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* noop */ }
  }
}

function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.bridge-patch-write-${process.pid}.tmp`)
  fs.writeFileSync(tmp, text)
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.writeFileSync(file, text)
    try { fs.rmSync(tmp, { force: true }) } catch { /* noop */ }
  }
}

/** client bundle：入口/页面形态/嵌套弹层关闭。 */
function patchClient(dir, version, applied, skipped) {
  const file = path.join(dir, 'lib', 'client.js')
  if (!fs.existsSync(file)) {
    skipped.push('client.js 不存在')
    return
  }
  const original = fs.readFileSync(file, 'utf8')
  let text = original

  if (!text.includes(MARKER_SETTINGS_SECTION)) {
    if (ENTRY_RE.test(text)) {
      text = text.replace(ENTRY_RE, ENTRY_REPLACEMENT)
      applied.push('settings-entry-page')
    } else {
      skipped.push('入口锚点未找到（上游结构变化）')
    }
  } else if (!text.includes('id: "agents-anywhere"')) {
    skipped.push('bundle 自带 settings.section（不是本补丁的入口），不改入口')
  }

  const connectionOpen = 'function ConnectionEntry({ wide, host, t, renderTrigger }) {\n\t\t\tconst [open, setOpen] = (0, react.useState)(false);'
  if (text.includes(connectionOpen)) {
    text = text.replace(
      connectionOpen,
      PAGE_PANEL + '\t\tfunction ConnectionEntry({ wide, host, t, renderTrigger, page }) {\n\t\t\tconst [open, setOpen] = (0, react.useState)(page === true);',
    )
    applied.push('inline-panel')
  }
  const modalCall = '}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {\n\t\t\t\topen,'
  if (text.includes(modalCall)) {
    text = text.replace(
      modalCall,
      '}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectionPagePanel, {\n\t\t\t\tpage,\n\t\t\t\topen,',
    )
    applied.push('inline-panel-modal')
  }
  if (text.includes(DIALOG_GUARD)) {
    text = text.replace(DIALOG_GUARD, DIALOG_GUARD_REPLACEMENT)
    applied.push('nested-dialog-close')
  }

  if (text === original) return
  const check = syntaxCheck(text, path.join(dir, 'lib'), 'cjs')
  if (!check.ok) {
    skipped.push('client 语法自检失败：' + check.reason)
    return
  }
  writeAtomic(file, text)
}

/** host bundle：进程查询空输出按空列表处理。 */
function patchHost(dir, version, applied, skipped) {
  const file = path.join(dir, 'lib', 'index.js')
  if (!fs.existsSync(file)) {
    skipped.push('lib/index.js 不存在')
    return
  }
  const original = fs.readFileSync(file, 'utf8')
  if (original.includes(EMPTY_JSON_MARKER)) return
  if (!original.includes(EMPTY_JSON_PARSE)) {
    skipped.push('进程查询锚点未找到（上游结构变化）')
    return
  }
  const text = original.replace(EMPTY_JSON_PARSE, EMPTY_JSON_REPLACEMENT)
  const check = syntaxCheck(text, path.join(dir, 'lib'), 'mjs')
  if (!check.ok) {
    skipped.push('host 语法自检失败：' + check.reason)
    return
  }
  writeAtomic(file, text)
  applied.push('empty-process-query')
}

/**
 * 对 profile 里已安装的 npm 版「手机连接」打补丁（幂等）。
 * @param {{ profileDir: string, log?: (line: string) => void }} opts
 * @returns {{ ok: boolean, version: string, applied: string[], skipped: string[] }}
 */
function apply(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const result = { ok: true, version: '', applied: [], skipped: [] }
  const dir = packageDir(opts.profileDir)
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    result.skipped.push('未安装')
    return result
  }
  // 旧版随包 payload 是内容寻址缓存（bridge-payloads，node_modules 指向它）：不往缓存里写，
  // 交给启动时的一次性迁移换成 npm 版本后再打补丁。
  let real = dir
  try { real = fs.realpathSync(dir) } catch { /* 按普通安装处理 */ }
  if (real.split(path.sep).includes('bridge-payloads')) {
    result.skipped.push('旧 payload 缓存（等待迁移到 npm 版本）')
    return result
  }
  result.version = readVersion(dir)
  try {
    patchClient(dir, result.version, result.applied, result.skipped)
    patchHost(dir, result.version, result.applied, result.skipped)
  } catch (e) {
    result.ok = false
    result.skipped.push((e && e.message) || String(e))
  }
  if (result.applied.length) log('bridge-patch: 已打补丁 v' + result.version + '：' + result.applied.join(', '))
  else if (result.skipped.length) log('bridge-patch: 未改动 v' + result.version + '（' + result.skipped.join('；') + '）')
  return result
}

module.exports = {
  PACKAGE,
  apply,
  // 纯函数/常量（测试用）
  packageDir,
  ENTRY_RE,
  DIALOG_GUARD,
  EMPTY_JSON_PARSE,
}
