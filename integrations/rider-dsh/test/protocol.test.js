import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, within, validatePacket, formatReference, BridgeState } from '../dsh-plugin/protocol.js';
const packet = { kind: 'send', projectRoot: 'E:\\Repo', file: 'E:\\Repo\\src\\A.cs', lineStart: 2, lineEnd: 3, selection: 'var x = 1;' };
test('path validation fail-closed and case-insensitive Windows containment', () => {
  assert.equal(canonical('E:\\Repo\\a.cs'), 'e:\\repo\\a.cs');
  assert.equal(canonical('E:\\'), 'e:\\');
  if (process.platform === 'win32') assert.equal(canonical('\\secret'), null);
  assert.equal(within('E:\\repo', 'e:\\REPO\\src\\A.cs'), true);
  assert.equal(within('E:\\repo', 'e:\\repository\\a.cs'), false);
  assert.equal(within('E:\\repo', 'e:\\repo\\..\\secret.cs'), false);
  assert.equal(validatePacket({ ...packet, file: 'E:\\secret.cs' }), null);
  assert.equal(validatePacket({ ...packet, selection: 'a'.repeat(33000) }), null);
  assert.equal(validatePacket({ ...packet, lineStart: 0 }), null);
  assert.ok(validatePacket(packet));
});
test('selected unsaved code and fenced backticks are visible, without auto-submit', () => {
  const text = formatReference(validatePacket({ ...packet, selection: '```\ncode' }));
  assert.match(text, /选中的代码（可能含未保存改动）/);
  assert.match(text, /````\n```\ncode\n````/);
});
test('single lease, correct workspace, acknowledgement and expiry', () => {
  let time = 1000; const state = new BridgeState(() => time);
  const p = validatePacket(packet);
  state.push({ ...p, kind: 'state' });
  assert.equal(state.context('E:\\Repo')?.file, p.file);
  assert.equal(state.context('E:\\Other'), null);
  const id = state.push(p);
  assert.equal(state.claim('E:\\Other', 'a'), null);
  assert.equal(state.claim('E:\\Repo', 'a')?.id, id);
  assert.equal(state.claim('E:\\Repo', 'b'), null);
  assert.equal(state.ack(id, 'b'), false);
  time += 5001;
  assert.equal(state.claim('E:\\Repo', 'b')?.id, id);
  assert.equal(state.ack(id, 'b'), true);
  assert.equal(state.claim('E:\\Repo', 'a'), null);
  state.push({ kind: 'clear', projectRoot: p.projectRoot });
  assert.equal(state.context('E:\\Repo'), null);
  state.push({ ...p, kind: 'state' });
  time += 30000; assert.equal(state.context('E:\\Repo'), null);
});



