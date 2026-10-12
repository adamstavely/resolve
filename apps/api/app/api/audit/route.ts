import type { NextRequest } from 'next/server';
import { auditQuerySchema } from '@resolve/contracts';
import { auditPage, decodeCursor } from '../../../lib/admin';
import { pool } from '../../../lib/db';
import { json, problem } from '../../../lib/http';
import { requireCapability } from '../../../lib/auth/session';
import { auditRead } from '../../../lib/audit';
import { sealer } from '../../../lib/sealer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Newest-first audit with category/outcome filters and keyset paging. */
export async function GET(request: NextRequest) {
 const principal = await requireCapability(request, 'audit.read');
 if (principal instanceof Response) return principal;
 const q = auditQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
 if (!q.success) return problem(400, 'INVALID_QUERY', q.error.issues[0]?.message ?? 'Invalid query.');
 const before = q.data.before ? decodeCursor(q.data.before) : undefined;
 if (q.data.before && !before) return problem(400, 'INVALID_CURSOR', 'The paging cursor is not valid.');
 const page = await auditPage(pool(), { category: q.data.category, outcome: q.data.outcome, limit: q.data.limit, before }, sealer());
 await auditRead(principal, 'audit', { category: q.data.category ?? null, outcome: q.data.outcome ?? null, page: before ? 'older' : 'first' });
 return json(page);
}
