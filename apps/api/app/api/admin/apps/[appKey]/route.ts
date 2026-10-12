import { appKeySchema, type AppAdmin } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { json, problem } from '../../../../../lib/http';
import { registry, resetRegistryCache } from '../../../../../lib/registry';
import { admin } from '../../../../../lib/fleet-admin/http';
import { jobsFor, refresh } from '../../../../../lib/fleet-admin/jobs';
import { entitlementSummary, mappingsFor } from '../../../../../lib/fleet-admin/entitlements';
import { auditRead } from '../../../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One app's administration view: lifecycle, team mappings, jobs and entitlement sync. */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string }> }) {
 const { appKey } = await ctx.params;
 return admin(request, 'app.register', async principal => {
  if (!appKeySchema.safeParse(appKey).success) return problem(404, 'NOT_FOUND', 'Unknown application.');
  // Bring running jobs up to date, and read the fleet afresh if a job changed this app recently.
  const recent = (await pool().query(`SELECT id, stage FROM fleet_jobs WHERE app_key = $1 AND updated_at > now() - interval '30 seconds'`, [appKey])).rows;
  for (const j of recent) await refresh(pool(), j.id).catch(() => undefined);
  if (recent.length) resetRegistryCache();
  const binding = (await pool().query(`SELECT b.lifecycle, b.application_id, a.name, b.environment FROM instance_bindings b JOIN applications a ON a.id = b.application_id WHERE b.workspace_key = $1`, [appKey])).rows[0];
  const reg = (await registry(fetch, false).catch(() => ({ apps: [] as { appKey: string; displayName: string; state: string }[] }))).apps.find(a => a.appKey === appKey);
  if (!binding && !reg) return problem(404, 'NOT_FOUND', 'Unknown application.');
  const { mappings, version } = await mappingsFor(pool(), appKey);
  const view: AppAdmin = {
   appKey, applicationId: binding?.application_id ?? null,
   displayName: binding ? (binding.environment === 'production' ? binding.name : `${binding.name} (test)`) : reg!.displayName,
   lifecycle: binding?.lifecycle ?? null, registryState: reg?.state ?? null, teamMappings: mappings, mappingsVersion: version,
   jobs: await jobsFor(pool(), { appKey }), entitlements: await entitlementSummary(pool(), appKey),
  };
  await auditRead(principal, 'app_admin', { app: appKey });
  return json(view);
 });
}
