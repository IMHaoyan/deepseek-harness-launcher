// tests/release-notes-style.test.js — 发布公告的粒度守卫（2026-10-20 用户要求）
//
// 背景：v1.4.12 的首版公告把同一功能的不同细节拆成了 20 条，用户反馈「这是更新公告，不是 commit」。
// 契约：
//   ① 公告按用户可感知功能归类；同一功能的多项细节必须合并成一条；
//   ② 一个版本通常 3–8 条，硬上限 10 条；
//   ③ 正式版公告超过 10 条时，发布脚本直接拒绝（不能只写在文档里靠自觉）。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n?/gu, '\n')
const style = read('docs/release-notes-style.md')
const release = read('tools/release.mjs')

test('发布规范：公告按功能合并细节，条数有硬上限', () => {
  assert.match(style, /公告不是 commit 明细/, '规范要写明公告不等于提交明细')
  assert.match(style, /同一功能的不同细节必须合并成一条/, '同一功能的细节必须合并')
  assert.match(style, /通常 \*\*3–8 条\*\*，\*\*硬上限 10 条\*\*/, '规范要有 3–8 条口径与 10 条硬上限')
  assert.match(style, /反例（同一功能被拆碎）/, '规范要有"拆碎"的反例')
  assert.match(style, /条数 ≤ 10，且同一功能的多项细节已合并/, '检查清单要能逐条核对')
})

test('发布脚本：正式版公告超过 10 条直接拒绝发布', () => {
  assert.match(release, /const announcementBullets = \(body\.match\(\/\^- \/gmu\) \|\| \[\]\)\.length/,
    '脚本要统计公告条目数（按 "- " 行）')
  assert.match(release, /channel === 'latest' && announcementBullets > 10/, '只对正式版公告设上限')
  assert.match(release, /超过公告上限 10 条/, '拒绝时要给出明确原因')
  assert.match(release, /公告不是 commit 列表/, '拒绝时要告诉作者怎么改')
  // 守卫必须在构建/上传之前：超限说明不应该先花几分钟打包再失败
  const guardAt = release.indexOf('announcementBullets > 10')
  const buildAt = release.indexOf("run(npm, ['test'])")
  assert.ok(guardAt > 0 && buildAt > guardAt, '守卫要在发布前检查阶段生效（早于 npm test / 构建）')
})
