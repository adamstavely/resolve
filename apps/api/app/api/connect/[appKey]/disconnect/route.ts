import { crossOrigin } from '../../../../../lib/http';
import { config } from '../../../../../lib/config';
import { pool } from '../../../../../lib/db';
import { sameOrigin } from '../../../../../lib/auth/policy';
import { audit } from '../../../../../lib/auth/repository';
import { apiError, requireCapability } from '../../../../../lib/auth/session';
import { setGrantState } from '../../../../../lib/tenants/grants';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Discard this user's tokens for one app. The identity link is kept so a reconnect must match it. */
export async function POST(request: Request, ctx: { params: Promise<{ appKey: string }> }) {
 if (!sameOrigin(request.headers.get('origin'), config().RESOLVE_ORIGIN)) return crossOrigin(request);
 const principal = await requireCapability(request, 'connection.manage');
 if (principal instanceof Response) return principal;
 const { appKey } = await ctx.params;
 await setGrantState(pool(), principal.userId, appKey, 'not_connected');
 await audit(pool(), { actorUserId: principal.userId, operation: 'grant.disconnect', outcome: 'succeeded', summary: { app: appKey } });
 return new Response(null, { status: 303, headers: { Location: `/?connect=disconnected&app=${encodeURIComponent(appKey)}`, 'Cache-Control': 'no-store' } });
}
