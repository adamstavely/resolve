import { createHash } from 'node:crypto';
import { Pool } from 'pg';

/** Highest migration in packages/database/migrations; readiness requires it (checked by a unit test). */
export const LATEST_MIGRATION = '0010';

export async function migrate(connectionString: string, migrations: {version:string; sql:string}[]) {
 const pool = new Pool({connectionString, max:1}); const client = await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(74819021)');
  await client.query('CREATE TABLE IF NOT EXISTS resolve_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const m of migrations) {
   const checksum = createHash('sha256').update(m.sql).digest('hex');
   const previous = await client.query('SELECT checksum FROM resolve_migrations WHERE version=$1',[m.version]);
   if (previous.rowCount) { if (previous.rows[0].checksum !== checksum) throw new Error('Migration checksum mismatch: '+m.version); continue; }
   await client.query(m.sql);
   await client.query('INSERT INTO resolve_migrations(version,checksum) VALUES($1,$2)',[m.version,checksum]);
  }
  await client.query('COMMIT');
 } catch(e) { await client.query('ROLLBACK'); throw e; }
 finally { client.release(); await pool.end(); }
}
