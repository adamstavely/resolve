import { computed, inject, Injectable, signal } from '@angular/core';
import { z } from 'zod';
import { fleetTicketsResponseSchema, targetToolResults, type TicketSummary } from '../../../../packages/contracts/src/index';
import { InboxService, type QueueRow } from './inbox.service';
import { api, AppState, UNAVAILABLE_TEXT } from './state';

/** One row of "My tickets" (prototype `CaseInbox`): a Quackback ticket (email) or chat conversation. */
export interface WorkItem {
 kind: 'ticket' | 'conversation';
 appKey: string;
 id: string;
 /** Ticket reference, or the conversation's short id. */
 ref: string;
 subject: string;
 customer: string | null;
 channel: 'chat' | 'email';
 /** When the customer started waiting for a reply (chats), else null. */
 waitingSince: string | null;
 priority: string;
 state: string;
 updatedAt: string;
 assigneeName: string | null;
 version?: number;
}
export type WorkScope = 'mine' | 'unassigned' | 'all';

const STATE_TEXT: Record<string, string> = { open: 'Open', pending: 'Waiting on customer', snoozed: 'Snoozed', closed: 'Resolved' };
export const PRIORITY_CODE: Record<string, string> = { urgent: 'P1', high: 'P2', medium: 'P3', low: 'P4', none: '—' };
export const PRIORITY_TEXT: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };
/** A short, readable chat reference: the last part of the application's id. */
export const chatRef = (id: string) => id.split(/[_-]/).filter(Boolean).at(-1)?.toUpperCase().slice(0, 12) ?? id;
const ticketRow = (appKey: string, t: TicketSummary): WorkItem => ({
 kind: 'ticket', appKey, id: t.id, ref: t.reference, subject: t.title, customer: null, channel: 'email', waitingSince: null,
 priority: t.priority, state: t.status || STATE_TEXT[t.statusCategory], updatedAt: t.updatedAt, assigneeName: t.assigneeName,
});
const chatRow = (r: QueueRow): WorkItem => ({
 kind: 'conversation', appKey: r.appKey, id: r.id, ref: chatRef(r.id), subject: r.subject ?? 'Conversation', customer: r.visitorName, channel: 'chat',
 waitingSince: r.waitingSince, priority: r.priority, state: STATE_TEXT[r.status] ?? r.status, updatedAt: r.lastMessageAt, assigneeName: r.assigneeName, version: r.version,
});

/**
 * Tickets for "My tickets", the Home panel, the nav count and each application's "Your open tickets", plus the live
 * open chats (from the inbox stream) for search. Open and waiting tickets are read per scope on demand. Quackback
 * stays the source of truth: nothing here is cached beyond the session.
 */
@Injectable({ providedIn: 'root' })
export class WorkService {
 private readonly state = inject(AppState);
 private readonly inbox = inject(InboxService);
 readonly scope = signal<WorkScope>('mine');
 readonly tickets = signal<WorkItem[]>([]);
 readonly ticketsLoading = signal(false);
 readonly notes = signal<string[]>([]);
 /** Idle applications: not read until the person asks (loading starts them). */
 readonly dormant = signal<string[]>([]);
 /** Per application and status, the cursor for the next page (plan 01: pagination is per application). */
 readonly cursors = signal<Record<string, string | null>>({});
 readonly loadingMore = signal<string | null>(null);
 readonly moreApps = computed(() => [...new Set(Object.entries(this.cursors()).filter(([, c]) => c).map(([k]) => k.split('|')[0]))]);
 private readonly include = new Set<string>();
 private loadedScope: WorkScope | null = null;

 private readonly me = computed(() => this.state.user()?.displayName ?? null);
 private inScope(i: WorkItem, scope: WorkScope) { return scope === 'all' || (scope === 'mine' ? !!i.assigneeName && i.assigneeName === this.me() : !i.assigneeName); }

 /** Open chats (the Inbox, live from the stream), for search and each application's "Your open tickets". */
 readonly chats = computed(() => this.inbox.rows().map(chatRow));
 /** My tickets (owner decision 2026-10-12: tickets only; chats live in the Inbox), most recently updated first. */
 readonly items = computed(() => [...this.tickets()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
 /** Your open and waiting tickets (the nav count). */
 readonly mine = signal<number | null>(null);

 setScope(scope: WorkScope) { this.scope.set(scope); this.loadTickets(true); }

 /** Open and waiting tickets for the scope ("all" means everything open you can see). */
 loadTickets(force = false) {
  if (!this.state.can('ticket.read')) { this.tickets.set([]); return; }
  const scope = this.scope();
  if (!force && this.loadedScope === scope) return;
  this.loadedScope = scope;
  this.ticketsLoading.set(true);
  const q = (status: string) => new URLSearchParams({ statusCategory: status, ...this.filter(scope), ...(this.include.size ? { include: [...this.include].join(',') } : {}) });
  Promise.all(['open', 'pending'].map(s => api('/api/tickets?' + q(s), fleetTicketsResponseSchema).then(r => ({ s, r })))).then(results => {
   if (this.scope() !== scope) return;
   const rows: WorkItem[] = []; const notes = new Set<string>(); const dormant = new Set<string>(); const cursors: Record<string, string | null> = {};
   for (const { s: status, r } of results) for (const a of r.apps) {
    if (a.status === 'ok') { rows.push(...a.data.tickets.map(t => ticketRow(a.appKey, t))); cursors[`${a.appKey}|${status}`] = a.data.nextCursor; }
    else if (a.reason === 'dormant') dormant.add(a.appKey);
    else if (a.reason !== 'suspended') notes.add(`${this.state.appName(a.appKey)}: ${UNAVAILABLE_TEXT[a.reason] ?? 'unavailable.'}`);
   }
   this.tickets.set(rows); this.notes.set([...notes]); this.dormant.set([...dormant]); this.cursors.set(cursors);
   if (scope === 'mine') this.mine.set(rows.length);
  }).catch(e => this.notes.set([e.message])).finally(() => this.ticketsLoading.set(false));
 }

 private filter(scope: WorkScope): Record<string, string> { return scope === 'all' ? {} : { assignee: scope === 'mine' ? 'me' : 'unassigned' }; }

 /** Explicit request: read an idle application, which starts it. */
 wake(appKey: string) { this.include.add(appKey); this.loadTickets(true); }

 /** The next page from one application, for each status that has more. */
 async loadMore(appKey: string) {
  const scope = this.scope();
  this.loadingMore.set(appKey);
  const page = targetToolResults.list_tickets.extend({ appKey: z.string() });
  try {
   for (const status of ['open', 'pending']) {
    const cursor = this.cursors()[`${appKey}|${status}`];
    if (!cursor) continue;
    const p = await api(`/api/apps/${encodeURIComponent(appKey)}/tickets?` + new URLSearchParams({ statusCategory: status, cursor, ...this.filter(scope) }), page);
    if (this.scope() !== scope) return;
    this.tickets.update(prev => [...prev, ...p.tickets.map(t => ticketRow(appKey, t))]);
    this.cursors.update(prev => ({ ...prev, [`${appKey}|${status}`]: p.nextCursor }));
   }
  } catch (e) { this.notes.update(n => [...n, (e as Error).message]); }
  finally { this.loadingMore.set(null); }
 }

 /** After an action on one item, re-read so lists stay true to the application. */
 refresh() { this.loadTickets(true); }
}
