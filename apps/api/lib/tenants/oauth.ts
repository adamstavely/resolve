import * as client from 'openid-client';
import { QUACKBACK_SCOPES, scopesFor, type CapabilityId, type RegistryApp } from '@resolve/contracts';
import { config } from '../config';
import { pool } from '../db';
import { acceptableOrigin, tenantIssuer } from '../registry';
import { sealer } from '../sealer';
import { RefreshError, tenantClient, type RefreshResult } from './grants';

const discovered = new Map<string, Promise<client.Configuration>>();

/** Per-tenant OAuth configuration from the tenant's own discovery document (issuer `${supportOrigin}/api/auth`). */
export async function tenantOidc(app: RegistryApp): Promise<client.Configuration> {
 const key = `${app.appKey}|${app.supportOrigin}`;
 let p = discovered.get(key);
 if (!p) {
  const creds = await tenantClient(pool(), sealer(), app.appKey);
  if (!creds) throw new Error(`No OAuth client registered for ${app.appKey}`);
  if (!acceptableOrigin(app.supportOrigin)) throw new Error(`Refusing non-https tenant origin for ${app.appKey}`);
  const insecure = new URL(app.supportOrigin).protocol === 'http:';
  p = client.discovery(new URL(tenantIssuer(app)), creds.clientId, creds.clientSecret, undefined, insecure ? { execute: [client.allowInsecureRequests] } : undefined)
   .then(cfg => { cfg.timeout = 4; return cfg; }) // seconds; plan 01 per-app timeout
   .catch(e => { discovered.delete(key); throw e; });
  discovered.set(key, p);
 }
 return p;
}

/** Drop cached discovery/credentials after a client registration or rotation. */
export function forgetTenantOidc(appKey: string) {
 for (const key of discovered.keys()) if (key.startsWith(appKey + '|')) discovered.delete(key);
}

export const connectRedirectUri = () => `${config().RESOLVE_ORIGIN}/api/connect/callback`;

/**
 * Scopes to request from a tenant: only what the user's capabilities need (an observer gets read scopes only),
 * limited to the tenant's vocabulary. Proposed scopes the fork lacks are not requested.
 */
export function tenantScopes(capabilities: Iterable<CapabilityId>): string[] {
 const supported = new Set<string>(QUACKBACK_SCOPES);
 return ['openid', 'offline_access', ...scopesFor(capabilities).filter(s => supported.has(s))];
}

/** Map openid-client failures to whether the tenant may have processed the refresh. */
export function classifyRefreshError(e: unknown): RefreshError {
 if (e instanceof client.ResponseBodyError && e.error === 'invalid_grant') return new RefreshError('invalid_grant');
 const code = (e as { cause?: { code?: string } })?.cause?.code;
 if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new RefreshError('not_sent');
 return new RefreshError('unknown');
}

export function refresher(app: RegistryApp) {
 return async (refreshToken: string): Promise<RefreshResult> => {
  let cfg: client.Configuration;
  try { cfg = await tenantOidc(app); } catch { throw new RefreshError('not_sent'); }
  try {
   const t = await client.refreshTokenGrant(cfg, refreshToken);
   return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: new Date(Date.now() + (t.expires_in ?? 300) * 1000) };
  } catch (e) {
   throw classifyRefreshError(e);
  }
 };
}
