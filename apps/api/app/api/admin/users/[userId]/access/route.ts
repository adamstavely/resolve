import { accessChangeSchema, uuidSchema } from '@resolve/contracts';
import { setManualAccess } from '../../../../../../lib/admin';
import { pool } from '../../../../../../lib/db';
import { json, jsonMutation, problem } from '../../../../../../lib/http';
import { requireCapability } from '../../../../../../lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RESULTS = {
 changed: [200, null],
 unchanged: [200, null],
 not_found: [404, 'No person with this id.'],
 self: [409, 'You cannot block your own access.'],
 directory_disabled: [409, 'This person is disabled in the directory. Re-enable them there.'],
} as const;

/** Apply or lift an emergency access block (plan 02). Blocking revokes sessions and app connections immediately. */
export async function POST(request: Request, ctx: { params: Promise<{ userId: string }> }) {
 const body = await jsonMutation(request);
 if (body instanceof Response) return body;
 const principal = await requireCapability(request, 'users.manage');
 if (principal instanceof Response) return principal;
 const { userId } = await ctx.params;
 if (!uuidSchema.safeParse(userId).success) return problem(404, 'NOT_FOUND', 'No person with this id.');
 const change = accessChangeSchema.safeParse(body);
 if (!change.success) return problem(400, 'INVALID_REQUEST', change.error.issues[0]?.message ?? 'Invalid request.');
 const result = await setManualAccess(pool(), principal.userId, userId, change.data.enabled, change.data.reason);
 const [status, message] = RESULTS[result];
 return message ? problem(status, result.toUpperCase(), message) : json({ result, enabled: change.data.enabled });
}
