import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { BridgeState, canonical, formatReference, validatePacket } from './protocol.js';

export const name = 'rider-dsh-ide';
export const inject = ['webServer', 'connection'];
const BASE = '/rider-dsh';
const MAX_BODY = 64 * 1024;
const dir = () => join(resolveDshHome(), 'rider-bridge');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
function loopback(req) {
  const ip = req.socket?.remoteAddress;
  return (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') && !req.headers.origin;
}
function sameToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function bearer(req, token, port) {
  return loopback(req) && req.headers.host === `127.0.0.1:${port}` &&
    sameToken(req.headers.authorization, `Bearer ${token}`);
}
function browser(req, res, connection) {
  const rejection = connection.requestRejection(req);
  if (rejection !== undefined) { json(res, rejection, { error: 'not-authorized' }); return false; }
  return true;
}
async function body(req) {
  if (String(req.headers['content-type']).split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new Error('content-type');
  let length = 0; const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new Error('too-large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function register(ctx, route, handler) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${BASE}/${route}`, handler }), `rider-dsh: ${route}`);
}
async function publishDescriptor(port, token, instance) {
  const root = dir(); await mkdir(root, { recursive: true, mode: 0o700 });
  const file = join(root, `${process.pid}-${instance}.json`);
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify({ protocol: 1, instance, port, token, pid: process.pid }), { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
  return async () => {
    // Old process must never remove a newer owner's descriptor.
    try {
      const current = JSON.parse(await readFile(file, 'utf8'));
      if (current.instance === instance && current.token === token) await unlink(file);
    } catch { /* startup races, already removed, or unreadable; leave it alone */ }
  };
}

export async function apply(ctx) {
  const port = ctx.webServer.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('rider-dsh: webServer is not listening');
  const token = randomBytes(32).toString('hex');
  const instance = randomUUID();
  const state = new BridgeState();
  const connection = Reflect.get(ctx, 'connection');

  register(ctx, 'health', (req, res) => {
    if (!bearer(req, token, port)) return json(res, 403, { error: 'not-authorized' });
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    json(res, 200, { protocol: 1, instance });
  });
  register(ctx, 'push', async (req, res) => {
    if (!bearer(req, token, port)) return json(res, 403, { error: 'not-authorized' });
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    let packet;
    try { packet = validatePacket(await body(req)); } catch { return json(res, 400, { error: 'invalid-body' }); }
    if (!packet) return json(res, 400, { error: 'invalid-packet' });
    try {
      const id = state.push(packet);
      json(res, 202, { queued: id !== null, id });
    } catch { json(res, 429, { error: 'queue-full' }); }
  });
  register(ctx, 'poll', (req, res) => {
    if (!browser(req, res, connection)) return;
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const cwd = url.searchParams.get('cwd'), clientId = url.searchParams.get('clientId');
    if (!canonical(cwd) || !/^[\w-]{8,100}$/.test(clientId ?? '')) return json(res, 400, { error: 'invalid-claim' });
    json(res, 200, { item: state.claim(cwd, clientId) });
  });
  register(ctx, 'ack', async (req, res) => {
    if (!browser(req, res, connection)) return;
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    let data;
    try { data = await body(req); } catch { return json(res, 400, { error: 'invalid-body' }); }
    if (!data || typeof data.id !== 'string' || !/^[\w-]{8,100}$/.test(data.clientId ?? '')) return json(res, 400, { error: 'invalid-ack' });
    json(res, state.ack(data.id, data.clientId) ? 200 : 409, { acknowledged: true });
  });
  // Read-only view of the live editor context, for the composer chip. Never consumes it:
  // the same snapshot still feeds the first model step of the turn.
  // The chip needs coordinates only — the selection body stays out of the DOM round-trip.
  register(ctx, 'context', (req, res) => {
    if (!browser(req, res, connection)) return;
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const cwd = url.searchParams.get('cwd');
    if (!canonical(cwd)) return json(res, 400, { error: 'invalid-claim' });
    const packet = state.context(cwd);
    json(res, 200, {
      context: packet ? {
        file: packet.file,
        displayFile: packet.displayFile ?? packet.file,
        lineStart: packet.lineStart,
        lineEnd: packet.lineEnd,
        hasSelection: Boolean(packet.selection)
      } : null
    });
  });

  // Context is a durable snapshot only on the first model step of an actual user turn.
  // Never treat editor text as instructions or claim the on-disk file was read.
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted || step !== 1) return decision;
    const packet = state.context(agent?.session?.header?.cwd);
    if (!packet) return decision;
    const text = `<editor-context source="Rider" trust="untrusted">\n${formatReference(packet, 4096)}\n</editor-context>`;
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: name, form: 'snapshot', sections: [{ name, text }] }
    })] };
  });

  const unpublish = await publishDescriptor(port, token, instance);
  ctx.effect(() => unpublish, 'rider-dsh: descriptor cleanup');
}

