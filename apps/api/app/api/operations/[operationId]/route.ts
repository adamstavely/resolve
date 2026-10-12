import { uuidSchema } from '@resolve/contracts';
import { pool } from '../../../../lib/db';
import { json, problem } from '../../../../lib/http';
import { requireCapability } from '../../../../lib/auth/session';
import { findOperation, KEYED_OPERATIONS, toApi } from '../../../../lib/operations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** An operation's current state. Only its author can read it. */
export async function GET(request: Request, ctx: { params: Promise<{ operationId: string }> }) {
 const principal = await requireCapability(request, 'fleet.view');
 if (principal instanceof Response) return principal;
 const { operationId } = await ctx.params;
 const row = uuidSchema.safeParse(operationId).success ? await findOperation(pool(), operationId, principal.userId) : undefined;
 return row ? json({ operation: toApi(row, KEYED_OPERATIONS.has(row.operation)) }) : problem(404, 'NOT_FOUND', 'No such operation.');
}
