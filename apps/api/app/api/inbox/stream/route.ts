import type { NextRequest } from 'next/server';
import { isServable, type InboxEvent, type RegistryApp } from '@resolve/contracts';
import { config } from '../../../../lib/config';
import { pool } from '../../../../lib/db';
import { requireCapability } from '../../../../lib/auth/session';
import { sessionStillValid } from '../../../../lib/auth/repository';
import { registry } from '../../../../lib/registry';
import { includeParam } from '../../../../lib/fleet/http';
import { rpc } from '../../../../lib/tenants/mcp';
import { actionSupported } from '../../../../lib/tenants/protocol';
import { auditRead, writeAudit } from '../../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type MonitorState = Extract<InboxEvent, { type: 'monitor' }>['apps'][number]['state'];
const encode = (cursors: Record<string, string>) => Buffer.from(JSON.stringify(cursors)).toString('base64url');
function decode(raw: string | null): Record<string, string> {
 try { const v = JSON.parse(Buffer.from(raw ?? '', 'base64url').toString()); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/**
 * Live inbox stream (plan 09). For each monitored app, long-poll the tenant's content-free change feed with the
 * human's own grant and forward invalidations; the browser re-reads items with its own authority. The SSE id holds
 * every app's cursor, so EventSource reconnects resume where they stopped; an expired cursor yields `resync`.
 * The session is re-checked before every poll, so sign-out, blocks and directory disables close the stream.
 * Dormant apps are monitored (and so kept warm) only when named in `include`.
 */
export async function GET(request: NextRequest) {
 const principal = await requireCapability(request, 'chat.read');
 if (principal instanceof Response) return principal;
 const include = includeParam(request.nextUrl);
 const cursors = decode(request.headers.get('last-event-id') ?? request.nextUrl.searchParams.get('cursors'));
 const apps = (await registry()).apps;
 await auditRead(principal, 'inbox_stream', { include: [...include].join(',') || null, resumed: Object.keys(cursors).length > 0 });
 const enc = new TextEncoder();
 const abort = new AbortController();
 request.signal.addEventListener('abort', () => abort.abort());

 const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
   let closed = false;
   const close = () => { if (!closed) { closed = true; void writeAudit(pool(), { actorUserId: principal.userId, operation: 'read.inbox_stream_end', outcome: 'succeeded' }).catch(() => {}); abort.abort(); try { controller.close(); } catch { /* already closed */ } } };
   abort.signal.addEventListener('abort', close);
   // A failed write means the client has gone: stop polling its applications straight away.
   const write = (text: string) => { if (closed) return; try { controller.enqueue(enc.encode(text)); } catch { close(); } };
   const send = (event: InboxEvent) => write(`id: ${encode(cursors)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
   const states: Record<string, MonitorState> = {};
   // Re-checked before every poll (sign-out, blocks and directory disables end the stream); activity is recorded once a minute.
   let touchedAt = Date.now();
   const stillValid = () => {
    const touch = Date.now() - touchedAt > 60_000;
    if (touch) touchedAt = Date.now();
    return sessionStillValid(pool(), principal.sessionHash, config().SESSION_IDLE_MINUTES, touch);
   };
   const publish = () => send({ type: 'monitor', apps: apps.map(a => ({ appKey: a.appKey, state: states[a.appKey] ?? 'unavailable' })) });
   const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);
   abort.signal.addEventListener('abort', () => clearInterval(heartbeat));

   const watch = async (app: RegistryApp) => {
    if (!isServable(app)) { states[app.appKey] = 'unavailable'; return; }
    if (app.dormant && !include.has(app.appKey)) { states[app.appKey] = 'dormant'; return; }
    if (!(await actionSupported(app, 'list_changes'))) { states[app.appKey] = 'unavailable'; return; }
    while (!closed) {
     if (!(await stillValid())) return close();
     // Without a cursor, first establish one (no wait), then long-poll from it.
     const o = await rpc(app, principal.userId, 'list_changes', { after: cursors[app.appKey], waitSeconds: cursors[app.appKey] === undefined ? 0 : 20 }, 25_000, abort.signal);
     if (closed) return;
     if (o.kind === 'not_connected' || o.kind === 'reconnect_required' || o.kind === 'denied') {
      states[app.appKey] = o.kind === 'denied' ? 'unavailable' : o.kind; publish(); return;
     }
     if (o.kind !== 'ok') {
      if (states[app.appKey] !== 'error') { states[app.appKey] = 'error'; publish(); }
      await new Promise(r => setTimeout(r, 2000));
      continue;
     }
     if (states[app.appKey] !== 'live') { states[app.appKey] = 'live'; publish(); }
     const resync = o.data.resync;
     cursors[app.appKey] = o.data.cursor;
     if (resync) send({ type: 'resync', appKey: app.appKey });
     for (const e of o.data.events) send({ type: 'change', appKey: app.appKey, itemType: e.itemType, itemId: e.itemId, kind: e.kind, at: e.at });
    }
   };
   // Establish each app's cursor first so the initial monitor event is accurate.
   for (const a of apps) states[a.appKey] = isServable(a) ? (a.dormant && !include.has(a.appKey) ? 'dormant' : 'connecting') : 'unavailable';
   publish();
   await Promise.all(apps.map(a => watch(a).catch(() => { states[a.appKey] = 'error'; publish(); })));
   close();
  },
  cancel() { abort.abort(); },
 });
 return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
}
