import type { NextRequest } from 'next/server';
import * as client from 'openid-client';
import { checkCallbackBinding, checkIdentityMapping, verifiedTenantIdentitySchema } from '@resolve/contracts';
import { config } from '../../../../lib/config';
import { pool } from '../../../../lib/db';
import { sha256 } from '../../../../lib/auth/policy';
import { audit } from '../../../../lib/auth/repository';
import { currentPrincipal } from '../../../../lib/auth/session';
import { tenantIssuer } from '../../../../lib/registry';
import { connectableApp } from '../../../../lib/fleet-admin/pilot-access';
import { sealer } from '../../../../lib/sealer';
import { identityLink, storeConnection, takeConnectAttempt } from '../../../../lib/tenants/grants';
import { tenantOidc } from '../../../../lib/tenants/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/*
 * Finish connecting a human to an app (contract 2). In order: consume the attempt; bind it to this session and
 * user; exchange the code (state, PKCE, nonce, issuer incl. RFC 9207 `iss`, audience, signature); prove the
 * tenant account belongs to this human's IdP identity; refuse scope escalation; check or create the identity
 * link; store sealed tokens. Any failure leaves no grant.
 */
export async function GET(request: NextRequest) {
 const go = (status: string, appKey?: string) => new Response(null, { status: 302, headers: {
  Location: appKey ? `/apps/${encodeURIComponent(appKey)}?connect=${status}` : `/?connect=${status}`, 'Cache-Control': 'no-store' } });
 const principal = await currentPrincipal(request);
 const state = request.nextUrl.searchParams.get('state');
 const attempt = state ? await takeConnectAttempt(pool(), sha256(state)) : undefined;
 const fail = async (reason: string, status = 'failed') => {
  await audit(pool(), { actorUserId: principal?.userId ?? null, operation: 'grant.connect', outcome: status === 'mismatch' ? 'denied' : 'failed',
   summary: { app: attempt?.appKey ?? null, reason } }).catch(() => {});
  return go(status, attempt?.appKey);
 };
 if (!principal) return fail('not_signed_in');
 if (!attempt || !state) return fail('unknown_state');

 const binding = checkCallbackBinding({
  attemptId: attempt.attemptId, userId: attempt.userId, appKey: attempt.appKey, sessionHash: attempt.sessionHash, stateHash: sha256(state),
  codeChallengeMethod: 'S256', redirectUri: `${config().RESOLVE_ORIGIN}/api/connect/callback`, expiresAt: attempt.expiresAt.toISOString(), consumedAt: null,
 }, { sessionHash: principal.sessionHash, userId: principal.userId, appKey: attempt.appKey, now: new Date() });
 if (!binding.ok) return fail(binding.reason);

 const app = (await connectableApp(principal.userId, attempt.appKey))?.app;
 if (!app) return fail('app_unavailable', 'unavailable');

 let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
 try {
  const currentUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, config().RESOLVE_ORIGIN);
  tokens = await client.authorizationCodeGrant(await tenantOidc(app), currentUrl, {
   pkceCodeVerifier: attempt.codeVerifier, expectedState: state, expectedNonce: attempt.nonce, idTokenExpected: true,
  });
 } catch (e) {
  console.warn(JSON.stringify({ level: 'warn', event: 'tenant_connect_rejected', app: attempt.appKey, error: e instanceof Error ? e.name + ': ' + e.message : 'unknown' }));
  return fail('token_exchange_or_validation_failed');
 }
 const claims = tokens.claims()!;

 // The tenant account must belong to the IdP identity this Resolve session signed in with (gap QB-ID-1 claims).
 if (claims.idp_iss !== principal.identity.issuer || claims.idp_sub !== principal.identity.subject) return fail('federated_identity_mismatch', 'mismatch');

 const identity = verifiedTenantIdentitySchema.safeParse({ issuer: claims.iss, audience: (await tenantOidc(app)).clientMetadata().client_id,
  subject: claims.sub, tenantUserId: claims.sub, tenantPrincipalId: claims.principal_id });
 if (!identity.success || identity.data.issuer !== tenantIssuer(app)) return fail('invalid_tenant_identity');

 const granted = (tokens.scope ?? attempt.requestedScopes.join(' ')).split(' ').filter(Boolean);
 if (granted.some(s => !attempt.requestedScopes.includes(s))) return fail('scope_escalation');

 const link = await identityLink(pool(), principal.userId, attempt.appKey);
 if (link) {
  const mismatch = checkIdentityMapping({ appKey: attempt.appKey, issuer: link.tenant_issuer, subject: link.tenant_user_id,
   tenantUserId: link.tenant_user_id, tenantPrincipalId: link.tenant_principal_id }, identity.data);
  if (mismatch !== 'unmapped' && mismatch.length) return fail('identity_mapping_changed:' + mismatch.join(','), 'mismatch');
 }

 const stored = await storeConnection(pool(), sealer(), {
  userId: principal.userId, appKey: attempt.appKey, identityId: principal.identity.id, tenantIssuer: identity.data.issuer,
  tenantUserId: identity.data.tenantUserId, tenantPrincipalId: identity.data.tenantPrincipalId, scopes: granted,
  accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 300) * 1000),
 });
 if (stored !== 'stored') return fail(stored, 'mismatch');
 await audit(pool(), { actorUserId: principal.userId, operation: 'grant.connect', outcome: 'succeeded', summary: { app: attempt.appKey, scopes: granted.join(' ') } });
 return go('connected', attempt.appKey);
}
