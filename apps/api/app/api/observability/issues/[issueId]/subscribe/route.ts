import { subscribeRequestSchema } from '@resolve/contracts';
import { pool } from '../../../../../../lib/db';
import { json, jsonMutation, problem } from '../../../../../../lib/http';
import { requireCapability } from '../../../../../../lib/auth/session';
import { writeAudit } from '../../../../../../lib/audit';
import { subscribe } from '../../../../../../lib/integrations/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** "Notify me when it clears." Clearing never re-runs anything; it asks for a new attempt. */
export async function POST(request: Request, ctx: { params: Promise<{ issueId: string }> }) {
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const principal = await requireCapability(request, 'observability.link');
 if (principal instanceof Response) return principal;
 const { issueId } = await ctx.params;
 const body = subscribeRequestSchema.safeParse(raw);
 if (!body.success || !/^[0-9a-f-]{36}$/.test(issueId)) return problem(400, 'INVALID_REQUEST', 'Invalid request.');
 const exists = (await pool().query(`SELECT 1 FROM known_issues WHERE id = $1 AND state = 'active'`, [issueId])).rowCount;
 if (!exists) return problem(404, 'NOT_FOUND', 'This issue is not active.');
 await subscribe(pool(), principal.userId, issueId, body.data.objectKind ?? null, body.data.objectId ?? null);
 await writeAudit(pool(), { actorUserId: principal.userId, operation: 'observability.issue_subscribe', outcome: 'succeeded', summary: { issue: issueId, target: body.data.objectId ?? null } });
 return json({ subscribed: true });
}
