import { CLEARANCE_TOOL_VERSION } from '@resolve/contracts';
import { json } from '../../../lib/http';
import { auditRead } from '../../../lib/audit';
import { fanOut } from '../../../lib/fleet/fanout';
import { fleetRequest } from '../../../lib/fleet/http';
import { callTenantTool } from '../../../lib/tenants/mcp';
import { tenantHealth } from '../../../lib/tenants/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Your support tier (T1–T3) in each application, as the application reports it with your own grant (QB-TIER-1).
 * An application that does not advertise the tool has no tier to show; that is not an error. Dormant and unavailable
 * applications are not contacted.
 */
export async function GET(request: Request) {
 const ctx = await fleetRequest(request, 'ticket.read');
 if (ctx instanceof Response) return ctx;
 const reports = await Promise.all(ctx.apps.map(async a => {
  const h = await tenantHealth(a).catch(() => null);
  return (h?.status === 'ok' && (h.tools.get_my_tier ?? 0) >= CLEARANCE_TOOL_VERSION) ? a : null;
 }));
 const advertised = ctx.apps.filter((_, i) => reports[i]);
 const results = await fanOut(advertised, app => callTenantTool(app, ctx.principal.userId, 'get_my_tier', {}));
 const apps = ctx.apps.map(a => {
  const r = results.find(x => x.appKey === a.appKey);
  if (!r) return { appKey: a.appKey, tier: null, status: 'not_reported' as const };
  return r.status === 'ok' ? { appKey: a.appKey, tier: r.data.tier, status: 'ok' as const } : { appKey: a.appKey, tier: null, status: 'unavailable' as const };
 });
 await auditRead(ctx.principal, 'clearance', { apps: apps.filter(a => a.status === 'ok').length });
 return json({ apps });
}
