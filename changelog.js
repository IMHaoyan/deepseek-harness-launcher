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

let cache = { at: 0, releases: [] }
let inflight = null

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
            done(new Error('HTTP ' + response.statusCode))
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

module.exports = { getReleases, RELEASES_API, MAX_VERSIONS }