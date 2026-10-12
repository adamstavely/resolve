import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeEach, expect, test } from 'vitest';
import { migrate } from '../../packages/database/src';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
const admin = new Pool({ connectionString: url, max: 2 });
let schema = '';
const scoped = () => { const u = new URL(url); u.searchParams.set('options', `-c search_path=${schema}`); return u.toString(); };
const versions = async () => (await admin.query(`SELECT version FROM ${schema}.resolve_migrations ORDER BY version`)).rows.map(r => r.version);
const tableExists = async (name: string) => (await admin.query('SELECT to_regclass($1) AS t', [`${schema}.${name}`])).rows[0].t !== null;

beforeEach(async () => { schema = 'm_' + randomUUID().replaceAll('-', ''); await admin.query(`CREATE SCHEMA ${schema}`); });
afterAll(async () => { const r = await admin.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'm\\_%'"); for (const { nspname } of r.rows) await admin.query(`DROP SCHEMA ${nspname} CASCADE`); await admin.end(); });

test('applies each migration once and is a no-op on rerun', async () => {
 const m = [{ version: '0001', sql: 'CREATE TABLE a (id int)' }, { version: '0002', sql: 'CREATE TABLE b (id int)' }];
 await migrate(scoped(), m); await migrate(scoped(), m);
 expect(await versions()).toEqual(['0001', '0002']);
});

test('rejects an edited migration without applying later ones', async () => {
 await migrate(scoped(), [{ version: '0001', sql: 'CREATE TABLE a (id int)' }]);
 await expect(migrate(scoped(), [{ version: '0001', sql: 'CREATE TABLE a (id bigint)' }, { version: '0002', sql: 'CREATE TABLE b (id int)' }])).rejects.toThrow('checksum mismatch: 0001');
 expect(await versions()).toEqual(['0001']);
 expect(await tableExists('b')).toBe(false);
});

test('a failing migration rolls back the whole run', async () => {
 await expect(migrate(scoped(), [{ version: '0001', sql: 'CREATE TABLE a (id int)' }, { version: '0002', sql: 'NOT SQL' }])).rejects.toThrow();
 expect(await tableExists('a')).toBe(false);
 expect(await tableExists('resolve_migrations')).toBe(false);
});

test('concurrent runners serialize and apply once', async () => {
 const m = [{ version: '0001', sql: 'CREATE TABLE a (id int)' }];
 await Promise.all([migrate(scoped(), m), migrate(scoped(), m), migrate(scoped(), m)]);
 expect(await versions()).toEqual(['0001']);
});
