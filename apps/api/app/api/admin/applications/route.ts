import { pool } from '../../../../lib/db';
import { json } from '../../../../lib/http';
import { registry } from '../../../../lib/registry';
import { admin } from '../../../../lib/fleet-admin/http';
import { listApplications } from '../../../../lib/fleet-admin/onboarding';
import { auditRead } from '../../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Registered applications with their environments, plus registry apps managed outside onboarding. */
export async function GET(request: Request) {
 return admin(request, 'app.register', async principal => {
  const applications = await listApplications(pool());
  const bound = new Set(applications.flatMap(a => a.bindings.map((b: { workspaceKey: string }) => b.workspaceKey)));
  const reg = await registry().catch(() => ({ apps: [] as { appKey: string; displayName: string; state: string }[] }));
  const external = reg.apps.filter(a => !bound.has(a.appKey)).map(a => ({ appKey: a.appKey, displayName: a.displayName, state: a.state }));
  await auditRead(principal, 'applications', { count: applications.length });
  return json({ applications, external });
 });
}
