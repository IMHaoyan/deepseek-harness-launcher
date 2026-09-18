// changelog.js — DSHL 各版本更新内容（数据源：GitHub Releases）。
//
// 为什么在主进程拉而不是页面里 fetch：
//   更新窗口页面是 file:// 协议，渲染进程直接请求 api.github.com 会被 CORS + 缺失 User-Agent 挡掉
//   （实测：PowerShell/主进程可达，渲染层拿不到）。放主进程还有两个好处：
//     - 请求走 Electron 会话，用户的代理设置自动生效
//     - 页面只负责渲染，符合「主进程持有数据、页面只读」的既有分工
//
// 行为：只读公开 API，不需要 token；结果缓存 12 小时；失败向上抛，由调用方决定缓存兜底还是报错。
'use strict'

const { net } = require('electron')

const RELEASES_API = 'https://api.github.com/repos/IMHaoyan/deepseek-harness-launcher/releases?per_page=100'
const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12 小时
const REQUEST_TIMEOUT_MS = 15 * 1000
const MAX_VERSIONS = 30
const LAUNCHER_REPO = 'IMHaoyan/deepseek-harness-launcher'
const DSH_REPO = 'deepseek-ai/deepseek-harness'

let cache = { at: 0, releases: [] }
let inflight = null

/**
 * HTTP 失败文案（纯函数，便于测试）。
 *
 * GitHub 公开 API 是未认证配额：每小时 60 次/IP，用光了就是 403（响应头 x-ratelimit-remaining=0）。
 * 只说「HTTP 403」会让用户以为仓库没了或网络坏了 —— 这里把"限流"和"预计恢复时间（按本地时间）"
 * 说清楚：页面会把这行原文显示给用户。其余状态码保持原样，不编造原因。
 */
function httpErrorText(statusCode, headers) {
  const code = Number(statusCode) || 0
  const get = (name) => {
    const h = headers || {}
    const v = h[name] !== undefined ? h[name] : h[String(name).toLowerCase()]
    if (Array.isArray(v)) return String(v[0] === undefined ? '' : v[0])
    return v === undefined || v === null ? '' : String(v)
  }
  const remaining = get('x-ratelimit-remaining')
  if ((code === 403 || code === 429) && (code === 429 || remaining === '0')) {
    const reset = Number(get('x-ratelimit-reset')) || 0
    const at = reset > 0 ? new Date(reset * 1000) : null
    // 无该头或时钟异常时只说限流，不编恢复时间
    const when = at && !Number.isNaN(at.getTime())
      ? at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : ''
    return `HTTP ${code}（GitHub API 限流：未认证每小时 60 次/IP${when ? `，约 ${when} 后恢复` : ''}）`
  }
  return 'HTTP ' + code
}

/** 主进程里取 JSON（net 模块自动带 Electron 的会话与代理配置）。 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(value)
    }
    let timer = null
    try {
      const request = net.request({
        method: 'GET',
        url,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'DSHL', // GitHub API 要求带 UA，否则 403
        },
      })
      request.on('response', (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode < 200 || response.statusCode >= 300) {
            done(new Error(httpErrorText(response.statusCode, response.headers)))
            return
          }
          try {
            done(null, JSON.parse(text))
          } catch (err) {
            done(new Error('返回内容不是合法 JSON'))
          }
        })
        response.on('error', (err) => done(err))
      })
      request.on('error', (err) => done(err))
      timer = setTimeout(() => {
        try { request.abort() } catch { /* noop */ }
        done(new Error('请求超时'))
      }, REQUEST_TIMEOUT_MS)
      request.end()
    } catch (err) {
      done(err)
    }
  })
}

function normalize(list) {
  const out = []
  for (const rel of Array.isArray(list) ? list : []) {
    if (!rel || rel.draft) continue
    const version = String(rel.tag_name || rel.name || '').replace(/^v/i, '').trim()
    if (!version) continue
    out.push({
      version,
      date: rel.published_at || '',
      prerelease: !!rel.prerelease,
      url: rel.html_url || '',
      body: String(rel.body || ''),
    })
    if (out.length >= MAX_VERSIONS) break
  }
  return out
}

/**
 * 取各版本更新内容（最新在前）。
 * @param {boolean} force 忽略缓存强刷
 * @returns {Promise<{releases: Array, cached: boolean, at: number, error?: string}>}
 */
async function getReleases(force = false) {
  const now = Date.now()
  if (!force && cache.releases.length && now - cache.at < CACHE_TTL_MS) {
    return { releases: cache.releases, cached: true, at: cache.at }
  }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const raw = await fetchJson(RELEASES_API)
      const releases = normalize(raw)
      cache = { at: Date.now(), releases }
      return { releases, cached: false, at: cache.at }
    } catch (err) {
      const message = (err && err.message) || String(err)
      // 有旧缓存就先用着：更新窗口宁可显示稍旧的内容，也不要整块空掉
      if (cache.releases.length) {
        return { releases: cache.releases, cached: true, at: cache.at, error: message }
      }
      throw new Error(message)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * 构造 GitHub 某个具体版本的 Release 页面地址。
 * DSH 仓库的 tag 带 `dsh-` 前缀（例如 dsh-v0.1.6-alpha.2），DSHL 使用普通 `v` 前缀。
 * 没有版本号时回落到该仓库的 Releases 列表，不拼一个必然 404 的空 tag。
 */
function releasePageUrl(repo, version, tagPrefix = 'v') {
  const normalized = String(version || '').trim().replace(/^v/i, '')
  const base = `https://github.com/${repo}/releases`
  return normalized ? `${base}/tag/${tagPrefix}${encodeURIComponent(normalized)}` : base
}

function launcherReleaseUrl(version) {
  return releasePageUrl(LAUNCHER_REPO, version, 'v')
}

function dshReleaseUrl(version) {
  return releasePageUrl(DSH_REPO, version, 'dsh-v')
}

module.exports = { getReleases, httpErrorText, RELEASES_API, MAX_VERSIONS, LAUNCHER_REPO, DSH_REPO, releasePageUrl, launcherReleaseUrl, dshReleaseUrl }
