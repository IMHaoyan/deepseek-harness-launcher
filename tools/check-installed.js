// check-installed.js — 校验已安装 asar 是否含端口一键切换修复
const asar = require('@electron/asar')
const s = asar.extractFile('C:/Users/gonghaoyan/AppData/Local/Programs/deepseek-harness-launcher/resources/app.asar', 'main.js').toString('utf8')
console.log('applyRuntimePort(seed = false):', s.includes('applyRuntimePort(seed = false)'))
console.log('seed&&args.port 逻辑:', /\(seed && args\.port\)/.test(s))
console.log('启动时 seed 调用:', s.includes('applyRuntimePort(true)'))
console.log('一键换端口 IPC(blockSwitch):', s.includes('blockSwitch'))
console.log('被占用说明页(reason=blocked):', s.includes('reason=blocked'))
console.log('window 被占用页 URL 构建 loadingParams:', s.includes('loadingParams'))
