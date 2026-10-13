import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { fleetConversationsResponseSchema, targetToolResults } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { InboxService, type MonitorApp, type QueueRow } from '../inbox.service';
import { api, AppState, fullTime, UNAVAILABLE_TEXT } from '../state';
import { when } from '../ui';
import { chatRef, PRIORITY_CODE, PRIORITY_TEXT } from '../work.service';

type Status = 'open' | 'snoozed' | 'closed' | 'all';
type Show = 'all' | 'mine' | 'unassigned' | 'waiting';
const pageSchema = targetToolResults.list_conversations.extend({ appKey: z.string() });
const MONITOR_LABELS: Record<MonitorApp['state'], string> = {
 connecting: 'Connecting', live: 'Live', not_connected: 'Not connected', reconnect_required: 'Reconnect required', dormant: 'Idle', unavailable: 'Unavailable', error: 'Retrying',
};
const STATE_TEXT: Record<string, string> = { open: 'Open', snoozed: 'Snoozed', closed: 'Closed' };

/**
 * Inbox (plan 09; owner decision 2026-10-12 to keep it beside My tickets): every chat you can see across applications,
 * open chats live from the stream, in the prototype's list style. Each chat opens in the case workspace.
 */
@Component({
 selector: 'rs-inbox-page',
 imports: [RouterLink, IconComponent],
 template: `
<div class="cases-page">
 <div class="esc-eyebrow">Live from your applications</div>
 <h1 class="esc-h1" tabindex="-1">Inbox</h1>
 <p class="esc-sub">Chats from your applications. Open chats update live; replies and notes go out as you, from the application's own record.</p>

 <div class="esc-toolbar" style="margin-top:20px;margin-bottom:0">
  <div class="tags" style="gap:10px">
   <div class="esc-filters" role="group" aria-label="Show">
    @for (f of shows; track f.id) {
     <button class="esc-filter" type="button" [attr.data-on]="show() === f.id" [attr.aria-pressed]="show() === f.id" (click)="show.set(f.id)">{{ f.label }}</button>
    }
   </div>
   <div class="esc-filters" role="group" aria-label="Status">
    @for (f of statuses; track f.id) {
     <button class="esc-filter" type="button" [attr.data-on]="status() === f.id" [attr.aria-pressed]="status() === f.id" (click)="setStatus(f.id)">{{ f.label }}</button>
    }
   </div>
  </div>
  <div class="esc-toolbar-meta" role="status">{{ loading() ? 'Loading…' : rows().length + (rows().length === 1 ? ' chat' : ' chats') }}</div>
 </div>

 <div class="tags" role="group" aria-label="Monitored applications" style="margin-top:12px;gap:8px">
  @for (m of inbox.monitor(); track m.appKey) {
   <span class="pillx"><span class="status-dot" [attr.data-tone]="tone(m.state)" aria-hidden="true"></span>{{ state.appName(m.appKey) }} · {{ monitorLabel(m.state) }}</span>
   @if (m.state === 'dormant') { <button class="btn btn-sm" type="button" (click)="inbox.monitorApp(m.appKey)">Monitor {{ state.appName(m.appKey) }}</button> }
  }
  @if (inbox.streamState() === 'connecting' || inbox.streamState() === 'retrying') {
   <span class="meta">{{ inbox.streamState() === 'connecting' ? 'Connecting to live updates…' : 'Live updates paused; reconnecting…' }}</span>
  }
 </div>

 <div class="case-list stagger">
  @for (c of rows(); track c.appKey + '/' + c.id) {
   <a class="case-row" [routerLink]="['/inbox', c.appKey, c.id]">
    <span class="ch-ic" aria-hidden="true"><rs-icon name="chat" [size]="17" />@if (c.status === 'open') { <span class="live"></span> }</span>
    <div style="min-width:0">
     <div class="subj">@if (c.unread) { <span class="sr-only">Unread. </span> }{{ c.subject ?? 'Conversation' }}</div>
     <div class="sub">
      <span class="mono">{{ ref(c.id) }}</span><span>·</span><span>{{ c.visitorName ?? 'Visitor' }}</span><span>·</span><span>{{ state.appName(c.appKey) }}</span>
      <span>·</span><span>{{ c.assigneeName ?? 'Unassigned' }}</span>
      @if (c.unread) { <span class="src">UNREAD</span> }
     </div>
    </div>
    <div class="right">
     <div class="tags"><span class="prio" [attr.data-p]="code(c.priority)" [attr.title]="ptext(c.priority) + ' priority'">{{ code(c.priority) }}</span>
      @if (c.waitingSince) { <span class="waiting">waiting {{ waited(c.waitingSince) }}</span> }
      @else { <span class="meta"><time [attr.datetime]="c.lastMessageAt" [attr.title]="fullTime(c.lastMessageAt)">{{ when(c.lastMessageAt) }}</time></span> }</div>
     <span class="meta">{{ stateText(c.status) }}</span>
    </div>
   </a>
  } @empty {
   <div class="esc-empty">
    <div class="big"><rs-icon name="check" [size]="24" /></div>
    <h2 style="font-size:16px;color:var(--ink-2);margin:0 0 6px;font-weight:600">{{ loading() ? 'Loading…' : 'No chats here' }}</h2>
    <p>{{ loading() ? '' : 'No conversations match these filters.' }}</p>
   </div>
  }
 </div>
 @if (moreApps().length) {
  <div class="tags" style="margin-top:12px;gap:8px">
   @for (a of moreApps(); track a) {
    <button class="btn btn-sm" type="button" (click)="loadMore(a)" [disabled]="loadingMore() === a"><rs-icon name="refresh" [size]="14" />{{ loadingMore() === a ? 'Loading…' : 'Load more from ' + state.appName(a) }}</button>
   }
  </div>
 }
 @for (n of notes(); track n) { <p class="meta" style="margin-top:10px">{{ n }}</p> }
</div>`,
})
export class InboxPage {
 readonly state = inject(AppState);
 readonly inbox = inject(InboxService);
 readonly shows: { id: Show; label: string }[] = [{ id: 'all', label: "Everyone's" }, { id: 'mine', label: 'Assigned to me' }, { id: 'unassigned', label: 'Unassigned' }, { id: 'waiting', label: 'Customer waiting' }];
 readonly statuses: { id: Status; label: string }[] = [{ id: 'open', label: 'Open' }, { id: 'snoozed', label: 'Snoozed' }, { id: 'closed', label: 'Closed' }, { id: 'all', label: 'All' }];
 readonly status = signal<Status>('open');
 readonly show = signal<Show>('all');
 /** Snoozed, closed and all are read on demand (the live queue covers open chats). */
 readonly other = signal<QueueRow[]>([]);
 readonly otherCursors = signal<Record<string, string | null>>({});
 readonly otherNotes = signal<string[]>([]);
 readonly otherLoading = signal(false);
 readonly otherLoadingMore = signal<string | null>(null);
 readonly fullTime = fullTime;
 readonly when = when;
 readonly ref = chatRef;
 readonly loading = computed(() => this.status() === 'open' ? this.inbox.loading() : this.otherLoading());
 readonly loadingMore = computed(() => this.status() === 'open' ? this.inbox.loadingMore() : this.otherLoadingMore());
 readonly moreApps = computed(() => Object.entries(this.status() === 'open' ? this.inbox.cursors() : this.otherCursors()).filter(([, c]) => c).map(([a]) => a));
 readonly notes = computed(() => this.status() === 'open' ? (this.inbox.error() ? [this.inbox.error()] : []) : this.otherNotes());
 /** Customers waiting first, then the most recent message. */
 readonly rows = computed(() => {
  const me = this.state.user()?.displayName;
  const f = this.show();
  return (this.status() === 'open' ? this.inbox.rows() : this.other())
   .filter(r => f === 'all' || (f === 'mine' ? r.assigneeName === me : f === 'unassigned' ? !r.assigneeName : !!r.waitingSince))
   .sort((a, b) => (b.waitingSince ? 1 : 0) - (a.waitingSince ? 1 : 0) || b.lastMessageAt.localeCompare(a.lastMessageAt) || a.id.localeCompare(b.id));
 });

 constructor() {
  // Closed or snoozed lists follow live changes too.
  effect(() => { void this.inbox.rows(); if (this.status() !== 'open') untracked(() => this.loadOther(true)); });
 }
 tone(s: MonitorApp['state']) { return s === 'live' ? 'safe' : s === 'dormant' || s === 'connecting' ? 'neutral' : s === 'unavailable' ? 'sensitive' : 'destructive'; }
 monitorLabel(s: MonitorApp['state']) { return MONITOR_LABELS[s]; }
 code(p: string) { return PRIORITY_CODE[p] ?? '—'; }
 ptext(p: string) { return PRIORITY_TEXT[p] ?? p; }
 stateText(s: string) { return STATE_TEXT[s] ?? s; }
 waited(since: string) { const m = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }

 setStatus(status: Status) { this.status.set(status); if (status !== 'open') this.loadOther(); }
 private loadOther(quiet = false) {
  const q = new URLSearchParams(this.status() === 'all' ? {} : { status: this.status() });
  if (!quiet) this.otherLoading.set(true);
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
}
