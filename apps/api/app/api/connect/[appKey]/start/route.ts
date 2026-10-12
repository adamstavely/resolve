import type { NextRequest } from 'next/server';
import * as client from 'openid-client';
import { isServable } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { audit } from '../../../../../lib/auth/repository';
import { sha256 } from '../../../../../lib/auth/policy';
import { requireCapability } from '../../../../../lib/auth/session';
import { registryApp } from '../../../../../lib/registry';
import { createConnectAttempt } from '../../../../../lib/tenants/grants';
import { connectRedirectUri, tenantOidc, tenantScopes } from '../../../../../lib/tenants/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const back = (status: string, appKey: string) => new Response(null, { status: 302, headers: { Location: `/?connect=${status}&app=${encodeURIComponent(appKey)}`, 'Cache-Control': 'no-store' } });

/** Start connecting the signed-in human to one app: PKCE + state bound to this session, user and app (contract 2). */
export async function GET(request: NextRequest, ctx: { params: Promise<{ appKey: string }> }) {
 const { appKey } = await ctx.params;
 const principal = await requireCapability(request, 'connection.manage');
 if (principal instanceof Response) return principal;
 const app = await registryApp(appKey).catch(() => undefined);
 await audit(pool(), { actorUserId: principal.userId, operation: 'grant.connect_start', outcome: app && isServable(app) ? 'succeeded' : 'failed', summary: { app: appKey } });
 if (!app || !isServable(app)) return back('unavailable', appKey);
 let cfg: client.Configuration;
 try { cfg = await tenantOidc(app); } catch {
  await audit(pool(), { actorUserId: principal.userId, operation: 'grant.connect', outcome: 'failed', summary: { app: appKey, reason: 'tenant_unreachable' } });
  return back('unavailable', appKey);
 }
 const state = client.randomState(), nonce = client.randomNonce(), codeVerifier = client.randomPKCECodeVerifier();
 const scopes = tenantScopes(principal.capabilities);
 await createConnectAttempt(pool(), { stateHash: sha256(state), userId: principal.userId, appKey, sessionHash: principal.sessionHash,
  codeVerifier, nonce, requestedScopes: scopes, ttlSeconds: 600 });
 const url = client.buildAuthorizationUrl(cfg, { redirect_uri: connectRedirectUri(), scope: scopes.join(' '), state, nonce,
  code_challenge: await client.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256' });
 return new Response(null, { status: 302, headers: { Location: url.href, 'Cache-Control': 'no-store' } });
}
