import { registryPageSchema, type RegistryApp } from '@resolve/contracts';
import { config, isLoopback } from './config';
import { pool } from './db';

/*
 * Registry adapter (contract 1). Reads the fleet adapter's column-limited projection with a service
 * credential, validates it strictly, and caches it briefly. Resolve never keeps its own copy of the registry.
 */
/** Short, so lifecycle changes made by the job dispatcher (another process) show up quickly everywhere. */
const TTL_MS = 10_000;
let cache: { at: number; revision: string; apps: RegistryApp[] } | undefined;

export class RegistryUnavailable extends Error {}

/** Production requires https origins; loopback http is accepted only outside production (local mocks). */
export function acceptableOrigin(origin: string) {
 const u = new URL(origin);
 return u.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && isLoopback(origin));
}

/**
 * Resolve's own lifecycle gates agent traffic: an app bound through onboarding serves agents only once Resolve has
 * activated it, even if the fleet already routes it (an adopted instance keeps serving its own users meanwhile).
 */
async function bindingLifecycles(apps: RegistryApp[]) {
 const rows = (await pool().query('SELECT workspace_key, lifecycle FROM instance_bindings WHERE workspace_key = ANY($1)', [apps.map(a => a.appKey)])).rows;
 // Any binding change counts (a newly adopted or created instance is not in the cached projection yet).
 const changed = (await pool().query('SELECT max(updated_at) AS at FROM instance_bindings')).rows[0]?.at as Date | null;
 return { lifecycle: new Map(rows.map(r => [r.workspace_key as string, r.lifecycle as string])), changedAt: changed?.getTime() ?? 0 };
}
function lifecycleOverlay(apps: RegistryApp[], lifecycle: Map<string, string>): RegistryApp[] {
 return apps.map(a => {
  const l = lifecycle.get(a.appKey);
  if (!l || l === 'active') return a;
  return { ...a, routable: false, state: l === 'suspended' ? 'suspended' : a.state === 'active' ? 'maintenance' : a.state };
 });
}

/** The fleet's projection without Resolve's lifecycle overlay (pilot access to an instance under validation). */
export async function rawRegistryApp(appKey: string) {
 const found = (await registry(fetch, false)).apps.find(a => a.appKey === appKey);
 if (found || !cache || Date.now() - cache.at < 1000) return found;
 cache = undefined;
 return (await registry(fetch, false)).apps.find(a => a.appKey === appKey);
}

/**
 * The registry with Resolve's lifecycle overlay. When Resolve changed a binding (activation, suspension, a new
 * instance; possibly in another process) after the cached projection was read, the fleet is read again, so the
 * change is visible at once rather than after the cache period.
 */
export async function registry(fetchImpl: typeof fetch = fetch, overlay = true): Promise<{ revision: string; apps: RegistryApp[] }> {
 let raw = await fetchRegistry(fetchImpl);
 let b = await bindingLifecycles(raw.apps);
 if (cache && b.changedAt > cache.at) {
  cache = undefined;
  raw = await fetchRegistry(fetchImpl);
  b = await bindingLifecycles(raw.apps);
 }
 return overlay ? { revision: raw.revision, apps: lifecycleOverlay(raw.apps, b.lifecycle) } : raw;
}

async function fetchRegistry(fetchImpl: typeof fetch): Promise<{ revision: string; apps: RegistryApp[] }> {
 if (cache && Date.now() - cache.at < TTL_MS) return cache;
 const c = config();
 let raw: unknown;
 try {
  const r = await fetchImpl(c.REGISTRY_URL, { headers: { Authorization: `Bearer ${c.REGISTRY_TOKEN}` }, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  raw = await r.json();
 } catch (e) {
  throw new RegistryUnavailable(e instanceof Error ? e.message : 'unknown');
 }
 const page = registryPageSchema.parse(raw);
 // An app with an unacceptable origin is reported as unknown rather than contacted.
 const apps = page.apps.map(a => acceptableOrigin(a.supportOrigin) ? a : { ...a, state: 'unknown' as const, routable: false });
 cache = { at: Date.now(), revision: page.revision, apps };
 return cache;
}

export async function registryApp(appKey: string) {
 const found = (await registry()).apps.find(a => a.appKey === appKey);
 if (found || !cache || Date.now() - cache.at < 1000) return found;
 // Not in the cached projection: it may have just been provisioned. Read the fleet once more.
 cache = undefined;
 return (await registry()).apps.find(a => a.appKey === appKey);
}

export const tenantIssuer = (app: RegistryApp) => `${app.supportOrigin}/api/auth`;

export function resetRegistryCache() { cache = undefined; }
