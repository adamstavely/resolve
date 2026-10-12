/*
 * Development-only mock OpenID Connect provider standing in for the organization's IdP (OIDC + SAML 2.0
 * capable; product not chosen yet). Implements the subset Resolve uses: discovery, JWKS, authorization
 * code with PKCE S256, client_secret_post/basic, RS256 ID tokens with nonce and a `groups` claim.
 * Keys are generated per process. It refuses to start with NODE_ENV=production.
 *
 *   npm run dev:idp     (reads .env: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, RESOLVE_ORIGIN)
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

if (process.env.NODE_ENV === 'production') throw new Error('The mock IdP must never run in production');

const issuer = new URL(process.env.OIDC_ISSUER ?? 'http://127.0.0.1:3200').origin;
const clientId = required('OIDC_CLIENT_ID'), clientSecret = required('OIDC_CLIENT_SECRET');
const redirectUris = [`${new URL(required('RESOLVE_ORIGIN')).origin}/api/auth/callback`];
const users: { sub: string; name: string; email: string; groups: string[] }[] = JSON.parse(readFileSync(new URL('./users.json', import.meta.url), 'utf8'));

const { privateKey, publicKey } = await generateKeyPair('RS256');
const kid = randomBytes(8).toString('hex');
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }] };

interface Code { sub: string; nonce: string; challenge: string; redirectUri: string; expires: number }
const codes = new Map<string, Code>();

function required(name: string) {
 const v = process.env[name];
 if (!v) throw new Error(`${name} is required (see .env.example)`);
 return v;
}

const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const b64url = (b: Buffer) => b.toString('base64url');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
 const isText = typeof body === 'string';
 res.writeHead(status, { 'Content-Type': isText ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
 res.end(isText ? body : JSON.stringify(body));
}
const oauthError = (res: ServerResponse, error: string, description: string, status = 400) => send(res, status, { error, error_description: description });

async function form(req: IncomingMessage) {
 let raw = '';
 for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) throw new Error('Body too large'); }
 return new URLSearchParams(raw);
}

/** Validate an authorization request; returns an error message or undefined. */
function checkAuthorize(p: URLSearchParams) {
 if (p.get('client_id') !== clientId) return 'Unknown client_id';
 if (!redirectUris.includes(p.get('redirect_uri') ?? '')) return 'redirect_uri is not registered for this client';
 if (p.get('response_type') !== 'code') return 'Only response_type=code is supported';
 if (!(p.get('scope') ?? '').split(' ').includes('openid')) return 'scope must include openid';
 if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return 'PKCE with S256 is required';
 if (!p.get('state') || !p.get('nonce')) return 'state and nonce are required';
 return undefined;
}

function loginPage(p: URLSearchParams) {
 const hidden = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method']
  .map(k => `<input type="hidden" name="${k}" value="${escape(p.get(k) ?? '')}">`).join('');
 const options = users.map((u, i) => `<div class="opt"><input type="radio" name="sub" id="u${i}" value="${escape(u.sub)}"${i === 0 ? ' checked' : ''}>
  <label for="u${i}">${escape(u.name)} <span>${escape(u.email)} · ${u.groups.length ? escape(u.groups.join(', ')) : 'no groups'}</span></label></div>`).join('');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Mock identity provider</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#fafafb;color:#16181d}main{max-width:32rem;margin:2rem auto;padding:0 1rem}
.warn{background:#fff4e5;border:1px solid #8f5d00;border-radius:8px;padding:.75rem 1rem}fieldset{border:1px solid #7c8390;border-radius:8px;padding:1rem}
.opt{display:flex;gap:.5rem;align-items:flex-start;padding:.25rem 0}.opt span{display:block;color:#5f6673;font-size:.875rem}
input[type=radio]{width:1.25rem;height:1.25rem;margin-top:.2rem}button{font:inherit;min-height:44px;padding:0 1.25rem;border-radius:8px;border:0;background:#3b5bff;color:#fff;margin-top:1rem}
:focus-visible{outline:3px solid #3b5bff;outline-offset:2px}</style></head><body><main>
<h1>Sign in</h1><p class="warn"><strong>Development mock.</strong> This identity provider is for local testing only and has no passwords.</p>
<form method="post" action="/authorize">${hidden}<fieldset><legend>Choose a test user</legend>${options}</fieldset><button type="submit">Continue</button></form>
</main></body></html>`;
}

async function idToken(user: (typeof users)[number], nonce: string) {
 return new SignJWT({ nonce, name: user.name, email: user.email, groups: user.groups, auth_time: Math.floor(Date.now() / 1000) })
  .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setSubject(user.sub).setAudience(clientId)
  .setIssuedAt().setExpirationTime('5m').sign(privateKey);
}

async function token(req: IncomingMessage, res: ServerResponse) {
 const p = await form(req);
 let id = p.get('client_id'), secret = p.get('client_secret');
 const basic = req.headers.authorization?.match(/^Basic (.+)$/);
 if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
 if (id !== clientId || !secret || !safeEqual(secret, clientSecret)) return oauthError(res, 'invalid_client', 'Client authentication failed', 401);
 if (p.get('grant_type') !== 'authorization_code') return oauthError(res, 'unsupported_grant_type', 'Only authorization_code');
 const code = codes.get(p.get('code') ?? '');
 codes.delete(p.get('code') ?? ''); // single use, even when the request below fails
 if (!code || code.expires < Date.now()) return oauthError(res, 'invalid_grant', 'Unknown, used or expired code');
 if (p.get('redirect_uri') !== code.redirectUri) return oauthError(res, 'invalid_grant', 'redirect_uri mismatch');
 const verifier = p.get('code_verifier') ?? '';
 if (b64url(createHash('sha256').update(verifier).digest()) !== code.challenge) return oauthError(res, 'invalid_grant', 'PKCE verification failed');
 const user = users.find(u => u.sub === code.sub)!;
 send(res, 200, { access_token: b64url(randomBytes(32)), token_type: 'Bearer', expires_in: 300, scope: 'openid profile email', id_token: await idToken(user, code.nonce) });
}

const server = createServer(async (req, res) => {
 try {
  const url = new URL(req.url ?? '/', issuer);
  if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') return send(res, 200, {
   issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
   response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'],
   id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
   token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'], scopes_supported: ['openid', 'profile', 'email'],
   claims_supported: ['sub', 'name', 'email', 'groups', 'nonce', 'auth_time'], authorization_response_iss_parameter_supported: true,
  });
  if (req.method === 'GET' && url.pathname === '/jwks') return send(res, 200, jwks);
  if (url.pathname === '/authorize') {
   const p = req.method === 'POST' ? await form(req) : url.searchParams;
   const problem = checkAuthorize(p);
   // Never redirect to an unvalidated redirect_uri: show the error here instead.
   if (problem) return send(res, 400, `<!doctype html><html lang="en"><title>Sign-in error</title><main><h1>Sign-in request rejected</h1><p>${escape(problem)}</p></main></html>`);
   if (req.method === 'GET') return send(res, 200, loginPage(p));
   const user = users.find(u => u.sub === p.get('sub'));
   if (!user) return send(res, 400, '<!doctype html><html lang="en"><title>Sign-in error</title><main><h1>Unknown user</h1></main></html>');
   const code = b64url(randomBytes(32));
   codes.set(code, { sub: user.sub, nonce: p.get('nonce')!, challenge: p.get('code_challenge')!, redirectUri: p.get('redirect_uri')!, expires: Date.now() + 60_000 });
   const back = new URL(p.get('redirect_uri')!);
   back.search = new URLSearchParams({ code, state: p.get('state')!, iss: issuer }).toString();
   res.writeHead(302, { Location: back.href, 'Cache-Control': 'no-store' }); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/token') return await token(req, res);
  send(res, 404, { error: 'not_found' });
 } catch (e) {
  send(res, 500, { error: 'server_error', error_description: e instanceof Error ? e.message : 'unknown' });
 }
});

const port = Number(new URL(issuer).port || 80);
server.listen(port, new URL(issuer).hostname, () => console.log(`Mock IdP (development only) at ${issuer}`));
