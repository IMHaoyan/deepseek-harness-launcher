// tests/workspace-map.test.js — DSH「会话 → 工作区根目录」查询（Ctrl+点击相对路径链接的还原依据）
//
// 事实来源：~/.dsh/storages/workspace.json 的 tables.workspaces.<id> = { path, sessionIds, title }；
// 会话正文 DOM 的 data-conversation-session 提供 sessionId。两者相加把相对路径还原成绝对路径。
// 这里锁住：正常映射（带/不带 session- 前缀）、找不到/坏文件一律空串（fail-closed）、相对路径拼接、
// 以及按 mtime+size 缓存但不吞掉文件更新。
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const workspaceMap = require('../workspace-map')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshl-workspace-map-'))
}

function writeIndex(dir, value) {
  const file = path.join(dir, 'workspace.json')
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  return file
}

const INDEX = {
  tables: {
    workspaces: {
      'e9717799-d273-482b-b32f-cc0b1b3b3785': {
        path: 'C:\\Users\\gonghaoyan\\Desktop\\dshl',
        title: 'dshl',
        sessionIds: ['session-74b7110a-63c4-4574-8141-9085d682c063', 'session-af9b1f01-6cce-46ac-879a-26b96c0726c5'],
      },
      '3e7fc39c-bc17-404c-b234-dcdbd6cc19f4': {
        path: 'E:\\Projects\\L66\\program\\l66',
        title: 'l66',
        sessionIds: ['session-7f6e0da7-0584-4bc1-b9bc-33fec740c0cc'],
      },
    },
  },
}

test('readWorkspaceIndex：读取 tables.workspaces；坏文件/缺表/不存在一律 null', () => {
  const dir = tempDir()
  const good = writeIndex(dir, INDEX)
  const index = workspaceMap.readWorkspaceIndex(good)
  assert.equal(Object.keys(index).length, 2)

  const broken = path.join(dir, 'broken.json')
  fs.writeFileSync(broken, '{ not json', 'utf8')
  assert.equal(workspaceMap.readWorkspaceIndex(broken), null)

  const noTable = path.join(dir, 'no-table.json')
  fs.writeFileSync(noTable, JSON.stringify({ tables: {} }), 'utf8')
  assert.equal(workspaceMap.readWorkspaceIndex(noTable), null)

  assert.equal(workspaceMap.readWorkspaceIndex(path.join(dir, 'missing.json')), null)
})

test('workspacePathForSession：按会话找到工作区根目录，容错 session- 前缀', () => {
  const index = INDEX.tables.workspaces
  const full = 'session-74b7110a-63c4-4574-8141-9085d682c063'
  assert.equal(workspaceMap.workspacePathForSession(index, full), 'C:\\Users\\gonghaoyan\\Desktop\\dshl')
  assert.equal(
    workspaceMap.workspacePathForSession(index, '74b7110a-63c4-4574-8141-9085d682c063'),
    'C:\\Users\\gonghaoyan\\Desktop\\dshl',
  )
  assert.equal(workspaceMap.workspacePathForSession(index, 'session-unknown'), '')
  assert.equal(workspaceMap.workspacePathForSession(null, full), '')
  assert.equal(workspaceMap.workspacePathForSession(index, ''), '')
})

test('filePathInWorkspace：相对路径拼成绝对路径；非法输入空串', () => {
  const cwd = 'C:\\Users\\gonghaoyan\\Desktop\\dshl'
  assert.equal(
    workspaceMap.filePathInWorkspace(cwd, 'tests/file-open-preload.test.js'),
    path.resolve(cwd, 'tests', 'file-open-preload.test.js'),
  )
  assert.equal(workspaceMap.filePathInWorkspace(cwd, 'browser-preload.js'), path.resolve(cwd, 'browser-preload.js'))
  assert.equal(workspaceMap.filePathInWorkspace('', 'a.js'), '')
  assert.equal(workspaceMap.filePathInWorkspace(cwd, ''), '')
  assert.equal(workspaceMap.filePathInWorkspace(cwd, 'a\u0000b.js'), '')
})

test('createWorkspaceMap：首次读取后按 mtime+size 缓存，文件更新后重新读取，reset 放弃缓存', () => {
  const dir = tempDir()
  const file = writeIndex(dir, INDEX)
  const map = workspaceMap.createWorkspaceMap(file)
  const session = 'session-74b7110a-63c4-4574-8141-9085d682c063'
  assert.equal(map.pathForSession(session), 'C:\\Users\\gonghaoyan\\Desktop\\dshl')

  // 同一份文件第二次查询命中缓存（内容不变，结果一致）
  assert.equal(map.pathForSession(session), 'C:\\Users\\gonghaoyan\\Desktop\\dshl')

  // 改写映射：文件变化后必须重新读，不能一直吃缓存
  const moved = {
    tables: {
      workspaces: {
        w1: { path: 'D:\\moved\\dshl', sessionIds: ['session-74b7110a-63c4-4574-8141-9085d682c063'] },
      },
    },
  }
  fs.writeFileSync(file, JSON.stringify(moved, null, 2), 'utf8')
  assert.equal(map.pathForSession(session), 'D:\\moved\\dshl')

  map.reset()
  assert.equal(map.pathForSession(session), 'D:\\moved\\dshl')

  // 文件被删掉：沿用上次成功索引（一次抖动不吞点击）
  fs.unlinkSync(file)
  assert.equal(map.pathForSession(session), 'D:\\moved\\dshl')
})
