// service-termination.js — 终止命令与退出证据分开；依赖注入便于模拟失败，不触碰真实进程。
'use strict'

/** true=仍存活，false=确认不存在，null=无法确认（权限/采样异常）。 */
function probePid(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try { kill(pid, 0); return true } catch (err) {
    return err && err.code === 'ESRCH' ? false : null
  }
}

async function terminateProcess(pid, options) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('无法停止服务：进程 ID 不可用')
  const { send, probe, force = false, gracefulMs = 1500, verifyMs = 2000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = options
  const sample = async () => { try { return await probe() } catch { return null } }
  const waitGone = async (timeout) => {
    const deadline = now() + timeout
    for (;;) {
      if (await sample() === false) return true
      const left = deadline - now()
      if (left <= 0) return false
      await sleep(Math.min(100, left))
    }
  }
  if (await sample() === false) return { stopped: true, alreadyGone: true }
  let lastError = ''
  const dispatch = async (forced) => {
    try {
      const result = await send(forced)
      if (!result || result.ok !== true) lastError = result && result.error || '终止命令没有确认成功'
    } catch (err) { lastError = err && err.message || String(err) }
  }
  if (!force) {
    await dispatch(false)
    if (await waitGone(gracefulMs)) return { stopped: true, forced: false }
  }
  // 再取退出证据；数字 PID 的存在性本身不证明身份，调用方须在 send/probe 中复核身份。
  if (await sample() === false) return { stopped: true, alreadyGone: true }
  await dispatch(true)
  if (await waitGone(verifyMs)) return { stopped: true, forced: true }
  const state = await sample()
  const err = new Error(`无法确认 DSH 服务已停止（PID ${pid}，${state === true ? '进程仍在运行' : '无法读取进程状态'}）${lastError ? '：' + lastError : ''}`)
  err.code = 'SERVICE_STOP_FAILED'
  err.pid = pid
  throw err
}

async function waitForCompletion(pending, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(pending).then(() => true, () => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

module.exports = { probePid, terminateProcess, waitForCompletion }
