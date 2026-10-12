import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { fleetTicketsResponseSchema, targetToolResults, type TicketSummary } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { AppState, fullTime, relativeTime } from '../state';
import { FleetList } from './fleet-list';

const pageSchema = targetToolResults.list_tickets.extend({ appKey: z.string() });

@Component({
 selector: 'rs-tickets-page',
 imports: [RouterLink, IconComponent],
 template: `
<div class="page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">Tickets</h1>
  <p class="lp-lede small-lede">Tickets you can see in each connected application, grouped by application. Read-only for now.</p>
 </header>
 <div class="filters" role="group" aria-label="Filter tickets">
  <label for="t-status">Status
   <select id="t-status" [value]="status()" (change)="status.set($any($event.target).value); reload()">
    <option value="open">Open</option><option value="pending">Waiting</option><option value="closed">Closed</option><option value="">All</option>
   </select>
  </label>
  <label for="t-assignee">Assignee
   <select id="t-assignee" [value]="assignee()" (change)="assignee.set($any($event.target).value); reload()">
    <option value="">Anyone</option><option value="me">Assigned to me</option><option value="unassigned">Unassigned</option>
   </select>
  </label>
  <p role="status" class="muted small">{{ list.loading() ? 'Loading tickets…' : summary() }}</p>
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
    <p class="pad muted small">No matching tickets.</p>
   } @else {
    <div class="table-wrap"><table class="data">
     <caption class="sr-only">Tickets in {{ state.appName(s.appKey) }}</caption>
     <thead><tr><th scope="col">Ticket</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Owner</th><th scope="col">Updated</th></tr></thead>
     <tbody>
      @for (t of s.rows; track t.id) {
       <tr>
        <td><a class="row-link" [routerLink]="['/tickets', s.appKey, t.id]"><span class="mono ref">{{ t.reference }}</span> {{ t.title }}</a></td>
        <td><span class="tag" [attr.data-tone]="statusTone(t.statusCategory)">{{ t.status }}</span></td>
        <td>{{ priority(t.priority) }}</td>
        <td>{{ t.assigneeName ?? (t.teamName ? t.teamName + ' team' : 'Unassigned') }}</td>
        <td class="nowrap"><time [attr.datetime]="t.updatedAt" [attr.title]="fullTime(t.updatedAt)">{{ relativeTime(t.updatedAt) }}</time></td>
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
export class TicketsPage {
 readonly state = inject(AppState);
 readonly status = signal('open');
 readonly assignee = signal('');
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly list = new FleetList<TicketSummary>('tickets', q => '/api/tickets?' + q, (app, q) => `/api/apps/${app}/tickets?` + q, fleetTicketsResponseSchema, pageSchema);

 constructor() {
  let started = false;
  effect(() => { if (!started && this.state.can('ticket.read')) { started = true; untracked(() => this.reload()); } });
 }
 filters() { return { statusCategory: this.status(), assignee: this.assignee() }; }
 reload() { this.list.load(this.filters()); }
 summary() {
  const ok = this.list.sections().filter(s => !s.unavailable);
  return `${ok.reduce((n, s) => n + s.rows.length, 0)} tickets shown from ${ok.length} of ${this.list.sections().length} applications.`;
 }
 statusTone(c: string) { return c === 'open' ? 'sensitive' : c === 'closed' ? 'safe' : 'neutral'; }
 priority(p: string) { return p === 'none' ? '—' : p[0].toUpperCase() + p.slice(1); }
}
