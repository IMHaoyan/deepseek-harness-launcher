// tests/balance-credentials.test.js — DSH .credentials.yaml 解析（含新版 refs 嵌套布局）
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const balance = require('../balance')

function withHome(cred, settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-bal-'))
  fs.writeFileSync(path.join(dir, '.credentials.yaml'), cred)
  if (settings !== undefined) fs.writeFileSync(path.join(dir, 'settings.yaml'), settings)
  const info = balance.readDshKeyInfo(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return info
}

const SETTINGS = 'llm-deepseek:\n  baseURL: https://internal.example/v1\n  apiKeyEnv: DEEPSEEK_API_KEY\n'

test('新版布局：密钥在 refs 段（缩进）下也能读到', () => {
  const info = withHome('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-nested123\n  OTHER_KEY: x\nrecords:\n  a:\n    kind: grant\n', SETTINGS)
  assert.equal(info.key, 'sk-nested123')
  assert.equal(info.baseUrl, 'https://internal.example/v1')
})

test('旧版布局：顶层扁平密钥仍可读', () => {
  const info = withHome('DEEPSEEK_API_KEY: sk-flat123\n', SETTINGS)
  assert.equal(info.key, 'sk-flat123')
})

test('refs 段里没有 DEEPSEEK_API_KEY 时不误取其他键', () => {
  const info = withHome('version: 1\nrefs:\n  LEIHUO_API_KEY: sk-other\n', SETTINGS)
  assert.equal(info.key, '')
})

test('credentials 缺失/为空：不抛错，返回空密钥', () => {
  assert.equal(withHome('', undefined).key, '')
  assert.equal(withHome('', undefined).baseUrl, '')
})

test('settings.yaml 的 baseURL 支持引号与尾斜杠', () => {
  const info = withHome('refs:\n  DEEPSEEK_API_KEY: sk-x\n', 'llm-deepseek:\n  baseURL: "https://x.example/v1/"\n')
  assert.equal(info.baseUrl, 'https://x.example/v1')
})
