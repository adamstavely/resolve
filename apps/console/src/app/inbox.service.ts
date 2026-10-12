import { computed, Injectable, signal } from '@angular/core';
import { z } from 'zod';
import { conversationDetailResponseSchema, fleetConversationsResponseSchema, inboxEventSchema, targetToolResults, type InboxEvent } from '../../../../packages/contracts/src/index';
import { api } from './state';

export type ConversationDetail = z.infer<typeof conversationDetailResponseSchema>['detail'];
export type QueueRow = z.infer<typeof targetToolResults.list_conversations>['conversations'][number] & { appKey: string };
export type MonitorApp = Extract<InboxEvent, { type: 'monitor' }>['apps'][number];
const pageSchema = targetToolResults.list_conversations.extend({ appKey: z.string() });

export const rowFromDetail = (appKey: string, c: ConversationDetail['conversation']): QueueRow => ({
 id: c.id, status: c.status, priority: c.priority, channel: c.channel, subject: c.subject, lastMessageAt: c.lastMessageAt, visitorPrincipalId: c.visitorPrincipalId,
 assignedAgentPrincipalId: c.assignedAgentPrincipalId, assigneeName: c.assigneeName, teamName: c.teamName, waitingSince: c.waitingSince, visitorName: c.visitorName,
 unread: c.unread, version: c.version, appKey,
});

/**
 * App-wide live inbox (plan 09): one stream per signed-in agent while Resolve is open, so the Inbox count and
 * announcements stay current on every page. Holds the open queue (per-app pages) and monitor state; pages
 * subscribe to change notifications to refresh what they show. Quackback stays the source of truth.
 */
@Injectable({ providedIn: 'root' })
export class InboxService {
 readonly rows = signal<QueueRow[]>([]);
 readonly loading = signal(false);
 readonly cursors = signal<Record<string, string | null>>({});
 readonly loadingMore = signal<string | null>(null);
 readonly monitor = signal<MonitorApp[]>([]);
 readonly streamState = signal<'idle' | 'connecting' | 'open' | 'retrying'>('idle');
 readonly announcement = signal('');
 readonly error = signal('');
 /** Shared support-team unread state (owner decision), over the open conversations loaded so far. */
 readonly unreadCount = computed(() => this.rows().filter(r => r.unread).length);
 /** True when some app has more open conversations than loaded, so the count is a lower bound. */
 readonly countIsPartial = computed(() => Object.values(this.cursors()).some(Boolean));

 private include = new Set<string>();
 private source?: EventSource;
 private listeners = new Set<(appKey: string, detail: ConversationDetail | null, itemId: string) => void>();
 private activityListeners = new Set<(appKey: string, itemId: string) => void>();
 private started = false;
 appName: (appKey: string) => string = k => k;

 start() {
  if (this.started) return;
  this.started = true;
  this.load();
  this.connect();
 }

 stop() { this.source?.close(); this.started = false; this.streamState.set('idle'); }

 /** Notified with the fresh detail (or null when the item is no longer visible). */
 onChange(listener: (appKey: string, detail: ConversationDetail | null, itemId: string) => void) {
  this.listeners.add(listener);
  return () => this.listeners.delete(listener);
 }

 /** Notified when someone starts or stops viewing or typing in a conversation (re-read it only if it is open). */
 onActivity(listener: (appKey: string, itemId: string) => void) {
  this.activityListeners.add(listener);
  return () => this.activityListeners.delete(listener);
 }

 load(appKey?: string) {
  const q = new URLSearchParams({ status: 'open' });
  if (this.include.size) q.set('include', [...this.include].join(','));
  if (!appKey) this.loading.set(true);
  api('/api/conversations?' + q, fleetConversationsResponseSchema).then(res => {
   const fresh = res.apps.flatMap(a => a.status === 'ok' && (!appKey || a.appKey === appKey) ? a.data.conversations.map(c => ({ ...c, appKey: a.appKey })) : []);
   this.rows.update(prev => appKey ? [...prev.filter(r => r.appKey !== appKey), ...fresh] : fresh);
   this.cursors.update(prev => ({ ...(appKey ? prev : {}), ...Object.fromEntries(res.apps.flatMap(a => a.status === 'ok' && (!appKey || a.appKey === appKey) ? [[a.appKey, a.data.nextCursor]] : [])) }));
   this.error.set('');
  }).catch(e => this.error.set(e.message)).finally(() => this.loading.set(false));
 }

 /** Next page of one app's open conversations (per-app pagination, plan 01). */
 loadMore(appKey: string) {
  const cursor = this.cursors()[appKey];
  if (!cursor) return;
  this.loadingMore.set(appKey);
  api(`/api/apps/${encodeURIComponent(appKey)}/conversations?status=open&cursor=${encodeURIComponent(cursor)}`, pageSchema).then(p => {
   this.rows.update(prev => [...prev, ...p.conversations.filter(c => !prev.some(r => r.appKey === appKey && r.id === c.id)).map(c => ({ ...c, appKey }))]);
   this.cursors.update(prev => ({ ...prev, [appKey]: p.nextCursor }));
  }).catch(e => this.error.set(e.message)).finally(() => this.loadingMore.set(null));
 }

 /** Explicitly monitor an idle application (this starts it and keeps it warm while monitored). */
 monitorApp(appKey: string) { this.include.add(appKey); this.connect(); this.load(); }

 /** Update one row from a fresh read (after the user's own action). */
 upsert(appKey: string, detail: ConversationDetail) {
  const row = rowFromDetail(appKey, detail.conversation);
  this.rows.update(prev => [...prev.filter(x => !(x.appKey === appKey && x.id === row.id)), ...(row.status === 'open' ? [row] : [])]);
 }

 announce(text: string) { this.announcement.set(''); setTimeout(() => this.announcement.set(text), 50); }

 /** EventSource reconnects by itself and resumes from the Last-Event-ID cursors. */
 private connect() {
  this.source?.close();
  const q = this.include.size ? '?include=' + [...this.include].join(',') : '';
  const es = new EventSource('/api/inbox/stream' + q);
  this.source = es;
  this.streamState.set('connecting');
  es.onopen = () => this.streamState.set('open');
  es.onerror = () => this.streamState.set(es.readyState === EventSource.CLOSED ? 'idle' : 'retrying');
  for (const type of ['monitor', 'change', 'resync']) es.addEventListener(type, e => {
   const ev = inboxEventSchema.safeParse(JSON.parse((e as MessageEvent).data));
   if (ev.success) this.onEvent(ev.data);
  });
 }

 private onEvent(ev: InboxEvent) {
  if (ev.type === 'monitor') { this.monitor.set(ev.apps); return; }
  if (ev.type === 'resync') { this.load(ev.appKey); return; }
  if (ev.itemType !== 'conversation') return;
  if (ev.kind === 'activity') { for (const l of this.activityListeners) l(ev.appKey, ev.itemId); return; }
  api(`/api/apps/${encodeURIComponent(ev.appKey)}/conversations/${encodeURIComponent(ev.itemId)}`, conversationDetailResponseSchema).then(r => {
   const c = r.detail.conversation;
   const isNew = !this.rows().some(x => x.appKey === ev.appKey && x.id === c.id);
   this.upsert(ev.appKey, r.detail);
   const last = r.detail.messages.at(-1);
   if ((ev.kind === 'message' || ev.kind === 'created') && last?.senderType === 'visitor')
    this.announce(`${isNew ? 'New conversation' : 'New message'} from ${c.visitorName ?? 'a customer'} in ${this.appName(ev.appKey)}: ${c.subject ?? ''}`);
   for (const l of this.listeners) l(ev.appKey, r.detail, ev.itemId);
  }).catch(() => {
   // No longer visible to this user: drop it without revealing anything else.
   this.rows.update(prev => prev.filter(x => !(x.appKey === ev.appKey && x.id === ev.itemId)));
   for (const l of this.listeners) l(ev.appKey, null, ev.itemId);
  });
 }
}
