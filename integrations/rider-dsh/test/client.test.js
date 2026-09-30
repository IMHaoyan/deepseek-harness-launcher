import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../dsh-plugin/client.js', import.meta.url), 'utf8');

// Minimal React shim: hook slots survive a manual re-render, effects are collected per render.
function react() {
  const slots = [], effects = [];
  let cursor = 0;
  return {
    effects,
    begin() { cursor = 0; effects.length = 0; },
    useState(init) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = init;
      return [slots[at], (value) => { slots[at] = value; }];
    },
    useEffect(callback) { effects.push(callback); cursor++; },
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; }
  };
}

function load(fetchImpl) {
  let definition;
  const globals = {
    window: { __ModuleLoader__: { load(found) { definition = found; } } },
    document: { baseURI: 'http://127.0.0.1:1234/', visibilityState: 'visible', hasFocus: () => true },
    crypto: { randomUUID: () => 'client-0001' }, URL,
    setInterval: () => 1, clearInterval: () => {}, Promise, JSON, Set,
    fetch: fetchImpl
  };
  vm.runInNewContext(source, globals);
  return definition;
}

function mount(definition, react, bailSink) {
  const registrations = [];
  const scoped = { bail(_subject, event, request) { bailSink.call = { event, request }; return true; } };
  const input = { state: { getSnapshot: () => ({ draft: bailSink.draft ?? 'existing', draftRev: bailSink.draftRev ?? 42 }) }, focus() {} };
  const { apply, inject } = definition.factory((id) => { assert.equal(id, 'react'); return react; });
  apply({
    sessions: { list: { getSnapshot: () => ({ byId: { sessionA: { cwd: 'E:\\Repo' } } }) }, scope: () => scoped },
    conversation: { input: { for: () => input } },
    slots: { inject(_name, thunk) { thunk(); }, register(options, component) { registrations.push({ options, component }); } }
  });
  return { registrations, inject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('receiver appends to the existing revision-guarded DSH draft and only ACKs after insertion', async () => {
  let ackCount = 0;
  const fake = react();
  const definition = load(async (url) => {
    if (String(url).includes('/ack')) { ackCount++; return { ok: true }; }
    return { ok: true, json: async () => ({ item: { id: '1', text: 'from Rider' } }) };
  });
  const bailSink = {};
  const { registrations, inject } = mount(definition, fake, bailSink);
  assert.ok(inject.includes('conversation'));
  const receiver = registrations.find((entry) => entry.options.id === 'rider-dsh-receiver');
  assert.ok(receiver, 'receiver is registered in the composer dock');
  fake.begin();
  receiver.component({ bridgeSessionId: 'sessionA' });
  fake.effects[0]();
  await tick();
  assert.equal(bailSink.call.event, 'slash/input-insert-text');
  assert.equal(bailSink.call.request.span.draftRev, 42);
  assert.equal(bailSink.call.request.span.start, 8);
  assert.equal(bailSink.call.request.text, '\n\nfrom Rider');
  assert.equal(ackCount, 1);
});

test('context chip shows the active Rider file and inserts an explicit reference on click', async () => {
  const context = { file: 'e:\\repo\\src\\a.cs', displayFile: 'E:\\Repo\\src\\A.cs', lineStart: 2, lineEnd: 3, hasSelection: true };
  const fake = react();
  const definition = load(async (url) => (String(url).includes('/context')
    ? { ok: true, json: async () => ({ context }) }
    : { ok: true, json: async () => ({ item: null }) }));
  const bailSink = { draft: '', draftRev: 7 };
  const { registrations } = mount(definition, fake, bailSink);
  const chip = registrations.find((entry) => entry.options.id === 'rider-dsh-context');
  assert.ok(chip, 'context chip is registered in the composer dock');
  assert.equal(chip.options.order < registrations.find((entry) => entry.options.id === 'rider-dsh-receiver').options.order, true);
  fake.begin();
  assert.equal(chip.component({ bridgeSessionId: 'sessionA' }), null, 'no chip before the first poll resolves');
  fake.effects[0]();
  await tick();
  fake.begin();
  const tree = chip.component({ bridgeSessionId: 'sessionA' });
  assert.ok(tree, 'chip renders once a context exists');
  assert.match(String(tree.children[0].children[0]), /A\.cs:2-3/); // editor spelling on the chip
  tree.children[0].props.onClick();
  assert.equal(bailSink.call.event, 'slash/input-insert-text');
  assert.equal(bailSink.call.request.text, '@"e:/repo/src/a.cs"'); // canonical path in the reference
  assert.equal(bailSink.call.request.span.draftRev, 7);
  tree.children[1].props.onClick();
  fake.begin();
  assert.equal(chip.component({ bridgeSessionId: 'sessionA' }), null, 'dismissed chip stays hidden for the same file');
});

test('context chip renders nothing when the bridge has no live context', async () => {
  const fake = react();
  const definition = load(async () => ({ ok: true, json: async () => ({ context: null }) }));
  const { registrations } = mount(definition, fake, {});
  const chip = registrations.find((entry) => entry.options.id === 'rider-dsh-context');
  fake.begin();
  chip.component({ bridgeSessionId: 'sessionA' });
  fake.effects[0]();
  await tick();
  fake.begin();
  assert.equal(chip.component({ bridgeSessionId: 'sessionA' }), null);
});
