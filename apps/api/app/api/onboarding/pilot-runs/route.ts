import { pool } from '../../../../lib/db';
import { json } from '../../../../lib/http';
import { requireCapability } from '../../../../lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Onboarding runs where the signed-in person is a named pilot and a pilot check is possible or pending. */
export async function GET(request: Request) {
 const principal = await requireCapability(request, 'connection.manage');
 if (principal instanceof Response) return principal;
 const rows = (await pool().query(`SELECT r.id, r.status, a.name, r.environment, b.workspace_key,
   EXISTS (SELECT 1 FROM pilot_checks p WHERE p.run_id = r.id AND p.user_id = $1 AND p.passed AND p.config_revision = r.config_revision) AS done
  FROM onboarding_runs r JOIN applications a ON a.id = r.application_id JOIN instance_bindings b ON b.id = r.binding_id
  WHERE r.status IN ('provisioning', 'validating', 'ready', 'failed') AND r.steps->'access'->'pilotUserIds' ? $1::text ORDER BY r.updated_at DESC`, [principal.userId])).rows;
 return json({ runs: rows.map(r => ({ runId: r.id, applicationName: r.name, environment: r.environment, workspaceKey: r.workspace_key, status: r.status, done: r.done })) });
}
