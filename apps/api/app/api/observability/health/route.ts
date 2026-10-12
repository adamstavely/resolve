import { config } from '../../../../lib/config';
import { pool } from '../../../../lib/db';
import { json } from '../../../../lib/http';
import { auditRead } from '../../../../lib/audit';
import { fleetRequest } from '../../../../lib/fleet/http';
import { fleetHealth } from '../../../../lib/integrations/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Service health for every registered app, from committed snapshots (plan 14, E1). Never calls Elastic. */
export async function GET(request: Request) {
 const r = await fleetRequest(request, 'observability.health');
 if (r instanceof Response) return r;
 const pollSeconds = config().OBSERVABILITY_POLL_SECONDS;
 const apps = await fleetHealth(pool(), r.apps, pollSeconds);
 await auditRead(r.principal, 'observability_health', { apps: apps.length });
 return json({ apps, pollSeconds });
}
