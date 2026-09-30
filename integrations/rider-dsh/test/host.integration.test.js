import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

// With normal package installation this test exercises the actual Host routes.
// The source-only checkout may have no @deepseek-ai packages yet.
test('authenticated loopback Rider push and DSH browser claim; per-turn context; disposal', async (t) => {
  let plugin;
  try { plugin = await import('../dsh-plugin/index.js'); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return t.skip('install the dsh-plugin dependencies to run Host integration'); throw error; }
  const oldHome = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), 'rider-dsh-test-'));
  process.env.DSH_HOME = home;
  t.after(async () => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; if (dirname(resolve(home)) !== resolve(tmpdir()) || !basename(home).startsWith('rider-dsh-test-')) throw new Error('Unsafe test cleanup path'); await rm(home, { recursive: true, force: true }); });
  const routes = new Map(), disposers = [];
  let preStep;
  const server = createServer((req, res) => (routes.get(new URL(req.url, 'http://localhost').pathname) ?? ((_, response) => { response.statusCode = 404; response.end(); }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const ctx = {
    webServer: { port, register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    connection: { requestRejection(req) { return req.headers.cookie === 'allowed' ? undefined : 401; } },
    effect(fn) { disposers.push(fn()); }, on(name, fn) { if (name === 'agent/pre-step') preStep = fn; }
  };
  await plugin.apply(ctx);
  const files = await readdir(join(home, 'rider-bridge'));
  assert.equal(files.length, 1);
  const { token } = JSON.parse(await readFile(join(home, 'rider-bridge', files[0]), 'utf8'));
  const base = `http://127.0.0.1:${port}/rider-dsh/`;
  const health = await fetch(base + 'health', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(health.status, 200);
  const blocked = await fetch(base + 'push', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(blocked.status, 403);
  const packet = { kind: 'send', projectRoot: 'E:\\Repo', file: 'E:\\Repo\\src\\A.cs', lineStart: 2, lineEnd: 3, selection: 'unsaved change' };
  const pushed = await fetch(base + 'push', { method: 'POST', body: JSON.stringify(packet), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  assert.equal(pushed.status, 202);
  assert.equal((await pushed.json()).queued, true);
  const wrongCookie = await fetch(base + 'poll?cwd=E%3A%5CRepo&clientId=client-1234');
  assert.equal(wrongCookie.status, 401);
  const unrelated = await fetch(base + 'poll?cwd=E%3A%5COther&clientId=client-1234', { headers: { cookie: 'allowed' } });
  assert.equal((await unrelated.json()).item, null);
  const poll = await fetch(base + 'poll?cwd=E%3A%5CRepo&clientId=client-1234', { headers: { cookie: 'allowed' } });
  const item = (await poll.json()).item;
  assert.match(item.text, /unsaved change/);
  // Composer chip reads the same snapshot without consuming it, and without the selection body.
  assert.equal((await fetch(base + 'context?cwd=E%3A%5CRepo')).status, 401);
  assert.equal((await fetch(base + 'context?cwd=E%3A%5COther', { headers: { cookie: 'allowed' } })).status, 200);
  const unrelatedContext = await (await fetch(base + 'context?cwd=E%3A%5COther', { headers: { cookie: 'allowed' } })).json();
  assert.equal(unrelatedContext.context, null);
  const live = await (await fetch(base + 'context?cwd=E%3A%5CRepo', { headers: { cookie: 'allowed' } })).json();
  assert.equal(live.context.file, 'e:\\repo\\src\\a.cs'); // canonical, case-folded: drives @"..." references
  assert.equal(live.context.displayFile, 'E:\\Repo\\src\\A.cs'); // raw spelling, display only
  assert.equal(live.context.lineStart, 2);
  assert.equal(live.context.hasSelection, true);
  assert.equal('selection' in live.context, false);
  // A plain state packet (no right-click) is what feeds the chip during normal editing.
  const auto = { kind: 'state', projectRoot: 'E:\\Repo', file: 'E:\\Repo\\src\\B.cs', lineStart: 9, lineEnd: 9, selection: '' };
  const autoPush = await fetch(base + 'push', { method: 'POST', body: JSON.stringify(auto), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  assert.equal(autoPush.status, 202);
  assert.equal((await autoPush.json()).queued, false);
  const autoContext = await (await fetch(base + 'context?cwd=E%3A%5CRepo', { headers: { cookie: 'allowed' } })).json();
  assert.equal(autoContext.context.file, 'e:\\repo\\src\\b.cs');
  assert.equal(autoContext.context.displayFile, 'E:\\Repo\\src\\B.cs');
  assert.equal(autoContext.context.hasSelection, false);
  const decision = await preStep({ agent: { session: { header: { cwd: 'E:\\Repo' } } }, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [] }));
  assert.equal(decision.messages.length, 1);
  const ack = await fetch(base + 'ack', { method: 'POST', headers: { cookie: 'allowed', 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id, clientId: 'client-1234' }) });
  assert.equal(ack.status, 200);
  assert.equal((await readdir(join(home, 'rider-bridge'))).length, 1);
  for (const dispose of disposers.reverse()) await dispose();
  assert.equal((await readdir(join(home, 'rider-bridge'))).length, 0);
});

