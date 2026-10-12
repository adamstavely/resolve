import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, problem } from '../../../lib/http';
import { fanOut } from '../../../lib/fleet/fanout';
import { fleetRequest, includeParam } from '../../../lib/fleet/http';
import { auditRead } from '../../../lib/audit';
import { callTenantTool } from '../../../lib/tenants/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const filters = z.strictObject({ status: z.enum(['open', 'snoozed', 'closed']).optional(), include: z.string().optional() });

/** First page of conversations from every app, per app. Read-only; the live inbox is phase 3 (plan 09). */
export async function GET(request: NextRequest) {
 const ctx = await fleetRequest(request, 'chat.read');
 if (ctx instanceof Response) return ctx;
 const q = filters.safeParse(Object.fromEntries(request.nextUrl.searchParams));
 if (!q.success) return problem(400, 'INVALID_QUERY', q.error.issues[0]?.message ?? 'Invalid query.');
 const apps = await fanOut(ctx.apps, app => callTenantTool(app, ctx.principal.userId, 'list_conversations', { status: q.data.status, limit: 25 }), { include: includeParam(request.nextUrl) });
 await auditRead(ctx.principal, 'conversations', { status: q.data.status ?? null, appsRead: apps.filter(a => a.status === 'ok').length, appsUnavailable: apps.filter(a => a.status !== 'ok').length });
 return json({ apps });
}
