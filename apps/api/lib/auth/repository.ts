import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { BundleId } from '@resolve/contracts';
import { transaction, type Queryable } from '../db';

/*
 * Identity, session and audit persistence. Every function takes its database handle so tests can run
 * against an isolated schema (tests/database/auth.db.test.ts).
 */

export interface LoginAttempt { codeVerifier: string; nonce: string; returnTo: string }

export async function createLoginAttempt(db: Queryable, a: { stateHash: string; bindingHash: string; codeVerifier: string; nonce: string; returnTo: string; ttlSeconds: number }) {
 // Abandoned attempts hold a PKCE verifier; drop them once expired so unauthenticated GETs cannot grow the table forever.
 await db.query('DELETE FROM login_attempts WHERE expires_at < now()');
 await db.query(
  `INSERT INTO login_attempts (state_hash, binding_hash, code_verifier, nonce, return_to, expires_at)
   VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
  [a.stateHash, a.bindingHash, a.codeVerifier, a.nonce, a.returnTo, a.ttlSeconds]);
}

/**
 * Atomically consume an unexpired attempt bound to this browser. The row is deleted, so the verifier does not
 * outlive its use. Replay, expiry and a foreign browser all return undefined.
 */
export async function consumeLoginAttempt(db: Queryable, stateHash: string, bindingHash: string): Promise<LoginAttempt | undefined> {
 const r = await db.query(
  `DELETE FROM login_attempts
   WHERE state_hash = $1 AND binding_hash = $2 AND consumed_at IS NULL AND expires_at > now()
   RETURNING code_verifier, nonce, return_to`, [stateHash, bindingHash]);
 const row = r.rows[0];
 return row && { codeVerifier: row.code_verifier, nonce: row.nonce, returnTo: row.return_to };
}

export interface SignInClaims { issuer: string; subject: string; displayName: string; email: string | null; bundles: BundleId[] }
export type SignInResult = { status: 'ok'; userId: string; identityId: string } | { status: 'disabled'; userId: string };

/**
 * Resolve the Resolve user for an issuer/subject pair, creating it on first sign-in. Never matches by email.
 * Concurrent first sign-ins for the same subject serialize on an advisory lock and produce one user.
 * Claim-sourced bundles are replaced; manually granted bundles are untouched.
 */
export async function signIn(db: Pick<Pool, 'connect'>, c: SignInClaims): Promise<SignInResult> {
 return transaction(db, async tx => {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [c.issuer + '\n' + c.subject]);
  let row = (await tx.query(
   `SELECT i.id AS identity_id, u.id AS user_id, u.enabled FROM identities i JOIN users u ON u.id = i.user_id
    WHERE i.issuer = $1 AND i.subject = $2`, [c.issuer, c.subject])).rows[0];
  if (!row) {
   const user = (await tx.query('INSERT INTO users (display_name, email) VALUES ($1, $2) RETURNING id', [c.displayName, c.email])).rows[0];
   const identity = (await tx.query('INSERT INTO identities (user_id, issuer, subject) VALUES ($1, $2, $3) RETURNING id', [user.id, c.issuer, c.subject])).rows[0];
   row = { identity_id: identity.id, user_id: user.id, enabled: true };
  }
  if (!row.enabled) return { status: 'disabled', userId: row.user_id };
  await tx.query('UPDATE users SET display_name = $2, email = $3, updated_at = now() WHERE id = $1', [row.user_id, c.displayName, c.email]);
  await tx.query('UPDATE identities SET last_login_at = now() WHERE id = $1', [row.identity_id]);
  await tx.query(`INSERT INTO identity_usages (identity_id, usage) VALUES ($1, 'tower_login') ON CONFLICT DO NOTHING`, [row.identity_id]);
  await tx.query(`DELETE FROM role_members WHERE user_id = $1 AND source = 'claim'`, [row.user_id]);
  for (const bundle of c.bundles) await tx.query(`INSERT INTO role_members (user_id, bundle, source) VALUES ($1, $2, 'claim')`, [row.user_id, bundle]);
  return { status: 'ok', userId: row.user_id, identityId: row.identity_id };
 });
}

export async function createSession(db: Queryable, s: { idHash: string; userId: string; identityId: string; absoluteMinutes: number }) {
 await db.query(
  `INSERT INTO sessions (id_hash, user_id, identity_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
  [s.idHash, s.userId, s.identityId, s.absoluteMinutes]);
}

export interface SessionUser { userId: string; displayName: string; email: string | null; bundles: string[] }

/**
 * The signed-in user for a session, or undefined when the session is unknown, revoked, past its absolute
 * or idle limit, or the user is disabled. Checked on every request; extends the idle window.
 */
export async function findSession(db: Queryable, idHash: string, idleMinutes: number): Promise<SessionUser | undefined> {
 const r = await db.query(
  `UPDATE sessions s SET last_seen_at = now()
   FROM users u
   WHERE s.id_hash = $1 AND u.id = s.user_id AND u.enabled AND s.revoked_at IS NULL
     AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(mins => $2)
   RETURNING u.id, u.display_name, u.email,
     ARRAY(SELECT DISTINCT bundle FROM role_members m WHERE m.user_id = u.id ORDER BY bundle) AS bundles`,
  [idHash, idleMinutes]);
 const row = r.rows[0];
 return row && { userId: row.id, displayName: row.display_name, email: row.email, bundles: row.bundles };
}

export async function revokeSession(db: Queryable, idHash: string): Promise<string | undefined> {
 const r = await db.query('UPDATE sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL RETURNING user_id', [idHash]);
 return r.rows[0]?.user_id;
}

/** Disabling a user denies existing sessions immediately (findSession checks enabled) and revokes them. */
export async function setUserEnabled(db: Pick<Pool, 'connect'>, userId: string, enabled: boolean) {
 await transaction(db, async tx => {
  await tx.query('UPDATE users SET enabled = $2, updated_at = now() WHERE id = $1', [userId, enabled]);
  if (!enabled) await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
 });
}

export async function audit(db: Queryable, e: { actorUserId: string | null; operation: string; outcome: 'succeeded' | 'failed' | 'denied'; summary?: Record<string, string | number | boolean | null> }) {
 await db.query('INSERT INTO audit_events (operation_id, actor_user_id, operation, outcome, summary) VALUES ($1, $2, $3, $4, $5)',
  [randomUUID(), e.actorUserId, e.operation, e.outcome, JSON.stringify(e.summary ?? {})]);
}

export async function recentAudit(db: Queryable, limit = 50) {
 const r = await db.query(
  `SELECT a.at, a.operation, a.outcome, a.summary, u.display_name AS actor
   FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.at DESC LIMIT $1`, [limit]);
 return r.rows.map(row => ({ at: (row.at as Date).toISOString(), operation: row.operation, outcome: row.outcome, actor: row.actor, summary: row.summary }));
}
