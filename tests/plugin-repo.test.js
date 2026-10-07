// tests/plugin-repo.test.js — 插件标题跳转地址的判定（纯函数，无 IO）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeRepo, releasesUrl } = require('../plugin-repo')

test('normalizeRepo：接受 GitHub 仓库主页的几种常见写法', () => {
  assert.equal(normalizeRepo('https://github.com/omdsh-dev/DSH-better-sidebar'), 'https://github.com/omdsh-dev/DSH-better-sidebar')
  assert.equal(normalizeRepo('git+https://github.com/bowenliang123/dsh-context.git'), 'https://github.com/bowenliang123/dsh-context')
  assert.equal(normalizeRepo('  https://github.com/dsh-market/dsh-market/  '), 'https://github.com/dsh-market/dsh-market')
  assert.equal(normalizeRepo('https://github.com/a/b_c.d-e'), 'https://github.com/a/b_c.d-e', '仓库名里的 _ . - 都是合法字符')
})

test('normalizeRepo：不是仓库主页就返回空串（宁可不可点，也不跳猜出来的地址）', () => {
  for (const bad of [
    '', '   ', null, undefined, 42,
    'https://github.com/a/b/issues', // 多一段路径
    'https://github.com/a/b/releases',
    'https://github.com/a', // 缺仓库名
    'https://github.com/-a/b', // owner 不能以 - 开头
    'http://github.com/a/b', // 只认 https
    'https://gitlab.com/a/b',
    'https://evil.com/github.com/a/b',
    'https://github.com.evil.com/a/b',
    'javascript:alert(1)',
    'file:///C:/windows',
    'https://github.com/a/b?tab=readme',
    'https://github.com/a/b#readme',
  ]) {
    assert.equal(normalizeRepo(bad), '', '不该接受：' + String(bad))
  }
})

test('releasesUrl：仓库地址 → 发布页；拿不到仓库就是空串', () => {
  assert.equal(releasesUrl('https://github.com/SiriLee/dsh-rewind'), 'https://github.com/SiriLee/dsh-rewind/releases')
  assert.equal(releasesUrl('git+https://github.com/Nwflower/dsh-chat-import.git'), 'https://github.com/Nwflower/dsh-chat-import/releases')
  assert.equal(releasesUrl(''), '', '空串进、空串出（调用方据此不发跳转）')
  assert.equal(releasesUrl('https://example.com/a/b'), '')
})
