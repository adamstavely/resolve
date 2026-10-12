import type { Pool } from 'pg';
import type { ElasticAppMapping, IsolationResult, MappingPreview, MappingView } from '@resolve/contracts';
import type { Sealer } from '../crypto';
import { transaction, type Queryable } from '../db';
import { writeAudit } from '../audit';
import { clientFor, ConnectionError } from './connections';
import { ElasticError, type ElasticClient } from './elastic/client';
import { notifyObservability } from './notify';
import { countEvents, fetchAlerts, fetchCases, fetchSlos, fetchSynthetics, serviceFilter } from './elastic/families';

/*
 * App mappings (plan 14, E1): which Elastic data belongs to an app and environment. A mapping polls only once it is
 * active, and it can be activated only after a preview (every configured id resolves and each family answers) and
 * an isolation check (its selectors share no events or ids with any other app's mapping on the same connection)
 * have passed for its current revision. Editing a mapping sends it back to draft. Everything is audited.
 */

interface Row {
 app_key: string; environment: string; connection_id: string; mapping: ElasticAppMapping; state: 'draft' | 'active' | 'disabled';
 preview: MappingPreview | null; isolation: IsolationResult | null; preview_passed_at: Date | null; isolation_passed_at: Date | null;
 revision: number; version: number; updated_at: Date;
}
const view = (r: Row): MappingView => ({
 appKey: r.app_key, environment: r.environment, mapping: r.mapping, state: r.state, revision: r.revision, version: r.version,
 preview: r.preview, isolation: r.isolation, updatedAt: r.updated_at.toISOString(),
});

export async function listMappings(db: Queryable): Promise<MappingView[]> {
 return ((await db.query('SELECT * FROM elastic_app_mappings ORDER BY app_key, environment')).rows as Row[]).map(view);
}
export async function getMapping(db: Queryable, appKey: string, environment: string): Promise<MappingView | null> {
 const r = (await db.query('SELECT * FROM elastic_app_mappings WHERE app_key = $1 AND environment = $2', [appKey, environment])).rows[0] as Row | undefined;
 return r ? view(r) : null;
}
async function row(db: Queryable, appKey: string, environment: string, lock = false) {
 const r = (await db.query(`SELECT * FROM elastic_app_mappings WHERE app_key = $1 AND environment = $2${lock ? ' FOR UPDATE' : ''}`, [appKey, environment])).rows[0] as Row | undefined;
 if (!r) throw new ConnectionError(404, 'NOT_FOUND', 'This application has no Elastic mapping for that environment.');
 return r;
}

/** Create or replace (version-checked). Any edit returns the mapping to draft and clears its checks. */
export async function saveMapping(db: Pick<Pool, 'connect'>, actorUserId: string, m: ElasticAppMapping, version: number | null): Promise<MappingView> {
 return transaction(db, async tx => {
  const conn = (await tx.query(`SELECT id FROM integration_connections WHERE id = $1 AND provider = 'elastic'`, [m.connectionId])).rows[0];
  if (!conn) throw new ConnectionError(400, 'UNKNOWN_CONNECTION', 'Choose an existing Elastic connection.', { field: 'connectionId' });
  const existing = (await tx.query('SELECT version, state, connection_id FROM elastic_app_mappings WHERE app_key = $1 AND environment = $2 FOR UPDATE', [m.appKey, m.environment])).rows[0];
  let r: Row;
  if (!existing) {
   if (version !== null) throw new ConnectionError(409, 'CONFLICT', 'This mapping was removed. Reload and try again.');
   r = (await tx.query(`INSERT INTO elastic_app_mappings (app_key, environment, connection_id, mapping, updated_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [m.appKey, m.environment, m.connectionId, JSON.stringify(m), actorUserId])).rows[0];
  } else {
   if (version === null || existing.version !== version) throw new ConnectionError(409, 'CONFLICT', 'Someone else changed this mapping. Reload and try again.');
   r = (await tx.query(
    `UPDATE elastic_app_mappings SET connection_id = $3, mapping = $4, state = 'draft', preview = NULL, isolation = NULL, preview_passed_at = NULL, isolation_passed_at = NULL,
      revision = revision + 1, version = version + 1, updated_by = $5, updated_at = now() WHERE app_key = $1 AND environment = $2 RETURNING *`,
    [m.appKey, m.environment, m.connectionId, JSON.stringify(m), actorUserId])).rows[0];
   if (existing.connection_id !== m.connectionId) await tx.query(`DELETE FROM integration_operations WHERE kind = 'poll' AND operation_key = $1`, [`${m.appKey}:${m.environment}`]);
  }
  await writeAudit(tx, { actorUserId, operation: 'observability.mapping_save', outcome: 'succeeded', summary: {
   app: m.appKey, environment: m.environment, connectionId: m.connectionId, revision: r.revision, wasActive: existing?.state === 'active',
   services: m.services.length, slos: m.sloIds.length, monitors: m.monitorIds.length, rules: m.alertRuleIds.length } });
  return view(r);
 });
}

type FamilyPreview = MappingPreview['families'][number];
async function familyPreview(family: FamilyPreview['family'], configured: boolean, work: () => Promise<{ found: number; missingIds?: string[] }>): Promise<FamilyPreview> {
 if (!configured) return { family, status: 'not_configured', found: 0, missingIds: [], code: null };
 try {
  const r = await work();
  const missingIds = r.missingIds ?? [];
  return { family, status: missingIds.length ? 'missing' : r.found ? 'ok' : 'empty', found: r.found, missingIds, code: null };
 } catch (e) {
  if (e instanceof ElasticError) return { family, status: e.code === 'FORBIDDEN' || e.code === 'UNAUTHENTICATED' ? 'denied' : 'error', found: 0, missingIds: [], code: e.elasticType ?? e.code };
  throw e;
 }
}

/** Run every configured family once against the last 24 hours (15 minutes for synthetics). */
export async function runPreview(client: ElasticClient, m: ElasticAppMapping, testSubject?: string, now = new Date()): Promise<MappingPreview> {
 const day = { from: new Date(now.getTime() - 24 * 3600_000), to: now };
 const services = serviceFilter(m.services);
 const families = await Promise.all([
  familyPreview('slo', m.sloIds.length > 0, async () => { const r = await fetchSlos(client, m.sloIds); return { found: r.items.length, missingIds: r.missing }; }),
  familyPreview('alerts', m.alertRuleIds.length > 0, async () => ({ found: (await fetchAlerts(client, m.alertRuleIds, day)).items.length })),
  familyPreview('synthetics', m.monitorIds.length > 0, async () => {
   const r = await fetchSynthetics(client, m.indices.synthetics, m.monitorIds, day);
   const seen = new Set(r.items.map(i => i.monitorId));
   return { found: r.items.length, missingIds: m.monitorIds.filter(id => !seen.has(id)) };
  }),
  familyPreview('apm', m.indices.apm.length > 0, async () => ({ found: await countEvents(client, m.indices.apm, [services], day) })),
  familyPreview('rum', m.indices.rum.length > 0, async () => ({ found: await countEvents(client, m.indices.rum, [services], day) })),
  familyPreview('logs', m.indices.logs.length > 0, async () => ({ found: await countEvents(client, m.indices.logs, [services], day) })),
  familyPreview('cases', m.caseTags.length > 0, async () => ({ found: (await fetchCases(client, m.caseTags)).items.length })),
 ]);
 let testSubjectEvents: number | null = null;
 if (testSubject) {
  const subject = [{ term: { 'user.id': testSubject } }, services];
  testSubjectEvents = (await countEvents(client, m.indices.apm, subject, day).catch(() => 0)) + (await countEvents(client, m.indices.rum, subject, day).catch(() => 0));
 }
 const passed = families.every(f => f.status === 'ok' || f.status === 'empty' || f.status === 'not_configured') && families.some(f => f.status !== 'not_configured');
 return { checkedAt: now.toISOString(), passed, families, testSubjectEvents };
}

export async function previewMapping(db: Pick<Pool, 'connect' | 'query'>, seal: Sealer, actorUserId: string, appKey: string, environment: string, testSubject?: string): Promise<MappingView> {
 const before = await row(db, appKey, environment);
 const preview = await runPreview(await clientFor(db, seal, before.connection_id), before.mapping, testSubject);
 return transaction(db, async tx => {
  const current = await row(tx, appKey, environment, true);
  // The mapping changed while the preview ran: the result belongs to an older revision.
  if (current.revision !== before.revision) throw new ConnectionError(409, 'CONFLICT', 'The mapping changed while it was being checked. Run the preview again.');
  const r = (await tx.query(`UPDATE elastic_app_mappings SET preview = $3, preview_passed_at = $4, updated_at = now() WHERE app_key = $1 AND environment = $2 RETURNING *`,
   [appKey, environment, JSON.stringify(preview), preview.passed ? new Date() : null])).rows[0] as Row;
  await writeAudit(tx, { actorUserId, operation: 'observability.mapping_preview', outcome: preview.passed ? 'succeeded' : 'failed',
   summary: { app: appKey, environment, revision: r.revision, passed: preview.passed, testSubject: testSubject ? true : false } });
  return view(r);
 });
}

/**
 * Isolation: for every other mapping on the same connection, count events in this mapping's indices that match both
 * mappings' service selectors, and list any SLO, monitor, rule or case tag both claim. Anything shared fails.
 */
export async function runIsolation(client: ElasticClient, self: ElasticAppMapping, others: ElasticAppMapping[], now = new Date()): Promise<IsolationResult> {
 const day = { from: new Date(now.getTime() - 24 * 3600_000), to: now };
 const patterns = [...self.indices.apm, ...self.indices.rum, ...self.indices.logs];
 const comparedWith: IsolationResult['comparedWith'] = [];
 for (const o of others) {
  const overlappingEvents = await countEvents(client, patterns, [serviceFilter(self.services), serviceFilter(o.services)], day);
  const shared = (a: string[], b: string[], kind: string) => a.filter(x => b.includes(x)).map(x => `${kind} ${x}`);
  const sharedIds = [...shared(self.sloIds, o.sloIds, 'SLO'), ...shared(self.monitorIds, o.monitorIds, 'monitor'), ...shared(self.alertRuleIds, o.alertRuleIds, 'rule'), ...shared(self.caseTags, o.caseTags, 'case tag')];
  comparedWith.push({ appKey: o.appKey, environment: o.environment, overlappingEvents, sharedIds });
 }
 return { checkedAt: now.toISOString(), passed: comparedWith.every(c => c.overlappingEvents === 0 && c.sharedIds.length === 0), comparedWith };
}

export async function isolationCheck(db: Pick<Pool, 'connect' | 'query'>, seal: Sealer, actorUserId: string, appKey: string, environment: string): Promise<MappingView> {
 const before = await row(db, appKey, environment);
 const others = ((await db.query('SELECT mapping FROM elastic_app_mappings WHERE connection_id = $1 AND NOT (app_key = $2 AND environment = $3)', [before.connection_id, appKey, environment])).rows as { mapping: ElasticAppMapping }[]).map(r => r.mapping);
 let isolation: IsolationResult;
 try { isolation = await runIsolation(await clientFor(db, seal, before.connection_id), before.mapping, others); }
 catch (e) { if (e instanceof ElasticError) throw new ConnectionError(502, e.code, 'Elastic did not answer the isolation check. Try again.'); throw e; }
 return transaction(db, async tx => {
  const current = await row(tx, appKey, environment, true);
  if (current.revision !== before.revision) throw new ConnectionError(409, 'CONFLICT', 'The mapping changed while it was being checked. Run the check again.');
  const r = (await tx.query(`UPDATE elastic_app_mappings SET isolation = $3, isolation_passed_at = $4, updated_at = now() WHERE app_key = $1 AND environment = $2 RETURNING *`,
   [appKey, environment, JSON.stringify(isolation), isolation.passed ? new Date() : null])).rows[0] as Row;
  await writeAudit(tx, { actorUserId, operation: 'observability.mapping_isolation', outcome: isolation.passed ? 'succeeded' : 'failed',
   summary: { app: appKey, environment, revision: r.revision, passed: isolation.passed, compared: isolation.comparedWith.length } });
  return view(r);
 });
}

/** Activate (only after both checks passed for this revision) or disable. Activation schedules an immediate poll. */
export async function setMappingState(db: Pick<Pool, 'connect'>, actorUserId: string, appKey: string, environment: string, state: 'active' | 'disabled', version: number): Promise<MappingView> {
 return transaction(db, async tx => {
  const current = await row(tx, appKey, environment, true);
  if (current.version !== version) throw new ConnectionError(409, 'CONFLICT', 'Someone else changed this mapping. Reload and try again.');
  if (state === 'active' && (!current.preview_passed_at || !current.isolation_passed_at))
   throw new ConnectionError(409, 'CHECKS_REQUIRED', 'Run the preview and the isolation check, and pass both, before activating.');
  const r = (await tx.query(`UPDATE elastic_app_mappings SET state = $3, version = version + 1, updated_at = now() WHERE app_key = $1 AND environment = $2 RETURNING *`, [appKey, environment, state])).rows[0] as Row;
  if (state === 'active') await tx.query(
   `INSERT INTO integration_operations (connection_id, app_key, kind, operation_key) VALUES ($1, $2, 'poll', $3)
    ON CONFLICT (connection_id, kind, operation_key) DO UPDATE SET not_before = now(), state = CASE WHEN integration_operations.state = 'running' THEN 'running' ELSE 'pending' END`,
   [r.connection_id, appKey, `${appKey}:${environment}`]);
  await notifyObservability(tx, { type: 'health', appKey, environment, at: new Date().toISOString() });
  await notifyObservability(tx, { type: 'issues', appKey, environment, at: new Date().toISOString() });
  await writeAudit(tx, { actorUserId, operation: 'observability.mapping_state', outcome: 'succeeded', summary: { app: appKey, environment, state, revision: r.revision } });
  return view(r);
 });
}

/** Poll this mapping as soon as a worker is free (an explicit admin request, never a browser loop). */
export async function refreshNow(db: Queryable, appKey: string, environment: string) {
 const r = await db.query(`UPDATE integration_operations SET not_before = now() WHERE kind = 'poll' AND operation_key = $1`, [`${appKey}:${environment}`]);
 return (r.rowCount ?? 0) > 0;
}
