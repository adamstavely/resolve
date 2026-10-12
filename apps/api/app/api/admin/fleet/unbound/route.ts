import { json, problem } from '../../../../../lib/http';
import { admin } from '../../../../../lib/fleet-admin/http';
import { unboundInstances } from '../../../../../lib/fleet-admin/worker-client';
import { auditRead } from '../../../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Managed instances not bound to any application yet (the only ones that can be adopted). */
export async function GET(request: Request) {
 return admin(request, 'app.register', async principal => {
  const r = await unboundInstances();
  await auditRead(principal, 'fleet_unbound', {}, r.kind === 'ok' ? 'succeeded' : 'failed');
  return r.kind === 'ok' ? json(r.data) : problem(503, 'WORKER_UNAVAILABLE', 'The fleet worker is unavailable. Try again shortly.');
 });
}
