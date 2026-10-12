/*
 * Development-only mock Quackback fleet. Each instance in tenants.json listens on its own port and acts as that
 * instance's OAuth authorization server for Resolve, the way Quackback's Better Auth provider does (issuer
 * `${origin}/api/auth`); see tenant.mts. Tenant sign-in federates to the mock IdP, so an existing IdP session
 * connects without a second prompt (first-party, no consent screen).
 *
 * Port 3300 serves:
 * - the Resolve-facing registry projection (contract 1, gap QB-REG-1): bound instances only;
 * - the privileged fleet worker (contract 4; worker.mts): jobs, unbound instances, adoption reports, migration status.
 *
 *   npm run dev:tenants   (reads .env: OIDC_ISSUER, RESOLVE_ORIGIN, REGISTRY_TOKEN, WORKER_TOKEN, DIRECTORY_TOKEN)
 */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { body, send, setRelayFailure, sha, startTenant, type FleetContext, type Tenant, type TenantConfig } from './tenant.mjs';
import { FleetWorker } from './worker.mjs';
import type { Viewer } from './fixtures.mjs';

if (process.env.NODE_ENV === 'production') throw new Error('The mock tenants must never run in production');

const fleetConfig: { registryPort: number; tenants: TenantConfig[]; people: FleetContext['people'] } = JSON.parse(readFileSync(new URL('./tenants.json', import.meta.url), 'utf8'));
const required = (name: string) => { const v = process.env[name]; if (!v) throw new Error(`${name} is required (see .env.example)`); return v; };
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ctx: FleetContext = {
 idp: new URL(required('OIDC_ISSUER')).origin,
 resolveRedirect: `${new URL(required('RESOLVE_ORIGIN')).origin}/api/connect/callback`,
 people: fleetConfig.people,
 names: { 'mock|ada': 'Ada Admin', 'mock|sam': 'Sam Agent', 'mock|ivy': 'Ivy Investigator', 'mock|olive': 'Olive Observer', 'mock|bo': 'Bo Blockable', 'mock|sam-imposter': 'Sam Duplicate' },
};
const registryToken = required('REGISTRY_TOKEN');
const workerToken = required('WORKER_TOKEN');
/** The fleet's serving image (one image per fleet, plan 03). */
const IMAGE = 'sha256:' + sha('quackback-0.14.1-mock');

const fleet = new Map<string, Tenant>();
for (const t of fleetConfig.tenants) fleet.set(t.appKey, await startTenant(t, ctx, IMAGE));
const worker = new FleetWorker(fleet, ctx, required('DIRECTORY_TOKEN'), IMAGE);

createServer(async (req, res) => {
 try {
  const url = new URL(req.url ?? '/', 'http://x');
  const auth = req.headers.authorization ?? '';
  if (req.method === 'GET' && url.pathname === '/registry') {
   if (!safeEqual(auth, `Bearer ${registryToken}`)) return send(res, 401, { error: 'unauthorized' });
   const apps = [...fleet.values()].filter(t => t.bound).map(t => ({
    appKey: t.config.appKey, displayName: t.config.displayName, supportOrigin: t.origin, routable: t.routable, dormant: t.dormant, state: t.state,
    deploymentVersion: `quackback-${t.image.slice(7, 19)}`, protocolVersions: [1], lastActivityAt: null,
   }));
   return send(res, 200, { schemaVersion: 1, revision: sha(JSON.stringify(apps)).slice(0, 12), apps });
  }
  if (url.pathname.startsWith('/worker/')) {
   if (!safeEqual(auth, `Bearer ${workerToken}`)) return send(res, 401, { error: 'unauthorized' });
   const job = url.pathname.match(/^\/worker\/jobs\/([0-9a-f-]{36})(\/resume|\/cancel)?$/);
   if (req.method === 'POST' && url.pathname === '/worker/jobs') { const r = worker.submit(JSON.parse(await body(req, 65_536))); return send(res, r.status, r.body); }
   if (job && req.method === 'GET' && !job[2]) { const s = worker.get(job[1]); return s ? send(res, 200, s) : send(res, 404, { error: 'NOT_FOUND' }); }
   if (job && req.method === 'POST' && job[2]) { const r = job[2] === '/resume' ? worker.resume(job[1]) : worker.cancel(job[1]); return send(res, r.status, r.body); }
   if (req.method === 'GET' && url.pathname === '/worker/unbound') return send(res, 200, { instances: worker.unbound() });
   const report = url.pathname.match(/^\/worker\/instances\/([a-z][a-z0-9-]{1,62})\/report$/);
   if (req.method === 'GET' && report) {
    const t = fleet.get(report[1]);
    return t && (!t.bound || t.adopted) ? send(res, 200, worker.report(t)) : send(res, 404, { error: 'NOT_FOUND' });
   }
   if (req.method === 'GET' && url.pathname === '/worker/migrations') return send(res, 200, worker.migrations());
   return send(res, 404, { error: 'not_found' });
  }
  // Development controls (tests): worker faults, a new fleet image, migrating the fleet.
  if (req.method === 'POST' && url.pathname === '/dev/worker/fault') return send(res, 200, worker.setFault(JSON.parse(await body(req))));
  if (req.method === 'POST' && url.pathname === '/dev/worker/image') return send(res, 200, worker.setImage(String(JSON.parse(await body(req)).image)));
  if (req.method === 'POST' && url.pathname === '/dev/worker/migrate-all') return send(res, 200, worker.migrateAll());
  if (req.method === 'POST' && url.pathname === '/dev/worker/unbound') {
   const b = JSON.parse(await body(req));
   const t = await worker.createUnbound(String(b.appKey), String(b.displayName ?? b.appKey));
   return send(res, 200, { appKey: t.config.appKey, port: t.config.port });
  }
  if (req.method === 'POST' && url.pathname === '/dev/relay') { const b = JSON.parse(await body(req)); setRelayFailure(String(b.appKey), !!b.failing); return send(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/dev/fleet') return send(res, 200, [...fleet.values()].map(t => ({
   appKey: t.config.appKey, state: t.state, routable: t.routable, bound: t.bound, adopted: t.adopted, port: t.config.port, image: t.image,
   pilots: t.pilots.size, entitlements: t.entitlements.size, configRevision: t.configRevision, mailbox: t.mailbox,
  })));
  send(res, 404, { error: 'not_found' });
 } catch (e) {
  send(res, 500, { error: 'server_error', error_description: e instanceof Error ? e.message : 'unknown' });
 }
}).listen(fleetConfig.registryPort, '127.0.0.1', () => console.log(`Mock fleet registry and worker at http://127.0.0.1:${fleetConfig.registryPort}`));

export type { Viewer };
