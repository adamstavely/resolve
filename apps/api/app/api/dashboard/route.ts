import type { NextRequest } from 'next/server';
import { KPI_METRICS, sumMetric, type KpiMetric, type MetricValue } from '@resolve/contracts';
import { json } from '../../../lib/http';
import { fanOut } from '../../../lib/fleet/fanout';
import { fleetRequest, includeParam } from '../../../lib/fleet/http';
import { callTenantTool } from '../../../lib/tenants/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * First-pass KPIs (plan 11) and recent activity across the fleet. Totals sum only apps that reported a value;
 * an app without data or permission is listed as missing, never counted as zero. Dormant apps are skipped
 * unless named in `include`.
 */
export async function GET(request: NextRequest) {
 const ctx = await fleetRequest(request, 'dashboard.view');
 if (ctx instanceof Response) return ctx;
 const include = includeParam(request.nextUrl);
 const [kpis, activity] = await Promise.all([
  fanOut(ctx.apps, app => callTenantTool(app, ctx.principal.userId, 'get_support_dashboard', { warningHorizonMinutes: 30 }), { include }),
  fanOut(ctx.apps, app => callTenantTool(app, ctx.principal.userId, 'list_support_activity', { limit: 10 }), { include }),
 ]);
 const totals = Object.fromEntries(KPI_METRICS.map(m => [m, sumMetric(kpis.map(r => ({
  appKey: r.appKey,
  metric: (r.status === 'ok'
   ? (r.data.metrics[m].status === 'available' ? { status: 'available', value: r.data.metrics[m].value, asOf: r.data.asOf } : { status: 'unavailable', reason: r.data.metrics[m].reason })
   : { status: 'unavailable', reason: 'app_unavailable' }) as MetricValue,
 })))])) as Record<KpiMetric, ReturnType<typeof sumMetric>>;
 // Report why an app is missing (suspended, dormant, not connected…) rather than a generic reason.
 const appReason = new Map(kpis.flatMap(r => r.status === 'unavailable' ? [[r.appKey, r.reason] as const] : []));
 for (const t of Object.values(totals)) t.missing = t.missing.map(m => m.reason === 'app_unavailable' ? { ...m, reason: appReason.get(m.appKey) ?? m.reason } : m);
 const merged = activity.flatMap(r => r.status === 'ok' ? r.data.entries.map(e => ({ ...e, appKey: r.appKey })) : [])
  .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 30);
 return json({
  apps: kpis, totals, activity: merged,
  activityApps: activity.map(r => r.status === 'ok' ? { ...r, data: { coverageSince: r.data.coverageSince, hasMore: r.data.nextCursor !== null } } : r),
 });
}
