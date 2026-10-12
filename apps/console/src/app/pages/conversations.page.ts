import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { fleetConversationsResponseSchema, targetToolResults } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { AppState, fullTime, relativeTime } from '../state';
import { FleetList } from './fleet-list';

const pageSchema = targetToolResults.list_conversations.extend({ appKey: z.string() });
type ConversationRow = z.infer<typeof targetToolResults.list_conversations>['conversations'][number];

@Component({
 selector: 'rs-conversations-page',
 imports: [RouterLink, IconComponent],
 template: `
<div class="page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">Conversations</h1>
  <p class="lp-lede small-lede">Chats you can see in each connected application. Read-only; replying from Resolve arrives with the live inbox.</p>
 </header>
 <div class="filters" role="group" aria-label="Filter conversations">
  <label for="c-status">Status
   <select id="c-status" [value]="status()" (change)="status.set($any($event.target).value); reload()">
    <option value="open">Open</option><option value="snoozed">Snoozed</option><option value="closed">Closed</option><option value="">All</option>
   </select>
  </label>
  <p role="status" class="muted small">{{ list.loading() ? 'Loading conversations…' : summary() }}</p>
 </div>
 @if (list.error()) { <p class="notice" data-tone="destructive" role="alert">{{ list.error() }}</p> }

 @for (s of list.sections(); track s.appKey) {
  <section class="card app-section" [attr.aria-labelledby]="'sec-' + s.appKey">
   <div class="card-head">
    <h2 class="card-title" [id]="'sec-' + s.appKey"><span class="app-glyph" aria-hidden="true">{{ state.appName(s.appKey).charAt(0) }}</span>{{ state.appName(s.appKey) }}</h2>
    @if (!s.unavailable) { <span class="card-meta">{{ s.rows.length }} shown{{ s.nextCursor ? ' · more available' : '' }}</span> }
   </div>
   @if (s.unavailable) {
    <div class="pad row"><p class="muted small grow">{{ s.unavailable }}</p>
     @if (s.dormant) { <button class="btn btn-sm" type="button" (click)="list.wake(s.appKey, filters())">Load {{ state.appName(s.appKey) }}</button> }
    </div>
   } @else if (!s.rows.length) {
    <p class="pad muted small">No matching conversations.</p>
   } @else {
    <div class="table-wrap"><table class="data">
     <caption class="sr-only">Conversations in {{ state.appName(s.appKey) }}</caption>
     <thead><tr><th scope="col">Conversation</th><th scope="col">Status</th><th scope="col">Waiting</th><th scope="col">Owner</th><th scope="col">Last message</th></tr></thead>
     <tbody>
      @for (c of s.rows; track c.id) {
       <tr>
        <td><a class="row-link" [routerLink]="['/conversations', s.appKey, c.id]">{{ c.subject ?? 'Conversation' }}</a><span class="muted small block">{{ c.visitorName ?? 'Visitor' }}</span></td>
        <td><span class="tag" [attr.data-tone]="c.status === 'open' ? 'sensitive' : c.status === 'closed' ? 'safe' : 'neutral'">{{ cap(c.status) }}</span></td>
        <td class="nowrap">@if (c.waitingSince) { <span class="tag" data-tone="destructive">Customer waiting</span> } @else { <span class="muted">—</span> }</td>
        <td>{{ c.assigneeName ?? (c.teamName ? c.teamName + ' team' : 'Unassigned') }}</td>
        <td class="nowrap"><time [attr.datetime]="c.lastMessageAt" [attr.title]="fullTime(c.lastMessageAt)">{{ relativeTime(c.lastMessageAt) }}</time></td>
       </tr>
      }
     </tbody>
    </table></div>
    @if (s.nextCursor) {
     <div class="pad-sm"><button class="btn btn-sm" type="button" (click)="list.more(s.appKey, filters())" [disabled]="s.loadingMore">
      <rs-icon name="refresh" [size]="14" />{{ s.loadingMore ? 'Loading…' : 'Load more from ' + state.appName(s.appKey) }}</button></div>
    }
    @if (s.error) { <p class="pad-sm small" role="alert">{{ s.error }}</p> }
   }
  </section>
 }
</div>`,
})
export class ConversationsPage {
 readonly state = inject(AppState);
 readonly status = signal('open');
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly list = new FleetList<ConversationRow>('conversations', q => '/api/conversations?' + q, (app, q) => `/api/apps/${app}/conversations?` + q, fleetConversationsResponseSchema, pageSchema);

 constructor() {
  let started = false;
  effect(() => { if (!started && this.state.can('chat.read')) { started = true; untracked(() => this.reload()); } });
 }
 filters() { return { status: this.status() }; }
 reload() { this.list.load(this.filters()); }
 summary() {
  const ok = this.list.sections().filter(s => !s.unavailable);
  return `${ok.reduce((n, s) => n + s.rows.length, 0)} conversations shown from ${ok.length} of ${this.list.sections().length} applications.`;
 }
 cap(s: string) { return s[0].toUpperCase() + s.slice(1); }
}
