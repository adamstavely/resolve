/*
 * Directory worker (plan 02): polls the IdP directory and applies observations. Runs outside request handlers.
 *   npm run dev:directory           continuous, every DIRECTORY_POLL_SECONDS
 *   npm run dev:directory -- --once a single pass (exit code 1 on failure)
 */
import { Pool } from 'pg';
import { config } from '../lib/config';
import { applyDirectorySnapshot, directorySnapshotSchema } from '../lib/directory';

const c = config();
const db = new Pool({ connectionString: c.DATABASE_URL, max: 2 });
const source = new URL(c.DIRECTORY_URL).origin;
let lastSuccess = Date.now();

async function pass() {
 const run = (await db.query('INSERT INTO directory_sync_runs (source) VALUES ($1) RETURNING id', [source])).rows[0].id;
 try {
  const r = await fetch(c.DIRECTORY_URL, { headers: { Authorization: `Bearer ${c.DIRECTORY_TOKEN}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Directory HTTP ${r.status}`);
  const snapshot = directorySnapshotSchema.parse(await r.json());
  const counts = await applyDirectorySnapshot(db, c.OIDC_ISSUER.replace(/\/$/, ''), source, snapshot);
  await db.query('UPDATE directory_sync_runs SET finished_at = now(), complete = $2 WHERE id = $1', [run, snapshot.complete]);
  lastSuccess = Date.now();
  console.log(JSON.stringify({ level: 'info', event: 'directory_sync', ...counts }));
  return true;
 } catch (e) {
  const message = e instanceof Error ? e.message : 'unknown';
  await db.query('UPDATE directory_sync_runs SET finished_at = now(), error = $2 WHERE id = $1', [run, message.slice(0, 500)]);
  // Stale observations are an alarm condition: revocation depends on this loop (15-minute target).
  console.error(JSON.stringify({ level: 'error', event: 'directory_sync_failed', error: message, staleSeconds: Math.round((Date.now() - lastSuccess) / 1000) }));
  return false;
 }
}

if (process.argv.includes('--once')) { const ok = await pass(); await db.end(); process.exit(ok ? 0 : 1); }
for (;;) { await pass(); await new Promise(r => setTimeout(r, c.DIRECTORY_POLL_SECONDS * 1000)); }
