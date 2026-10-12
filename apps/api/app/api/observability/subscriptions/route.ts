import { pool } from '../../../../lib/db';
import { json } from '../../../../lib/http';
import { requireCapability } from '../../../../lib/auth/session';
import { subscriptionsFor } from '../../../../lib/integrations/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Your issue subscriptions; cleared ones ask you to come back to the item. */
export async function GET(request: Request) {
 const principal = await requireCapability(request, 'observability.health');
 if (principal instanceof Response) return principal;
 return json({ subscriptions: await subscriptionsFor(pool(), principal.userId) });
}
