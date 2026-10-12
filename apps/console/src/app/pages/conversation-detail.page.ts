import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { conversationDetailResponseSchema } from '../../../../../packages/contracts/src/index';
import { z } from 'zod';
import { IconComponent } from '../icon.component';
import { api, AppState, fullTime, relativeTime } from '../state';
import { ThreadComponent } from './thread.component';

/** The shell focuses <main> on navigation; once async content arrives, hand focus to the page heading (2.4.3). */
function focusHeadingAfterLoad() {
 setTimeout(() => { if (document.activeElement?.id === 'main') document.querySelector<HTMLElement>('main h1')?.focus(); });
}

type Detail = z.infer<typeof conversationDetailResponseSchema>['detail'];

@Component({
 selector: 'rs-conversation-detail-page',
 imports: [RouterLink, IconComponent, ThreadComponent],
 template: `
<div class="page">
 <a class="back" routerLink="/conversations"><rs-icon name="arrowL" [size]="15" />All conversations</a>
 @if (detail(); as d) {
  <header class="page-head">
   <p class="eyebrow mono">{{ state.appName(app()) }} · {{ d.conversation.id }}</p>
   <h1 class="page-title" tabindex="-1">{{ d.conversation.subject ?? 'Conversation' }}</h1>
  </header>
  <div class="detail-cols">
   <section class="card" aria-labelledby="thread-title">
    <div class="card-head"><h2 class="card-title" id="thread-title">Thread</h2><span class="card-meta">Read-only</span></div>
    <div class="pad"><rs-thread [messages]="d.messages" /></div>
   </section>
   <aside class="card" aria-labelledby="facts-title">
    <div class="card-head"><h2 class="card-title" id="facts-title">Details</h2></div>
    <dl class="facts pad">
     <div><dt>Status</dt><dd><span class="tag" [attr.data-tone]="d.conversation.status === 'open' ? 'sensitive' : d.conversation.status === 'closed' ? 'safe' : 'neutral'">{{ d.conversation.status }}</span></dd></div>
     <div><dt>Customer</dt><dd>{{ d.conversation.visitorName ?? 'Visitor' }}</dd></div>
     <div><dt>Waiting</dt><dd>@if (d.conversation.waitingSince) { <span class="tag" data-tone="destructive">Since {{ relativeTime(d.conversation.waitingSince) }}</span> } @else { — }</dd></div>
     <div><dt>Owner</dt><dd>{{ d.conversation.assigneeName ?? 'Unassigned' }}</dd></div>
     <div><dt>Team</dt><dd>{{ d.conversation.teamName ?? '—' }}</dd></div>
     <div><dt>Linked ticket</dt><dd>@if (d.conversation.linkedTicketId; as t) { <a [routerLink]="['/tickets', app(), t]" class="mono">{{ t }}</a> } @else { — }</dd></div>
     <div><dt>Started</dt><dd><time [attr.datetime]="d.conversation.createdAt">{{ fullTime(d.conversation.createdAt) }}</time></dd></div>
    </dl>
   </aside>
  </div>
 } @else if (error()) {
  <header class="page-head"><h1 class="page-title" tabindex="-1">Conversation unavailable</h1></header>
  <p class="notice" data-tone="destructive" role="alert">{{ error() }}</p>
 } @else {
  <p role="status" class="muted">Loading conversation…</p>
 }
</div>`,
})
export class ConversationDetailPage {
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
    api(`/api/apps/${encodeURIComponent(app)}/conversations/${encodeURIComponent(id)}`, conversationDetailResponseSchema)
     .then(r => this.detail.set(r.detail)).catch(e => this.error.set(e.message)).finally(() => focusHeadingAfterLoad());
   });
  });
 }
}
