import { pool } from '../../../../lib/db';
import { json } from '../../../../lib/http';
import { auditRead } from '../../../../lib/audit';
import { fleetRequest } from '../../../../lib/fleet/http';
import { activeIssues } from '../../../../lib/integrations/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Live known issues (active Elastic alerts and open cases) across registered apps. */
export async function GET(request: Request) {
 const r = await fleetRequest(request, 'observability.health');
 if (r instanceof Response) return r;
 const issues = await activeIssues(pool(), r.apps.map(a => a.appKey));
 await auditRead(r.principal, 'observability_issues', { issues: issues.length });
 return json({ issues });
}
