import { Component, computed, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Location } from '@angular/common';
import { z } from 'zod';
import { activityResponseSchema, conversationDetailResponseSchema, fleetConversationsResponseSchema, targetToolResults, type ConversationActivity } from '../../../../../packages/contracts/src/index';
import { MessageSender, postAction } from '../actions';
import { RESOLVE_ELEMENTS } from '../elements';
import { IconComponent } from '../icon.component';
import { InboxService, rowFromDetail, type ConversationDetail, type MonitorApp, type QueueRow } from '../inbox.service';
import { api, AppState, fullTime, relativeTime, UNAVAILABLE_TEXT } from '../state';
import { ComposerComponent } from './composer.component';
import { ThreadComponent } from './thread.component';
import { SystemContextComponent } from './system-context.component';
import { PreflightDialogComponent } from './preflight-dialog.component';
import { RouterLink } from '@angular/router';

type Status = 'open' | 'snoozed' | 'closed' | 'all';
const pageSchema = targetToolResults.list_conversations.extend({ appKey: z.string() });
const key = (appKey: string, id: string) => `${appKey}/${id}`;
/** Viewing is refreshed while the thread is open and the page visible; the tenant expires it shortly after. */
const VIEWING_REFRESH_MS = 20_000;
const names = (list: string[]) => list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
const MONITOR_LABELS: Record<MonitorApp['state'], string> = {
 connecting: 'Connecting', live: 'Live', not_connected: 'Not connected', reconnect_required: 'Reconnect required', dormant: 'Idle', unavailable: 'Unavailable', error: 'Retrying',
};

/**
 * Inbox: every conversation you can see across applications (plan 09), with live updates for open chats.
 * Replaces the separate conversations list. `/inbox/:app/:id` opens a conversation directly.
 */
@Component({
 selector: 'rs-inbox-page',
 imports: [IconComponent, ThreadComponent, ComposerComponent, SystemContextComponent, PreflightDialogComponent, RouterLink, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page inbox-page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">Inbox</h1>
  <p class="lp-lede small-lede">Chats from your applications. Open chats update live; replies and notes go out as you, from the application's own record.</p>
 </header>

 <div class="monitor" role="group" aria-label="Monitored applications">
  @for (m of inbox.monitor(); track m.appKey) {
   <span class="monitor-chip"><span class="status-dot" [attr.data-tone]="tone(m.state)" aria-hidden="true"></span>{{ state.appName(m.appKey) }} · {{ monitorLabel(m.state) }}</span>
   @if (m.state === 'dormant') { <button class="btn btn-sm" type="button" (click)="inbox.monitorApp(m.appKey)">Monitor {{ state.appName(m.appKey) }}</button> }
  }
  @if (inbox.streamState() === 'connecting' || inbox.streamState() === 'retrying') {
   <span class="muted small">{{ inbox.streamState() === 'connecting' ? 'Connecting to live updates…' : 'Live updates paused; reconnecting…' }}</span>
  }
 </div>

 <div class="inbox">
  <section class="card queue" aria-labelledby="queue-title">
   <div class="card-head">
    <h2 class="card-title" id="queue-title"><rs-icon name="inbox" [size]="15" />Conversations</h2>
   </div>
   <div class="queue-filters" role="group" aria-label="Filter conversations">
    <label for="queue-status">Status
     <select id="queue-status" [value]="status()" (change)="setStatus($any($event.target).value)">
      <option value="open">Open</option><option value="snoozed">Snoozed</option><option value="closed">Closed</option><option value="all">All</option>
     </select>
    </label>
    <label for="queue-filter">Show
     <select id="queue-filter" [value]="filter()" (change)="filter.set($any($event.target).value)">
      <option value="all">Everyone's</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option><option value="waiting">Customer waiting</option>
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
       <span class="qi-meta">{{ r.visitorName ?? 'Visitor' }} · {{ r.assigneeName ?? 'Unassigned' }}@if (r.waitingSince) { <span class="tag" data-tone="destructive">Waiting</span> }@if (status() !== 'open') { <span class="tag">{{ r.status }}</span> }</span>
      </button>
     </li>
    } @empty { <li class="pad muted small">{{ loading() ? 'Loading conversations…' : 'No conversations match.' }}</li> }
   </ul>
   @if (moreApps().length || notes().length) {
    <div class="queue-more">
     @for (a of moreApps(); track a) {
      <button class="btn btn-sm" type="button" (click)="loadMore(a)" [disabled]="loadingMore() === a"><rs-icon name="refresh" [size]="14" />{{ loadingMore() === a ? 'Loading…' : 'Load more from ' + state.appName(a) }}</button>
     }
     @for (n of notes(); track n) { <p class="small muted">{{ n }}</p> }
    </div>
   }
  </section>

  <section class="card thread-panel" aria-labelledby="thread-panel-title">
   @if (detail(); as d) {
    <div class="card-head thread-head">
     <div class="grow">
      <p class="eyebrow mono">{{ state.appName(selected()!.appKey) }} · {{ d.conversation.visitorName ?? 'Visitor' }}@if (d.conversation.linkedTicketId) { · linked ticket }</p>
      <h2 class="card-title thread-title" id="thread-panel-title">{{ d.conversation.subject ?? 'Conversation' }}</h2>
     </div>
    </div>
    <div class="thread-actions pad-sm">
     <span class="tag" [attr.data-tone]="d.conversation.status === 'open' ? 'sensitive' : d.conversation.status === 'closed' ? 'safe' : 'neutral'">{{ d.conversation.status }}</span>
     <span class="small">Owner: {{ d.conversation.assigneeName ?? 'Unassigned' }}</span>
     @if (d.conversation.waitingSince) { <span class="tag" data-tone="destructive">Waiting since {{ relativeTime(d.conversation.waitingSince) }}</span> }
     <span class="grow"></span>
     @if (state.can('chat.assign')) {
      @if (d.conversation.assigneeName === state.user()?.displayName) { <button class="btn btn-sm" type="button" (click)="assign('unassigned')" [disabled]="busy()">Unassign</button> }
      @else { <button class="btn btn-sm" type="button" (click)="assign('me')" [disabled]="busy()">Assign to me</button> }
     }
     @if (state.can('chat.status')) {
      @if (d.conversation.status === 'closed') { <button class="btn btn-sm" type="button" (click)="changeStatus('open')" [disabled]="busy()">Reopen</button> }
      @else {
       @if (d.conversation.status === 'open') { <button class="btn btn-sm" type="button" (click)="changeStatus('snoozed')" [disabled]="busy()">Snooze</button> }
       <button class="btn btn-sm" type="button" (click)="preflight()?.open('conversation.close')" [disabled]="busy()">Close…</button>
      }
     }
     @if (state.can('chat.mark_read') && d.conversation.unread) { <button class="btn btn-sm btn-ghost" type="button" (click)="markRead()" [disabled]="busy()">Mark read for team</button> }
    </div>
    @if (actionMessage()) { <p class="pad-sm small" [attr.role]="actionError() ? 'alert' : 'status'">{{ actionMessage() }}</p> }
    <p class="pad-sm small presence-line muted" role="status" aria-live="polite">
     @if (activityText()) { @if (someoneTyping()) { <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span> }{{ activityText() }} }
    </p>
    <div class="pad thread-scroll"><rs-thread [messages]="d.messages" [attachmentBase]="base() + '/attachments/'" /></div>
    @if (state.can('chat.reply') || state.can('chat.note')) {
     <div class="pad composer-wrap">
      @for (k of [key(selected()!.appKey, selected()!.id)]; track k) {
       <rs-composer [fieldId]="'composer-' + selected()!.id" [canReply]="state.can('chat.reply')" [canNote]="state.can('chat.note')"
        [pending]="sender.pending()" [initialDraft]="drafts.get(k) ?? ''" (draftChange)="drafts.set(k, $event)"
        [uploadPath]="'/api/apps/' + encode(selected()!.appKey) + '/uploads'" [target]="{ type: 'conversation', id: selected()!.id }" (typing)="onTyping($event)"
        (send)="sender.send($event)" (retry)="sender.retry($event)" (check)="sender.check($event)" (discard)="sender.discard($event)" />
      }
      @if (sender.lastSent(); as l) { <p class="small"><a [routerLink]="['/receipts', l.operationId]">View the receipt for your {{ l.kind }}</a></p> }
     </div>
    }
   } @else if (detailError()) {
    <h2 class="sr-only" id="thread-panel-title">Conversation</h2><p class="pad notice" data-tone="destructive" role="alert">{{ detailError() }}</p>
   } @else {
    <h2 class="sr-only" id="thread-panel-title">Conversation</h2><p class="pad muted">{{ selected() ? 'Loading conversation…' : 'Choose a conversation.' }}</p>
   }
  </section>
 </div>
 @if (state.can('observability.subject') && selected() && detail(); as d) {
  <rs-system-context [appKey]="selected()!.appKey" kind="conversation" [objectId]="selected()!.id" [appName]="state.appName(selected()!.appKey)"
   [messages]="d.messages" [customer]="{ name: d.conversation.visitorName ?? null, email: d.conversation.visitorEmail ?? null }" />
 }

 @if (selected() && detail(); as d) {
  <rs-preflight-dialog #preflightRef [appKey]="selected()!.appKey" kind="conversation" [objectId]="selected()!.id" [customerName]="d.conversation.visitorName ?? null"
   (confirmed)="changeStatus('closed', $event)" (diverted)="actionError.set(false); actionMessage.set($event)" />
 }
</div>`,
})
export class InboxPage {
 /** Route parameters for `/inbox/:app/:id` (deep link to one conversation). */
 readonly app = input<string>();
 readonly id = input<string>();
 readonly state = inject(AppState);
 readonly inbox = inject(InboxService);
 private readonly location = inject(Location);
 readonly status = signal<Status>('open');
 readonly filter = signal<'all' | 'mine' | 'unassigned' | 'waiting'>('all');
 /** Snoozed/closed/all lists are read on demand (the live queue covers open chats). */
 readonly other = signal<QueueRow[]>([]);
 readonly otherCursors = signal<Record<string, string | null>>({});
 readonly otherNotes = signal<string[]>([]);
 readonly otherLoading = signal(false);
 readonly otherLoadingMore = signal<string | null>(null);
 readonly selected = signal<{ appKey: string; id: string } | undefined>(undefined);
 readonly detail = signal<ConversationDetail | undefined>(undefined);
 readonly detailError = signal('');
 readonly actionMessage = signal('');
 readonly actionError = signal(false);
 readonly busy = signal(false);
 readonly preflight = viewChild('preflightRef', { read: PreflightDialogComponent });
 readonly drafts = new Map<string, string>(); // in memory only: drafts can contain customer data (plan 09)
 readonly key = key;
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly base = () => { const s = this.selected()!; return `/api/apps/${encodeURIComponent(s.appKey)}/conversations/${encodeURIComponent(s.id)}`; };
 readonly encode = encodeURIComponent;
 /** Other staff viewing or typing, and the customer's presence, for the open conversation (from the application). */
 readonly activity = signal<ConversationActivity | undefined>(undefined);
 readonly someoneTyping = computed(() => { const a = this.activity(); return !!a && (a.visitor.typing || a.agents.some(x => x.activity === 'typing')); });
 readonly activityText = computed(() => {
  const a = this.activity(), d = this.detail();
  if (!a || !d) return '';
  const customer = d.conversation.visitorName ?? 'The customer';
  const typing = a.agents.filter(x => x.activity === 'typing').map(x => x.name);
  const viewing = a.agents.filter(x => x.activity === 'viewing').map(x => x.name);
  return [
   a.visitor.typing ? `${customer} is typing…` : a.visitor.online ? `${customer} is online` : '',
   typing.length ? `${names(typing)} ${typing.length > 1 ? 'are' : 'is'} writing a reply` : '',
   viewing.length ? `${names(viewing)} ${viewing.length > 1 ? 'are' : 'is'} viewing` : '',
  ].filter(Boolean).join(' · ');
 });
 private signalled?: { appKey: string; id: string };
 private viewingTimer?: ReturnType<typeof setInterval>;
 readonly sender = new MessageSender(() => this.base() + '/messages', () => this.refreshSelected(), t => this.inbox.announce(t));

 readonly loading = computed(() => this.status() === 'open' ? this.inbox.loading() : this.otherLoading());
 readonly loadingMore = computed(() => this.status() === 'open' ? this.inbox.loadingMore() : this.otherLoadingMore());
 readonly moreApps = computed(() => Object.entries(this.status() === 'open' ? this.inbox.cursors() : this.otherCursors()).filter(([, c]) => c).map(([a]) => a));
 readonly notes = computed(() => this.status() === 'open' ? (this.inbox.error() ? [this.inbox.error()] : []) : this.otherNotes());
 readonly visibleRows = computed(() => {
  const me = this.state.user()?.displayName;
  const f = this.filter();
  return (this.status() === 'open' ? this.inbox.rows() : this.other())
   .filter(r => f === 'all' || (f === 'mine' ? r.assigneeName === me : f === 'unassigned' ? !r.assigneeName : !!r.waitingSince))
   .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt) || a.id.localeCompare(b.id));
 });

 constructor() {
  let opened = false;
  effect(() => {
   const [app, id] = [this.app(), this.id()];
   if (!opened && app && id && this.state.can('chat.read')) { opened = true; untracked(() => this.select(app, id)); }
  });
  const offActivity = this.inbox.onActivity((appKey, itemId) => {
   const s = this.selected();
   if (s && s.appKey === appKey && s.id === itemId) this.loadActivity();
  });
  const onVisibility = () => document.visibilityState === 'visible' ? this.startViewing() : this.stopViewing();
  const onPageHide = () => this.stopViewing(true);
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', onPageHide);
  inject(DestroyRef).onDestroy(() => {
   offActivity(); this.stopViewing();
   document.removeEventListener('visibilitychange', onVisibility); removeEventListener('pagehide', onPageHide);
  });
  const off = this.inbox.onChange((appKey, detail, itemId) => {
   const s = this.selected();
   if (detail && this.status() !== 'open') this.other.update(prev => prev.map(r => r.appKey === appKey && r.id === itemId ? rowFromDetail(appKey, detail.conversation) : r));
   if (s && s.appKey === appKey && s.id === itemId) { if (detail) this.detail.set(detail); else this.detailError.set('This conversation is no longer available to you.'); }
  });
  inject(DestroyRef).onDestroy(() => off());
 }

 tone(s: MonitorApp['state']) { return s === 'live' ? 'safe' : s === 'dormant' || s === 'connecting' ? 'neutral' : s === 'unavailable' ? 'sensitive' : 'destructive'; }
 monitorLabel(s: MonitorApp['state']) { return MONITOR_LABELS[s]; }
 isSelected(r: QueueRow) { const s = this.selected(); return !!s && s.appKey === r.appKey && s.id === r.id; }

 setStatus(status: Status) {
  this.status.set(status);
  if (status !== 'open') this.loadOther();
 }

 private loadOther() {
  const q = new URLSearchParams(this.status() === 'all' ? {} : { status: this.status() });
  this.otherLoading.set(true);
  api('/api/conversations?' + q, fleetConversationsResponseSchema).then(res => {
   this.other.set(res.apps.flatMap(a => a.status === 'ok' ? a.data.conversations.map(c => ({ ...c, appKey: a.appKey })) : []));
   this.otherCursors.set(Object.fromEntries(res.apps.flatMap(a => a.status === 'ok' ? [[a.appKey, a.data.nextCursor]] : [])));
   this.otherNotes.set(res.apps.flatMap(a => a.status === 'unavailable' && a.reason !== 'suspended' ? [`${this.state.appName(a.appKey)}: ${UNAVAILABLE_TEXT[a.reason] ?? 'unavailable.'}`] : []));
  }).catch(e => this.otherNotes.set([e.message])).finally(() => this.otherLoading.set(false));
 }

 loadMore(appKey: string) {
  if (this.status() === 'open') return this.inbox.loadMore(appKey);
  const cursor = this.otherCursors()[appKey];
  if (!cursor) return;
  const q = new URLSearchParams(this.status() === 'all' ? { cursor } : { status: this.status(), cursor });
  this.otherLoadingMore.set(appKey);
  api(`/api/apps/${encodeURIComponent(appKey)}/conversations?` + q, pageSchema).then(p => {
   this.other.update(prev => [...prev, ...p.conversations.map(c => ({ ...c, appKey }))]);
   this.otherCursors.update(prev => ({ ...prev, [appKey]: p.nextCursor }));
  }).finally(() => this.otherLoadingMore.set(null));
 }

 select(appKey: string, id: string) {
  this.stopViewing();
  this.selected.set({ appKey, id }); this.detail.set(undefined); this.detailError.set(''); this.actionMessage.set('');
  this.sender.pending.set([]); this.activity.set(undefined);
  // Keep the address shareable without re-routing (which would rebuild the page).
  this.location.replaceState(`/inbox/${encodeURIComponent(appKey)}/${encodeURIComponent(id)}`);
  this.refreshSelected();
  this.startViewing();
  this.loadActivity();
 }

 // ── Viewing and typing: explicit, short-lived signals sent only while this person has the thread open ──

 private get canSignal() { return this.state.can('chat.reply') || this.state.can('chat.note'); }
 private signal(target: { appKey: string; id: string }, activity: 'viewing' | 'typing' | 'stopped', keepalive = false) {
  const path = `/api/apps/${encodeURIComponent(target.appKey)}/conversations/${encodeURIComponent(target.id)}/activity`;
  // Best effort: a lost signal simply expires at the application.
  fetch(path, { method: 'POST', credentials: 'same-origin', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity }) }).catch(() => {});
 }
 private startViewing() {
  const s = this.selected();
  if (!s || !this.canSignal || document.visibilityState !== 'visible') return;
  this.signalled = s;
  this.signal(s, 'viewing');
  clearInterval(this.viewingTimer);
  this.viewingTimer = setInterval(() => { if (this.signalled) this.signal(this.signalled, 'viewing'); }, VIEWING_REFRESH_MS);
 }
 private stopViewing(keepalive = false) {
  clearInterval(this.viewingTimer);
  if (this.signalled) { this.signal(this.signalled, 'stopped', keepalive); this.signalled = undefined; }
 }
 onTyping(typing: boolean) {
  const s = this.selected();
  if (s && this.signalled) this.signal(s, typing ? 'typing' : 'viewing');
 }
 loadActivity() {
  const s = this.selected(); if (!s) return;
  api(this.base() + '/activity', activityResponseSchema).then(r => { if (this.selected() === s) this.activity.set(r.activity); }).catch(() => this.activity.set(undefined));
 }

 refreshSelected() {
  const s = this.selected(); if (!s) return;
  api(this.base(), conversationDetailResponseSchema).then(r => {
   if (this.selected()?.id !== s.id) return;
   this.detail.set(r.detail);
   this.inbox.upsert(s.appKey, r.detail);
   if (this.status() !== 'open') this.other.update(prev => prev.map(x => x.appKey === s.appKey && x.id === s.id ? rowFromDetail(s.appKey, r.detail.conversation) : x));
  }).catch(e => this.detailError.set(e.message));
 }

 async assign(assignee: 'me' | 'unassigned') { await this.act('/assign', { assignee, expectedVersion: this.detail()!.conversation.version }, assignee === 'me' ? 'Assigned to you.' : 'Unassigned.'); }
 async changeStatus(status: 'open' | 'snoozed' | 'closed', pre?: { preflightId: string; override?: { reason: string } }) {
  await this.act('/status', { status, expectedVersion: this.detail()!.conversation.version, ...(pre ?? {}) }, status === 'closed' ? 'Conversation closed.' : status === 'snoozed' ? 'Conversation snoozed.' : 'Conversation reopened.');
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
}
