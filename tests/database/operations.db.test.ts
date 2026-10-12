import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrate } from '../../packages/database/src';
import { signIn } from '../../apps/api/lib/auth/repository';
import { beginOperation, OperationConflict, toApi, type ActionSpec } from '../../apps/api/lib/operations';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for database tests');
const schema = 'ops_' + randomUUID().replaceAll('-', '');
const scoped = new URL(url); scoped.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Pool({ connectionString: url, max: 1 });
const db = new Pool({ connectionString: scoped.toString(), max: 4 });

beforeAll(async () => {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const dir = new URL('../../packages/database/migrations/', import.meta.url);
 const files = (await readdir(dir)).filter(f => /^\d{4}\.sql$/.test(f)).sort();
 await migrate(scoped.toString(), await Promise.all(files.map(async f => ({ version: f.slice(0, 4), sql: await readFile(new URL(f, dir), 'utf8') }))));
});
afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

const person = async () => { const r = await signIn(db, { issuer: 'https://idp.test', subject: 's-' + randomUUID(), displayName: 'Op', email: null, bundles: ['fleet-agent'] }); if (r.status !== 'ok') throw new Error(); return r.userId; };
const reply = (content: string): ActionSpec => ({ operation: 'conversation.reply', tool: 'reply_to_conversation', targetType: 'conversation', targetId: 'c1', keyed: true,
 args: { conversationId: 'c1', content }, summary: { kind: 'reply', characters: content.length } });

describe('operation intents', () => {
 test('are recorded before dispatch with a pending audit transition that carries no content', async () => {
  const user = await person(); const id = randomUUID();
  const { row, created } = await beginOperation(db, id, user, 'payroll', reply('Secret customer detail'));
  expect(created).toBe(true);
  expect(row.state).toBe('pending');
  const audit = (await db.query('SELECT operation, outcome, summary FROM audit_events WHERE operation_id = $1', [id])).rows;
  expect(audit).toEqual([{ operation: 'conversation.reply', outcome: 'pending', summary: { app: 'payroll', target: 'c1', kind: 'reply', characters: 22 } }]);
  expect(JSON.stringify(row)).not.toContain('Secret customer detail');
 });

 test('a repeated id with the same payload returns the same operation; different content or another user is refused', async () => {
  const user = await person(); const other = await person(); const id = randomUUID();
  await beginOperation(db, id, user, 'payroll', reply('Hello'));
  expect((await beginOperation(db, id, user, 'payroll', reply('Hello'))).created).toBe(false);
  await expect(beginOperation(db, id, user, 'payroll', reply('Changed'))).rejects.toThrow(OperationConflict);
  await expect(beginOperation(db, id, other, 'payroll', reply('Hello'))).rejects.toThrow(OperationConflict);
 });

 test('concurrent submissions of one id create one operation', async () => {
  const user = await person(); const id = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => beginOperation(db, id, user, 'payroll', reply('Once'))));
  expect(results.filter(r => r.created)).toHaveLength(1);
  expect((await db.query('SELECT count(*)::int AS n FROM audit_events WHERE operation_id = $1', [id])).rows[0].n).toBe(1);
 });

 test('next steps never include an automatic retry', async () => {
  const base = { id: randomUUID(), user_id: 'u', app_key: 'payroll', operation: 'conversation.reply', target_type: 'conversation' as const, target_id: 'c1', payload_hash: 'h',
   summary: {}, failure_code: null, tenant_record_id: null, result: null, created_at: new Date(), completed_at: null };
  expect(toApi({ ...base, state: 'uncertain' }, true).next).toBe('reconcile');
  expect(toApi({ ...base, state: 'uncertain', operation: 'conversation.assign' }, false).next).toBe('refresh_and_retry');
  expect(toApi({ ...base, state: 'failed', failure_code: 'NOT_SENT' }, true).next).toBe('retry_same_operation');
  expect(toApi({ ...base, state: 'failed', failure_code: 'CONFLICT' }, false).next).toBe('refresh_and_retry');
  expect(toApi({ ...base, state: 'denied', failure_code: 'FORBIDDEN' }, true).next).toBe('none');
 });
});

describe('audited message text', () => {
 test('is sealed at rest, bound to its event, and opened only through the audit page', async () => {
  const { localSealer, aad } = await import('../../apps/api/lib/crypto');
  const { auditPage } = await import('../../apps/api/lib/admin');
  const seal = localSealer(Buffer.alloc(32, 9).toString('base64'));
  const user = await person(); const id = randomUUID();
  await beginOperation(db, id, user, 'payroll', { ...reply('Your refund is on its way'), content: 'Your refund is on its way' }, seal);
  const raw = (await db.query('SELECT id, content_enc FROM audit_events WHERE operation_id = $1', [id])).rows[0];
  expect(raw.content_enc).not.toContain('refund');
  expect(seal.open(raw.content_enc, aad.auditContent(raw.id))).toBe('Your refund is on its way');
  expect(() => seal.open(raw.content_enc, aad.auditContent(randomUUID()))).toThrow();
  const page = await auditPage(db, { category: 'conversation', limit: 50 }, seal);
  expect(page.events.find(e => e.summary.target === 'c1' && e.content === 'Your refund is on its way')).toBeDefined();
 });
});
