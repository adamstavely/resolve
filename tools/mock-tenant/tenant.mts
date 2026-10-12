/*
 * One mock Quackback instance: its own OAuth authorization server for Resolve (issuer `${origin}/api/auth`), MCP
 * tools, the protocol advertisement, and the lifecycle the fleet worker drives (provisioning → maintenance → active,
 * suspended). Tenant sign-in federates to the mock IdP. Development only.
 *
 * Enforcement the tenant does itself, independent of Resolve:
 * - Not active: only pilot identities may sign in or call tools (maintenance-only validation, plan 07 step 6).
 *   Suspended: nobody.
 * - Managed principals (people Resolve has applied entitlements for) get exactly the applied role and teams;
 *   a denied entitlement refuses every call and refresh. Unmanaged people keep their existing role.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createLocalJWKSet, createRemoteJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type JWK } from 'jose';
import { buildTenant, callTool, ToolError, type TenantData, type Viewer } from './fixtures.mjs';
import { TenantStore } from './actions.mjs';

export interface TenantConfig {
 appKey: string; displayName: string; port: number; state: string; routable: boolean; dormant: boolean;
 seed: number; tickets: number; conversations: number; analyticsRoles: string[];
 idpClient: { id: string; secret: string };
 /** Resolve's OAuth client: a plaintext dev secret (seeded fixtures) or only its SHA-256 (provisioned by the worker). */
 resolveClient?: { id: string; secret?: string; secretSha256?: string };
 /** Bound to Resolve: listed in the Resolve-facing registry projection. Unbound instances can be adopted. */
 bound?: boolean;
 /** Fixture people keep their configured roles (unmanaged); a provisioned instance starts with nobody. */
 fixturePeople?: boolean;
 image?: string;
 settings?: Record<string, string>;
}
export type TenantState = 'provisioning' | 'maintenance' | 'active' | 'suspended';
export interface Entitlement { version: number; payloadHash: string; status: 'active' | 'denied'; role: 'admin' | 'agent' | 'observer' | 'portal'; teams: string[] }
export interface TenantUser { id: string; principalId: string; idpIss: string; idpSub: string; name: string }

export interface Tenant {
 config: TenantConfig;
 origin: string; issuer: string;
 state: TenantState; routable: boolean; dormant: boolean; bound: boolean;
 image: string; migrations: { applied: number; pending: number };
 receipts: { upstream: string | null; fork: string | null; templates: string | null };
 settings: Record<string, string>;
 resolveClient: TenantConfig['resolveClient'] | null;
 /** `${issuer}|${subject}` of people allowed in while the instance is not active. */
 pilots: Set<string>;
 entitlements: Map<string, Entitlement>;
 mailbox: string | null;
 configRevision: string | null;
 createdByWorker: boolean;
 /** Bound to Resolve through an adopt job (its existing data, sign-in and unmanaged roles are left as they were). */
 adopted: boolean;
 data: TenantData; store: TenantStore;
 stats: { toolCalls: number; protocolCalls: number };
 people: { sub: string; name: string; role: Viewer['role']; teams: string[] }[];
 userFor(idpIss: string, idpSub: string, name: string): TenantUser;
 viewer(tenantUserId: string): Viewer & { denied: boolean; managed: boolean };
 /** In-process tool call for the worker's probes (bypasses HTTP, not authorization). */
 probe(tenantUserId: string | null, tool: string, args: Record<string, unknown>): { ok: boolean; code?: string };
 revokeTokensFor(idpIss: string, idpSub: string): void;
 close(): Promise<void>;
}

export interface FleetContext {
 idp: string; resolveRedirect: string;
 people: Record<string, { role: Viewer['role']; teams: string[]; roles?: Record<string, Viewer['role']> }>;
 names: Record<string, string>;
}

const SUPPORTED_SCOPES = ['openid', 'offline_access', 'read:feedback', 'write:feedback', 'write:changelog', 'read:article', 'write:article', 'read:chat', 'write:chat', 'read:settings', 'write:settings'];
const ACCESS_SECONDS = 300;
export const WRITE_TOOLS = new Set(['reply_to_conversation', 'add_conversation_note', 'assign_conversation', 'set_conversation_status', 'mark_conversation_read', 'reply_to_ticket', 'add_ticket_note', 'assign_ticket', 'set_ticket_status',
 'upload_file', 'signal_activity', 'set_availability']);
export const PROTOCOL_TOOLS = {
 list_tickets: 2, get_ticket: 2, list_conversations: 2, get_conversation: 2, get_support_dashboard: 1, list_support_activity: 1,
 reply_to_conversation: 2, add_conversation_note: 1, assign_conversation: 1, set_conversation_status: 2, mark_conversation_read: 1,
 reply_to_ticket: 2, add_ticket_note: 2, assign_ticket: 1, set_ticket_status: 1, get_operation_result: 1, list_changes: 1,
 upload_file: 2, get_attachment: 1, signal_activity: 1, get_conversation_activity: 1, get_availability: 1, set_availability: 1,
};

const b64url = (b: Buffer) => b.toString('base64url');
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
 res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
 res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const oauthError = (res: ServerResponse, error: string, description: string, status = 400) => send(res, status, { error, error_description: description });
const page = (title: string, detail = '') => `<!doctype html><html lang="en"><title>${title}</title><main><h1>${title}</h1>${detail ? `<p>${detail}</p>` : ''}</main></html>`;
export async function body(req: IncomingMessage, limit = 16_384) {
 let raw = '';
 for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw new Error('Body too large'); }
 return raw;
}

export async function startTenant(t: TenantConfig, ctx: FleetContext, image: string): Promise<Tenant> {
 const origin = `http://127.0.0.1:${t.port}`;
 const issuer = `${origin}/api/auth`;
 const { privateKey, publicKey } = await generateKeyPair('RS256');
 const kid = randomBytes(8).toString('hex');
 const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } as JWK] };
 const ownKeys = createLocalJWKSet(jwks);
 // No refetch cooldown: the dev IdP generates new keys on every restart.
 const idpKeys = createRemoteJWKSet(new URL(`${ctx.idp}/jwks`), { cooldownDuration: 0 });

 const pending = new Map<string, { params: URLSearchParams; idpVerifier: string; idpNonce: string; expires: number }>();
 const codes = new Map<string, { user: TenantUser; scope: string; nonce: string; challenge: string; expires: number }>();
 /** Refresh token -> family; reuse of a rotated token revokes the family (OAuth 2.1 / BCP). */
 const refresh = new Map<string, { family: string; user: TenantUser; scope: string; used: boolean }>();
 const revokedFamilies = new Set<string>();
 let dropNextTokenResponse = false;
 /** Tenant accounts are keyed by the federated issuer/subject (never email), as the managed-account linking rules require. */
 const known = new Map<string, TenantUser>();
 const userFor = (idpIss: string, idpSub: string, name: string): TenantUser => {
  const h = sha(`${t.appKey}|${idpIss}|${idpSub}`).slice(0, 20);
  const u = { id: `user_${h}`, principalId: `principal_${h}`, idpIss, idpSub, name };
  if (!known.has(u.id) || name) known.set(u.id, { ...u, name: name || known.get(u.id)?.name || idpSub });
  return known.get(u.id)!;
 };

 // Fixture people (unmanaged) keep their configured roles; a provisioned instance starts with nobody.
 const people = t.fixturePeople === false ? [] : Object.entries(ctx.people).map(([sub, p]) => ({ sub, name: ctx.names[sub] ?? sub, role: p.roles?.[t.appKey] ?? p.role, teams: p.teams }));
 for (const p of people) userFor(ctx.idp, p.sub, p.name);
 const fixtureStaff = people.filter(p => p.role === 'agent').map(p => ({ principalId: userFor(ctx.idp, p.sub, p.name).principalId, name: p.name }));
 const staff = [...fixtureStaff, { principalId: 'principal_priya', name: 'Priya Shah' }, { principalId: 'principal_tom', name: 'Tom Okafor' }];
 const data = buildTenant(t.appKey, t.seed, { tickets: t.tickets, conversations: t.conversations }, staff);
 const nameOf = (principalId: string) => [...known.values()].find(u => u.principalId === principalId)?.name ?? staff.find(x => x.principalId === principalId)?.name ?? 'Agent';
 const store = new TenantStore(t.appKey, data, nameOf);
 const stats = { toolCalls: 0, protocolCalls: 0 };
 /** Development fault injection for partial-failure tests: tool calls by one user (IdP subject) fail or hang. */
 const failFor = new Map<string, 'error' | 'timeout' | 'drop'>();

 const tenant: Tenant = {
  config: t, origin, issuer,
  state: (['provisioning', 'maintenance', 'active', 'suspended'].includes(t.state) ? t.state : 'maintenance') as TenantState,
  routable: t.routable, dormant: t.dormant, bound: t.bound !== false,
  image, migrations: { applied: 212, pending: 0 },
  receipts: { upstream: sha(`upstream|${image}`).slice(0, 12), fork: sha(`fork|${image}`).slice(0, 12), templates: sha(`templates|${image}`).slice(0, 12) },
  settings: { 'auth.sso': 'company-idp', 'portal.access': 'intranet-sso', 'anonymous.actions': 'off', 'widget.hmac': 'on', 'announcements.audience': 'authenticated', ...(t.settings ?? {}) },
  resolveClient: t.resolveClient ?? null,
  pilots: new Set(), entitlements: new Map(), mailbox: null, configRevision: null, createdByWorker: false, adopted: false,
  data, store, stats, people, userFor,
  viewer(tenantUserId) {
   const u = known.get(tenantUserId);
   const ent = u && tenant.entitlements.get(`${u.idpIss}|${u.idpSub}`);
   const analytics = (role: string) => t.analyticsRoles.includes(role);
   if (ent) {
    const role = ent.status === 'denied' ? 'portal' : ent.role;
    return { principalId: u!.principalId, role, teams: ent.status === 'denied' ? [] : ent.teams, analytics: analytics(role), denied: ent.status === 'denied', managed: true };
   }
   const p = u && people.find(x => x.sub === u.idpSub && u.idpIss === ctx.idp);
   if (!p) return { principalId: u?.principalId ?? 'principal_' + tenantUserId.slice(5), role: 'portal', teams: [], analytics: false, denied: false, managed: false };
   return { principalId: u!.principalId, role: p.role, teams: p.teams, analytics: analytics(p.role), denied: false, managed: false };
  },
  probe(tenantUserId, tool, args) {
   if (!tenantUserId) return { ok: false, code: 'UNAUTHENTICATED' };
   const v = tenant.viewer(tenantUserId);
   if (v.denied || v.role === 'portal') return { ok: false, code: 'FORBIDDEN' };
   try { store.call(v, tool, args) ?? callTool(data, v, tool, args); return { ok: true }; }
   catch (e) { return { ok: false, code: e instanceof ToolError ? e.code : 'ERROR' }; }
  },
  revokeTokensFor(idpIss, idpSub) {
   for (const [, r] of refresh) if (r.user.idpIss === idpIss && r.user.idpSub === idpSub) revokedFamilies.add(r.family);
  },
  close: () => new Promise(r => server.close(() => r())),
 };
 const identityOf = (tenantUserId: string) => { const u = known.get(tenantUserId); return u ? `${u.idpIss}|${u.idpSub}` : ''; };
 /** Not active: only pilots get in (maintenance-only validation). Suspended: nobody. */
 const admitted = (tenantUserId: string) => tenant.state === 'active' || (tenant.state === 'maintenance' && tenant.pilots.has(identityOf(tenantUserId)));

 async function mcp(req: IncomingMessage, res: ServerResponse) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  let payload;
  try { ({ payload } = await jwtVerify(bearer ?? '', ownKeys, { issuer, audience: `${origin}/api/mcp` })); }
  catch { res.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"', 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid_token' })); }
  if (!admitted(String(payload.sub))) return send(res, 503, { error: 'not_routable', state: tenant.state });
  // Uploads carry up to 5 MiB as base64.
  const rpc = JSON.parse(await body(req, 8 * 1024 * 1024));
  stats.toolCalls++;
  const failMode = failFor.get(String(payload.sub));
  if (failMode === 'error') return send(res, 500, { error: 'injected failure' });
  if (failMode === 'timeout') await new Promise(r => setTimeout(r, 8000));
  const reply = (result: unknown) => send(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, result });
  if (rpc.method !== 'tools/call') return send(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } });
  const tool = String(rpc.params?.name);
  const needed = WRITE_TOOLS.has(tool) ? 'write:chat' : 'read:chat';
  if (!String(payload.scope).split(' ').includes(needed)) {
   res.writeHead(403, { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${needed}"`, 'Content-Type': 'application/json' });
   return res.end(JSON.stringify({ error: 'insufficient_scope' }));
  }
  const viewer = tenant.viewer(String(payload.sub));
  if (viewer.denied) return reply({ isError: true, content: [{ type: 'text', text: 'Error: FORBIDDEN: Your access to this application has been withdrawn.' }] });
  if (viewer.role === 'portal') return reply({ isError: true, content: [{ type: 'text', text: 'Error: This operation requires a team member (admin or member) role.' }] });
  try {
   const args = rpc.params?.arguments ?? {};
   let result: unknown;
   if (tool === 'list_changes') {
    // Fix the starting point before waiting, so changes that arrive during the wait are returned.
    const after = args.after ?? store.changes(viewer, undefined).cursor;
    result = store.changes(viewer, after);
    const wait = Math.min(Number(args.waitSeconds ?? 0), 25);
    if (wait > 0 && (result as { events: unknown[]; resync: boolean }).events.length === 0 && !(result as { resync: boolean }).resync) {
     await store.waitForChange(wait * 1000);
     if (!admitted(String(payload.sub))) return send(res, 503, { error: 'not_routable', state: tenant.state });
     result = store.changes(viewer, after);
    }
   } else result = store.call(viewer, tool, args) ?? callTool(data, viewer, tool, args);
   // Fault injection: the write committed, but the response is lost.
   if (failMode === 'drop' && WRITE_TOOLS.has(tool)) { res.socket?.destroy(); return; }
   reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (e) {
   if (e instanceof ToolError) return reply({ isError: true, content: [{ type: 'text', text: `Error: ${e.code}: ${e.message}` }] });
   throw e;
  }
 }

 async function issueTokens(res: ServerResponse, user: TenantUser, scope: string, nonce: string | null, family = b64url(randomBytes(16))) {
  const now = Math.floor(Date.now() / 1000);
  const access = await new SignJWT({ scope, principal_id: user.principalId, client_id: tenant.resolveClient!.id })
   .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setSubject(user.id).setAudience(`${origin}/api/mcp`)
   .setIssuedAt(now).setExpirationTime(now + ACCESS_SECONDS).sign(privateKey);
  const rt = b64url(randomBytes(32));
  refresh.set(rt, { family, user, scope, used: false });
  const response: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_SECONDS, scope, refresh_token: rt };
  if (nonce !== null) response.id_token = await new SignJWT({ nonce, principal_id: user.principalId, idp_iss: user.idpIss, idp_sub: user.idpSub, name: user.name })
   .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setSubject(user.id).setAudience(tenant.resolveClient!.id)
   .setIssuedAt(now).setExpirationTime(now + 300).sign(privateKey);
  if (dropNextTokenResponse) { dropNextTokenResponse = false; res.socket?.destroy(); return; } // simulate a lost response after commit
  send(res, 200, response);
 }

 const clientOk = (id: string | null, secret: string | null) => {
  const c = tenant.resolveClient;
  if (!c || id !== c.id || !secret) return false;
  return c.secret ? safeEqual(secret, c.secret) : !!c.secretSha256 && safeEqual(sha(secret), c.secretSha256);
 };

 async function token(req: IncomingMessage, res: ServerResponse) {
  const p = new URLSearchParams(await body(req));
  let id = p.get('client_id'), secret = p.get('client_secret');
  const basic = req.headers.authorization?.match(/^Basic (.+)$/);
  if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
  if (!clientOk(id, secret)) return oauthError(res, 'invalid_client', 'Client authentication failed', 401);
  if (p.get('grant_type') === 'authorization_code') {
   const code = codes.get(p.get('code') ?? '');
   codes.delete(p.get('code') ?? '');
   if (!code || code.expires < Date.now()) return oauthError(res, 'invalid_grant', 'Unknown, used or expired code');
   if (p.get('redirect_uri') !== ctx.resolveRedirect) return oauthError(res, 'invalid_grant', 'redirect_uri mismatch');
   if (b64url(createHash('sha256').update(p.get('code_verifier') ?? '').digest()) !== code.challenge) return oauthError(res, 'invalid_grant', 'PKCE verification failed');
   return issueTokens(res, code.user, code.scope, code.nonce);
  }
  if (p.get('grant_type') === 'refresh_token') {
   const entry = refresh.get(p.get('refresh_token') ?? '');
   if (!entry || revokedFamilies.has(entry.family)) return oauthError(res, 'invalid_grant', 'Unknown or revoked refresh token');
   if (entry.used) { revokedFamilies.add(entry.family); return oauthError(res, 'invalid_grant', 'Refresh token reuse detected; grant revoked'); }
   if (tenant.viewer(entry.user.id).denied) { revokedFamilies.add(entry.family); return oauthError(res, 'invalid_grant', 'Access withdrawn'); }
   entry.used = true;
   return issueTokens(res, entry.user, entry.scope, null, entry.family);
  }
  oauthError(res, 'unsupported_grant_type', 'Unsupported grant_type');
 }

 /** Resolve -> tenant authorization request: validate, then sign the user in at the IdP. */
 async function authorize(res: ServerResponse, p: URLSearchParams) {
  const problem = !tenant.resolveClient || p.get('client_id') !== tenant.resolveClient.id ? 'Unknown client_id'
   : p.get('redirect_uri') !== ctx.resolveRedirect ? 'redirect_uri is not registered'
   : p.get('response_type') !== 'code' ? 'Only response_type=code'
   : p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') ? 'PKCE S256 is required'
   : !p.get('state') || !p.get('nonce') ? 'state and nonce are required'
   : (p.get('scope') ?? '').split(' ').some(s => !SUPPORTED_SCOPES.includes(s)) ? 'Unsupported scope requested' : undefined;
  if (problem) return send(res, 400, page('Connection request rejected', problem));
  const key = b64url(randomBytes(24)), idpVerifier = b64url(randomBytes(32)), idpNonce = b64url(randomBytes(16));
  pending.set(key, { params: p, idpVerifier, idpNonce, expires: Date.now() + 600_000 });
  const to = new URL(`${ctx.idp}/authorize`);
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
  const failed = () => send(res, 400, page('Sign-in failed'));
  if (!req || req.expires < Date.now() || !q.get('code')) return failed();
  const r = await fetch(`${ctx.idp}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
   grant_type: 'authorization_code', code: q.get('code')!, redirect_uri: `${origin}/api/auth/idp/callback`, code_verifier: req.idpVerifier,
   client_id: t.idpClient.id, client_secret: t.idpClient.secret,
  }) });
  if (!r.ok) return failed();
  const { payload } = await jwtVerify(String((await r.json()).id_token), idpKeys, { issuer: ctx.idp, audience: t.idpClient.id });
  if (payload.nonce !== req.idpNonce) return failed();
  const user = userFor(ctx.idp, String(payload.sub), String(payload.name ?? payload.sub));
  if (!admitted(user.id)) return send(res, 403, page('This application is not open yet', tenant.state === 'suspended' ? 'It is suspended.' : 'Only pilot users can sign in while it is being validated.'));
  if (tenant.viewer(user.id).denied) return send(res, 403, page('Access withdrawn'));
  const code = b64url(randomBytes(32));
  codes.set(code, { user, scope: req.params.get('scope') ?? 'openid', nonce: req.params.get('nonce')!, challenge: req.params.get('code_challenge')!, expires: Date.now() + 60_000 });
  const back = new URL(ctx.resolveRedirect);
  back.search = new URLSearchParams({ code, state: req.params.get('state')!, iss: issuer }).toString();
  res.writeHead(302, { Location: back.href, 'Cache-Control': 'no-store' }); res.end();
 }

 /** Stand-in for a tenant tool call made with the human's token. */
 async function whoami(req: IncomingMessage, res: ServerResponse) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  try {
   const { payload } = await jwtVerify(bearer ?? '', ownKeys, { issuer, audience: `${origin}/api/mcp` });
   if (!admitted(String(payload.sub))) return send(res, 503, { error: 'not_routable', state: tenant.state });
   send(res, 200, { app: t.appKey, tenantUserId: payload.sub, principalId: payload.principal_id, scopes: String(payload.scope).split(' ') });
  } catch { send(res, 401, { error: 'invalid_token' }); }
 }

 const server: Server = createServer(async (req, res) => {
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
   if (req.method === 'POST' && url.pathname === '/api/mcp') return await mcp(req, res);
   if (req.method === 'GET' && url.pathname === '/api/resolve/protocol') {
    stats.protocolCalls++;
    return send(res, 200, { protocolVersions: [1], tools: PROTOCOL_TOOLS });
   }
   if (req.method === 'GET' && url.pathname === '/dev/stats') return send(res, 200, stats);
   if (req.method === 'POST' && url.pathname === '/dev/customer-message') { const b = JSON.parse(await body(req)); return send(res, 200, store.customerMessage(b.conversationId, String(b.text ?? 'Hello'), b.team)); }
   if (req.method === 'POST' && url.pathname === '/dev/visitor-activity') { const b = JSON.parse(await body(req)); return send(res, 200, store.visitorActivity(String(b.conversationId), b)); }
   if (req.method === 'GET' && url.pathname === '/dev/activity') return send(res, 200, store.rawActivity(url.searchParams.get('conversationId') ?? ''));
   if (req.method === 'GET' && url.pathname === '/dev/availability') return send(res, 200, store.availabilityByName());
   if (req.method === 'GET' && url.pathname === '/dev/entitlements') return send(res, 200, Object.fromEntries([...tenant.entitlements].map(([k, e]) => [k.slice(k.indexOf('|') + 1), e])));
   if (req.method === 'POST' && url.pathname === '/dev/fail') {
    const { mode, sub } = JSON.parse(await body(req));
    const id = userFor(ctx.idp, String(sub), '').id;
    if (mode === 'error' || mode === 'timeout' || mode === 'drop') failFor.set(id, mode); else failFor.delete(id);
    return send(res, 200, { sub, mode: failFor.get(id) ?? null });
   }
   if (req.method === 'POST' && url.pathname === '/dev/reset-stats') { stats.toolCalls = 0; stats.protocolCalls = 0; return send(res, 200, stats); }
   if (req.method === 'POST' && url.pathname === '/dev/drop-next-token-response') { dropNextTokenResponse = true; return send(res, 200, { ok: true }); }
   send(res, 404, { error: 'not_found' });
  } catch (e) {
   send(res, 500, { error: 'server_error', error_description: e instanceof Error ? e.message : 'unknown' });
  }
 });
 await new Promise<void>(r => server.listen(t.port, '127.0.0.1', () => r()));
 console.log(`Mock tenant ${t.appKey} at ${origin} (${tenant.state}${tenant.bound ? '' : ', unbound'})`);
 return tenant;
}
