import type { NextRequest } from 'next/server';
import * as client from 'openid-client';
import { config } from '../../../../lib/config';
import { pool } from '../../../../lib/db';
import { oidc, redirectUri, SCOPES } from '../../../../lib/auth/oidc';
import { LOGIN_ATTEMPT_SECONDS, LOGIN_COOKIE, randomToken, safeReturnTo, serializeCookie, sha256 } from '../../../../lib/auth/policy';
import { createLoginAttempt } from '../../../../lib/auth/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start OIDC sign-in: authorization code + PKCE (S256), single-use state and nonce bound to this browser. */
export async function GET(request: NextRequest) {
 const c = config();
 const state = client.randomState(), nonce = client.randomNonce(), codeVerifier = client.randomPKCECodeVerifier(), binding = randomToken();
 await createLoginAttempt(pool(), {
  stateHash: sha256(state), bindingHash: sha256(binding), codeVerifier, nonce,
  returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo')), ttlSeconds: LOGIN_ATTEMPT_SECONDS,
 });
 const url = client.buildAuthorizationUrl(await oidc(), {
  redirect_uri: redirectUri(), scope: SCOPES, state, nonce,
  code_challenge: await client.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256',
 });
 return new Response(null, { status: 302, headers: {
  Location: url.href, 'Cache-Control': 'no-store',
  'Set-Cookie': serializeCookie(LOGIN_COOKIE, binding, { secure: c.RESOLVE_COOKIE_SECURE, path: '/api/auth', maxAgeSeconds: LOGIN_ATTEMPT_SECONDS }),
 } });
}
