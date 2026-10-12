import { pool } from '../../../lib/db';
import { recentAudit } from '../../../lib/auth/repository';
import { requireCapability } from '../../../lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
 const principal = await requireCapability(request, 'audit.read');
 if (principal instanceof Response) return principal;
 return Response.json({ events: await recentAudit(pool()) }, { headers: { 'Cache-Control': 'no-store' } });
}
