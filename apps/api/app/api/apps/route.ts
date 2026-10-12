import { isServable } from '@resolve/contracts';
import { pool } from '../../../lib/db';
import { requireCapability } from '../../../lib/auth/session';
import { registry, RegistryUnavailable } from '../../../lib/registry';
import { grantsFor } from '../../../lib/tenants/grants';

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
 return Response.json({
  registryRevision: reg.revision,
  apps: reg.apps.map(a => {
   const g = grants.get(a.appKey);
   return { appKey: a.appKey, displayName: a.displayName, state: a.state, servable: isServable(a),
    connection: { state: g?.state ?? 'not_connected', scopes: g?.scopes ?? [], tenantUserId: g?.tenantUserId ?? null } };
  }),
 }, { headers: { 'Cache-Control': 'no-store' } });
}

