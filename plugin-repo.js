// plugin-repo.js — 「点插件标题 → 在系统默认浏览器打开它的 GitHub 发布页」的地址判定
// （纯函数：无 IO、无 Electron 依赖，便于单测）
//
// 只认 https://github.com/<owner>/<repo> 这一种形状：多一段路径（/issues、/releases…）、别的域名、
// http:// 或任何非 https 协议一律返回空串。调用方据此把标题渲染成不可点的纯文本 ——
// 宁可不可点，也不跳到一个猜出来或拼错的地址。
'use strict'

const REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u

/** 归一化成 https://github.com/owner/repo；不是 GitHub 仓库地址就返回空串。 */
function normalizeRepo(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
    .replace(/^git\+/u, '') // package.json 里的惯用写法：git+https://…
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '')
  const m = REPO_RE.exec(s)
  return m ? 'https://github.com/' + m[1] + '/' + m[2] : ''
}

/** 仓库的发布页地址（GitHub Releases）；拿不到仓库就是空串。 */
function releasesUrl(raw) {
  const repo = normalizeRepo(raw)
  return repo ? repo + '/releases' : ''
}

module.exports = { REPO_RE, normalizeRepo, releasesUrl }
