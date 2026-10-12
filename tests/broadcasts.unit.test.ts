import { describe, expect, test } from 'vitest';
import { announcementToolArgs, announcementToolResults, broadcastDraftSchema, deliveryKey, toTenantAnnouncement, type BroadcastContent } from '../packages/contracts/src';
import { Announcements } from '../tools/mock-tenant/tenant.mts';

const content: BroadcastContent = { kind: 'info', title: 'Hello', body: null, link: null, surfaces: ['portal', 'embed'], audience: 'everyone', publishAt: null, expiresAt: null };
const hex = (c: string) => c.repeat(64);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'none'; };

describe('broadcast contracts', () => {
 test('tenant announcements carry the Everyone (authenticated) audience only', () => {
  const a = toTenantAnnouncement(content);
  expect(a.audience).toEqual({ tier: 'authenticated', segmentIds: [] });
  expect(announcementToolArgs.upsert_announcement.safeParse({ broadcastKey: 'k', payloadHash: hex('a'), announcement: { ...a, audience: { tier: 'segments', segmentIds: ['x'] } } }).success).toBe(false);
 });
 test('drafts: selected needs apps; expiry must follow publication and be in the future', () => {
  expect(broadcastDraftSchema.safeParse({ content, targeting: { mode: 'selected', apps: [] } }).success).toBe(false);
  expect(broadcastDraftSchema.safeParse({ content: { ...content, expiresAt: '2020-01-01T00:00:00Z' }, targeting: { mode: 'all' } }).success).toBe(false);
  const later = new Date(Date.now() + 3600_000).toISOString(), sooner = new Date(Date.now() + 60_000).toISOString();
  expect(broadcastDraftSchema.safeParse({ content: { ...content, publishAt: later, expiresAt: sooner }, targeting: { mode: 'all' } }).success).toBe(false);
  expect(broadcastDraftSchema.safeParse({ content: { ...content, publishAt: sooner, expiresAt: later }, targeting: { mode: 'all' } }).success).toBe(true);
 });
 test('one delivery key per broadcast, revision and app', () => {
  expect(deliveryKey('b', 2, 'hr')).toBe('resolve-broadcast:v1:b:2:hr');
  expect(new Set([deliveryKey('b', 1, 'hr'), deliveryKey('b', 2, 'hr'), deliveryKey('b', 1, 'payroll')]).size).toBe(3);
 });
});

describe('tenant announcements (target QB-ANN-1/2 semantics, mock)', () => {
 const upsert = (store: Announcements, key: string, hash: string, extra: Record<string, unknown> = {}, embed = false) =>
  announcementToolResults.upsert_announcement.parse(store.call('upsert_announcement', { broadcastKey: key, payloadHash: hash, announcement: toTenantAnnouncement(content), ...extra }, 'Bea', embed));

 test('a repeated key with the same payload replays; another payload under it is refused', () => {
  const s = new Announcements('t');
  const a = upsert(s, 'k1', hex('a'));
  const b = upsert(s, 'k1', hex('a'));
  expect(b).toMatchObject({ announcementId: a.announcementId, replayed: true });
  expect(s.dump()[0].mutations).toBe(1);
  expect(code(() => upsert(s, 'k1', hex('b')))).toBe('OPERATION_CONFLICT');
 });
 test('updates and archives are version-checked; a local edit is a conflict, never overwritten', () => {
  const s = new Announcements('t');
  const a = upsert(s, 'k1', hex('a'));
  s.localEdit(a.announcementId);
  expect(code(() => upsert(s, 'k2', hex('b'), { announcementId: a.announcementId, expectedVersion: 1 }))).toBe('CONFLICT');
  const u = upsert(s, 'k3', hex('c'), { announcementId: a.announcementId, expectedVersion: 2 });
  expect(u.version).toBe(3);
  expect(code(() => s.call('archive_announcement', { announcementId: a.announcementId, expectedVersion: 2 }, 'Bea', false))).toBe('CONFLICT');
  expect(s.call('archive_announcement', { announcementId: a.announcementId, expectedVersion: 3 }, 'Bea', false)).toMatchObject({ archived: true });
 });
 test('reconciliation by key: committed with its payload hash, or unknown', () => {
  const s = new Announcements('t');
  upsert(s, 'k1', hex('a'));
  expect(s.call('get_announcement_by_key', { broadcastKey: 'k1' }, 'Bea', false)).toMatchObject({ state: 'committed', payloadHash: hex('a') });
  expect(s.call('get_announcement_by_key', { broadcastKey: 'nope' }, 'Bea', false)).toEqual({ state: 'unknown' });
 });
 test('publication is not delivery: the in-app surface reports a missing embed script', () => {
  expect(upsert(new Announcements('t'), 'k', hex('a'), {}, false).surfaces).toEqual({ portal: 'published', embed: 'not_installed' });
  expect(upsert(new Announcements('t'), 'k', hex('a'), {}, true).surfaces).toEqual({ portal: 'published', embed: 'published' });
 });
});

describe('content only (owner decision: the fork owns presentation)', () => {
 test('the tenant contract carries content in the fork field names and refuses any presentation field', () => {
  const a = toTenantAnnouncement({ ...content, link: { url: 'https://status.corp.internal', label: 'Status' } });
  expect(a).toMatchObject({ linkUrl: 'https://status.corp.internal', linkLabel: 'Status' });
  expect(Object.keys(a).sort()).toEqual(['audience', 'body', 'expiresAt', 'kind', 'linkLabel', 'linkUrl', 'surfaces', 'title']);
  for (const extra of [{ style: 'red' }, { color: '#f00' }, { icon: 'x' }, { priority: 100 }, { className: 'big' }])
   expect(announcementToolArgs.upsert_announcement.safeParse({ broadcastKey: 'k', payloadHash: hex('a'), announcement: { ...a, ...extra } }).success, JSON.stringify(extra)).toBe(false);
 });
});
