import { CLEARANCE_TOOL_VERSION, type RegistryApp } from '@resolve/contracts';
import { registry } from './registry';
import { callTenantTool } from './tenants/mcp';
import { tenantHealth } from './tenants/protocol';

/**
 * A person's support tier (T1–T3) in each named application, as the application reports it with their own grant
 * (QB-TIER-1). Null when the application does not advertise the tool, cannot be reached, or reports no tier: the
 * caller must treat that as "no tier", never as a default.
 */
export async function tiersFor(userId: string, appKeys: readonly string[]): Promise<Record<string, 1 | 2 | 3 | null>> {
 const reg = await registry();
 const out: Record<string, 1 | 2 | 3 | null> = {};
 await Promise.all(appKeys.map(async key => {
  out[key] = null;
  const app = reg.apps.find(a => a.appKey === key) as RegistryApp | undefined;
  if (!app) return;
  const h = await tenantHealth(app).catch(() => null);
  if (h?.status !== 'ok' || (h.tools.get_my_tier ?? 0) < CLEARANCE_TOOL_VERSION) return;
  const r = await callTenantTool(app, userId, 'get_my_tier', {}).catch(() => null);
  if (r?.ok) out[key] = r.data.tier;
 }));
 return out;
}
