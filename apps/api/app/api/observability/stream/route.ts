import type { ObservabilityEvent } from '@resolve/contracts';
import { config } from '../../../../lib/config';
import { pool } from '../../../../lib/db';
import { requireCapability } from '../../../../lib/auth/session';
import { sessionStillValid } from '../../../../lib/auth/repository';
import { auditRead } from '../../../../lib/audit';
import { subscribeObservability } from '../../../../lib/integrations/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Observability invalidations (plan 12 §6): content-free events after the worker commits. The browser subscribes
 * first, then reads (`ready` tells it to read now, and again after any gap). The session is re-checked every
 * 30 seconds, so sign-out and blocks close the stream. No per-browser polling of Elastic exists.
 */
export async function GET(request: Request) {
 const principal = await requireCapability(request, 'observability.health');
 if (principal instanceof Response) return principal;
 await auditRead(principal, 'observability_stream');
 const enc = new TextEncoder();
 let cleanup = () => {};
 const stream = new ReadableStream<Uint8Array>({
  start(controller) {
   let closed = false;
   const write = (text: string) => { if (closed) return; try { controller.enqueue(enc.encode(text)); } catch { close(); } };
   const send = (e: ObservabilityEvent) => write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
   const unsubscribe = subscribeObservability(send, () => send({ type: 'ready' }));
   const heartbeat = setInterval(() => write(': keep-alive\n\n'), 15_000);
   const check = setInterval(async () => { if (!(await sessionStillValid(pool(), principal.sessionHash, config().SESSION_IDLE_MINUTES, false).catch(() => false))) close(); }, 30_000);
   function close() {
    if (closed) return; closed = true;
    unsubscribe(); clearInterval(heartbeat); clearInterval(check);
    try { controller.close(); } catch { /* already closed */ }
   }
   cleanup = close;
   request.signal.addEventListener('abort', close);
   send({ type: 'ready' });
  },
  cancel() { cleanup(); },
 });
 return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
}
