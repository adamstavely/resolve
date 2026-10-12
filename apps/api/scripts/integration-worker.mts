/*
 * Integration worker (plan 12 §2, plan 14 E1/E3): polls Elastic for each active app mapping and watches for receipt
 * evidence, outside request handlers.
 * Several workers may run; leases and fencing tokens make each poll exclusive, and a crashed worker's lease simply
 * expires. Browsers never cause Elastic calls: they read the committed snapshots and get NOTIFY invalidations.
 *
 *   npm run dev:integrations
 */
import { config } from '../lib/config';
import { pool } from '../lib/db';
import { sealer } from '../lib/sealer';
import { claim, ensureOperations, pollOnce, prune, workerId } from '../lib/integrations/poller';
import { watchReceipts } from '../lib/integrations/receipts';

const owner = workerId();
const CONCURRENCY = 4;
const pollSeconds = config().OBSERVABILITY_POLL_SECONDS;
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
const log = (level: 'info' | 'error', event: string, extra: Record<string, unknown> = {}) => (level === 'error' ? console.error : console.log)(JSON.stringify({ level, event, ...extra }));

async function lane() {
 while (!stopping) {
  const op = await claim(pool(), owner).catch(e => { log('error', 'integration_claim_failed', { error: e instanceof Error ? e.message : 'unknown' }); return undefined; });
  if (!op) return;
  try {
   const r = await pollOnce(pool(), sealer(), op, pollSeconds);
   log('info', 'observability_poll', { target: op.operation_key, ...r });
  } catch (e) {
   log('error', 'observability_poll_failed', { target: op.operation_key, error: e instanceof Error ? e.message : 'unknown' });
  }
 }
}

log('info', 'integration_worker_started', { owner, pollSeconds });
let lastPrune = 0;
let lastReceipts = 0;
while (!stopping) {
 await ensureOperations(pool()).catch(() => {});
 await Promise.all(Array.from({ length: CONCURRENCY }, lane));
 // Receipts (E3): look for downstream evidence every few seconds; a burst of new actions is one query per app.
 if (Date.now() - lastReceipts > 5000) { lastReceipts = Date.now(); await watchReceipts(pool(), sealer()).catch(e => log('error', 'receipt_watch_failed', { error: e instanceof Error ? e.message : 'unknown' })); }
 if (Date.now() - lastPrune > 3600_000) { lastPrune = Date.now(); await prune(pool()).catch(() => {}); }
 await new Promise(r => setTimeout(r, 1000));
}
await pool().end();
