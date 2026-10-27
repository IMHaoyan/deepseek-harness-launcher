// workspace-map.js — DSH 会话 → 工作区根目录的只读查询（给「Ctrl+点击相对路径文件链接」用）
//
// 背景（2026-10-27 真机第二轮）：DSH 的文件入口里只有两类能直接拿到绝对路径（绝对路径 Markdown
// 链接、deliverables 卡片）。相对路径链接和 @ 提及 chip 的 title 只有相对路径；DSH 自己的文档预览
// 头部对**文本文件**也只显示相对路径（图片等 bytes 预览才带 absolutePath），所以 preload 无法从
// DOM 还原绝对路径——但 DSH 在 ~/.dsh/storages/workspace.json 里维护了
// `tables.workspaces.<id> = { path, sessionIds }`，会话正文 DOM 上又有 data-conversation-session。
// 两者相加就能把「会话 + 相对路径」还原成绝对路径，不必打开预览。
//
// 失败一律收敛为「解析不出来」（空串）：文件缺失/损坏、会话不在映射里、路径非法 → 调用方放弃打开。
'use strict'

const fs = require('fs')
const path = require('path')

/**
 * 读取 DSH 的 workspace 存储索引；任何异常都返回 null（fail-closed）。
 * @param {string} file workspace.json 的绝对路径
 * @returns {Record<string, { path?: string, sessionIds?: string[] }> | null}
 */
function readWorkspaceIndex(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const table = data && data.tables && data.tables.workspaces
    return table && typeof table === 'object' && !Array.isArray(table) ? table : null
  } catch {
    return null
  }
}

/** 会话 id 可能带/不带 `session-` 前缀，映射里按两种形式比对。 */
function sessionIdForms(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id === '') return []
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : id
  return [id, bare, 'session-' + bare]
}

/**
 * 在 workspace 索引里找某个会话所属的工作区根目录。
 * @param {Record<string, { path?: string, sessionIds?: string[] }> | null} index
 * @param {string} sessionId
 * @returns {string} 绝对路径；找不到返回空串
 */
function workspacePathForSession(index, sessionId) {
  if (index === null) return ''
  const forms = sessionIdForms(sessionId)
  if (forms.length === 0) return ''
  for (const entry of Object.values(index)) {
    if (!entry || typeof entry !== 'object') continue
    const ids = Array.isArray(entry.sessionIds) ? entry.sessionIds : []
    if (!ids.some((id) => forms.includes(String(id)))) continue
    const cwd = typeof entry.path === 'string' ? entry.path.trim() : ''
    return cwd
  }
  return ''
}

/**
 * 把工作区相对路径拼成绝对路径；输入非法返回空串。
 * @param {string} cwd 工作区根目录
 * @param {string} relativePath 会话里的相对路径（DSH 用 `/` 分隔）
 * @returns {string}
 */
function filePathInWorkspace(cwd, relativePath) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  if (typeof relativePath !== 'string') return ''
  const relative = relativePath.trim()
  if (relative === '' || /[\u0000-\u001f\u007f]/u.test(relative)) return ''
  try {
    return path.resolve(cwd.trim(), relative.replace(/\//gu, path.sep))
  } catch {
    return ''
  }
}

/**
 * 带 mtime+size 缓存的读取器：每次 Ctrl+点击都会查一次，workspace.json 很少变。
 * 中途读取失败退回上一次成功的索引，避免一次抖动把点击吞掉。
 * @param {string} file workspace.json 的绝对路径
 */
function createWorkspaceMap(file) {
  let stamp = ''
  let index = null
  const current = () => {
    try {
      const stat = fs.statSync(file)
      const next = String(stat.mtimeMs) + ':' + String(stat.size)
      if (next !== stamp) {
        stamp = next
        const parsed = readWorkspaceIndex(file)
        if (parsed !== null) index = parsed
      }
    } catch { /* 读不到就沿用上次的索引 */ }
    return index
  }
  return {
    /** @param {string} sessionId @returns {string} */
    pathForSession(sessionId) {
      return workspacePathForSession(current(), sessionId)
    },
    /** 测试/诊断用：强制丢弃缓存。 */
    reset() {
      stamp = ''
      index = null
    },
  }
}

module.exports = { readWorkspaceIndex, workspacePathForSession, filePathInWorkspace, createWorkspaceMap }
