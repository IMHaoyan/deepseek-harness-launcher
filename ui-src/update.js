// update.js — DSHL 更新窗口渲染。
//
// 数据来源全部走更新窗口专用 dshBridge：
//   - 主进程推送：onUpdate → { launcher, dsh }
//   - 首帧兜底：cmd('updaterGetState') / cmd('getState')，避免推送到达前空白
//   - 动作：cmd('updaterCheck' | 'updaterInstall' | 'dshCheckNow' | 'dshUpdateNow')
//   - 更新内容：cmd('changelogGet') 走主进程（changelog.js → GitHub Releases，带缓存）
//   - 所有 cmd 都走 update:cmd；此窗口不属于 dsh:cmd 的 console/shell 信任域
//
// 版本与更新动作的口径与「通用」页那两行完全一致：启动器负责 DSHL 自身，DSH 更新全手动。
'use strict'

const $ = (id) => document.getElementById(id)

// 更新内容：由主进程 changelog.js 从 GitHub Releases 取（渲染层是 file:// 页面，直连 API 会被 CORS/UA 挡掉）
const MAX_VERSIONS = 30

// 动作进行中时抑制状态回跳（下载进度推送会让状态在 downloading 间抖动）
const busy = { launcher: false, dsh: false }
const released = { launcher: false, dsh: false }

/** 更新窗口的所有命令都走独立通道 update:cmd；主进程只放行该窗口需要的一组动作。 */
async function cmd(name, value) {
  try {
    const result = await window.dshBridge.upd(name, value)
    return result ? JSON.parse(result) : null
  } catch (err) {
    console.error('[update] update-bridge error:', err)
    return null
  }
}
const cmdUpd = cmd

// ---------- 主题：跟随系统（窗口不带主题设置，控制台的主题开关也不影响这里） ----------
try {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const applyTheme = () => { document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light') }
  applyTheme()
  mq.addEventListener('change', applyTheme)
} catch { /* 老版 Electron 忽略 */ }

// ---------- 版本行 ----------

const LAUNCHER_STATUS = {
  checking: '检查中…',
  downloading: '下载中',
  downloaded: '已下载',
  'up-to-date': '已是最新',
  error: '检查失败',
  dev: '开发模式（不检查更新）',
  idle: '未检查',
}

const DSH_STATUS = {
  checking: '检查中…',
  available: '有新版本',
  updating: '更新中…',
  'up-to-date': '已是最新',
  error: '检查失败',
  idle: '未检查',
}

function renderVersion(el, current, latest, pending) {
  el.textContent = current ? 'v' + current : '-'
  const shown = latest && latest !== current
  if (!shown) return
  const span = document.createElement('span')
  span.className = 'upd-new' + (pending ? ' upd-new-pending' : '')
  span.textContent = (pending ? '→ v' : '，可更新到 v') + latest
  el.appendChild(span)
}

function renderLauncher(state) {
  const s = state || {}
  const status = s.status || 'idle'
  if (busy.launcher && status !== 'downloading' && status !== 'downloaded' && s.error) busy.launcher = false
  if (status === 'downloaded' && s.latest) released.launcher = true
  if (busy.launcher && status === 'downloading') released.launcher = false

  renderVersion($('updLauncherVersion'), s.current, released.launcher ? s.latest : '', status === 'downloading')

  const box = $('updLauncherActions')
  box.textContent = ''

  if (busy.launcher) {
    const note = document.createElement('span')
    note.className = 'upd-note'
    note.textContent = status === 'downloading' ? `下载中 ${s.percent || 0}%…` : '处理中…'
    box.appendChild(note)
    return
  }

  if (status === 'downloaded' && s.latest) {
    const btn = document.createElement('button')
    btn.className = 'upd-btn primary'
    btn.textContent = `更新到 v${s.latest}`
    btn.addEventListener('click', async () => {
      released.launcher = false
      busy.launcher = false
      btn.disabled = true
      btn.textContent = '正在安装…'
      await cmd('updaterInstall')
    })
    box.appendChild(btn)
    return
  }

  if (status === 'downloading') {
    const note = document.createElement('span')
    note.className = 'upd-note'
    note.textContent = `下载中 ${s.percent || 0}%…`
    box.appendChild(note)
    return
  }

  const note = document.createElement('span')
  const tone = (status === 'up-to-date' || status === 'dev') ? ' upd-note ok' : ' upd-note'
  note.className = tone.trim()
  note.textContent = LAUNCHER_STATUS[status] || LAUNCHER_STATUS.idle
  box.appendChild(note)
}

function renderDsh(state) {
  const s = state || {}
  const status = s.status || 'idle'
  if (busy.dsh && status === 'available' && s.error) busy.dsh = false

  renderVersion($('updDshVersion'), s.current, status === 'available' ? s.latest : '', status === 'updating')

  const box = $('updDshActions')
  box.textContent = ''

  if (busy.dsh || status === 'updating') {
    const note = document.createElement('span')
    note.className = 'upd-note'
    note.textContent = '更新中…'
    box.appendChild(note)
    return
  }

  if (status === 'available' && s.latest) {
    const btn = document.createElement('button')
    btn.className = 'upd-btn primary'
    btn.textContent = `更新到 v${s.latest}`
    btn.addEventListener('click', async () => {
      busy.dsh = true
      released.dsh = true
      btn.disabled = true
      btn.textContent = '正在更新…'
      await cmd('dshUpdateNow')
    })
    box.appendChild(btn)
    return
  }

  const note = document.createElement('span')
  note.className = 'upd-note' + ((status === 'up-to-date') ? ' ok' : '')
  note.textContent = DSH_STATUS[status] || DSH_STATUS.idle
  box.appendChild(note)
}

/** 两者都有更新时的顺序建议：先更启动器（内含更稳的 DSH 更新链路），再更 DSH。 */
function renderOrderHint(state) {
  const el = $('updOrderHint')
  const launcherPending = !!(state && state.launcher && state.launcher.latest)
  const dshPending = !!(state && state.dsh && state.dsh.latest)
  if (!launcherPending || !dshPending) {
    el.classList.add('hidden')
    el.textContent = ''
    return
  }
  el.classList.remove('hidden')
  el.textContent = '建议先更新启动器：DSHL 负责 DSH 的更新与启动收尾，新版本可能包含更稳的更新链路；更新完启动器后再更新 DSH。'
}

function renderAll(state) {
  renderLauncher(state.launcher)
  renderDsh(state.dsh)
  renderOrderHint(state)
}

// ---------- 更新内容（GitHub Releases） ----------

function renderInline(parent, text) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m = pattern.exec(text)
  while (m) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)))
    const token = m[0]
    if (token.startsWith('`')) {
      const code = document.createElement('code')
      code.textContent = token.slice(1, -1)
      parent.appendChild(code)
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong')
      strong.textContent = token.slice(2, -2)
      parent.appendChild(strong)
    } else {
      const link = token.match(/\[([^\]]+)\]\(([^)]+)\)/)
      if (link && /^https:\/\//i.test(link[2])) {
        const a = document.createElement('a')
        a.textContent = link[1]
        a.href = link[2]
        a.target = '_blank'
        a.rel = 'noreferrer noopener'
        parent.appendChild(a)
      } else {
        parent.appendChild(document.createTextNode(token))
      }
    }
    last = pattern.lastIndex
    m = pattern.exec(text)
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
}

/** 去掉正文开头的版本标题（Release 正文常以「## v1.3.1 — 2026-09-13」开头，
 *  而列表里已经画了自己的版本头 + 日期，重复一遍只是噪音）。 */
function stripLeadingVersionHeading(body) {
  const lines = String(body || '').split(/\r?\n/)
  let i = 0
  while (i < lines.length && !lines[i].trim()) i += 1
  if (i >= lines.length) return ''
  const first = lines[i].trim()
  // 只吃「纯版本标题」：## 开头、含 vX.Y.Z、整行不含其它说明文字
  if (/^#{1,6}\s+v?\d+\.\d+\.\d+[^\n]*$/iu.test(first)) {
    i += 1
    while (i < lines.length && (!lines[i].trim() || /^-{3,}$/u.test(lines[i].trim()))) i += 1
  }
  return lines.slice(i).join('\n')
}

/** Release 正文是受控 Markdown（约定：**分组** + "- 一条"）。这里按需渲染，
 *  用 document.createTextNode / createElement 构造，绝不使用 innerHTML。 */
function renderMarkdown(body) {
  const frag = document.createDocumentFragment()
  let list = null
  for (const raw of stripLeadingVersionHeading(body).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) { list = null; continue }
    if (/^#{1,6}\s+/.test(line)) {
      list = null
      const p = document.createElement('p')
      const strong = document.createElement('strong')
      strong.textContent = line.replace(/^#{1,6}\s+/, '')
      p.appendChild(strong)
      frag.appendChild(p)
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      if (!list) {
        list = document.createElement('ul')
        frag.appendChild(list)
      }
      const li = document.createElement('li')
      renderInline(li, line.replace(/^[-*]\s+/, ''))
      list.appendChild(li)
      continue
    }
    list = null
    const p = document.createElement('p')
    renderInline(p, line)
    frag.appendChild(p)
  }
  return frag
}

/** 主进程已归一化（version/date/body/url/prerelease）；这里兼容原始 Release 结构以便单测。 */
function releaseVersionOf(rel) {
  return String(rel.version || rel.tag_name || rel.name || '').replace(/^v/i, '').trim()
}

function formatDate(iso) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function renderReleases(releases) {
  const box = $('updChangelog')
  box.textContent = ''
  if (!releases.length) {
    const empty = document.createElement('div')
    empty.className = 'upd-empty'
    empty.textContent = '还没有发布记录。'
    box.appendChild(empty)
    return
  }
  for (const rel of releases) {
    const item = document.createElement('article')
    item.className = 'upd-release'

    const head = document.createElement('div')
    head.className = 'upd-release-head'
    const ver = document.createElement('span')
    ver.className = 'upd-release-ver'
    ver.textContent = 'v' + releaseVersionOf(rel)
    head.appendChild(ver)
    if (rel.prerelease) {
      const tag = document.createElement('span')
      tag.className = 'upd-release-tag'
      tag.textContent = '预发布'
      head.appendChild(tag)
    }
    const date = document.createElement('span')
    date.className = 'upd-release-date'
    date.textContent = formatDate(rel.date || rel.published_at)
    head.appendChild(date)
    item.appendChild(head)

    const body = document.createElement('div')
    body.className = 'upd-release-body'
    const text = String(rel.body || '').trim()
    if (text) body.appendChild(renderMarkdown(text))
    else {
      const p = document.createElement('p')
      p.textContent = '（这个版本没有写更新说明）'
      body.appendChild(p)
    }
    item.appendChild(body)
    box.appendChild(item)
  }
}

let changelogLoaded = false

async function loadChangelog(force) {
  if (changelogLoaded && !force) return
  const status = $('updChangelogStatus')
  status.textContent = '加载中…'
  try {
    const r = await cmdUpd('changelogGet', { force: !!force })
    if (!r || !r.ok) throw new Error((r && r.error) || '主进程未返回更新内容')
    const releases = (Array.isArray(r.releases) ? r.releases : []).slice(0, MAX_VERSIONS)
    changelogLoaded = true
    renderReleases(releases)
    const more = releases.length === MAX_VERSIONS ? `（只看最近 ${MAX_VERSIONS} 个版本）` : ''
    // 主进程用旧缓存兜底时如实说明，别让用户以为这就是最新列表
    status.textContent = r.error
      ? `共 ${releases.length} 个版本（离线，显示上次缓存）`
      : `共 ${releases.length} 个版本${more}`
  } catch (err) {
    const box = $('updChangelog')
    box.textContent = ''
    const empty = document.createElement('div')
    empty.className = 'upd-empty error'
    empty.textContent = '无法读取更新内容：' + ((err && err.message) || String(err))
    box.appendChild(empty)
    status.textContent = '读取失败：' + ((err && err.message) || String(err))
    const retry = document.createElement('button')
    retry.className = 'upd-btn'
    retry.textContent = '重试'
    retry.style.marginTop = '8px'
    retry.addEventListener('click', () => void loadChangelog(true))
    box.appendChild(retry)
  }
}

// ---------- 事件与启动 ----------

$('btnUpdRefresh').addEventListener('click', async () => {
  const btn = $('btnUpdRefresh')
  btn.disabled = true
  try {
    await cmd('updaterCheck')
    await cmd('dshCheckNow')
    await loadChangelog(true)
  } finally {
    btn.disabled = false
  }
})

window.dshBridge.onUpdate((json) => {
  try {
    const state = typeof json === 'string' ? JSON.parse(json) : json
    if (state) renderAll(state)
  } catch (err) {
    console.error('[update] onUpdate parse error:', err)
  }
})

// 首帧兜底：推送可能在本页加载完成前就发出去了（主进程有排队，这里再取一次做保险）
void (async () => {
  try {
    const launcher = await cmd('updaterGetState')
    const full = await cmd('getState')
    const env = (full && full.env) || {}
    renderAll({
      launcher: launcher || {},
      dsh: Object.assign({}, (full && full.dshUpdate) || {}, {
        current: (env.dsh && env.dsh.version) || '',
      }),
    })
  } catch (err) {
    // 首帧失败不能静默：把原因写进版本行，自检与用户都能看到
    console.error('[update] initial state failed:', err)
    const el = $('updLauncherVersion')
    if (el) el.textContent = '读取失败'
  }
  void loadChangelog(false)
})()