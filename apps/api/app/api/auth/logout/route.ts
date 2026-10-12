import { crossOrigin } from '../../../../lib/http';
import { config } from '../../../../lib/config';
import { pool } from '../../../../lib/db';
import { clearCookie, readCookie, sameOrigin, SESSION_COOKIE, sha256 } from '../../../../lib/auth/policy';
import { audit, revokeSession } from '../../../../lib/auth/repository';
import { currentPrincipal } from '../../../../lib/auth/session';
import { registry } from '../../../../lib/registry';
import { fleetAvailability } from '../../../../lib/fleet/availability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Signing out ends your chat availability, so applications stop routing chats to someone who has left. (A closed
 * browser leaves its session open until it idles out, so "your last session" cannot be told apart reliably.)
 * Best effort, a few seconds at most; each application's result is audited.
 */
async function endAvailability(request: Request) {
 const principal = await currentPrincipal(request);
 if (!principal?.capabilities.includes('chat.availability')) return;
 try { await fleetAvailability(principal, (await registry()).apps, 'away', 2000); } catch { /* registry unavailable: the tenant's own expiry applies */ }
}

/** Sign out: POST only, same-origin only; revokes the server-side session, not just the cookie. */
export async function POST(request: Request) {
 const c = config();
 if (!sameOrigin(request.headers.get('origin'), c.RESOLVE_ORIGIN)) return crossOrigin(request);
 await endAvailability(request);
 const raw = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
 const userId = raw ? await revokeSession(pool(), sha256(raw)) : undefined;
 if (userId) await audit(pool(), { actorUserId: userId, operation: 'session.logout', outcome: 'succeeded' });
 return new Response(null, { status: 303, headers: { Location: '/?signin=signed-out', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie(SESSION_COOKIE, { secure: c.RESOLVE_COOKIE_SECURE }) } });
}
