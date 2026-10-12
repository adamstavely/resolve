import type { NextRequest } from 'next/server';
import { findUsers } from '../../../../lib/admin';
import { pool } from '../../../../lib/db';
import { json } from '../../../../lib/http';
import { requireCapability } from '../../../../lib/auth/session';
import { auditRead } from '../../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Find people by name or email (display data only; identity is issuer/subject). */
export async function GET(request: NextRequest) {
 const principal = await requireCapability(request, 'users.manage');
 if (principal instanceof Response) return principal;
 const q = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 100);
 await auditRead(principal, 'users', { query: q });
 return json({ users: await findUsers(pool(), q) });
}
