import { evaluateCompatibility, TARGET_PROTOCOL, TARGET_TOOL_VERSIONS, TENANT_PROTOCOL_PATH, type RegistryApp } from '@resolve/contracts';

/*
 * Tenant compatibility (contract 6): read the tenant's advertised protocol and tool versions and compare them
 * with what Resolve requires. Incompatible tenants are reported, never called with guessed arguments.
 * Cached briefly per origin. Callers must not probe dormant or unavailable apps (that would wake them).
 */
export type Health = { status: 'ok' | 'incompatible' | 'unreachable'; reasons: string[]; checkedAt: string };
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; health: Health }>();

export async function tenantHealth(app: RegistryApp, fetchImpl: typeof fetch = fetch): Promise<Health> {
 const hit = cache.get(app.supportOrigin);
 if (hit && Date.now() - hit.at < TTL_MS) return hit.health;
 let health: Health;
 try {
  const r = await fetchImpl(app.supportOrigin + TENANT_PROTOCOL_PATH, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const c = evaluateCompatibility(await r.json(), { protocol: TARGET_PROTOCOL, tools: TARGET_TOOL_VERSIONS });
  health = { status: c.compatible ? 'ok' : 'incompatible', reasons: c.reasons.map(x => x.tool ? `${x.code}:${x.tool}` : x.code), checkedAt: new Date().toISOString() };
 } catch {
  health = { status: 'unreachable', reasons: ['UNREACHABLE'], checkedAt: new Date().toISOString() };
 }
 cache.set(app.supportOrigin, { at: Date.now(), health });
 return health;
}

export function resetHealthCache() { cache.clear(); }
