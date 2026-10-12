import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { json, problem } from '../../../../../lib/http';
import { appRequest, readOutcome, toolFailure } from '../../../../../lib/fleet/http';
import { auditRead } from '../../../../../lib/audit';
import { callTenantTool } from '../../../../../lib/tenants/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.strictObject({ status: z.enum(['open', 'snoozed', 'closed']).optional(), cursor: z.string().max(500).optional() });

export async function GET(request: NextRequest, ctx: { params: Promise<{ appKey: string }> }) {
 const r = await appRequest(request, 'chat.read', (await ctx.params).appKey, 'read.conversations');
 if (r instanceof Response) return r;
 const q = query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
 if (!q.success) return problem(400, 'INVALID_QUERY', q.error.issues[0]?.message ?? 'Invalid query.');
 const out = await callTenantTool(r.app, r.principal.userId, 'list_conversations', { ...q.data, limit: 25 });
 await auditRead(r.principal, 'conversations', { app: r.app.appKey, page: q.data.cursor ? 'next' : 'first', ...(out.ok ? {} : { code: out.reason }) }, readOutcome(out));
 return out.ok ? json({ appKey: r.app.appKey, ...out.data }) : toolFailure(out.reason);
}
