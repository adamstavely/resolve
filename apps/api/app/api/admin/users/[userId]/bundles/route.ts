import { BUNDLES, bundleGrantSchema, uuidSchema } from '@resolve/contracts';
import { z } from 'zod';
import { pool, transaction } from '../../../../../../lib/db';
import { json } from '../../../../../../lib/http';
import { writeAudit } from '../../../../../../lib/audit';
import { adminMutation, fieldProblem } from '../../../../../../lib/fleet-admin/http';
import { recomputeUser } from '../../../../../../lib/fleet-admin/entitlements';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = bundleGrantSchema.extend({ grant: z.boolean() });

/**
 * Grant or remove a manual bundle (claim bundles come from IdP groups and are replaced at each sign-in). Takes effect
 * on the person's next request in Resolve, and in each mapped app through versioned entitlements.
 */
export async function POST(request: Request, ctx: { params: Promise<{ userId: string }> }) {
 const { userId } = await ctx.params;
 return adminMutation(request, 'roles.manage', async (principal, raw) => {
  const body = schema.safeParse(raw);
  if (!uuidSchema.safeParse(userId).success) return fieldProblem(404, 'NOT_FOUND', 'Person not found.');
  if (!body.success) return fieldProblem(400, 'INVALID_REQUEST', body.error.issues[0]?.message ?? 'Choose a bundle and give a reason.', { field: String(body.error.issues[0]?.path.at(-1) ?? '') });
  if (!(body.data.bundle in BUNDLES)) return fieldProblem(400, 'INVALID_REQUEST', 'Unknown bundle.', { field: 'bundle' });
  if (userId === principal.userId) return fieldProblem(409, 'SELF', 'You cannot change your own bundles.');
  const changed = await transaction(pool(), async tx => {
   if (!(await tx.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount) return null;
   const r = body.data.grant
    ? await tx.query(`INSERT INTO role_members (user_id, bundle, source) VALUES ($1, $2, 'manual') ON CONFLICT DO NOTHING`, [userId, body.data.bundle])
    : await tx.query(`DELETE FROM role_members WHERE user_id = $1 AND bundle = $2 AND source = 'manual'`, [userId, body.data.bundle]);
   await writeAudit(tx, { actorUserId: principal.userId, operation: body.data.grant ? 'user.bundle_grant' : 'user.bundle_revoke', outcome: 'succeeded',
    summary: { targetUserId: userId, bundle: body.data.bundle, reason: body.data.reason, changed: (r.rowCount ?? 0) > 0 } });
   return (r.rowCount ?? 0) > 0;
  });
  if (changed === null) return fieldProblem(404, 'NOT_FOUND', 'Person not found.');
  if (changed) await recomputeUser(pool(), userId);
  const bundles = (await pool().query('SELECT bundle, source FROM role_members WHERE user_id = $1 ORDER BY bundle, source', [userId])).rows;
  return json({ changed, bundles });
 });
}
