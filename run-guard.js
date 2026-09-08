// run-guard.js — 活跃运行证据（active-run marker）：检测"上次是否非受控退出"
// 借鉴 dsh-desktop 的 crash-evidence.ts：owner token + 临时文件 rename 原子发布 + 只允许 owner 清理。
// 语义：
//  - beginRun() 读取旧 marker（仅作证据），再以私有临时文件 + rename 原子发布本进程记录；
//  - marker 只认普通文件：符号链接/硬链接（nlink>1）/目录 → 启动时失败关闭（caller 捕获后记日志，不依赖证据继续）；
//  - markClean() 校验 owner 才删除：延迟退出的旧进程不会删掉新进程的 marker；幂等；
//  - 所有失败均不致命（调用方 catch），绝不改变启动结果。
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MARKER_MAX_BYTES = 8 * 1024

function noFollowFlag() {
  return process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW
}

function lstatOptional(p) {
  try {
    return fs.lstatSync(p)
  } catch (e) {
    if (e && e.code === 'ENOENT') return undefined
    throw e
  }
}

// 非普通文件（链接/硬链接/目录等）→ 抛错（fail closed）
function assertOwnedMarker(stats) {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
    throw new Error('active run marker is invalid')
  }
  if (stats.size > MARKER_MAX_BYTES) throw new Error('active run marker is too large')
}

function readStored(statePath) {
  const pathStats = lstatOptional(statePath)
  if (pathStats === undefined) return undefined
  assertOwnedMarker(pathStats)
  const fd = fs.openSync(statePath, fs.constants.O_RDONLY | noFollowFlag())
  let text
  try {
    assertOwnedMarker(fs.fstatSync(fd))
    text = fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { unreadable: true }
  }
  if (value === null || typeof value !== 'object') return { unreadable: true }
  if (typeof value.startedAt !== 'string' || typeof value.pid !== 'number' || typeof value.version !== 'string') {
    return { unreadable: true }
  }
  return {
    startedAt: value.startedAt,
    pid: value.pid,
    version: value.version,
    ...(typeof value.ownerId === 'string' ? { ownerId: value.ownerId } : {}),
  }
}

function writeCurrent(statePath, record) {
  const dir = path.dirname(statePath)
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  const dirStats = fs.lstatSync(dir)
  if (dirStats.isSymbolicLink() || !dirStats.isDirectory()) {
    throw new Error('active run directory is invalid')
  }
  try { fs.chmodSync(dir, PRIVATE_DIR_MODE) } catch { /* best effort */ }
  const tmp = path.join(dir, `.${path.basename(statePath)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE })
    try { fs.chmodSync(tmp, PRIVATE_FILE_MODE) } catch { /* best effort */ }
    fs.renameSync(tmp, statePath)
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* 已 rename 或不存在 */ }
  }
}

/**
 * 开始一次运行：读取上次证据并发布本次记录。
 * @param {string} statePath marker 绝对路径（如 ~/.dsh/dshl-logs/active-run.json）
 * @param {{startedAt: string, pid: number, version: string}} record
 * @returns {{previousRun: ({startedAt: string, pid: number, version: string} & {unreadable?: true}) | undefined, markClean: () => void}}
 */
function beginRun(statePath, record) {
  const stored = readStored(statePath)
  const previousRun = stored === undefined || 'unreadable' in stored
    ? stored
    : { startedAt: stored.startedAt, pid: stored.pid, version: stored.version }
  const ownerId = crypto.randomUUID()
  writeCurrent(statePath, {
    startedAt: record.startedAt,
    pid: record.pid,
    version: record.version,
    ownerId,
  })
  let clean = false
  return {
    previousRun,
    markClean() {
      if (clean) return
      clean = true
      let storedNow
      try {
        storedNow = readStored(statePath)
      } catch {
        return // 不可读/不安全：绝不删除未知 marker
      }
      if (storedNow === undefined || 'unreadable' in storedNow) return
      if (storedNow.ownerId !== ownerId) return // 旧进程/其他所有者的 marker：不动
      try { fs.unlinkSync(statePath) } catch { /* ENOENT 等：幂等 */ }
    },
  }
}

module.exports = { beginRun }
