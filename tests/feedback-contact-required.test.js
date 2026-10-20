// tests/feedback-contact-required.test.js — 反馈表单的联系方式必须是必填项
//
// 契约（用户直接提的诉求）：联系方式（邮箱 / 飞书号 / QQ 等）改为必填，不填无法提交。
// 只改 placeholder 不算数，三处必须同时成立：
//   ① 输入框文案标「必填」，并保留 required 语义；
//   ② 渲染层点「提交反馈」时先校验，空值就地拦截、聚焦输入框，且发生在 IPC 之前；
//   ③ 主进程 feedbackSend 再守一次（旧界面 / 直接调 IPC 也绕不过），且发生在打包与发送之前。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')

const indexHtml = read('ui-src/index.html')
const appJs = read('ui-src/app.js')
const builtAppJs = read('wwwroot/app.js')
const builtIndexHtml = read('wwwroot/index.html')
const mainJs = read('main.js')

function contactInputTag() {
  const m = /<input id="feedbackContact"[^>]*>/u.exec(indexHtml)
  assert.ok(m, 'index.html 里应有 #feedbackContact 输入框')
  return m[0]
}

/** 提交按钮的点击处理（从监听注册切到下一段顶层代码）。 */
function sendHandler() {
  const at = appJs.indexOf("$('btnFeedbackSend').addEventListener")
  assert.ok(at > 0, 'app.js 里应有提交反馈的点击处理')
  const end = appJs.indexOf("window.addEventListener('keydown'", at)
  assert.ok(end > at, '找不到提交处理的结束边界')
  return appJs.slice(at, end)
}

/** 主进程 feedbackSend 分支（从 case 切到下一个 case）。 */
function sendCase() {
  const at = mainJs.indexOf("case 'feedbackSend': {")
  assert.ok(at > 0, 'main.js 里应有 feedbackSend 分支')
  const end = mainJs.indexOf("case 'clipboardWrite':", at)
  assert.ok(end > at, '找不到 feedbackSend 分支的结束边界')
  return mainJs.slice(at, end)
}

test('输入框：标签标必填，且保留 required 语义', () => {
  assert.match(indexHtml, /<label class="field-label" for="feedbackContact">联系方式 <span class="field-required">必填<\/span><\/label>/u, '联系方式要有可见的「必填」标签')
  const tag = contactInputTag()
  assert.doesNotMatch(tag, /可选/u, '不能还写着「可选」')
  assert.match(tag, /\brequired\b/u, 'required 语义要留在 DOM 上')
  assert.match(tag, /maxlength="200"/u, '长度上限与主进程的 200 字符截断保持一致')
})

test('渲染层：空联系方式在发 IPC 之前就被拦下，并聚焦输入框', () => {
  const handler = sendHandler()
  const guard = handler.indexOf('FEEDBACK_CONTACT_REQUIRED')
  assert.ok(guard > 0, '提交处理要用统一的必填提示常量')
  const ipc = handler.indexOf("cmd('feedbackSend'")
  assert.ok(ipc > 0, '提交处理应调用 feedbackSend')
  assert.ok(guard < ipc, '必填校验必须发生在发 IPC 之前（先拦后发）')
  assert.ok(handler.indexOf('.focus()', guard) > guard, '拦下后要聚焦联系方式输入框')
})

test('渲染层：取值统一走 trim（纯空格不算填了）', () => {
  assert.match(appJs, /function feedbackContact\(\)[\s\S]{0,200}?\.value\.trim\(\)/u, '取值必须先 trim')
  assert.match(sendHandler(), /contact: feedbackContact\(\)/u, '发送时必须用校验过的那份取值')
})

test('主进程再守一次：空联系方式直接拒绝，且在打包/发送之前', () => {
  const block = sendCase()
  const guard = block.indexOf('if (!contact) return')
  assert.ok(guard > 0, 'feedbackSend 必须有空联系方式守卫')
  const pack = block.indexOf('buildFeedbackPack(')
  assert.ok(pack > guard, '守卫要在生成反馈正文之前')
  const webhook = block.indexOf('effectiveFeishuWebhook(')
  assert.ok(webhook > guard, '守卫要在真正发送之前')
  assert.match(block, /请填写联系方式/u, '错误文案要直说填什么')
})

test('wwwroot 产物同步（打包后的界面不能还是旧文案/旧逻辑）', () => {
  assert.equal(builtAppJs, appJs, 'ui-src/app.js 与 wwwroot/app.js 不一致，先跑 npm run build:assets')
  assert.match(builtIndexHtml, /<label class="field-label" for="feedbackContact">联系方式 <span class="field-required">必填<\/span><\/label>/u)
  assert.doesNotMatch(builtIndexHtml, /联系方式（可选）/u)
})
