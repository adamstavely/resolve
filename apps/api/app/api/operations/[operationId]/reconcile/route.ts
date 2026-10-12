import { uuidSchema } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { jsonMutation, problem } from '../../../../../lib/http';
import { appRequest } from '../../../../../lib/fleet/http';
import { operationResponse } from '../../../../../lib/fleet/actions';
import { requireCapability } from '../../../../../lib/auth/session';
import { findOperation, KEYED_OPERATIONS, reconcile, toApi } from '../../../../../lib/operations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ask the tenant what happened to an uncertain keyed operation (never re-sends). */
export async function POST(request: Request, ctx: { params: Promise<{ operationId: string }> }) {
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const principal = await requireCapability(request, 'fleet.view');
 if (principal instanceof Response) return principal;
 const { operationId } = await ctx.params;
 const row = uuidSchema.safeParse(operationId).success ? await findOperation(pool(), operationId, principal.userId) : undefined;
 if (!row) return problem(404, 'NOT_FOUND', 'No such operation.');
 if (row.state !== 'uncertain' || !KEYED_OPERATIONS.has(row.operation)) return operationResponse(toApi(row, KEYED_OPERATIONS.has(row.operation)));
 const app = await appRequest(request, 'fleet.view', row.app_key);
 if (app instanceof Response) return app;
 return operationResponse(toApi(await reconcile(pool(), app.app, row), true));
}
