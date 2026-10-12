import { isServable } from '@resolve/contracts';
import { pool } from '../../../lib/db';
import { requireCapability } from '../../../lib/auth/session';
import { registry, RegistryUnavailable } from '../../../lib/registry';
import { grantsFor } from '../../../lib/tenants/grants';
import { tenantHealth } from '../../../lib/tenants/protocol';
import { auditRead } from '../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
 const principal = await requireCapability(request, 'fleet.view');
 if (principal instanceof Response) return principal;
 let reg;
 try { reg = await registry(); } catch (e) {
  if (e instanceof RegistryUnavailable) return Response.json({ error: { code: 'REGISTRY_UNAVAILABLE', message: 'The application registry is unavailable.', requestId: crypto.randomUUID() } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  throw e;
 }
 const grants = await grantsFor(pool(), principal.userId);
 await auditRead(principal, 'apps', { registryRevision: reg.revision });
 return Response.json({
  registryRevision: reg.revision,
  apps: await Promise.all(reg.apps.map(async a => {
   const g = grants.get(a.appKey);
   // Probing would wake a dormant app or contact an unavailable one, so those are reported as not checked.
   const health = isServable(a) && !a.dormant ? await tenantHealth(a).then(({ tools: _t, ...h }) => h) : { status: 'not_checked' as const, reasons: [], checkedAt: null };
   return { appKey: a.appKey, displayName: a.displayName, state: a.state, servable: isServable(a), dormant: a.dormant, health,
    connection: { state: g?.state ?? 'not_connected', scopes: g?.scopes ?? [], tenantUserId: g?.tenantUserId ?? null } };
  })),
 }, { headers: { 'Cache-Control': 'no-store' } });
}

