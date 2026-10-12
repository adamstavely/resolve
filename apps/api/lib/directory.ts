import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction, type Queryable } from './db';
import { writeAudit } from './audit';

/*
 * Directory observation ingestion (plan 02). The directory is authoritative for whether a person may use
 * Resolve. Versions only move forward, so a stale or replayed observation can never re-enable a user.
 * Disabling revokes sessions and per-app grants immediately; re-enabling restores neither.
 * A manual (emergency) denial is independent of the directory and is never lifted by it.
 */
export const directorySnapshotSchema = z.object({
 observedAt: z.iso.datetime({ offset: true }),
 /** True when the snapshot covers every user; only then does absence mean removal. */
 complete: z.boolean(),
 users: z.array(z.object({ sub: z.string().min(1), active: z.boolean(), version: z.number().int().nonnegative() })),
});
export type DirectorySnapshot = z.infer<typeof directorySnapshotSchema>;

export type ObservationOutcome = 'applied' | 'stale' | 'unchanged' | 'unknown_user' | 'absent';

async function revokeAccess(tx: Queryable, userId: string) {
 await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
 await tx.query(`UPDATE user_tenant_grants SET state = 'revoked', scopes = '{}', access_token_enc = NULL, refresh_token_enc = NULL,
  access_expires_at = NULL, last_error = 'directory_disabled', updated_at = now() WHERE user_id = $1 AND state <> 'revoked'`, [userId]);
}

async function record(tx: Queryable, source: string, issuer: string, subject: string, active: boolean, version: number | null, observedAt: string, outcome: ObservationOutcome) {
 await tx.query(`INSERT INTO directory_observations (source, issuer, subject, active, version, observed_at, outcome) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [source, issuer, subject, active, version, observedAt, outcome]);
}

async function systemAudit(tx: Queryable, operation: string, userId: string, summary: Record<string, string | number | boolean>) {
 await writeAudit(tx, { actorUserId: null, operation, outcome: 'succeeded', summary: { executor: 'directory-sync', userId, ...summary } });
}

export async function applyDirectorySnapshot(db: Pick<Pool, 'connect'>, issuer: string, source: string, snapshot: DirectorySnapshot) {
 const counts: Record<ObservationOutcome, number> = { applied: 0, stale: 0, unchanged: 0, unknown_user: 0, absent: 0 };
 for (const u of snapshot.users) {
  const outcome = await transaction(db, async tx => {
   const row = (await tx.query(
    `SELECT u.id, u.enabled, u.directory_version, u.disabled_reason FROM identities i JOIN users u ON u.id = i.user_id
     WHERE i.issuer = $1 AND i.subject = $2 FOR UPDATE OF u`, [issuer, u.sub])).rows[0];
   let outcome: ObservationOutcome;
   if (!row) outcome = 'unknown_user';
   else if (u.version < Number(row.directory_version)) outcome = 'stale';
   else if (u.version === Number(row.directory_version) && (u.active === row.enabled || row.disabled_reason === 'manual')) outcome = 'unchanged';
   else {
    outcome = 'applied';
    if (!u.active) {
     await tx.query(`UPDATE users SET enabled = false, disabled_reason = CASE WHEN disabled_reason = 'manual' THEN 'manual' ELSE 'directory' END,
      directory_version = $2, updated_at = now() WHERE id = $1`, [row.id, u.version]);
     await revokeAccess(tx, row.id);
     await systemAudit(tx, 'user.directory_disable', row.id, { source, version: u.version });
    } else if (row.disabled_reason === 'manual') {
     await tx.query('UPDATE users SET directory_version = $2 WHERE id = $1', [row.id, u.version]);
    } else {
     await tx.query('UPDATE users SET enabled = true, disabled_reason = NULL, directory_version = $2, updated_at = now() WHERE id = $1', [row.id, u.version]);
     if (!row.enabled) await systemAudit(tx, 'user.directory_enable', row.id, { source, version: u.version });
    }
   }
   await record(tx, source, issuer, u.sub, u.active, u.version, snapshot.observedAt, outcome);
   return outcome;
  });
  counts[outcome]++;
 }
 if (snapshot.complete) {
  const present = snapshot.users.map(u => u.sub);
  const absent = (await (db as unknown as Queryable).query(
   `SELECT u.id, i.subject FROM identities i JOIN users u ON u.id = i.user_id WHERE i.issuer = $1 AND u.enabled AND NOT (i.subject = ANY($2))`,
   [issuer, present])).rows;
  for (const a of absent) await transaction(db, async tx => {
   await tx.query(`UPDATE users SET enabled = false, disabled_reason = 'directory_absent', updated_at = now() WHERE id = $1`, [a.id]);
   await revokeAccess(tx, a.id);
   await record(tx, source, issuer, a.subject, false, null, snapshot.observedAt, 'absent');
   await systemAudit(tx, 'user.directory_disable', a.id, { source, reason: 'absent_from_complete_snapshot' });
   counts.absent++;
  });
 }
 return counts;
}
