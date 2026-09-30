// DSH client-modules browser bundle: no DOM editing, no simulated keyboard, no auto-send.
window.__ModuleLoader__.load({
  id: '@local/dsh-rider-ide',
  factory(require) {
    const { createElement, useEffect, useState } = require('react');
    const inject = ['slots', 'sessions', 'conversation'];
    function apply(ctx) {
      const clientId = crypto.randomUUID();
      const inserted = new Set();
      const endpoint = (name) => new URL(`rider-dsh/${name}`, document.baseURI).toString();
      const cwdOf = (sessionId) => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
      async function poll(sessionId) {
        if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
        const cwd = cwdOf(sessionId);
        const actx = ctx.sessions.scope(sessionId);
        if (!cwd || !actx) return;
        const url = new URL(endpoint('poll'));
        url.searchParams.set('cwd', cwd);
        url.searchParams.set('clientId', clientId);
        let item;
        try {
          const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
          if (!response.ok) return;
          item = (await response.json()).item;
          if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') return;
          if (!inserted.has(item.id)) {
            // The scoped, revision-guarded composer event preserves the existing draft and reference chips.
            const current = ctx.conversation.input.for(actx).state.getSnapshot();
            const span = { start: current.draft.length, end: current.draft.length, draftRev: current.draftRev };
            const prefix = current.draft ? '\n\n' : '';
            if (actx.bail(actx, 'slash/input-insert-text', { text: `${prefix}${item.text}`, span }) !== true) return;
            inserted.add(item.id);
            ctx.conversation.input.for(actx).focus();
          }
          const ack = await fetch(endpoint('ack'), {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: item.id, clientId })
          });
          if (ack.ok) inserted.delete(item.id);
        } catch { /* DSH service is restarting; keep the unsent draft and retry on the next tick. */ }
      }
      function Receiver({ bridgeSessionId }) {
        useEffect(() => {
          let busy = false;
          const run = () => {
            if (busy) return;
            busy = true;
            Promise.resolve(poll(bridgeSessionId)).finally(() => { busy = false; });
          };
          run();
          const timer = setInterval(run, 700);
          return () => clearInterval(timer);
        }, [bridgeSessionId]);
        return null;
      }
      // Read-only chip: Rider reports the active file on its own, so this needs no right-click.
      // Clicking inserts an explicit @"path" reference; it never submits the draft.
      const baseName = (file) => file.replace(/\\/g, '/').split('/').pop();
      const reference = (file) => `@"${file.replace(/\\/g, '/')}"`;
      const chipStyle = {
        display: 'inline-flex', alignItems: 'center', gap: '4px', maxWidth: '100%',
        margin: '0 0 4px', padding: '1px 4px 1px 8px', borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.35)', background: 'rgba(127,127,127,0.10)',
        color: 'inherit', fontSize: '12px', lineHeight: '18px'
      };
      const labelStyle = {
        border: 'none', background: 'none', color: 'inherit', font: 'inherit',
        padding: '0', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      };
      const closeStyle = { border: 'none', background: 'none', color: 'inherit', font: 'inherit', padding: '0 2px', cursor: 'pointer', opacity: '0.65' };
      function ContextChip({ bridgeSessionId }) {
        const [packet, setPacket] = useState(null);
        const [dismissed, setDismissed] = useState('');
        useEffect(() => {
          let busy = false;
          const run = async () => {
            if (busy) return;
            busy = true;
            try {
              if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
              const cwd = cwdOf(bridgeSessionId);
              if (!cwd) { setPacket(null); return; }
              const url = new URL(endpoint('context'));
              url.searchParams.set('cwd', cwd);
              const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
              if (!response.ok) return;
              const live = (await response.json()).context;
              setPacket(live && typeof live.file === 'string' ? live : null);
            } catch { /* DSH service is restarting; keep the last chip and retry. */ } finally { busy = false; }
          };
          run();
          const timer = setInterval(run, 1500);
          return () => clearInterval(timer);
        }, [bridgeSessionId]);
        if (!packet) return null;
        const key = `${packet.file}:${packet.lineStart}`;
        if (dismissed === key) return null;
        const lines = packet.lineStart === packet.lineEnd ? `${packet.lineStart}` : `${packet.lineStart}-${packet.lineEnd}`;
        // Label uses the editor's own spelling; the inserted reference uses the canonical path,
        // which is what the per-turn <editor-context> injection quotes as well.
        const shown = packet.displayFile || packet.file;
        // The trailing dot marks "there is also a selection"; the chip itself stays read-only.
        const label = `${baseName(shown)}:${lines}${packet.hasSelection ? ' ·' : ''}`;
        const insert = () => {
          const actx = ctx.sessions.scope(bridgeSessionId);
          if (!actx) return;
          const input = ctx.conversation.input.for(actx);
          const current = input.state.getSnapshot();
          const span = { start: current.draft.length, end: current.draft.length, draftRev: current.draftRev };
          const prefix = current.draft ? '\n\n' : '';
          if (actx.bail(actx, 'slash/input-insert-text', { text: `${prefix}${reference(packet.file)}`, span }) !== true) return;
          input.focus();
        };
        return createElement('div', { style: chipStyle },
          createElement('button', {
            type: 'button',
            style: labelStyle,
            title: `插入文件引用 ${packet.file}`,
            onClick: insert
          }, `📄 ${label}`),
          createElement('button', {
            type: 'button',
            style: closeStyle,
            title: '暂时隐藏（Rider 切到别的文件会重新出现）',
            onClick: () => setDismissed(key)
          }, '×'));
      }
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'rider-dsh-context', order: 900,
        inject: (sessionId) => ({ bridgeSessionId: sessionId })
      }, ContextChip));
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'rider-dsh-receiver', order: 1000,
        inject: (sessionId) => ({ bridgeSessionId: sessionId })
      }, Receiver));
    }
    return { apply, inject };
  }
});
