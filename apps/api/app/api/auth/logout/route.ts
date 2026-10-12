import { config } from '../../../../lib/config';
import { pool } from '../../../../lib/db';
import { clearCookie, readCookie, sameOrigin, SESSION_COOKIE, sha256 } from '../../../../lib/auth/policy';
import { audit, revokeSession } from '../../../../lib/auth/repository';
import { apiError } from '../../../../lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Sign out: POST only, same-origin only; revokes the server-side session, not just the cookie. */
export async function POST(request: Request) {
 const c = config();
 if (!sameOrigin(request.headers.get('origin'), c.RESOLVE_ORIGIN)) return apiError(403, 'CROSS_ORIGIN', 'Request origin is not allowed.');
 const raw = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
 const userId = raw ? await revokeSession(pool(), sha256(raw)) : undefined;
 if (userId) await audit(pool(), { actorUserId: userId, operation: 'session.logout', outcome: 'succeeded' });
 return new Response(null, { status: 303, headers: { Location: '/?signin=signed-out', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie(SESSION_COOKIE, { secure: c.RESOLVE_COOKIE_SECURE }) } });
}
