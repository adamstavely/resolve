import { Component, computed, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { conversationDetailResponseSchema, fleetConversationsResponseSchema, inboxEventSchema, type InboxEvent } from '../../../../../packages/contracts/src/index';
import { MessageSender, postAction } from '../actions';
import { RESOLVE_ELEMENTS, ResolveConfirmDialog } from '../elements';
import { IconComponent } from '../icon.component';
import { api, AppState, fullTime, relativeTime } from '../state';
import { ComposerComponent } from './composer.component';
import { ThreadComponent } from './thread.component';

type Detail = z.infer<typeof conversationDetailResponseSchema>['detail'];
type Row = z.infer<typeof fleetConversationsResponseSchema>['apps'][number] extends infer R ? R extends { status: 'ok'; data: { conversations: (infer C)[] } } ? C & { appKey: string } : never : never;
type MonitorApp = Extract<InboxEvent, { type: 'monitor' }>['apps'][number];
const key = (appKey: string, id: string) => `${appKey}/${id}`;
const MONITOR_LABELS: Record<MonitorApp['state'], string> = {
 connecting: 'Connecting', live: 'Live', not_connected: 'Not connected', reconnect_required: 'Reconnect required', dormant: 'Idle', unavailable: 'Unavailable', error: 'Retrying',
};

/** Unified live SRE inbox (plan 09). Quackback stays the source of truth; Resolve re-reads on every change. */
@Component({
 selector: 'rs-inbox-page',
 imports: [RouterLink, IconComponent, ThreadComponent, ComposerComponent, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page inbox-page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">Inbox</h1>
  <p class="lp-lede small-lede">Live chats from your applications. Replies and notes go out as you, from the application's own record.</p>
 </header>

 <div class="monitor" role="group" aria-label="Monitored applications">
  @for (m of monitor(); track m.appKey) {
   <span class="monitor-chip" [attr.data-state]="m.state"><span class="status-dot" [attr.data-tone]="tone(m.state)" aria-hidden="true"></span>{{ state.appName(m.appKey) }} · {{ monitorLabel(m.state) }}</span>
   @if (m.state === 'dormant') { <button class="btn btn-sm" type="button" (click)="monitorApp(m.appKey)">Monitor {{ state.appName(m.appKey) }}</button> }
  }
  @if (streamState() !== 'open') { <span class="muted small">{{ streamState() === 'connecting' ? 'Connecting to live updates…' : 'Live updates paused; reconnecting…' }}</span> }
 </div>
 <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>

 <div class="inbox">
  <section class="card queue" aria-labelledby="queue-title">
   <div class="card-head">
    <h2 class="card-title" id="queue-title"><rs-icon name="inbox" [size]="15" />Queue</h2>
    <label class="queue-filter" for="queue-filter"><span class="sr-only">Show</span>
     <select id="queue-filter" [value]="filter()" (change)="filter.set($any($event.target).value)">
      <option value="all">All open</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option><option value="waiting">Customer waiting</option>
     </select>
    </label>
   </div>
   <ul class="queue-list" aria-label="Conversations">
    @for (r of visibleRows(); track key(r.appKey, r.id)) {
     <li>
      <button type="button" class="queue-item" [attr.aria-current]="isSelected(r) ? 'true' : null" (click)="select(r.appKey, r.id)">
       <span class="qi-top"><span class="qi-app mono">{{ state.appName(r.appKey) }}</span>
        <time class="muted small" [attr.datetime]="r.lastMessageAt" [attr.title]="fullTime(r.lastMessageAt)">{{ relativeTime(r.lastMessageAt) }}</time></span>
       <span class="qi-subject">@if (r.unread) { <span class="unread-dot" aria-hidden="true"></span><span class="sr-only">Unread. </span> }{{ r.subject ?? 'Conversation' }}</span>
       <span class="qi-meta">{{ r.visitorName ?? 'Visitor' }} · {{ r.assigneeName ?? 'Unassigned' }}@if (r.waitingSince) { <span class="tag" data-tone="destructive">Waiting</span> }</span>
      </button>
     </li>
    } @empty { <li class="pad muted small">{{ loading() ? 'Loading conversations…' : 'No conversations match.' }}</li> }
   </ul>
   @if (queueNotes().length) { <ul class="queue-notes small muted">@for (n of queueNotes(); track n) { <li>{{ n }}</li> }</ul> }
  </section>

  <section class="card thread-panel" aria-labelledby="thread-panel-title">
   @if (detail(); as d) {
    <div class="card-head thread-head">
     <div class="grow">
      <p class="eyebrow mono">{{ state.appName(selected()!.appKey) }} · {{ d.conversation.visitorName ?? 'Visitor' }}</p>
      <h2 class="card-title thread-title" id="thread-panel-title">{{ d.conversation.subject ?? 'Conversation' }}</h2>
     </div>
     <a class="btn btn-sm btn-ghost" [routerLink]="['/conversations', selected()!.appKey, d.conversation.id]">Open page</a>
    </div>
    <div class="thread-actions pad-sm">
     <span class="tag" [attr.data-tone]="d.conversation.status === 'open' ? 'sensitive' : d.conversation.status === 'closed' ? 'safe' : 'neutral'">{{ d.conversation.status }}</span>
     <span class="small">Owner: {{ d.conversation.assigneeName ?? 'Unassigned' }}</span>
     <span class="grow"></span>
     @if (state.can('chat.assign')) {
      @if (d.conversation.assigneeName === state.user()?.displayName) { <button class="btn btn-sm" type="button" (click)="assign('unassigned')" [disabled]="busy()">Unassign</button> }
      @else { <button class="btn btn-sm" type="button" (click)="assign('me')" [disabled]="busy()">Assign to me</button> }
     }
     @if (state.can('chat.status')) {
      @if (d.conversation.status === 'closed') { <button class="btn btn-sm" type="button" (click)="setStatus('open')" [disabled]="busy()">Reopen</button> }
      @else {
       @if (d.conversation.status === 'open') { <button class="btn btn-sm" type="button" (click)="setStatus('snoozed')" [disabled]="busy()">Snooze</button> }
       <button class="btn btn-sm" type="button" (click)="closeDialog()?.show()" [disabled]="busy()">Close…</button>
      }
     }
     @if (state.can('chat.mark_read') && d.conversation.unread) { <button class="btn btn-sm btn-ghost" type="button" (click)="markRead()" [disabled]="busy()">Mark read for team</button> }
    </div>
    @if (actionMessage()) { <p class="pad-sm small" [attr.role]="actionError() ? 'alert' : 'status'">{{ actionMessage() }}</p> }
    <div class="pad thread-scroll"><rs-thread [messages]="d.messages" /></div>
    @if (state.can('chat.reply') || state.can('chat.note')) {
     <div class="pad composer-wrap">
      @for (k of [key(selected()!.appKey, selected()!.id)]; track k) {
       <rs-composer [fieldId]="'composer-' + selected()!.id" [canReply]="state.can('chat.reply')" [canNote]="state.can('chat.note')"
        [pending]="sender.pending()" [initialDraft]="drafts.get(key(selected()!.appKey, selected()!.id)) ?? ''"
        (draftChange)="drafts.set(key(selected()!.appKey, selected()!.id), $event)"
        (send)="sender.send($event)" (retry)="sender.retry($event)" (check)="sender.check($event)" (discard)="sender.discard($event)" />
      }
     </div>
    }
   } @else if (detailError()) {
    <h2 class="sr-only" id="thread-panel-title">Conversation</h2><p class="pad notice" data-tone="destructive" role="alert">{{ detailError() }}</p>
   } @else {
    <h2 class="sr-only" id="thread-panel-title">Conversation</h2><p class="pad muted">Choose a conversation from the queue.</p>
   }
  </section>
 </div>

 <resolve-confirm-dialog #closeDialogRef tone="destructive" heading="Close this conversation?"
  description="The customer's chat is marked resolved in the application. A new customer message reopens it."
  confirmLabel="Close conversation" cancelLabel="Keep open" (confirmed)="setStatus('closed')"/>
</div>`,
})
export class InboxPage {
 readonly state = inject(AppState);
 readonly rows = signal<Row[]>([]);
 readonly loading = signal(true);
 readonly queueNotes = signal<string[]>([]);
 readonly filter = signal<'all' | 'mine' | 'unassigned' | 'waiting'>('all');
 readonly monitor = signal<MonitorApp[]>([]);
 readonly streamState = signal<'connecting' | 'open' | 'retrying'>('connecting');
 readonly selected = signal<{ appKey: string; id: string } | undefined>(undefined);
 readonly detail = signal<Detail | undefined>(undefined);
 readonly detailError = signal('');
 readonly announcement = signal('');
 readonly actionMessage = signal('');
 readonly actionError = signal(false);
 readonly busy = signal(false);
 readonly closeDialog = viewChild('closeDialogRef', { read: ResolveConfirmDialog });
 readonly drafts = new Map<string, string>(); // in memory only: drafts can contain customer data (plan 09)
 readonly key = key;
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 private include = new Set<string>();
 private source?: EventSource;
 private readonly base = () => { const s = this.selected()!; return `/api/apps/${encodeURIComponent(s.appKey)}/conversations/${encodeURIComponent(s.id)}`; };
 readonly sender = new MessageSender(() => this.base() + '/messages', () => this.refreshSelected(), t => this.announce(t));

 readonly visibleRows = computed(() => {
  const me = this.state.user()?.displayName;
  const f = this.filter();
  return this.rows().filter(r => f === 'all' || (f === 'mine' ? r.assigneeName === me : f === 'unassigned' ? !r.assigneeName : !!r.waitingSince))
   .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || a.id.localeCompare(b.id));
 });

 constructor() {
  let started = false;
  effect(() => { if (!started && this.state.can('chat.read')) { started = true; untracked(() => { this.loadQueue(); this.connect(); }); } });
  inject(DestroyRef).onDestroy(() => this.source?.close());
 }

 tone(s: MonitorApp['state']) { return s === 'live' ? 'safe' : s === 'dormant' || s === 'connecting' ? 'neutral' : s === 'unavailable' ? 'sensitive' : 'destructive'; }
 monitorLabel(s: MonitorApp['state']) { return MONITOR_LABELS[s]; }
 isSelected(r: Row) { const s = this.selected(); return !!s && s.appKey === r.appKey && s.id === r.id; }

 loadQueue(appKey?: string) {
  const q = new URLSearchParams({ status: 'open' });
  if (this.include.size) q.set('include', [...this.include].join(','));
  api('/api/conversations?' + q, fleetConversationsResponseSchema).then(res => {
   const fresh = res.apps.flatMap(a => a.status === 'ok' && (!appKey || a.appKey === appKey) ? a.data.conversations.map(c => ({ ...c, appKey: a.appKey })) : []);
   this.rows.update(prev => appKey ? [...prev.filter(r => r.appKey !== appKey), ...fresh] : fresh);
   this.queueNotes.set(res.apps.flatMap(a => a.status === 'ok' && a.data.hasMore ? [`${this.state.appName(a.appKey)} has more open conversations than shown.`] : []));
  }).catch(e => this.queueNotes.set([e.message])).finally(() => this.loading.set(false));
 }

 /** Live stream: EventSource reconnects by itself and resumes from the Last-Event-ID cursors. */
 connect() {
  this.source?.close();
  const q = this.include.size ? '?include=' + [...this.include].join(',') : '';
  const es = new EventSource('/api/inbox/stream' + q);
  this.source = es;
  this.streamState.set('connecting');
  es.onopen = () => this.streamState.set('open');
  es.onerror = () => this.streamState.set('retrying');
  for (const type of ['monitor', 'change', 'resync']) es.addEventListener(type, e => {
   const ev = inboxEventSchema.safeParse(JSON.parse((e as MessageEvent).data));
   if (ev.success) this.onEvent(ev.data);
  });
 }

 monitorApp(appKey: string) { this.include.add(appKey); this.connect(); this.loadQueue(); }

 private onEvent(ev: InboxEvent) {
  if (ev.type === 'monitor') { this.monitor.set(ev.apps); return; }
  if (ev.type === 'resync') { this.loadQueue(ev.appKey); return; }
  if (ev.itemType !== 'conversation') return;
  api(`/api/apps/${encodeURIComponent(ev.appKey)}/conversations/${encodeURIComponent(ev.itemId)}`, conversationDetailResponseSchema).then(r => {
   const c = r.detail.conversation;
   const row: Row = { id: c.id, status: c.status, priority: c.priority, channel: c.channel, subject: c.subject, lastMessageAt: c.lastMessageAt, visitorPrincipalId: c.visitorPrincipalId,
    assignedAgentPrincipalId: c.assignedAgentPrincipalId, assigneeName: c.assigneeName, teamName: c.teamName, waitingSince: c.waitingSince, visitorName: c.visitorName,
    unread: c.unread, version: c.version, appKey: ev.appKey };
   const isNew = !this.rows().some(x => x.appKey === ev.appKey && x.id === c.id);
   this.rows.update(prev => [...prev.filter(x => !(x.appKey === ev.appKey && x.id === c.id)), ...(c.status === 'closed' ? [] : [row])]);
   const last = r.detail.messages.at(-1);
   if ((ev.kind === 'message' || ev.kind === 'created') && last?.senderType === 'visitor')
    this.announce(`${isNew ? 'New conversation' : 'New message'} from ${c.visitorName ?? 'a customer'} in ${this.state.appName(ev.appKey)}: ${c.subject ?? ''}`);
   const s = this.selected();
   if (s && s.appKey === ev.appKey && s.id === c.id) this.detail.set(r.detail);
  }).catch(() => {
   // No longer visible to this user: drop it from the queue without revealing anything else.
   this.rows.update(prev => prev.filter(x => !(x.appKey === ev.appKey && x.id === ev.itemId)));
  });
 }

 select(appKey: string, id: string) {
  this.selected.set({ appKey, id }); this.detail.set(undefined); this.detailError.set(''); this.actionMessage.set('');
  this.sender.pending.set([]);
  this.refreshSelected();
 }

 refreshSelected() {
  const s = this.selected(); if (!s) return;
  api(this.base(), conversationDetailResponseSchema).then(r => {
   if (this.selected()?.id !== s.id) return;
   this.detail.set(r.detail);
   const c = r.detail.conversation;
   this.rows.update(prev => prev.map(x => x.appKey === s.appKey && x.id === s.id ? { ...x, status: c.status, assigneeName: c.assigneeName, waitingSince: c.waitingSince, unread: c.unread, version: c.version, lastMessageAt: c.lastMessageAt } : x));
  }).catch(e => this.detailError.set(e.message));
 }

 async assign(assignee: 'me' | 'unassigned') { await this.act('/assign', { assignee, expectedVersion: this.detail()!.conversation.version }, assignee === 'me' ? 'Assigned to you.' : 'Unassigned.'); }
 async setStatus(status: 'open' | 'snoozed' | 'closed') {
  await this.act('/status', { status, expectedVersion: this.detail()!.conversation.version }, status === 'closed' ? 'Conversation closed.' : status === 'snoozed' ? 'Conversation snoozed.' : 'Conversation reopened.');
 }
 async markRead() { await this.act('/read', {}, 'Marked read for your team.'); }

 private async act(suffix: string, body: unknown, success: string) {
  this.busy.set(true);
  const r = await postAction(this.base() + suffix, body);
  this.busy.set(false);
  this.actionError.set(!r.ok);
  this.actionMessage.set(r.ok ? success : r.message);
  if (r.ok || r.operation?.next === 'refresh_and_retry') this.refreshSelected();
 }

 private announce(text: string) { this.announcement.set(''); setTimeout(() => this.announcement.set(text), 50); }
}
