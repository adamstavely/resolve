import { pool } from '../../../../../../lib/db';
import { json, jsonMutation } from '../../../../../../lib/http';
import { requireCapability } from '../../../../../../lib/auth/session';
import { acknowledge } from '../../../../../../lib/integrations/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const principal = await requireCapability(request, 'observability.health');
 if (principal instanceof Response) return principal;
 const { id } = await ctx.params;
 if (/^[0-9a-f-]{36}$/.test(id)) await acknowledge(pool(), principal.userId, id);
 return json({ acknowledged: true });
}
