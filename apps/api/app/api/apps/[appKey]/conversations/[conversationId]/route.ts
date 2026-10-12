import { json } from '../../../../../../lib/http';
import { appRequest, toolFailure } from '../../../../../../lib/fleet/http';
import { callTenantTool } from '../../../../../../lib/tenants/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Conversation detail by ID, read-only. Requires the gap-fixed visibility rule (QB-CHAT-4). */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string; conversationId: string }> }) {
 const { appKey, conversationId } = await ctx.params;
 const r = await appRequest(request, 'chat.read', appKey);
 if (r instanceof Response) return r;
 const out = await callTenantTool(r.app, r.principal.userId, 'get_conversation', { conversationId });
 return out.ok ? json({ appKey, detail: out.data }) : toolFailure(out.reason);
}
