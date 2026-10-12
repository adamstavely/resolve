import { activitySignalSchema } from '@resolve/contracts';
import { pool } from '../../../../../../../lib/db';
import { json, jsonMutation, problem } from '../../../../../../../lib/http';
import { currentPrincipal } from '../../../../../../../lib/auth/session';
import { appRequest } from '../../../../../../../lib/fleet/http';
import { auditRead, writeAudit } from '../../../../../../../lib/audit';
import { rpc } from '../../../../../../../lib/tenants/mcp';
import { actionSupported } from '../../../../../../../lib/tenants/protocol';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ appKey: string; conversationId: string }> };

/*
 * Typing and viewing (plan 09). Signals are explicit and short-lived: the console sends them while a person has the
 * thread open or is writing a reply, and the tenant expires them. Monitoring the inbox stream never implies presence.
 * Typing an internal note is never signalled, so a customer cannot see that a note is being written.
 */
export async function POST(request: Request, ctx: Ctx) {
 const { appKey, conversationId } = await ctx.params;
 const raw = await jsonMutation(request);
 if (raw instanceof Response) return raw;
 const body = activitySignalSchema.safeParse(raw);
 const activity = body.success ? body.data.activity : 'viewing';
 const held = (await currentPrincipal(request))?.capabilities ?? [];
 const capability = activity === 'typing' || !held.includes('chat.note') ? 'chat.reply' : 'chat.note';
 const r = await appRequest(request, capability, appKey, 'presence.activity');
 if (r instanceof Response) return r;
 if (!body.success) return problem(400, 'INVALID_REQUEST', 'Unknown activity.');
 const audit = (outcome: 'succeeded' | 'failed' | 'denied', code?: string) =>
  writeAudit(pool(), { actorUserId: r.principal.userId, operation: 'presence.activity', outcome, summary: { app: appKey, target: conversationId, activity, ...(code ? { code } : {}) } });
 if (!(await actionSupported(r.app, 'signal_activity'))) { await audit('failed', 'ACTION_UNAVAILABLE'); return problem(409, 'ACTION_UNAVAILABLE', 'This application does not share typing or viewing yet.'); }
 const o = await rpc(r.app, r.principal.userId, 'signal_activity', { conversationId, activity }, 3000);
 if (o.kind === 'ok') { await audit('succeeded'); return json({ expiresAt: o.data.expiresAt }); }
 const code = o.kind === 'tool_error' ? o.code : o.kind.toUpperCase();
 await audit(code === 'FORBIDDEN' || code === 'DENIED' || code === 'NOT_FOUND' ? 'denied' : 'failed', code);
 return problem(code === 'NOT_FOUND' ? 404 : code === 'FORBIDDEN' || code === 'DENIED' ? 403 : 502, code, 'The signal was not delivered.');
}

/** Who else is in this conversation now (other staff viewing or typing), and whether the customer is online or typing. */
export async function GET(request: Request, ctx: Ctx) {
 const { appKey, conversationId } = await ctx.params;
 const r = await appRequest(request, 'chat.read', appKey, 'read.conversation_activity');
 if (r instanceof Response) return r;
 if (!(await actionSupported(r.app, 'get_conversation_activity'))) {
  await auditRead(r.principal, 'conversation_activity', { app: appKey, target: conversationId, code: 'ACTION_UNAVAILABLE' }, 'failed');
  return problem(409, 'ACTION_UNAVAILABLE', 'This application does not share typing or viewing yet.');
 }
 const o = await rpc(r.app, r.principal.userId, 'get_conversation_activity', { conversationId }, 3000);
 const code = o.kind === 'ok' ? null : o.kind === 'tool_error' ? o.code : o.kind.toUpperCase();
 await auditRead(r.principal, 'conversation_activity', { app: appKey, target: conversationId, ...(code ? { code } : {}) },
  o.kind === 'ok' ? 'succeeded' : code === 'NOT_FOUND' || code === 'DENIED' ? 'denied' : 'failed');
 if (o.kind === 'ok') return json({ activity: o.data });
 return problem(code === 'NOT_FOUND' ? 404 : code === 'DENIED' ? 403 : 502, code!, 'Activity is not available right now.');
}
