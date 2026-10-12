import { EventEmitter } from 'node:events';
import { Client } from 'pg';
import { observabilityEventSchema, type ObservabilityEvent } from '@resolve/contracts';
import { config } from '../config';
import type { Queryable } from '../db';

/*
 * Observability invalidations (plan 12 §6). The worker calls `notifyObservability` inside the transaction that
 * commits a snapshot, so PostgreSQL delivers it only on commit: an outbox without a table. Each API process holds
 * one LISTEN connection and fans events out to its open streams. Notifications can be lost while a listener
 * reconnects; streams then tell browsers to re-read (`ready`), and staleness covers the rest.
 */
export const CHANNEL = 'resolve_observability';

export function notifyObservability(db: Queryable, event: Exclude<ObservabilityEvent, { type: 'ready' }>) {
 return db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(event)]);
}

const holder = globalThis as unknown as { resolveObservabilityBus?: { bus: EventEmitter; start: () => void } };

function bus() {
 if (holder.resolveObservabilityBus) return holder.resolveObservabilityBus;
 const emitter = new EventEmitter();
 emitter.setMaxListeners(0);
 let client: Client | null = null;
 let starting = false;
 const start = () => {
  if (client || starting) return;
  starting = true;
  const c = new Client({ connectionString: config().DATABASE_URL });
  const retry = () => { client = null; starting = false; emitter.emit('reconnect'); setTimeout(() => { if (emitter.listenerCount('event') > 0) start(); }, 2000); };
  c.on('error', () => { c.end().catch(() => {}); retry(); });
  c.on('notification', n => {
   if (n.channel !== CHANNEL || !n.payload) return;
   try { emitter.emit('event', observabilityEventSchema.parse(JSON.parse(n.payload))); } catch { /* ignore malformed */ }
  });
  c.connect().then(() => c.query(`LISTEN ${CHANNEL}`)).then(() => { client = c; starting = false; }).catch(() => retry());
 };
 holder.resolveObservabilityBus = { bus: emitter, start };
 return holder.resolveObservabilityBus;
}

/** Subscribe to committed observability changes; `onGap` fires when the listener lost its connection. */
export function subscribeObservability(onEvent: (e: ObservabilityEvent) => void, onGap: () => void): () => void {
 const b = bus();
 b.bus.on('event', onEvent);
 b.bus.on('reconnect', onGap);
 b.start();
 return () => { b.bus.off('event', onEvent); b.bus.off('reconnect', onGap); };
}
