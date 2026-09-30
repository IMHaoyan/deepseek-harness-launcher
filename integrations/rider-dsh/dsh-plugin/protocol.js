import path from 'node:path';

const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;

export function canonical(input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) return null;
  if (WINDOWS_ABS.test(input)) {
    const normalized = path.win32.normalize(input);
    return (normalized.length > path.win32.parse(normalized).root.length ? normalized.replace(/\\+$/, '') : normalized).toLowerCase();
  }
  if (process.platform === 'win32' || !path.isAbsolute(input)) return null;
  const normalized = path.normalize(input);
  return normalized === path.parse(normalized).root ? normalized : normalized.replace(/\/+$/, '');
}

export function within(root, target) {
  const a = canonical(root), b = canonical(target);
  if (!a || !b) return false;
  const win = WINDOWS_ABS.test(a);
  if (win !== WINDOWS_ABS.test(b)) return false;
  const rel = (win ? path.win32 : path).relative(a, b);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${win ? '\\' : '/'}`) && !(win ? path.win32 : path).isAbsolute(rel));
}

const MAX_SELECTION = 32 * 1024;
export function validatePacket(value) {
  if (!value || typeof value !== 'object' || !['state', 'send', 'clear'].includes(value.kind)) return null;
  const projectRoot = canonical(value.projectRoot);
  if (!projectRoot) return null;
  if (value.kind === 'clear') return { kind: 'clear', projectRoot };
  const file = canonical(value.file);
  if (!file || !within(projectRoot, file)) return null;
  const { lineStart, lineEnd, selection } = value;
  if (!Number.isSafeInteger(lineStart) || lineStart < 1 || !Number.isSafeInteger(lineEnd) || lineEnd < lineStart || lineEnd - lineStart > 10000) return null;
  if (typeof selection !== 'string' || selection.length > MAX_SELECTION) return null;
  // The canonical (case-folded) path drives matching and @"..." references; the raw spelling is
  // carried for display only so the composer chip shows the file the way the editor spells it.
  const displayFile = typeof value.file === 'string' && value.file.length <= 4096 ? value.file : file;
  return { kind: value.kind, projectRoot, file, displayFile, lineStart, lineEnd, selection };
}

export function formatReference(packet, maxSelection = MAX_SELECTION) {
  const file = packet.file.replace(/\\/g, '/');
  const lines = packet.lineStart === packet.lineEnd ? `第 ${packet.lineStart} 行` : `第 ${packet.lineStart}-${packet.lineEnd} 行`;
  // No auto-read claim: an @ path is an explicit reference, not proof of file contents.
  const header = `来自 Rider 的编辑器上下文：@"${file}"（${lines}）`;
  if (!packet.selection) return header;
  const snippet = packet.selection.slice(0, maxSelection);
  const fence = '`'.repeat(Math.max(3, ...Array.from(snippet.matchAll(/`+/g), m => m[0].length + 1)));
  return `${header}\n选中的代码（可能含未保存改动）：\n${fence}\n${snippet}${snippet.length < packet.selection.length ? '\n[选区过长，已截断]' : ''}\n${fence}`;
}

export class BridgeState {
  constructor(now = Date.now) { this.now = now; this.active = null; this.queue = []; this.nextId = 0; }
  push(packet) {
    if (packet.kind === 'clear') {
      if (this.active?.projectRoot === packet.projectRoot) this.active = null;
      return null;
    }
    this.active = { ...packet, time: this.now() };
    if (packet.kind !== 'send') return null;
    this.prune();
    if (this.queue.length >= 16) throw new Error('queue-full');
    const item = { id: String(++this.nextId), packet, time: this.now(), lease: null };
    this.queue.push(item);
    return item.id;
  }
  prune() { this.queue = this.queue.filter(item => this.now() - item.time < 120000); }
  context(cwd) {
    const a = this.active;
    return a && this.now() - a.time < 30000 && within(cwd, a.file) ? a : null;
  }
  claim(cwd, clientId) {
    this.prune();
    const item = this.queue.find(i => within(cwd, i.packet.file) && (!i.lease || i.lease.until < this.now() || i.lease.clientId === clientId));
    if (!item) return null;
    item.lease = { clientId, until: this.now() + 5000 };
    return { id: item.id, text: formatReference(item.packet) };
  }
  ack(id, clientId) {
    const at = this.queue.findIndex(i => i.id === id && i.lease?.clientId === clientId);
    if (at < 0) return false;
    this.queue.splice(at, 1);
    return true;
  }
}



