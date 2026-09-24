// tests/assert-package.test.js — 打包产物断言工具（tools/assert-package.cjs，node --test）
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const tool = require('../tools/assert-package.cjs')

const root = path.join(__dirname, '..')
const ASAR = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar')

// electron-builder 写出的 yml 形状（取自一次真实构建）
const YML = [
  'version: 1.4.9-alpha.3',
  'files:',
  '  - url: dshl-1.4.9-alpha.3.exe',
  '    sha512: AAAA',
  '    size: 148529479',
  'path: dshl-1.4.9-alpha.3.exe',
  'sha512: AAAA',
  "releaseDate: '2026-09-24T02:41:05.174Z'",
  '',
].join('\n')

test('渠道与 yml 文件名：预发布段决定渠道，非 alpha 的预发布回落 latest', () => {
  assert.equal(tool.channelOf('1.4.9-alpha.3'), 'alpha')
  assert.equal(tool.channelOf('1.4.9'), 'latest')
  assert.equal(tool.channelOf('1.4.9-beta.1'), 'latest', 'release.mjs 会先拒掉非 alpha 的预发布段，这里只保证不误判成 alpha')
  assert.equal(tool.ymlNameOf('1.4.9-alpha.3'), 'alpha.yml')
  assert.equal(tool.ymlNameOf('1.4.9'), 'latest.yml')
})

test('parseYml：只取顶层 version/path/sha512 与 files[0] 的 size', () => {
  assert.deepEqual(tool.parseYml(YML), {
    version: '1.4.9-alpha.3',
    path: 'dshl-1.4.9-alpha.3.exe',
    sha512: 'AAAA',
    size: '148529479',
  })
})

test('ymlProblems：一致时无问题；版本/指向/大小/哈希任一不符都要报出来', () => {
  const base = { yml: tool.parseYml(YML), exeName: 'dshl-1.4.9-alpha.3.exe', version: '1.4.9-alpha.3', exeSize: 148529479, exeSha512: 'AAAA' }
  assert.deepEqual(tool.ymlProblems(base), [])

  const wrongVersion = tool.ymlProblems({ ...base, version: '1.4.9-alpha.4' })
  assert.equal(wrongVersion.length, 1)
  assert.match(wrongVersion[0], /yml 版本是 1\.4\.9-alpha\.3/)

  assert.match(tool.ymlProblems({ ...base, exeName: 'dshl-1.4.9-alpha.4.exe' })[0], /yml 指向/)
  assert.match(tool.ymlProblems({ ...base, exeSize: 1 })[0], /字节/)
  assert.match(tool.ymlProblems({ ...base, exeSha512: 'BBBB' })[0], /sha512/)
  assert.equal(tool.ymlProblems({ yml: {} }).length, 4, '空 yml 要报四项缺失，不能静默通过')
})

test('packagedSources：比对清单必须非空且覆盖界面文件，并排除走 extraResources 的 node-dist', () => {
  const rels = tool.packagedSources().map((r) => r.replace(/\\/g, '/'))
  assert.ok(rels.length > 40, `比对清单太短（${rels.length}），断言会变成假通过`)
  for (const must of ['wwwroot/index.html', 'wwwroot/app.js', 'wwwroot/styles.css', 'dsh-update.js', 'main.js']) {
    assert.ok(rels.includes(must), `清单缺少 ${must}`)
  }
  assert.ok(!rels.some((r) => r.startsWith('assets/node-dist/')), 'assets/node-dist 走 extraResources，不在 asar 里')
})

test('集成：能真的从 app.asar 里取出文件，且与仓库文件逐字节一致（当前版本还没打包则跳过）', (t) => {
  // 门槛是「当前版本的产物齐了」而不是「有 asar 就行」：release.mjs 是先 npm test 再 dist:win，
  // 只要改过源码还没重打包，旧 asar 必然与仓库不一致 —— 那属于正常迭代中，不是缺陷。
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const exe = path.join(root, 'dist', `dshl-${pkgVersion}.exe`)
  const yml = path.join(root, 'dist', tool.ymlNameOf(pkgVersion))
  if (![exe, yml, ASAR].every((f) => fs.existsSync(f))) {
    t.skip(`当前版本（${pkgVersion}）还没有完整构建产物，先跑一次打包`)
    return
  }
  const session = tool.asarOpen(ASAR)
  try {
    for (const rel of ['wwwroot/app.js', 'wwwroot/index.html', 'dsh-update.js']) {
      const entry = tool.asarEntry(session, rel)
      assert.ok(entry && typeof entry.size === 'number', `asar 里找不到 ${rel}`)
      assert.equal(Buffer.compare(tool.asarRead(session, entry), fs.readFileSync(path.join(root, rel))), 0, `${rel} 与仓库不一致`)
    }
  } finally {
    fs.closeSync(session.fd)
  }
  execFileSync(process.execPath, ['tools/assert-package.cjs'], { cwd: root })
})
