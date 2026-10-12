import type { Pool } from 'pg';
import type { AdminUser, AuditEvent } from '@resolve/contracts';
import { transaction, type Queryable } from './db';

/*
 * Phase 1 administration primitives. Every change is audited with the acting admin and their reason, in the
 * same transaction as the change.
 */

export async function findUsers(db: Queryable, query: string, limit = 25): Promise<AdminUser[]> {
 const like = '%' + query.replace(/[\\%_]/g, c => '\\' + c) + '%';
 const rows = (await db.query(
  `SELECT u.id, u.display_name, u.email, u.enabled, u.disabled_reason,
    ARRAY(SELECT DISTINCT bundle FROM role_members m WHERE m.user_id = u.id ORDER BY bundle) AS bundles,
    (SELECT max(last_login_at) FROM identities i WHERE i.user_id = u.id) AS last_login_at
   FROM users u WHERE $1 = '' OR u.display_name ILIKE $2 OR u.email ILIKE $2
   ORDER BY u.display_name, u.id LIMIT $3`, [query, like, limit])).rows;
 return rows.map(r => ({ id: r.id, displayName: r.display_name, email: r.email, enabled: r.enabled, disabledReason: r.disabled_reason,
  bundles: r.bundles, lastLoginAt: r.last_login_at ? (r.last_login_at as Date).toISOString() : null }));
}

export type AccessChangeResult = 'changed' | 'unchanged' | 'not_found' | 'self' | 'directory_disabled';

/**
 * Emergency block (plan 02): independent of the directory. Blocking revokes sessions and per-app grants at once.
 * Lifting only removes a manual block; a directory-disabled person must be re-enabled in the directory.
 * Admins cannot block themselves, so the last admin cannot lock everyone out by accident.
 */
export async function setManualAccess(db: Pick<Pool, 'connect'>, actorUserId: string, targetUserId: string, enabled: boolean, reason: string): Promise<AccessChangeResult> {
 if (actorUserId === targetUserId) return 'self';
 return transaction(db, async tx => {
  const row = (await tx.query('SELECT enabled, disabled_reason FROM users WHERE id = $1 FOR UPDATE', [targetUserId])).rows[0];
  if (!row) return 'not_found';
  let result: AccessChangeResult;
  if (!enabled) {
   if (row.disabled_reason === 'manual') result = 'unchanged';
   else {
    await tx.query(`UPDATE users SET enabled = false, disabled_reason = 'manual', updated_at = now() WHERE id = $1`, [targetUserId]);
    await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [targetUserId]);
    await tx.query(`UPDATE user_tenant_grants SET state = 'revoked', scopes = '{}', access_token_enc = NULL, refresh_token_enc = NULL,
     access_expires_at = NULL, last_error = 'manually_disabled', updated_at = now() WHERE user_id = $1 AND state <> 'revoked'`, [targetUserId]);
    result = 'changed';
   }
  } else if (row.disabled_reason === 'manual') {
   await tx.query('UPDATE users SET enabled = true, disabled_reason = NULL, updated_at = now() WHERE id = $1', [targetUserId]);
   result = 'changed';
  } else result = row.enabled ? 'unchanged' : 'directory_disabled';
  await tx.query(`INSERT INTO audit_events (operation_id, actor_user_id, operation, outcome, summary) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
   [actorUserId, enabled ? 'user.manual_enable' : 'user.manual_disable', result === 'changed' || result === 'unchanged' ? 'succeeded' : 'denied',
    JSON.stringify({ targetUserId, reason, result })]);
  return result;
 });
}

/** Opaque keyset cursor over (at, id), newest first. */
export const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString('base64url');
export function decodeCursor(cursor: string): [string, string] | undefined {
 try {
  const v = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && !Number.isNaN(Date.parse(v[0])) ? [v[0], v[1]] : undefined;
 } catch { return undefined; }
}

export async function auditPage(db: Queryable, q: { category?: string; outcome?: string; limit: number; before?: [string, string] }) {
 const rows = (await db.query(
  `SELECT a.id, a.at, a.at::text AS at_exact, a.operation, a.outcome, a.summary, a.actor_user_id, u.display_name
   FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
   WHERE ($1::text IS NULL OR a.operation LIKE $1 || '.%') AND ($2::text IS NULL OR a.outcome = $2)
     AND ($3::timestamptz IS NULL OR (a.at, a.id) < ($3::timestamptz, $4::uuid))
   ORDER BY a.at DESC, a.id DESC LIMIT $5`,
  [q.category ?? null, q.outcome ?? null, q.before?.[0] ?? null, q.before?.[1] ?? null, q.limit + 1])).rows;
 const page = rows.slice(0, q.limit);
 const events: AuditEvent[] = page.map(r => ({
  id: r.id, at: (r.at as Date).toISOString(), operation: r.operation, outcome: r.outcome,
  actorType: r.actor_user_id ? 'human' : 'system', actor: r.display_name ?? String(r.summary?.executor ?? 'system'), summary: r.summary ?? {},
 }));
 const last = page.at(-1);
 // The cursor keeps Postgres' microsecond timestamp text; a JS Date would truncate it and skip or repeat rows.
 return { events, nextCursor: rows.length > q.limit && last ? encodeCursor(last.at_exact, last.id) : null };
}
