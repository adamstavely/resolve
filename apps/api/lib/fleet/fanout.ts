import { isServable, UNAVAILABLE_REASONS, type RegistryApp } from '@resolve/contracts';
import { tenantHealth } from '../tenants/protocol';
import type { ToolOutcome } from '../tenants/mcp';

/*
 * Fleet fan-out (plan 01 "Aggregation"): bounded concurrency, per-app timeout, app provenance on every result,
 * and partial results instead of all-or-nothing. Dormant apps are skipped unless the user explicitly asked
 * for them, so passive dashboards never wake a tenant. Unavailable apps are never contacted.
 */
export const FANOUT_CONCURRENCY = 6;
export const APP_TIMEOUT_MS = 4000;

type Reason = (typeof UNAVAILABLE_REASONS)[number];
export type AppResult<T> =
 | { status: 'ok'; appKey: string; fetchedAt: string; data: T }
 | { status: 'unavailable'; appKey: string; reason: Reason; retryable: boolean };

const RETRYABLE: Record<Reason, boolean> = {
 not_connected: false, reconnect_required: false, denied: false, timeout: true, tenant_error: true, incompatible: false, suspended: false, dormant: true,
};
export const unavailable = (appKey: string, reason: Reason): AppResult<never> => ({ status: 'unavailable', appKey, reason, retryable: RETRYABLE[reason] });

export async function fanOut<T>(apps: RegistryApp[], call: (app: RegistryApp) => Promise<ToolOutcome<T>>,
 opts: { include?: ReadonlySet<string>; concurrency?: number; timeoutMs?: number } = {}): Promise<AppResult<T>[]> {
 const results: AppResult<T>[] = new Array(apps.length);
 let next = 0;
 const worker = async () => {
  while (next < apps.length) {
   const i = next++;
   results[i] = await one(apps[i]);
  }
 };
 const one = async (app: RegistryApp): Promise<AppResult<T>> => {
  if (!isServable(app)) return unavailable(app.appKey, 'suspended');
  if (app.dormant && !opts.include?.has(app.appKey)) return unavailable(app.appKey, 'dormant');
  const health = await tenantHealth(app);
  if (health.status === 'incompatible') return unavailable(app.appKey, 'incompatible');
  if (health.status === 'unreachable') return unavailable(app.appKey, 'tenant_error');
  const timeout = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), opts.timeoutMs ?? APP_TIMEOUT_MS).unref?.());
  const outcome = await Promise.race([call(app).catch(() => ({ ok: false, reason: 'tenant_error' } as const)), timeout]);
  if (outcome === 'timeout') return unavailable(app.appKey, 'timeout');
  if (outcome.ok) return { status: 'ok', appKey: app.appKey, fetchedAt: new Date().toISOString(), data: outcome.data };
  // A hidden or missing item in a fleet list is not an app failure; detail routes handle not_found themselves.
  return unavailable(app.appKey, outcome.reason === 'not_found' ? 'tenant_error' : outcome.reason);
 };
 await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? FANOUT_CONCURRENCY, apps.length) }, worker));
 return results;
}
