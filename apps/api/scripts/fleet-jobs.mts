/*
 * Fleet job dispatcher (plans 02 and 03): runs outside request handlers.
 * - Lifecycle jobs: dispatches any that never reached the worker (same request id, so never twice) and follows
 *   running ones until they settle, auditing each stage.
 * - Broadcasts: publishes scheduled banners when due (re-resolving "All apps") and resends deliveries a crashed
 *   process left pending (the delivery key makes that safe).
 * - Entitlements: claims queued apply jobs with a lease and fencing token, skips superseded versions, and records
 *   results only while it still holds the lease. Several dispatchers can run at once.
 *
 *   npm run dev:jobs
 */
import { pool } from '../lib/db';
import { openJobIds, refresh } from '../lib/fleet-admin/jobs';
import { claim, processJob, workerId } from '../lib/fleet-admin/entitlements';
import { tick as broadcastTick } from '../lib/broadcasts';

const owner = workerId();
const CONCURRENCY = 4;
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

async function lifecycleTick() {
 for (const id of await openJobIds(pool())) {
  try { await refresh(pool(), id); } catch (e) { console.error(JSON.stringify({ level: 'error', event: 'job_refresh_failed', id, error: e instanceof Error ? e.message : 'unknown' })); }
 }
}

async function entitlementWorker() {
 while (!stopping) {
  const job = await claim(pool(), owner).catch(() => undefined);
  if (!job) return;
  try {
   const r = await processJob(pool(), job);
   console.log(JSON.stringify({ level: 'info', event: 'entitlement_apply', app: job.app_key, version: Number(job.version), result: r }));
  } catch (e) {
   console.error(JSON.stringify({ level: 'error', event: 'entitlement_apply_failed', id: job.id, error: e instanceof Error ? e.message : 'unknown' }));
  }
 }
}

console.log(JSON.stringify({ level: 'info', event: 'fleet_jobs_started', owner }));
while (!stopping) {
 await lifecycleTick().catch(() => {});
 await broadcastTick(pool()).catch(e => console.error(JSON.stringify({ level: 'error', event: 'broadcast_tick_failed', error: e instanceof Error ? e.message : 'unknown' })));
 await Promise.all(Array.from({ length: CONCURRENCY }, entitlementWorker));
 await new Promise(r => setTimeout(r, 400));
}
await pool().end();
