import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
 broadcastSummary, canonicalJson, deliveryKey, isServable, toTenantAnnouncement,
 type BlockReason, type BroadcastContent, type BroadcastReview, type BroadcastView, type DeliveryState, type RegistryApp,
} from '@resolve/contracts';
import type { z } from 'zod';
import type { announcementToolResults, broadcastDraftSchema, broadcastTargetingSchema } from '@resolve/contracts';
import { transaction, type Queryable } from './db';
import { writeAudit } from './audit';
import { capabilityList } from './auth/policy';
import { tiersFor } from './clearance';
import { registry } from './registry';
import { rpc } from './tenants/mcp';
import { actionSupported, tenantHealth } from './tenants/protocol';

/*
 * Banner broadcasts (plan 08, plan 00 phase 5). Intent is recorded before any tenant call: a revision pins the
 * content and reviewed recipients, and each app gets one delivery row with a stable key (broadcast, revision, app).
 * Tenants replay a repeated key instead of creating a second announcement, so retries, double submits and crashes
 * after commit stay at one tenant mutation. An unknown outcome is "uncertain" and is settled only by asking the
 * tenant by key, never by a blind resend. Deliveries run as the author, with the author's own grant, and only the
 * author can act on them. Resolve schedules publication itself, so a scheduled "All apps" broadcast includes apps
 * registered before its publish time (owner decision 2026-10-12).
 */
type Draft = z.infer<typeof broadcastDraftSchema>;
type Targeting = z.infer<typeof broadcastTargetingSchema>;
export class BroadcastError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, string> = {}) { super(message); } }
const fail = (status: number, code: string, message: string, details: Record<string, string> = {}): never => { throw new BroadcastError(status, code, message, details); };
const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const FANOUT = 4;
/** A pending delivery not settled within this time (crashed dispatcher) may be dispatched again; the key makes that safe. */
const REDISPATCH_SECONDS = 30;

interface BroadcastRow { id: string; author_user_id: string; status: string; draft: Draft; current_revision: number; version: number; created_at: Date; updated_at: Date }
interface DeliveryRow {
 broadcast_id: string; revision: number; app_key: string; delivery_key: string; payload_hash: string; state: DeliveryState; reason: BlockReason | null; failure_code: string | null;
 tenant_announcement_id: string | null; tenant_version: number | null; surfaces: BroadcastView['deliveries'][number]['surfaces']; attempts: number;
 archive_state: 'pending' | 'succeeded' | 'failed' | 'conflict' | 'uncertain' | null; archive_failure_code: string | null; updated_at: Date;
}
interface Actor { userId: string; capabilities: string[] }

async function load(db: Queryable, id: string, lock = false): Promise<BroadcastRow> {
 const row = (await db.query(`SELECT * FROM broadcasts WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0] as BroadcastRow | undefined;
 return row ?? fail(404, 'NOT_FOUND', 'This broadcast does not exist.');
}
const requireAuthor = (b: BroadcastRow, actor: Actor) => { if (b.author_user_id !== actor.userId) fail(403, 'NOT_AUTHOR', 'Only the author can change this broadcast: deliveries are published as them.'); };
const audit = (db: Queryable, actorUserId: string | null, operation: string, summary: Record<string, string | number | boolean | null>, outcome: 'succeeded' | 'failed' | 'pending' | 'uncertain' | 'denied' = 'succeeded', content?: string) =>
 writeAudit(db, { actorUserId, operation: `broadcast.${operation}`, outcome, summary, content });
const contentText = (c: BroadcastContent) => [c.title, c.body, c.link ? `${c.link.label} <${c.link.url}>` : null].filter(Boolean).join('\n');

// ── Tier-scoped authors ──

/** Authors with `broadcast.app` but not `broadcast.publish`: banners only to applications where they hold Tier 1+. */
export const tierScoped = (actor: Actor) => !actor.capabilities.includes('broadcast.publish');

/**
 * Re-checked at draft, review and publish (a tier can change in the application between them). "All applications"
 * is never open to a tier-scoped author, and every selected application must report Tier 1 or higher for them.
 */
export async function assertTargetingAllowed(actor: Actor, targeting: Targeting) {
 if (!tierScoped(actor)) return;
 if (targeting.mode !== 'selected') return fail(403, 'TIER_SCOPE', 'You can send banners only to applications where you hold Tier 1 or higher. Choose those applications.', { field: 'targeting' });
 const tiers = await tiersFor(actor.userId, targeting.apps);
 const outside = targeting.apps.filter(k => !tiers[k]);
 if (outside.length) {
  const names = new Map((await registry()).apps.map(a => [a.appKey, a.displayName]));
  fail(403, 'TIER_SCOPE', `You do not hold Tier 1 or higher in ${outside.map(k => names.get(k) ?? k).join(', ')}, so you cannot send it a banner.`, { field: 'targeting' });
 }
}
/** A tier-scoped author sees and changes only their own broadcasts. */
export async function assertCanView(db: Queryable, actor: Actor, id: string) {
 if (!tierScoped(actor)) return;
 requireAuthor(await load(db, id), actor);
}

// ── Drafts ──

export async function createDraft(db: Pick<Pool, 'connect'>, authorUserId: string, draft: Draft) {
 return transaction(db, async tx => {
  const id = (await tx.query('INSERT INTO broadcasts (author_user_id, draft) VALUES ($1, $2) RETURNING id', [authorUserId, JSON.stringify(draft)])).rows[0].id as string;
  await audit(tx, authorUserId, 'draft', { broadcastId: id, title: draft.content.title, targeting: draft.targeting.mode });
  return id;
 });
}

export async function saveDraft(db: Pick<Pool, 'connect'>, actor: Actor, id: string, draft: Draft, version: number) {
 await transaction(db, async tx => {
  const b = await load(tx, id, true);
  requireAuthor(b, actor);
  if (b.status !== 'draft') fail(409, 'NOT_DRAFT', 'This broadcast was already published. Edit it instead.');
  if (b.version !== version) fail(409, 'CONFLICT', 'This draft changed elsewhere. Reload it and try again.');
  await tx.query('UPDATE broadcasts SET draft = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, JSON.stringify(draft)]);
  await audit(tx, actor.userId, 'draft', { broadcastId: id, title: draft.content.title, targeting: draft.targeting.mode });
 });
}

// ── Recipients and readiness ──

/** Whether one app can take this author's broadcast now, and why not. */
async function readiness(db: Queryable, app: RegistryApp | undefined, userId: string): Promise<BlockReason | null> {
 if (!app) return 'not_registered';
 if (app.state === 'suspended') return 'suspended';
 if (!isServable(app)) return 'not_open';
 const grant = (await db.query('SELECT state, scopes FROM user_tenant_grants WHERE user_id = $1 AND app_key = $2', [userId, app.appKey])).rows[0];
 if (!grant || grant.state === 'not_connected' || grant.state === 'revoked') return 'not_connected';
 if (grant.state !== 'connected') return 'reconnect_required';
 if (!(grant.scopes as string[]).includes('write:announcement')) return 'missing_scope';
 const health = await tenantHealth(app);
 if (health.status === 'unreachable') return 'unreachable';
 if (!(await actionSupported(app, 'upsert_announcement'))) return 'unsupported';
 return null;
}

/** "All" is every registered app (none silently dropped); "Selected" is the named list. */
async function recipients(db: Queryable, targeting: Targeting, userId: string) {
 const reg = await registry();
 const keys = targeting.mode === 'all' ? reg.apps.map(a => a.appKey) : targeting.apps;
 const list = await Promise.all(keys.map(async appKey => {
  const app = reg.apps.find(a => a.appKey === appKey);
  const reason = await readiness(db, app, userId);
  return { appKey, displayName: app?.displayName ?? appKey, state: reason ? 'blocked' as const : 'ready' as const, reason };
 }));
 return { registryRevision: reg.revision, recipients: list.sort((a, b) => a.displayName.localeCompare(b.displayName)) };
}

const isScheduled = (c: BroadcastContent) => !!c.publishAt && Date.parse(c.publishAt) > Date.now() + 5_000;
const reviewHashOf = (draft: Draft, r: Awaited<ReturnType<typeof recipients>>) =>
 sha({ content: draft.content, targeting: draft.targeting, registryRevision: r.registryRevision, recipients: r.recipients.map(x => [x.appKey, x.state, x.reason]) });

export async function review(db: Queryable, actor: Actor, id: string): Promise<BroadcastReview> {
 const b = await load(db, id);
 requireAuthor(b, actor);
 if (b.status !== 'draft') fail(409, 'NOT_DRAFT', 'This broadcast was already published.');
 await assertTargetingAllowed(actor, b.draft.targeting);
 const r = await recipients(db, b.draft.targeting, actor.userId);
 await audit(db, actor.userId, 'review', { broadcastId: id, recipients: r.recipients.length, blocked: r.recipients.filter(x => x.state === 'blocked').length });
 return { broadcastId: id, revision: 1, reviewHash: reviewHashOf(b.draft, r), registryRevision: r.registryRevision, recipients: r.recipients,
  followsRegistry: b.draft.targeting.mode === 'all' && isScheduled(b.draft.content) };
}

// ── Publish ──

export async function publish(db: Pick<Pool, 'connect'> & Queryable, actor: Actor, id: string, body: { reviewHash: string; requestId: string; confirmPartial: boolean }) {
 // A repeated request (double click, retry after a lost response) returns the same publication.
 const prior = (await db.query('SELECT broadcast_id FROM broadcast_revisions WHERE publish_request_id = $1', [body.requestId])).rows[0];
 if (prior) { if (prior.broadcast_id !== id) fail(409, 'REQUEST_CONFLICT', 'This request id was used for another broadcast.'); return; }
 const b = await load(db, id);
 requireAuthor(b, actor);
 if (b.status !== 'draft') fail(409, 'NOT_DRAFT', 'This broadcast was already published.');
 await assertTargetingAllowed(actor, b.draft.targeting);
 const r = await recipients(db, b.draft.targeting, actor.userId);
 if (reviewHashOf(b.draft, r) !== body.reviewHash) fail(409, 'STALE_REVIEW', 'Something changed since you reviewed (content, recipients or their readiness). Review again.');
 const scheduled = isScheduled(b.draft.content);
 const blocked = r.recipients.filter(x => x.state === 'blocked');
 if (blocked.length && !body.confirmPartial) fail(409, 'PARTIAL_NOT_CONFIRMED', `${blocked.length} application${blocked.length > 1 ? 's' : ''} cannot receive this now. Confirm a partial delivery, or fix them and review again.`);
 if (!scheduled && blocked.length === r.recipients.length) fail(409, 'NOTHING_READY', 'No recipient can receive this broadcast now.');
 const publishAt = scheduled ? b.draft.content.publishAt! : new Date().toISOString();
 const inserted = await transaction(db, async tx => {
  const locked = await load(tx, id, true);
  if (locked.status !== 'draft') return false;
  await tx.query(`INSERT INTO broadcast_revisions (broadcast_id, revision, content, content_hash, targeting, reviewed_recipients, registry_revision, review_hash, confirmed_partial,
    publish_request_id, confirmed_by, publish_at) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
   [id, JSON.stringify(b.draft.content), sha(b.draft.content), JSON.stringify(b.draft.targeting), JSON.stringify(r.recipients), r.registryRevision, body.reviewHash,
    blocked.length > 0, body.requestId, actor.userId, publishAt]);
  await tx.query(`UPDATE broadcasts SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, scheduled ? 'scheduled' : 'publishing']);
  await audit(tx, actor.userId, 'publish', { broadcastId: id, revision: 1, targeting: b.draft.targeting.mode, recipients: r.recipients.length, blocked: blocked.length,
   confirmedPartial: blocked.length > 0, scheduledFor: scheduled ? publishAt : null }, 'succeeded', contentText(b.draft.content));
  return true;
 });
 if (!inserted) return;
 if (!scheduled) { await materialize(db, id, 1); await dispatchPending(db, id); }
}

/**
 * Create the delivery rows for a revision once it is due. Immediate publication uses the reviewed list. A scheduled
 * revision re-resolves its recipients at publish time ("All apps" follows the registry) and re-checks readiness and
 * the author's authority; anything that cannot take it is recorded as blocked, never skipped silently.
 */
export async function materialize(db: Pick<Pool, 'connect'> & Queryable, id: string, revision: number) {
 const rev = (await db.query('SELECT * FROM broadcast_revisions WHERE broadcast_id = $1 AND revision = $2', [id, revision])).rows[0];
 if (!rev || rev.materialized_at) return;
 const b = await load(db, id);
 const scheduledLate = Date.parse(rev.publish_at) - Date.parse(rev.confirmed_at) > 5_000;
 let list: { appKey: string; state: 'ready' | 'blocked'; reason: BlockReason | null; announcementId?: string | null; version?: number | null }[] = rev.reviewed_recipients;
 if (scheduledLate) {
  const author = (await db.query(`SELECT u.enabled, ARRAY(SELECT DISTINCT bundle FROM role_members m WHERE m.user_id = u.id) AS bundles FROM users u WHERE u.id = $1`, [b.author_user_id])).rows[0];
  const fresh = await recipients(db, rev.targeting, b.author_user_id);
  const allowed = await authorAllowed(author, b.author_user_id, fresh.recipients.map(x => x.appKey));
  list = fresh.recipients.map(x => allowed.has(x.appKey) ? x : { ...x, state: 'blocked' as const, reason: 'author_not_authorized' as const });
 }
 if (revision > 1) {
  // An edit updates each app's existing announcement (version-checked against local edits).
  const prev = (await db.query(`SELECT app_key, tenant_announcement_id, tenant_version FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2`, [id, revision - 1])).rows;
  list = list.map(x => { const p = prev.find(q => q.app_key === x.appKey); return { ...x, announcementId: p?.tenant_announcement_id ?? null, version: p?.tenant_version ?? null }; });
 }
 await transaction(db, async tx => {
  const locked = (await tx.query('SELECT materialized_at FROM broadcast_revisions WHERE broadcast_id = $1 AND revision = $2 FOR UPDATE', [id, revision])).rows[0];
  if (locked.materialized_at) return;
  for (const x of list) {
   await tx.query(`INSERT INTO broadcast_deliveries (broadcast_id, revision, app_key, delivery_key, payload_hash, state, reason, tenant_announcement_id, tenant_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, revision, x.appKey, deliveryKey(id, revision, x.appKey), rev.content_hash, x.state === 'ready' ? 'pending' : 'blocked', x.reason, x.announcementId ?? null, x.version ?? null]);
  }
  await tx.query('UPDATE broadcast_revisions SET materialized_at = now() WHERE broadcast_id = $1 AND revision = $2', [id, revision]);
  await tx.query(`UPDATE broadcasts SET status = 'publishing', updated_at = now() WHERE id = $1 AND status IN ('scheduled', 'publishing', 'published', 'partial', 'needs_attention', 'failed')`, [id]);
 });
 await refreshStatus(db, id);
}

/**
 * Which of these applications the author may still banner when it is sent: all of them with `broadcast.publish`;
 * with only `broadcast.app`, those where the application still reports Tier 1 or higher for them.
 */
async function authorAllowed(author: { enabled: boolean; bundles: string[] } | undefined, userId: string, appKeys: string[]): Promise<Set<string>> {
 if (!author?.enabled) return new Set();
 const caps = capabilityList(author.bundles as Parameters<typeof capabilityList>[0]);
 if (caps.includes('broadcast.publish')) return new Set(appKeys);
 if (!caps.includes('broadcast.app')) return new Set();
 const tiers = await tiersFor(userId, appKeys);
 return new Set(appKeys.filter(k => tiers[k]));
}

/** Send every pending delivery of a broadcast's current revision (bounded fan-out; one app's failure affects no other). */
export async function dispatchPending(db: Pick<Pool, 'connect'> & Queryable, id: string) {
 const b = await load(db, id);
 const pending = (await db.query(`SELECT app_key FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2 AND state = 'pending'
  AND (dispatched_at IS NULL OR dispatched_at < now() - make_interval(secs => $3))`, [id, b.current_revision, REDISPATCH_SECONDS])).rows.map(r => r.app_key as string);
 let next = 0;
 await Promise.all(Array.from({ length: Math.min(FANOUT, pending.length) }, async () => {
  while (next < pending.length) await deliver(db, b, pending[next++]).catch(e => console.error(JSON.stringify({ level: 'error', event: 'broadcast_delivery_failed', error: e instanceof Error ? e.message : 'unknown' })));
 }));
 await refreshStatus(db, id);
}

async function deliver(db: Pick<Pool, 'connect'> & Queryable, b: BroadcastRow, appKey: string) {
 // Claim: only one dispatcher sends a delivery at a time; a crashed one's claim expires and the key keeps a resend safe.
 const claimed = (await db.query(`UPDATE broadcast_deliveries SET dispatched_at = now(), attempts = attempts + 1, updated_at = now()
  WHERE broadcast_id = $1 AND revision = $2 AND app_key = $3 AND state = 'pending' AND (dispatched_at IS NULL OR dispatched_at < now() - make_interval(secs => $4)) RETURNING *`,
  [b.id, b.current_revision, appKey, REDISPATCH_SECONDS])).rows[0] as DeliveryRow | undefined;
 if (!claimed) return;
 const rev = (await db.query('SELECT content FROM broadcast_revisions WHERE broadcast_id = $1 AND revision = $2', [b.id, b.current_revision])).rows[0];
 const author = (await db.query(`SELECT u.enabled, ARRAY(SELECT DISTINCT bundle FROM role_members m WHERE m.user_id = u.id) AS bundles FROM users u WHERE u.id = $1`, [b.author_user_id])).rows[0];
 if (!(await authorAllowed(author, b.author_user_id, [appKey])).has(appKey)) return settle(db, claimed, b.author_user_id, { state: 'blocked', reason: 'author_not_authorized' });
 const app = (await registry()).apps.find(a => a.appKey === appKey);
 const reason = await readiness(db, app, b.author_user_id);
 if (reason) return settle(db, claimed, b.author_user_id, { state: 'blocked', reason });
 const o = await rpc(app!, b.author_user_id, 'upsert_announcement', {
  broadcastKey: claimed.delivery_key, payloadHash: claimed.payload_hash, announcement: toTenantAnnouncement(rev.content),
  ...(claimed.tenant_announcement_id ? { announcementId: claimed.tenant_announcement_id, expectedVersion: claimed.tenant_version ?? 0 } : {}),
 }, 6000);
 switch (o.kind) {
  case 'ok': return settle(db, claimed, b.author_user_id, { state: 'succeeded', announcementId: o.data.announcementId, version: o.data.version, surfaces: o.data.surfaces, replayed: o.data.replayed });
  case 'tool_error': return settle(db, claimed, b.author_user_id, { state: 'failed', code: o.code === 'CONFLICT' ? 'LOCAL_EDIT_CONFLICT' : o.code === 'OPERATION_CONFLICT' ? 'KEY_CONFLICT' : o.code });
  case 'not_connected': case 'reconnect_required': return settle(db, claimed, b.author_user_id, { state: 'blocked', reason: o.kind });
  case 'denied': return settle(db, claimed, b.author_user_id, { state: 'failed', code: 'TENANT_DENIED' });
  case 'not_sent': return settle(db, claimed, b.author_user_id, { state: 'failed', code: 'NOT_SENT' });
  case 'unknown': return settle(db, claimed, b.author_user_id, { state: 'uncertain', code: o.detail.toUpperCase() });
 }
}

type Outcome = { state: DeliveryState; reason?: BlockReason; code?: string; announcementId?: string; version?: number; surfaces?: DeliveryRow['surfaces']; replayed?: boolean };
async function settle(db: Queryable, d: DeliveryRow, authorUserId: string, o: Outcome) {
 await db.query(`UPDATE broadcast_deliveries SET state = $4, reason = $5, failure_code = $6, tenant_announcement_id = COALESCE($7, tenant_announcement_id),
   tenant_version = COALESCE($8, tenant_version), surfaces = COALESCE($9, surfaces), updated_at = now() WHERE broadcast_id = $1 AND revision = $2 AND app_key = $3`,
  [d.broadcast_id, d.revision, d.app_key, o.state, o.reason ?? null, o.code ?? null, o.announcementId ?? null, o.version ?? null, o.surfaces ? JSON.stringify(o.surfaces) : null]);
 await audit(db, authorUserId, 'delivery', { broadcastId: d.broadcast_id, revision: d.revision, app: d.app_key, deliveryKey: d.delivery_key,
  ...(o.reason ? { reason: o.reason } : {}), ...(o.code ? { code: o.code } : {}), ...(o.announcementId ? { tenantRecord: o.announcementId } : {}), ...(o.replayed ? { replayed: true } : {}) },
  o.state === 'succeeded' ? 'succeeded' : o.state === 'uncertain' ? 'uncertain' : o.state === 'pending' ? 'pending' : 'failed');
}

/** Aggregate state from the current revision's deliveries; never "published" while any target is unresolved. */
async function refreshStatus(db: Queryable, id: string) {
 const b = await load(db, id);
 if (b.status === 'archived' || b.status === 'draft' || b.status === 'scheduled') return;
 const states = (await db.query('SELECT state FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2', [id, b.current_revision])).rows.map(r => r.state as DeliveryState);
 if (!states.length) return;
 const s = broadcastSummary(states);
 const status = s === 'in_progress' ? 'publishing' : s;
 await db.query('UPDATE broadcasts SET status = $2, updated_at = now() WHERE id = $1 AND status <> $2', [id, status]);
}

// ── Recovery ──

/** Ask the tenant, by key, what happened to an uncertain publication. Never resends blindly. */
export async function reconcile(db: Pick<Pool, 'connect'> & Queryable, actor: Actor, id: string, appKey: string) {
 const b = await load(db, id);
 requireAuthor(b, actor);
 const d = (await db.query(`SELECT * FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2 AND app_key = $3`, [id, b.current_revision, appKey])).rows[0] as DeliveryRow | undefined;
 if (!d) fail(404, 'NOT_FOUND', 'No delivery for this application.');
 if (d!.state !== 'uncertain') fail(409, 'NOT_UNCERTAIN', 'Only an unconfirmed delivery needs checking.');
 const app = (await registry()).apps.find(a => a.appKey === appKey);
 if (!app) fail(409, 'NOT_REGISTERED', 'This application is no longer registered.');
 const o = await rpc(app!, b.author_user_id, 'get_announcement_by_key', { broadcastKey: d!.delivery_key }, 6000);
 if (o.kind !== 'ok') fail(503, 'TENANT_UNAVAILABLE', 'The application could not confirm the result. Try again shortly.');
 const r = (o as { data: z.infer<typeof announcementToolResults.get_announcement_by_key> }).data;
 if (r.state === 'committed' && r.payloadHash === d!.payload_hash) await settle(db, d!, b.author_user_id, { state: 'succeeded', announcementId: r.announcementId, version: r.version, surfaces: r.surfaces });
 else if (r.state === 'committed') await settle(db, d!, b.author_user_id, { state: 'failed', code: 'KEY_CONFLICT' });
 // Never committed: safe to send again with the same key.
 else await settle(db, d!, b.author_user_id, { state: 'failed', code: 'NOT_COMMITTED' });
 await audit(db, actor.userId, 'reconcile', { broadcastId: id, app: appKey, result: r.state });
 await refreshStatus(db, id);
}

/** Send a failed or blocked delivery again with the same key (after the cause was fixed). */
export async function retry(db: Pick<Pool, 'connect'> & Queryable, actor: Actor, id: string, appKey: string) {
 const b = await load(db, id);
 requireAuthor(b, actor);
 if (b.status === 'archived') fail(409, 'ARCHIVED', 'This broadcast was archived.');
 const r = await db.query(`UPDATE broadcast_deliveries SET state = 'pending', reason = NULL, failure_code = NULL, dispatched_at = NULL, updated_at = now()
  WHERE broadcast_id = $1 AND revision = $2 AND app_key = $3 AND state IN ('failed', 'blocked') RETURNING app_key`, [id, b.current_revision, appKey]);
 if (!r.rowCount) fail(409, 'NOT_RETRYABLE', 'Only a failed or blocked delivery can be sent again. Check an unconfirmed one first.');
 await audit(db, actor.userId, 'retry', { broadcastId: id, app: appKey });
 await dispatchPending(db, id);
}

// ── Edit and archive ──

/** A new revision updates every app's announcement (version-checked against local edits); recipients stay the same. */
export async function revise(db: Pick<Pool, 'connect'> & Queryable, actor: Actor, id: string, body: { content: BroadcastContent; version: number; requestId: string }) {
 const prior = (await db.query('SELECT broadcast_id FROM broadcast_revisions WHERE publish_request_id = $1', [body.requestId])).rows[0];
 if (prior) return;
 const b = await load(db, id);
 requireAuthor(b, actor);
 if (b.status === 'draft' || b.status === 'archived' || b.status === 'scheduled') fail(409, 'NOT_PUBLISHED', 'Only a published broadcast can be edited; change a draft or scheduled one by archiving and starting again.');
 if (b.version !== body.version) fail(409, 'CONFLICT', 'This broadcast changed elsewhere. Reload it and try again.');
 const open = (await db.query(`SELECT 1 FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2 AND state IN ('pending', 'uncertain')`, [id, b.current_revision])).rowCount;
 if (open) fail(409, 'DELIVERY_OPEN', 'Settle the pending or unconfirmed deliveries first.');
 const prev = (await db.query('SELECT * FROM broadcast_revisions WHERE broadcast_id = $1 AND revision = $2', [id, b.current_revision])).rows[0];
 const next = b.current_revision + 1;
 const recipientsList = (await db.query(`SELECT app_key FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2`, [id, b.current_revision])).rows
  .map(r => ({ appKey: r.app_key, displayName: r.app_key, state: 'ready', reason: null }));
 const content = { ...body.content, publishAt: null };
 await transaction(db, async tx => {
  const locked = await load(tx, id, true);
  if (locked.version !== body.version) fail(409, 'CONFLICT', 'This broadcast changed elsewhere. Reload it and try again.');
  await tx.query(`INSERT INTO broadcast_revisions (broadcast_id, revision, content, content_hash, targeting, reviewed_recipients, registry_revision, review_hash, publish_request_id, confirmed_by)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
   [id, next, JSON.stringify(content), sha(content), JSON.stringify(prev.targeting), JSON.stringify(recipientsList), prev.registry_revision, sha({ content, recipientsList }), body.requestId, actor.userId]);
  await tx.query(`UPDATE broadcasts SET current_revision = $2, draft = jsonb_set(draft, '{content}', $3::jsonb), version = version + 1, status = 'publishing', updated_at = now() WHERE id = $1`,
   [id, next, JSON.stringify(content)]);
  await audit(tx, actor.userId, 'revise', { broadcastId: id, revision: next }, 'succeeded', contentText(content));
 });
 await materialize(db, id, next);
 await dispatchPending(db, id);
}

/**
 * Archive: a scheduled broadcast that has not gone out is simply cancelled. A published one is archived in each app
 * that has it, version-checked: a local edit in an app is reported as a conflict, not overwritten.
 */
export async function archive(db: Pick<Pool, 'connect'> & Queryable, actor: Actor, id: string, requestId: string) {
 const b = await load(db, id);
 requireAuthor(b, actor);
 const already = (await db.query('SELECT 1 FROM broadcasts WHERE id = $1 AND archive_request_id = $2', [id, requestId])).rowCount;
 if (!already) {
  if (b.status === 'archived') fail(409, 'ARCHIVED', 'This broadcast was already archived.');
  if (b.status === 'draft') fail(409, 'NOT_PUBLISHED', 'Delete nothing: a draft was never published.');
  const open = (await db.query(`SELECT 1 FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2 AND state IN ('pending', 'uncertain')`, [id, b.current_revision])).rowCount;
  if (open) fail(409, 'DELIVERY_OPEN', 'Settle the pending or unconfirmed deliveries first.');
  await transaction(db, async tx => {
   await tx.query(`UPDATE broadcasts SET status = 'archived', archive_request_id = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, requestId]);
   // Never published (scheduled): it will not go out.
   await tx.query(`UPDATE broadcast_revisions SET materialized_at = now() WHERE broadcast_id = $1 AND materialized_at IS NULL`, [id]);
   await tx.query(`UPDATE broadcast_deliveries SET archive_state = 'pending', updated_at = now() WHERE broadcast_id = $1 AND revision = $2 AND state = 'succeeded'`, [id, b.current_revision]);
   await audit(tx, actor.userId, 'archive', { broadcastId: id, wasScheduled: b.status === 'scheduled' });
  });
 }
 const reg = (await registry()).apps;
 const rows = (await db.query(`SELECT * FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2 AND archive_state IN ('pending', 'uncertain', 'failed')`, [id, b.current_revision])).rows as DeliveryRow[];
 for (const d of rows) {
  const app = reg.find(a => a.appKey === d.app_key);
  const o = app ? await rpc(app, b.author_user_id, 'archive_announcement', { announcementId: d.tenant_announcement_id!, expectedVersion: d.tenant_version ?? 0 }, 6000) : { kind: 'not_sent' as const };
  const [state, code] = o.kind === 'ok' ? ['succeeded', null] : o.kind === 'tool_error' && o.code === 'CONFLICT' ? ['conflict', 'LOCAL_EDIT_CONFLICT']
   : o.kind === 'unknown' ? ['uncertain', o.detail.toUpperCase()] : ['failed', o.kind === 'tool_error' ? o.code : o.kind.toUpperCase()];
  await db.query(`UPDATE broadcast_deliveries SET archive_state = $4, archive_failure_code = $5, tenant_version = COALESCE($6, tenant_version), updated_at = now()
   WHERE broadcast_id = $1 AND revision = $2 AND app_key = $3`, [d.broadcast_id, d.revision, d.app_key, state, code, o.kind === 'ok' ? o.data.version : null]);
  await audit(db, b.author_user_id, 'archive_delivery', { broadcastId: id, app: d.app_key, ...(code ? { code } : {}) }, state === 'succeeded' ? 'succeeded' : state === 'uncertain' ? 'uncertain' : 'failed');
 }
}

// ── Scheduling (dispatcher) ──

/** Publish due scheduled revisions and resend deliveries left pending by a crashed process. */
export async function tick(db: Pick<Pool, 'connect'> & Queryable) {
 const due = (await db.query(`SELECT r.broadcast_id, r.revision FROM broadcast_revisions r JOIN broadcasts b ON b.id = r.broadcast_id
  WHERE r.materialized_at IS NULL AND r.publish_at <= now() AND b.status <> 'archived' ORDER BY r.publish_at LIMIT 20`)).rows;
 for (const r of due) { await materialize(db, r.broadcast_id, r.revision); await dispatchPending(db, r.broadcast_id); }
 const stale = (await db.query(`SELECT DISTINCT broadcast_id FROM broadcast_deliveries WHERE state = 'pending' AND (dispatched_at IS NULL OR dispatched_at < now() - make_interval(secs => $1)) LIMIT 20`, [REDISPATCH_SECONDS])).rows;
 for (const s of stale) await dispatchPending(db, s.broadcast_id);
}

// ── Read models ──

const BLOCK_TEXT: Record<BlockReason, string> = {
 not_registered: 'not registered', suspended: 'suspended', not_open: 'not open yet', not_connected: 'you are not connected', reconnect_required: 'reconnect required',
 missing_scope: 'your connection lacks announcement access (reconnect)', unsupported: 'the app does not support fleet announcements yet', unreachable: 'the app did not respond',
 author_not_authorized: 'the author can no longer publish',
};

export async function view(db: Queryable, id: string, viewerUserId: string | null = null): Promise<BroadcastView> {
 const b = (await db.query(`SELECT b.*, u.display_name FROM broadcasts b JOIN users u ON u.id = b.author_user_id WHERE b.id = $1`, [id])).rows[0];
 if (!b) fail(404, 'NOT_FOUND', 'This broadcast does not exist.');
 const rev = (await db.query('SELECT * FROM broadcast_revisions WHERE broadcast_id = $1 AND revision = $2', [id, b.current_revision])).rows[0];
 const names = new Map((await registry().catch(() => ({ apps: [] as RegistryApp[] }))).apps.map(a => [a.appKey, a.displayName]));
 const deliveries = (await db.query('SELECT * FROM broadcast_deliveries WHERE broadcast_id = $1 AND revision = $2 ORDER BY app_key', [id, b.current_revision])).rows as DeliveryRow[];
 const notes: string[] = [];
 if (b.status === 'scheduled' && rev) notes.push(`Scheduled for ${new Date(rev.publish_at).toUTCString()}.${(rev.targeting as Targeting).mode === 'all' ? ' Applications registered before then are included.' : ''}`);
 for (const d of deliveries) {
  const name = names.get(d.app_key) ?? d.app_key;
  if (d.state === 'blocked') notes.push(`${name}: not delivered (${BLOCK_TEXT[d.reason ?? 'not_connected']}). Fix it, then send again.`);
  if (d.state === 'uncertain') notes.push(`${name}: the application did not confirm. Check the result before doing anything else.`);
  if (d.state === 'failed') notes.push(`${name}: failed (${d.failure_code}).`);
  if (d.state === 'succeeded' && d.surfaces?.embed === 'not_installed') notes.push(`${name}: published to the portal; the in-app banner shows only once ${name} installs the banner script.`);
  if (d.archive_state === 'conflict') notes.push(`${name}: the banner was edited in the application, so it was not archived. Archive it there or reconcile.`);
 }
 return {
  id: b.id, status: b.status, author: b.display_name, createdAt: b.created_at.toISOString(), updatedAt: b.updated_at.toISOString(), version: b.version,
  revision: b.current_revision, content: rev?.content ?? b.draft.content, targeting: rev?.targeting ?? b.draft.targeting,
  canAct: viewerUserId === b.author_user_id,
  deliveries: deliveries.map(d => ({ appKey: d.app_key, displayName: names.get(d.app_key) ?? d.app_key, revision: d.revision, state: d.state, reason: d.reason, failureCode: d.failure_code,
   announcementId: d.tenant_announcement_id, surfaces: d.surfaces, archive: d.archive_state ? { state: d.archive_state, failureCode: d.archive_failure_code } : null, updatedAt: d.updated_at.toISOString() })),
  notes,
 };
}

/** Every broadcast, or only the author's own (tier-scoped authors). */
export async function list(db: Queryable, onlyAuthor: string | null = null) {
 const rows = (await db.query(`SELECT b.id, b.status, b.updated_at, b.draft, u.display_name,
   (SELECT count(*)::int FROM broadcast_deliveries d WHERE d.broadcast_id = b.id AND d.revision = b.current_revision) AS recipients,
   (SELECT count(*)::int FROM broadcast_deliveries d WHERE d.broadcast_id = b.id AND d.revision = b.current_revision AND d.state = 'succeeded') AS succeeded
  FROM broadcasts b JOIN users u ON u.id = b.author_user_id WHERE ($1::uuid IS NULL OR b.author_user_id = $1) ORDER BY b.updated_at DESC LIMIT 100`, [onlyAuthor])).rows;
 return rows.map(r => ({ id: r.id, title: r.draft.content.title, kind: r.draft.content.kind, status: r.status, author: r.display_name, updatedAt: r.updated_at.toISOString(), recipients: r.recipients, succeeded: r.succeeded }));
}
