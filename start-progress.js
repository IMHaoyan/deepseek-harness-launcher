// start-progress.js — 状态说明页的"第几步/共几步"模型（纯数据 + 纯函数，可单测）
//
// 说明页（ui-src/loading.html）由主进程加载，页面自己拿不到服务状态，只能靠主进程推的
// loading:progress 知道进度。这里只管：某个 reason 有哪些步骤、里程碑键 → 文案。
// 打点在真实检查处（handleStart / startServer / markReady / 各流程自己的段），键不在表里就自动忽略，
// 所以 handleStart/startServer 这些共用代码可以无脑打点。
'use strict'

const LABELS = {
  stop: '停止旧服务',
  env: '检查运行环境',
  port: '检查端口占用',
  spawn: '启动服务进程',
  ready: '等待服务就绪',
  load: '载入界面',
  install: '安装新版本（npm）',
  restore: '写回健康检查点',
  reload: '重载配置并重新探测环境',
}

// reason 与 ui-src/loading.js 的 TEXTS 键一一对应；表里没有的 reason（offline/failed/blocked/auth）
// 不显示步骤行 —— 那些页面要的是用户动作，不是进度。
const PLANS = {
  start: ['env', 'port', 'spawn', 'ready', 'load'],
  restart: ['stop', 'env', 'port', 'spawn', 'ready', 'load'],
  restartManual: ['stop', 'env', 'port', 'spawn', 'ready', 'load'],
  update: ['stop', 'install', 'spawn', 'ready', 'load'],
  // 插件市场是"先装（控制台里显示进度）→ 再重启服务生效"，说明页只覆盖重启那一段，别虚报安装进度
  plugin: ['stop', 'spawn', 'ready', 'load'],
  recovery: ['stop', 'restore', 'reload', 'spawn', 'ready', 'load'],
}

function stepsFor(reason) {
  const plan = PLANS[reason]
  if (!plan) return []
  return plan.map((key) => ({ key, label: LABELS[key] || key }))
}

module.exports = { LABELS, PLANS, stepsFor }
