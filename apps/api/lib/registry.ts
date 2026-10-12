import { registryPageSchema, type RegistryApp } from '@resolve/contracts';
import { config, isLoopback } from './config';

/*
 * Registry adapter (contract 1). Reads the fleet adapter's column-limited projection with a service
 * credential, validates it strictly, and caches it briefly. Resolve never keeps its own copy of the registry.
 */
const TTL_MS = 30_000;
let cache: { at: number; revision: string; apps: RegistryApp[] } | undefined;

export class RegistryUnavailable extends Error {}

/** Production requires https origins; loopback http is accepted only outside production (local mocks). */
export function acceptableOrigin(origin: string) {
 const u = new URL(origin);
 return u.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && isLoopback(origin));
}

export async function registry(fetchImpl: typeof fetch = fetch): Promise<{ revision: string; apps: RegistryApp[] }> {
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
 return (await registry()).apps.find(a => a.appKey === appKey);
}

export const tenantIssuer = (app: RegistryApp) => `${app.supportOrigin}/api/auth`;

export function resetRegistryCache() { cache = undefined; }
