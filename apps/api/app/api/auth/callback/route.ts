import type { NextRequest } from 'next/server';
import * as client from 'openid-client';
import { config } from '../../../../lib/config';
import { pool } from '../../../../lib/db';
import { oidc } from '../../../../lib/auth/oidc';
import { bundlesForGroups, clearCookie, LOGIN_COOKIE, randomToken, readCookie, serializeCookie, SESSION_COOKIE, sha256 } from '../../../../lib/auth/policy';
import { audit, consumeLoginAttempt, createSession, revokeSession, signIn } from '../../../../lib/auth/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Finish OIDC sign-in. The attempt is consumed before the code exchange, so a replayed callback fails
 * even if the IdP would accept the code twice. Failures return to the console without detail.
 */
export async function GET(request: NextRequest) {
 const c = config();
 const cookieOptions = { secure: c.RESOLVE_COOKIE_SECURE };
 const finish = (location: string, cookies: string[]) => {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const cookie of [clearCookie(LOGIN_COOKIE, { ...cookieOptions, path: '/api/auth' }), ...cookies]) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
 };
 const fail = async (reason: string, userId: string | null = null, outcome: 'failed' | 'denied' = 'failed') => {
  await audit(pool(), { actorUserId: userId, operation: 'session.login', outcome, summary: { reason } }).catch(() => {});
  return finish(`/?signin=${outcome}`, []);
 };

 const state = request.nextUrl.searchParams.get('state');
 const binding = readCookie(request.headers.get('cookie'), LOGIN_COOKIE);
 if (!state || !binding) return fail('missing_state_or_binding');
 const attempt = await consumeLoginAttempt(pool(), sha256(state), sha256(binding));
 if (!attempt) return fail('unknown_consumed_expired_or_foreign_attempt');

 let claims: client.IDToken | undefined;
 try {
  // Behind the console proxy, request.url is the internal address; validate against the public callback URL.
  const currentUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, c.RESOLVE_ORIGIN);
  const tokens = await client.authorizationCodeGrant(await oidc(), currentUrl, {
   pkceCodeVerifier: attempt.codeVerifier, expectedState: state, expectedNonce: attempt.nonce, idTokenExpected: true,
  });
  claims = tokens.claims();
 } catch (e) {
  console.warn(JSON.stringify({ level: 'warn', event: 'oidc_callback_rejected', error: e instanceof Error ? e.name + ': ' + e.message : 'unknown' }));
 }
 if (!claims) return fail('token_exchange_or_validation_failed');

 const result = await signIn(pool(), {
  issuer: claims.iss, subject: claims.sub,
  displayName: typeof claims.name === 'string' && claims.name ? claims.name : claims.sub,
  email: typeof claims.email === 'string' ? claims.email : null,
  bundles: bundlesForGroups(claims.groups, c.RESOLVE_GROUP_BUNDLES),
 });
 if (result.status === 'disabled') return fail('user_disabled', result.userId, 'denied');

 // A new sign-in replaces, rather than adds to, the session this browser already had.
 const previous = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
 if (previous) await revokeSession(pool(), sha256(previous));
 const sessionId = randomToken();
 await createSession(pool(), { idHash: sha256(sessionId), userId: result.userId, identityId: result.identityId, absoluteMinutes: c.SESSION_ABSOLUTE_MINUTES });
 await audit(pool(), { actorUserId: result.userId, operation: 'session.login', outcome: 'succeeded' });
 return finish(attempt.returnTo, [serializeCookie(SESSION_COOKIE, sessionId, { ...cookieOptions, maxAgeSeconds: c.SESSION_ABSOLUTE_MINUTES * 60 })]);
}
