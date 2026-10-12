import { pool } from '../../../../../lib/db';
import { json, problem } from '../../../../../lib/http';
import { requireCapability } from '../../../../../lib/auth/session';
import { auditRead } from '../../../../../lib/audit';
import { receiptFor } from '../../../../../lib/integrations/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The verified receipt for one of your own actions (plan 14, E3). */
export async function GET(request: Request, ctx: { params: Promise<{ operationId: string }> }) {
 const { operationId } = await ctx.params;
 const principal = await requireCapability(request, 'fleet.view');
 if (principal instanceof Response) return principal;
 const r = /^[0-9a-f-]{36}$/.test(operationId) ? await receiptFor(pool(), operationId, principal.userId) : null;
 if (!r) return problem(404, 'NOT_FOUND', 'No receipt for that action.');
 await auditRead(principal, 'receipt', { operation: operationId, state: r.state });
 return json(r);
}
