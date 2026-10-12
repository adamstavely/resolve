import { pool } from '../../../../lib/db';
import { json } from '../../../../lib/http';
import { auditRead } from '../../../../lib/audit';
import { fleetRequest } from '../../../../lib/fleet/http';
import { liveActivity } from '../../../../lib/integrations/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Live activity across the console (prototype board 2): actions and whether each was verified downstream. */
export async function GET(request: Request) {
 const r = await fleetRequest(request, 'observability.health');
 if (r instanceof Response) return r;
 const entries = await liveActivity(pool(), r.principal.userId, r.apps.map(a => a.appKey));
 await auditRead(r.principal, 'live_activity', { entries: entries.length });
 return json({ entries });
}
