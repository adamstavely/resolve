import type { Pool } from 'pg';
import { GRANT_STATES, type GrantState } from '@resolve/contracts';
import { aad, type Sealer } from '../crypto';
import { transaction, type Queryable } from '../db';

/*
 * Per-user, per-app OAuth grants (contract 2). Tokens are sealed and bound to (user, app). Rotation runs under a
 * row lock so concurrent requests refresh once. A refresh whose response may have been lost (the tenant may
 * already have rotated) becomes reconnect_required; there is no guessed recovery.
 */

export interface TenantClient { clientId: string; clientSecret: string }

export async function saveTenantClient(db: Queryable, sealer: Sealer, appKey: string, c: TenantClient) {
 await db.query(
  `INSERT INTO tenant_clients (app_key, client_id, client_secret_enc) VALUES ($1, $2, $3)
   ON CONFLICT (app_key) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc, updated_at = now()`,
  [appKey, c.clientId, sealer.seal(c.clientSecret, aad.clientSecret(appKey))]);
}

export async function tenantClient(db: Queryable, sealer: Sealer, appKey: string): Promise<TenantClient | undefined> {
 const row = (await db.query('SELECT client_id, client_secret_enc FROM tenant_clients WHERE app_key = $1', [appKey])).rows[0];
 return row && { clientId: row.client_id, clientSecret: sealer.open(row.client_secret_enc, aad.clientSecret(appKey)) };
}

export interface ConnectAttemptRow { attemptId: string; userId: string; appKey: string; sessionHash: string; codeVerifier: string; nonce: string; requestedScopes: string[]; expiresAt: Date }

export async function createConnectAttempt(db: Queryable, a: { stateHash: string; userId: string; appKey: string; sessionHash: string; codeVerifier: string; nonce: string; requestedScopes: string[]; ttlSeconds: number }) {
 await db.query('DELETE FROM connect_attempts WHERE expires_at < now()');
 await db.query(
  `INSERT INTO connect_attempts (state_hash, user_id, app_key, session_hash, code_verifier, nonce, requested_scopes, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
  [a.stateHash, a.userId, a.appKey, a.sessionHash, a.codeVerifier, a.nonce, a.requestedScopes, a.ttlSeconds]);
}

/** Consume (delete) an attempt by state. Binding to session, user and expiry is checked by the caller with checkCallbackBinding. */
export async function takeConnectAttempt(db: Queryable, stateHash: string): Promise<ConnectAttemptRow | undefined> {
 const row = (await db.query(
  `DELETE FROM connect_attempts WHERE state_hash = $1
   RETURNING attempt_id, user_id, app_key, session_hash, code_verifier, nonce, requested_scopes, expires_at`, [stateHash])).rows[0];
 return row && { attemptId: row.attempt_id, userId: row.user_id, appKey: row.app_key, sessionHash: row.session_hash, codeVerifier: row.code_verifier,
  nonce: row.nonce, requestedScopes: row.requested_scopes, expiresAt: row.expires_at };
}

export interface LinkRow { appKey: string; issuer: string; subject: string; tenantUserId: string; tenantPrincipalId: string }

export async function identityLink(db: Queryable, userId: string, appKey: string) {
 return (await db.query('SELECT tenant_issuer, tenant_user_id, tenant_principal_id FROM tenant_identity_links WHERE user_id = $1 AND app_key = $2', [userId, appKey])).rows[0] as
  { tenant_issuer: string; tenant_user_id: string; tenant_principal_id: string } | undefined;
}

export type StoreOutcome = 'stored' | 'tenant_account_linked_elsewhere';

/**
 * Persist a verified connection: create the identity link on first connect (unique per tenant account) and
 * store the sealed tokens. The caller has already checked any existing link with checkIdentityMapping.
 */
export async function storeConnection(db: Pick<Pool, 'connect'>, sealer: Sealer, c: {
 userId: string; appKey: string; tenantIssuer: string; tenantUserId: string; tenantPrincipalId: string; identityId: string;
 scopes: string[]; accessToken: string; refreshToken: string | undefined; accessExpiresAt: Date;
}): Promise<StoreOutcome> {
 return transaction(db, async tx => {
  const linked = await tx.query(
   `INSERT INTO tenant_identity_links (user_id, app_key, tenant_issuer, tenant_user_id, tenant_principal_id) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING RETURNING user_id`, [c.userId, c.appKey, c.tenantIssuer, c.tenantUserId, c.tenantPrincipalId]);
  if (!linked.rowCount) {
   const existing = await identityLink(tx, c.userId, c.appKey);
   if (!existing || existing.tenant_user_id !== c.tenantUserId) return 'tenant_account_linked_elsewhere';
  }
  await tx.query(`INSERT INTO identity_usages (identity_id, usage) VALUES ($1, 'app_provider') ON CONFLICT DO NOTHING`, [c.identityId]);
  await tx.query(
   `INSERT INTO user_tenant_grants (user_id, app_key, state, scopes, access_token_enc, refresh_token_enc, access_expires_at, last_error)
    VALUES ($1, $2, 'connected', $3, $4, $5, $6, NULL)
    ON CONFLICT (user_id, app_key) DO UPDATE SET state = 'connected', scopes = EXCLUDED.scopes, access_token_enc = EXCLUDED.access_token_enc,
     refresh_token_enc = EXCLUDED.refresh_token_enc, access_expires_at = EXCLUDED.access_expires_at, last_error = NULL, updated_at = now()`,
   [c.userId, c.appKey, c.scopes, sealer.seal(c.accessToken, aad.accessToken(c.userId, c.appKey)),
    c.refreshToken ? sealer.seal(c.refreshToken, aad.refreshToken(c.userId, c.appKey)) : null, c.accessExpiresAt]);
  return 'stored';
 });
}

/** Move a grant out of `connected`, discarding its tokens. */
export async function setGrantState(db: Queryable, userId: string, appKey: string, state: Exclude<GrantState, 'connected'>, error: string | null = null) {
 await db.query(
  `INSERT INTO user_tenant_grants (user_id, app_key, state, last_error) VALUES ($1, $2, $3, $4)
   ON CONFLICT (user_id, app_key) DO UPDATE SET state = EXCLUDED.state, scopes = '{}', access_token_enc = NULL, refresh_token_enc = NULL,
    access_expires_at = NULL, last_error = EXCLUDED.last_error, updated_at = now()`, [userId, appKey, state, error]);
}

export async function grantsFor(db: Queryable, userId: string) {
 const rows = (await db.query(
  `SELECT g.app_key, g.state, g.scopes, g.last_error, l.tenant_user_id FROM user_tenant_grants g
   LEFT JOIN tenant_identity_links l ON l.user_id = g.user_id AND l.app_key = g.app_key WHERE g.user_id = $1`, [userId])).rows;
 return new Map(rows.map(r => [r.app_key as string, { state: (GRANT_STATES as readonly string[]).includes(r.state) ? r.state as GrantState : 'not_connected',
  scopes: r.scopes as string[], lastError: r.last_error as string | null, tenantUserId: r.tenant_user_id as string | null }]));
}

export type RefreshResult = { accessToken: string; refreshToken?: string; expiresAt: Date };
/** `not_sent`: the request never reached the tenant. `invalid_grant`: definite refusal. Anything else: outcome unknown. */
export class RefreshError extends Error { constructor(readonly kind: 'not_sent' | 'invalid_grant' | 'unknown') { super(kind); } }

export type TokenOutcome =
 | { status: 'ok'; accessToken: string; scopes: string[] }
 | { status: 'not_connected' | 'reconnect_required' | 'unavailable'; state?: GrantState };

/**
 * A usable access token for (user, app), refreshing under a row lock when it is about to expire.
 * The lock spans the refresh call, so concurrent callers wait and then reuse the rotated token.
 */
export async function accessToken(db: Pick<Pool, 'connect'>, sealer: Sealer, userId: string, appKey: string,
 refresh: (refreshToken: string) => Promise<RefreshResult>, now = () => new Date()): Promise<TokenOutcome> {
 return transaction(db, async tx => {
  const row = (await tx.query(
   `SELECT state, scopes, access_token_enc, refresh_token_enc, access_expires_at FROM user_tenant_grants
    WHERE user_id = $1 AND app_key = $2 FOR UPDATE`, [userId, appKey])).rows[0];
  if (!row || row.state !== 'connected') return { status: row?.state === 'reconnect_required' ? 'reconnect_required' : 'not_connected', state: row?.state };
  if (row.access_expires_at.getTime() - now().getTime() > 30_000)
   return { status: 'ok', accessToken: sealer.open(row.access_token_enc, aad.accessToken(userId, appKey)), scopes: row.scopes };
  if (!row.refresh_token_enc) { await setGrantState(tx, userId, appKey, 'reconnect_required', 'access_expired_no_refresh'); return { status: 'reconnect_required' }; }
  try {
   const r = await refresh(sealer.open(row.refresh_token_enc, aad.refreshToken(userId, appKey)));
   await tx.query(
    `UPDATE user_tenant_grants SET access_token_enc = $3, refresh_token_enc = $4, access_expires_at = $5, updated_at = now() WHERE user_id = $1 AND app_key = $2`,
    [userId, appKey, sealer.seal(r.accessToken, aad.accessToken(userId, appKey)),
     r.refreshToken ? sealer.seal(r.refreshToken, aad.refreshToken(userId, appKey)) : row.refresh_token_enc, r.expiresAt]);
   return { status: 'ok', accessToken: r.accessToken, scopes: row.scopes };
  } catch (e) {
   const kind = e instanceof RefreshError ? e.kind : 'unknown';
   if (kind === 'not_sent') return { status: 'unavailable' };
   await setGrantState(tx, userId, appKey, 'reconnect_required', kind === 'invalid_grant' ? 'refresh_rejected' : 'refresh_outcome_unknown');
   return { status: 'reconnect_required' };
  }
 });
}
