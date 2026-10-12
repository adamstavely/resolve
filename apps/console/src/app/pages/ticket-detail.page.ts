import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ticketDetailResponseSchema } from '../../../../../packages/contracts/src/index';
import { z } from 'zod';
import { IconComponent } from '../icon.component';
import { api, AppState, fullTime, relativeTime } from '../state';
import { ThreadComponent } from './thread.component';

/** The shell focuses <main> on navigation; once async content arrives, hand focus to the page heading (2.4.3). */
function focusHeadingAfterLoad() {
 setTimeout(() => { if (document.activeElement?.id === 'main') document.querySelector<HTMLElement>('main h1')?.focus(); });
}

type Detail = z.infer<typeof ticketDetailResponseSchema>['detail'];

@Component({
 selector: 'rs-ticket-detail-page',
 imports: [RouterLink, IconComponent, ThreadComponent],
 template: `
<div class="page">
 <a class="back" routerLink="/tickets"><rs-icon name="arrowL" [size]="15" />All tickets</a>
 @if (detail(); as d) {
  <header class="page-head">
   <p class="eyebrow mono">{{ state.appName(app()) }} · {{ d.ticket.reference }}</p>
   <h1 class="page-title" tabindex="-1">{{ d.ticket.title }}</h1>
  </header>
  <div class="detail-cols">
   <section class="card" aria-labelledby="thread-title">
    <div class="card-head"><h2 class="card-title" id="thread-title">Thread</h2><span class="card-meta">Read-only</span></div>
    <div class="pad"><rs-thread [messages]="d.messages" /></div>
   </section>
   <aside class="card" aria-labelledby="facts-title">
    <div class="card-head"><h2 class="card-title" id="facts-title">Details</h2></div>
    <dl class="facts pad">
     <div><dt>Status</dt><dd><span class="tag" [attr.data-tone]="d.ticket.status.category === 'open' ? 'sensitive' : d.ticket.status.category === 'closed' ? 'safe' : 'neutral'">{{ d.ticket.status.name }}</span></dd></div>
     <div><dt>Priority</dt><dd>{{ d.ticket.priority === 'none' ? '—' : d.ticket.priority }}</dd></div>
     <div><dt>Owner</dt><dd>{{ d.ticket.assigneeName ?? 'Unassigned' }}</dd></div>
     <div><dt>Team</dt><dd>{{ d.ticket.teamName ?? '—' }}</dd></div>
     <div><dt>SLA</dt><dd>
      @if (d.ticket.slaBreachedAt) { <span class="tag" data-tone="destructive">Breached {{ relativeTime(d.ticket.slaBreachedAt) }}</span> }
      @else if (d.ticket.slaDueAt) { <time [attr.datetime]="d.ticket.slaDueAt" [attr.title]="fullTime(d.ticket.slaDueAt)">Due {{ relativeTime(d.ticket.slaDueAt) }}</time> }
      @else { — }
     </dd></div>
     <div><dt>Created</dt><dd><time [attr.datetime]="d.ticket.createdAt">{{ fullTime(d.ticket.createdAt) }}</time></dd></div>
     <div><dt>Updated</dt><dd><time [attr.datetime]="d.ticket.updatedAt">{{ fullTime(d.ticket.updatedAt) }}</time></dd></div>
    </dl>
   </aside>
  </div>
 } @else if (error()) {
  <header class="page-head"><h1 class="page-title" tabindex="-1">Ticket unavailable</h1></header>
  <p class="notice" data-tone="destructive" role="alert">{{ error() }}</p>
 } @else {
  <p role="status" class="muted">Loading ticket…</p>
 }
</div>`,
})
export class TicketDetailPage {
 readonly app = input.required<string>();
 readonly id = input.required<string>();
 readonly state = inject(AppState);
 readonly detail = signal<Detail | undefined>(undefined);
 readonly error = signal('');
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 constructor() {
  effect(() => {
   const [app, id] = [this.app(), this.id()];
   untracked(() => {
    this.detail.set(undefined); this.error.set('');
    api(`/api/apps/${encodeURIComponent(app)}/tickets/${encodeURIComponent(id)}`, ticketDetailResponseSchema)
     .then(r => this.detail.set(r.detail)).catch(e => this.error.set(e.message)).finally(() => focusHeadingAfterLoad());
   });
  });
 }
}
