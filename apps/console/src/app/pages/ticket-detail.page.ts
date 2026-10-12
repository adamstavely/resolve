import { Component, CUSTOM_ELEMENTS_SCHEMA, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ticketDetailResponseSchema } from '../../../../../packages/contracts/src/index';
import { z } from 'zod';
import { IconComponent } from '../icon.component';
import { api, AppState, fullTime, relativeTime } from '../state';
import { ThreadComponent } from './thread.component';
import { ComposerComponent } from './composer.component';
import { SystemContextComponent } from './system-context.component';
import { PreflightDialogComponent } from './preflight-dialog.component';
import { MessageSender, postAction } from '../actions';
import { RESOLVE_ELEMENTS } from '../elements';

/** The shell focuses <main> on navigation; once async content arrives, hand focus to the page heading (2.4.3). */
function focusHeadingAfterLoad() {
 setTimeout(() => { if (document.activeElement?.id === 'main') document.querySelector<HTMLElement>('main h1')?.focus(); });
}

type Detail = z.infer<typeof ticketDetailResponseSchema>['detail'];
/** The requester's name as the thread shows it (the ticket DTO carries only their principal id). */
const requesterName = (d: Detail) => d.messages.find(m => m.senderType === 'visitor')?.authorName ?? null;

@Component({
 selector: 'rs-ticket-detail-page',
 imports: [RouterLink, IconComponent, ThreadComponent, ComposerComponent, SystemContextComponent, PreflightDialogComponent, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page">
 <a class="back" routerLink="/tickets"><rs-icon name="arrowL" [size]="15" />All tickets</a>
 @if (detail(); as d) {
  <header class="ticket-head">
   <div class="ticket-head-main">
    <p class="eyebrow mono">{{ state.appName(app()) }} · {{ d.ticket.reference }}</p>
    <h1 class="page-title" tabindex="-1">{{ d.ticket.title }}</h1>
    <p class="ticket-sub small muted">{{ customerName(d) ?? 'Unknown requester' }} · opened <time [attr.datetime]="d.ticket.createdAt" [attr.title]="fullTime(d.ticket.createdAt)">{{ relativeTime(d.ticket.createdAt) }}</time> · updated <time [attr.datetime]="d.ticket.updatedAt" [attr.title]="fullTime(d.ticket.updatedAt)">{{ relativeTime(d.ticket.updatedAt) }}</time></p>
   </div>
   @if (state.can('ticket.assign') || state.can('ticket.status')) {
    <div class="ticket-actions">
     @if (state.can('ticket.assign')) {
      @if (d.ticket.assigneeName === state.user()?.displayName) { <button class="btn btn-sm" type="button" (click)="assign('unassigned')" [disabled]="busy()">Unassign</button> }
      @else { <button class="btn btn-sm" type="button" (click)="assign('me')" [disabled]="busy()">Assign to me</button> }
     }
     @if (state.can('ticket.status')) {
      <label for="ticket-status">Change status
       <select id="ticket-status" [value]="d.ticket.status.category" (change)="requestStatus($any($event.target))">
        <option value="open">Open</option><option value="pending">Waiting on customer</option><option value="closed">Resolved</option>
       </select>
      </label>
     }
    </div>
   }
  </header>
  @if (actionMessage()) { <p class="small" [attr.role]="actionError() ? 'alert' : 'status'">{{ actionMessage() }}@if (lastOperation(); as op) {&nbsp;<a [routerLink]="['/receipts', op]">View receipt</a> }</p> }
  <section class="ticket-facts" aria-label="Details">
   <dl>
    <div><dt>Status</dt><dd><span class="tag" [attr.data-tone]="d.ticket.status.category === 'open' ? 'sensitive' : d.ticket.status.category === 'closed' ? 'safe' : 'neutral'">{{ d.ticket.status.name }}</span></dd></div>
    <div><dt>Priority</dt><dd>{{ d.ticket.priority === 'none' ? '—' : d.ticket.priority }}</dd></div>
    <div><dt>Owner</dt><dd>{{ d.ticket.assigneeName ?? 'Unassigned' }}</dd></div>
    <div><dt>Team</dt><dd>{{ d.ticket.teamName ?? '—' }}</dd></div>
    <div><dt>SLA</dt><dd>
     @if (d.ticket.slaBreachedAt) { <span class="tag" data-tone="destructive">Breached {{ relativeTime(d.ticket.slaBreachedAt) }}</span> }
     @else if (d.ticket.slaDueAt) { <time [attr.datetime]="d.ticket.slaDueAt" [attr.title]="fullTime(d.ticket.slaDueAt)">Due {{ relativeTime(d.ticket.slaDueAt) }}</time> }
     @else { — }
    </dd></div>
   </dl>
  </section>
  <section class="card ticket-thread" aria-labelledby="thread-title">
   <h2 class="sr-only" id="thread-title">Conversation</h2>
   <div class="pad"><rs-thread [messages]="d.messages" [attachmentBase]="base() + '/attachments/'" /></div>
   @if (state.can('ticket.reply') || state.can('ticket.note')) {
    <div class="pad composer-wrap">
     <rs-composer fieldId="ticket-composer" [canReply]="state.can('ticket.reply')" [canNote]="state.can('ticket.note')" [pending]="sender.pending()"
      [uploadPath]="'/api/apps/' + encode(app()) + '/uploads'" [target]="{ type: 'ticket', id: id() }"
      (send)="sender.send($event)" (retry)="sender.retry($event)" (check)="sender.check($event)" (discard)="sender.discard($event)" />
     @if (sender.lastSent(); as l) { <p class="small"><a [routerLink]="['/receipts', l.operationId]">View the receipt for your {{ l.kind }}</a></p> }
    </div>
   }
  </section>
  @if (state.can('observability.subject')) {
   <rs-system-context [appKey]="app()" kind="ticket" [objectId]="id()" [appName]="state.appName(app())" [messages]="d.messages"
    [customer]="{ name: customerName(d), email: null }" />
  }
 } @else if (error()) {
  <header class="page-head"><h1 class="page-title" tabindex="-1">Ticket unavailable</h1></header>
  <p class="notice" data-tone="destructive" role="alert">{{ error() }}</p>
 } @else {
  <p role="status" class="muted">Loading ticket…</p>
 }
 <p class="sr-only" role="status">{{ announcement() }}</p>
 @if (detail(); as d) {
  <rs-preflight-dialog #preflightRef [appKey]="app()" kind="ticket" [objectId]="id()" [customerName]="customerName(d)"
   (confirmed)="setStatus('closed', $event)" (cancelled)="cancelClose()" (diverted)="diverted($event)" />
 }
</div>`,
})
export class TicketDetailPage {
 readonly lastOperation = signal<string | null>(null);
 readonly preflight = viewChild('preflightRef', { read: PreflightDialogComponent });
 readonly customerName = requesterName;
 readonly app = input.required<string>();
 readonly id = input.required<string>();
 readonly state = inject(AppState);
 readonly detail = signal<Detail | undefined>(undefined);
 readonly error = signal('');
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly busy = signal(false);
 readonly actionMessage = signal('');
 readonly actionError = signal(false);
 readonly announcement = signal('');
 private statusSelect?: HTMLSelectElement;
 readonly encode = encodeURIComponent;
 readonly base = () => `/api/apps/${encodeURIComponent(this.app())}/tickets/${encodeURIComponent(this.id())}`;
 readonly sender = new MessageSender(() => this.base() + '/messages', () => this.load(false), t => { this.announcement.set(''); setTimeout(() => this.announcement.set(t), 50); });
 constructor() {
  effect(() => {
   void [this.app(), this.id()];
   untracked(() => { this.detail.set(undefined); this.error.set(''); this.load(true); });
  });
 }
 load(focus: boolean) {
  api(this.base(), ticketDetailResponseSchema)
   .then(r => this.detail.set(r.detail)).catch(e => this.error.set(e.message)).finally(() => { if (focus) focusHeadingAfterLoad(); });
 }
 async assign(assignee: 'me' | 'unassigned') { await this.act('/assign', { assignee, expectedVersion: this.detail()!.ticket.version }, assignee === 'me' ? 'Assigned to you.' : 'Unassigned.'); }
 /** Resolving asks for confirmation; other status changes apply directly. */
 requestStatus(select: HTMLSelectElement) {
  const value = select.value as 'open' | 'pending' | 'closed';
  if (value === 'closed') { this.statusSelect = select; void this.preflight()?.open('ticket.close'); return; }
  void this.setStatus(value);
 }
 cancelClose() { if (this.statusSelect) this.statusSelect.value = this.detail()!.ticket.status.category; }
 async setStatus(statusCategory: 'open' | 'pending' | 'closed', pre?: { preflightId: string; override?: { reason: string } }) {
  await this.act('/status', { statusCategory, expectedVersion: this.detail()!.ticket.version, ...(pre ?? {}) }, 'Status updated.');
 }
 /** Linked to the known issue instead of resolving: the ticket stays open. */
 diverted(text: string) { this.cancelClose(); this.actionError.set(false); this.actionMessage.set(text); this.lastOperation.set(null); }
 private async act(suffix: string, body: unknown, success: string) {
  this.busy.set(true);
  const r = await postAction(this.base() + suffix, body);
  this.busy.set(false);
  this.actionError.set(!r.ok); this.actionMessage.set(r.ok ? success : r.message);
  this.lastOperation.set(r.ok ? r.operation?.id ?? null : null);
  this.load(false);
 }
}
