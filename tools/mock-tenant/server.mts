/*
 * Development-only mock Quackback fleet. Each active tenant in tenants.json listens on its own port and acts
 * as that instance's OAuth authorization server for Resolve, the way Quackback's Better Auth provider does
 * (issuer `${origin}/api/auth`). Tenant sign-in federates to the mock IdP, so an existing IdP session
 * connects without a second prompt (first-party, no consent screen).
 *
 * Tokens assert the federated identity (`idp_iss`, `idp_sub`) so Resolve can prove the tenant account
 * belongs to the signed-in human. This claim is a Resolve requirement on the fork (gap QB-ID-1).
 * Port 3300 serves the fleet registry projection (contract 1, gap QB-REG-1).
 *
 *   npm run dev:tenants   (reads .env: OIDC_ISSUER, RESOLVE_ORIGIN, REGISTRY_TOKEN)
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLocalJWKSet, createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from 'jose';

if (process.env.NODE_ENV === 'production') throw new Error('The mock tenants must never run in production');

interface TenantConfig {
 appKey: string; displayName: string; port: number; state: string; routable: boolean;
 idpClient: { id: string; secret: string }; resolveClient: { id: string; secret: string };
}
const fleet: { registryPort: number; tenants: TenantConfig[] } = JSON.parse(readFileSync(new URL('./tenants.json', import.meta.url), 'utf8'));
const idp = new URL(required('OIDC_ISSUER')).origin;
const resolveRedirect = `${new URL(required('RESOLVE_ORIGIN')).origin}/api/connect/callback`;
const registryToken = required('REGISTRY_TOKEN');
// No refetch cooldown: the dev IdP generates new keys on every restart.
const idpKeys = createRemoteJWKSet(new URL(`${idp}/jwks`), { cooldownDuration: 0 });
/** Scopes the tenant will grant to Resolve (the fork's vocabulary plus OIDC). */
const SUPPORTED_SCOPES = ['openid', 'offline_access', 'read:feedback', 'write:feedback', 'write:changelog', 'read:article', 'write:article', 'read:chat', 'write:chat', 'read:settings', 'write:settings'];
const ACCESS_SECONDS = 300;

function required(name: string) {
 const v = process.env[name];
 if (!v) throw new Error(`${name} is required (see .env.example)`);
 return v;
}
const b64url = (b: Buffer) => b.toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function send(res: ServerResponse, status: number, body: unknown) {
 res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' });
 res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const oauthError = (res: ServerResponse, error: string, description: string, status = 400) => send(res, status, { error, error_description: description });
async function body(req: IncomingMessage) {
 let raw = '';
 for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) throw new Error('Body too large'); }
 return raw;
}

async function startTenant(t: TenantConfig) {
 const origin = `http://127.0.0.1:${t.port}`;
 const issuer = `${origin}/api/auth`;
 const { privateKey, publicKey } = await generateKeyPair('RS256');
 const kid = randomBytes(8).toString('hex');
 const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } as JWK] };
 const ownKeys = createLocalJWKSet(jwks);

 /** Resolve's pending authorization requests while the tenant signs the user in at the IdP. */
 const pending = new Map<string, { params: URLSearchParams; idpVerifier: string; idpNonce: string; expires: number }>();
 const codes = new Map<string, { user: TenantUser; scope: string; nonce: string; challenge: string; expires: number }>();
 /** Refresh token -> family; reuse of a rotated token revokes the family (OAuth 2.1 / BCP). */
 const refresh = new Map<string, { family: string; user: TenantUser; scope: string; used: boolean }>();
 const revokedFamilies = new Set<string>();
 let dropNextTokenResponse = false;

 interface TenantUser { id: string; principalId: string; idpIss: string; idpSub: string; name: string }
 /** Tenant accounts are keyed by the federated issuer/subject (never email), as the managed-account linking rules require. */
 const userFor = (idpIss: string, idpSub: string, name: string): TenantUser => {
  const h = sha(`${t.appKey}|${idpIss}|${idpSub}`).slice(0, 20);
  return { id: `user_${h}`, principalId: `principal_${h}`, idpIss, idpSub, name };
 };

 async function issueTokens(res: ServerResponse, user: TenantUser, scope: string, nonce: string | null, family = b64url(randomBytes(16))) {
  const now = Math.floor(Date.now() / 1000);
  const access = await new SignJWT({ scope, principal_id: user.principalId, client_id: t.resolveClient.id })
   .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setSubject(user.id).setAudience(`${origin}/api/mcp`)
   .setIssuedAt(now).setExpirationTime(now + ACCESS_SECONDS).sign(privateKey);
  const rt = b64url(randomBytes(32));
  refresh.set(rt, { family, user, scope, used: false });
  const response: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, scope, refresh_token: rt };
  if (nonce !== null) response.id_token = await new SignJWT({ nonce, principal_id: user.principalId, idp_iss: user.idpIss, idp_sub: user.idpSub, name: user.name })
   .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setSubject(user.id).setAudience(t.resolveClient.id)
   .setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
  if (dropNextTokenResponse) { dropNextTokenResponse = false; res.socket?.destroy(); return; } // simulate a lost response after commit
  send(res, 200, response);
 }

 async function token(req: IncomingMessage, res: ServerResponse) {
  const p = new URLSearchParams(await body(req));
  let id = p.get('client_id'), secret = p.get('client_secret');
  const basic = req.headers.authorization?.match(/^Basic (.+)$/);
  if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
  if (id !== t.resolveClient.id || !secret || !safeEqual(secret, t.resolveClient.secret)) return oauthError(res, 'invalid_client', 'Client authentication failed', 401);
  if (p.get('grant_type') === 'authorization_code') {
   const code = codes.get(p.get('code') ?? '');
   codes.delete(p.get('code') ?? '');
   if (!code || code.expires < Date.now()) return oauthError(res, 'invalid_grant', 'Unknown, used or expired code');
   if (p.get('redirect_uri') !== resolveRedirect) return oauthError(res, 'invalid_grant', 'redirect_uri mismatch');
   if (b64url(createHash('sha256').update(p.get('code_verifier') ?? '').digest()) !== code.challenge) return oauthError(res, 'invalid_grant', 'PKCE verification failed');
   return issueTokens(res, code.user, code.scope, code.nonce);
  }
  if (p.get('grant_type') === 'refresh_token') {
   const entry = refresh.get(p.get('refresh_token') ?? '');
   if (!entry || revokedFamilies.has(entry.family)) return oauthError(res, 'invalid_grant', 'Unknown or revoked refresh token');
   if (entry.used) { revokedFamilies.add(entry.family); return oauthError(res, 'invalid_grant', 'Refresh token reuse detected; grant revoked'); }
   entry.used = true;
   return issueTokens(res, entry.user, entry.scope, null, entry.family);
  }
  oauthError(res, 'unsupported_grant_type', 'Unsupported grant_type');
 }

 /** Resolve -> tenant authorization request: validate, then sign the user in at the IdP. */
 async function authorize(res: ServerResponse, p: URLSearchParams) {
  const problem = p.get('client_id') !== t.resolveClient.id ? 'Unknown client_id'
   : p.get('redirect_uri') !== resolveRedirect ? 'redirect_uri is not registered'
   : p.get('response_type') !== 'code' ? 'Only response_type=code'
   : p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') ? 'PKCE S256 is required'
   : !p.get('state') || !p.get('nonce') ? 'state and nonce are required'
   : (p.get('scope') ?? '').split(' ').some(s => !SUPPORTED_SCOPES.includes(s)) ? 'Unsupported scope requested' : undefined;
  if (problem) return send(res, 400, `<!doctype html><html lang="en"><title>Connection rejected</title><main><h1>Connection request rejected</h1><p>${problem}</p></main></html>`);
  const key = b64url(randomBytes(24)), idpVerifier = b64url(randomBytes(32)), idpNonce = b64url(randomBytes(16));
  pending.set(key, { params: p, idpVerifier, idpNonce, expires: Date.now() + 600_000 });
  const to = new URL(`${idp}/authorize`);
  to.search = new URLSearchParams({
   client_id: t.idpClient.id, redirect_uri: `${origin}/api/auth/idp/callback`, response_type: 'code', scope: 'openid profile email',
   state: key, nonce: idpNonce, code_challenge: b64url(createHash('sha256').update(idpVerifier).digest()), code_challenge_method: 'S256',
  }).toString();
  res.writeHead(302, { Location: to.href, 'Cache-Control': 'no-store' }); res.end();
 }

 /** IdP -> tenant: verify the federated identity, then return a code to Resolve. */
 async function idpCallback(res: ServerResponse, q: URLSearchParams) {
  const req = pending.get(q.get('state') ?? '');
  pending.delete(q.get('state') ?? '');
  if (!req || req.expires < Date.now() || !q.get('code')) return send(res, 400, '<!doctype html><html lang="en"><title>Sign-in failed</title><main><h1>Sign-in failed</h1></main></html>');
  const r = await fetch(`${idp}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
   grant_type: 'authorization_code', code: q.get('code')!, redirect_uri: `${origin}/api/auth/idp/callback`, code_verifier: req.idpVerifier,
   client_id: t.idpClient.id, client_secret: t.idpClient.secret,
  }) });
  if (!r.ok) return send(res, 400, '<!doctype html><html lang="en"><title>Sign-in failed</title><main><h1>Sign-in failed</h1></main></html>');
  const { payload } = await jwtVerify(String((await r.json()).id_token), idpKeys, { issuer: idp, audience: t.idpClient.id });
  if (payload.nonce !== req.idpNonce) return send(res, 400, '<!doctype html><html lang="en"><title>Sign-in failed</title><main><h1>Sign-in failed</h1></main></html>');
  const user = userFor(idp, String(payload.sub), String(payload.name ?? payload.sub));
  const code = b64url(randomBytes(32));
  codes.set(code, { user, scope: req.params.get('scope') ?? 'openid', nonce: req.params.get('nonce')!, challenge: req.params.get('code_challenge')!, expires: Date.now() + 60_000 });
  const back = new URL(resolveRedirect);
  back.search = new URLSearchParams({ code, state: req.params.get('state')!, iss: issuer }).toString();
  res.writeHead(302, { Location: back.href, 'Cache-Control': 'no-store' }); res.end();
 }

 /** Stand-in for a tenant tool call made with the human's token. */
 async function whoami(req: IncomingMessage, res: ServerResponse) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  try {
   const { payload } = await jwtVerify(bearer ?? '', ownKeys, { issuer, audience: `${origin}/api/mcp` });
   send(res, 200, { app: t.appKey, tenantUserId: payload.sub, principalId: payload.principal_id, scopes: String(payload.scope).split(' ') });
  } catch { send(res, 401, { error: 'invalid_token' }); }
 }

 const server = createServer(async (req, res) => {
  try {
   const url = new URL(req.url ?? '/', origin);
   if (url.pathname === '/api/auth/.well-known/openid-configuration') return send(res, 200, {
    issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'], scopes_supported: SUPPORTED_SCOPES,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'], authorization_response_iss_parameter_supported: true,
   });
   if (url.pathname === '/api/auth/jwks') return send(res, 200, jwks);
   if (req.method === 'GET' && url.pathname === '/api/auth/oauth2/authorize') return await authorize(res, url.searchParams);
   if (req.method === 'GET' && url.pathname === '/api/auth/idp/callback') return await idpCallback(res, url.searchParams);
   if (req.method === 'POST' && url.pathname === '/api/auth/oauth2/token') return await token(req, res);
   if (req.method === 'GET' && url.pathname === '/api/mcp/whoami') return await whoami(req, res);
   // Development controls for tests.
   if (req.method === 'POST' && url.pathname === '/dev/drop-next-token-response') { dropNextTokenResponse = true; return send(res, 200, { ok: true }); }
   send(res, 404, { error: 'not_found' });
  } catch (e) {
   send(res, 500, { error: 'server_error', error_description: e instanceof Error ? e.message : 'unknown' });
  }
 });
 server.listen(t.port, '127.0.0.1', () => console.log(`Mock tenant ${t.appKey} at ${origin}`));
}

for (const t of fleet.tenants) if (t.routable) await startTenant(t);

createServer((req, res) => {
 if (req.method !== 'GET' || new URL(req.url ?? '/', 'http://x').pathname !== '/registry') return send(res, 404, { error: 'not_found' });
 if (!safeEqual(req.headers.authorization ?? '', `Bearer ${registryToken}`)) return send(res, 401, { error: 'unauthorized' });
 const apps = fleet.tenants.map(t => ({
  appKey: t.appKey, displayName: t.displayName, supportOrigin: `http://127.0.0.1:${t.port}`, routable: t.routable, state: t.state,
  deploymentVersion: 'quackback-0.14.1-mock', protocolVersions: [1], lastActivityAt: null,
 }));
 send(res, 200, { schemaVersion: 1, revision: sha(JSON.stringify(apps)).slice(0, 12), apps });
}).listen(fleet.registryPort, '127.0.0.1', () => console.log(`Mock fleet registry at http://127.0.0.1:${fleet.registryPort}/registry`));
