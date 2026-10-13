import { Component, computed, effect, inject, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '../icon.component';
import { AppState, fullTime, relativeTime } from '../state';
import { hm, when } from '../ui';
import { PRIORITY_CODE, PRIORITY_TEXT, WorkService, type WorkScope } from '../work.service';


/**
 * My tickets (prototype v2 `CaseInbox`, plan 16): Quackback tickets, opening in the case workspace. Defaults to tickets
 * assigned to you; unassigned and all open tickets are one click away. Chats are in the Inbox (owner decision).
 */
@Component({
 selector: 'rs-my-tickets-page',
 imports: [RouterLink, IconComponent],
 template: `
<div class="cases-page">
 <div class="esc-eyebrow">Live from your applications</div>
 <h1 class="esc-h1" tabindex="-1">My tickets</h1>
 <p class="esc-sub">Tickets assigned to you. Each one opens next to the customer's account, live system health, and the tools you can run. Chats are in the <a routerLink="/inbox">Inbox</a>.</p>

 <div class="esc-toolbar" style="margin-top:20px;margin-bottom:0">
  <div class="esc-filters" role="group" aria-label="Show">
   @for (f of scopes; track f.id) {
    <button class="esc-filter" type="button" [attr.data-on]="work.scope() === f.id" [attr.aria-pressed]="work.scope() === f.id" (click)="work.setScope(f.id)">{{ f.label }}</button>
   }
  </div>
  <div class="esc-toolbar-meta" role="status">{{ loading() ? 'Loading…' : work.items().length + (work.items().length === 1 ? ' item' : ' items') }}</div>
 </div>
 @if (work.dormant().length) {
  <div class="tags" style="margin-top:12px;gap:8px">
   @for (a of work.dormant(); track a) { <button class="btn btn-sm" type="button" (click)="work.wake(a)">Load {{ state.appName(a) }} tickets</button> }
   <span class="meta">Idle applications are not read until you load them. Loading starts the application.</span>
  </div>
 }

 <div class="case-list stagger">
  @for (c of work.items(); track c.kind + c.appKey + c.id) {
   <a class="case-row" [routerLink]="[c.kind === 'ticket' ? '/tickets' : '/inbox', c.appKey, c.id]">
    <span class="ch-ic" aria-hidden="true"><rs-icon name="mail" [size]="17" /></span>
    <div style="min-width:0">
     <div class="subj">{{ c.subject }}</div>
     <div class="sub">
      <span class="mono">{{ c.ref }}</span>
      @if (c.customer) { <span>·</span><span>{{ c.customer }}</span> }
      <span>·</span><span>{{ state.appName(c.appKey) }}</span>
      @if (work.scope() !== 'mine') { <span>·</span><span>{{ c.assigneeName ?? 'Unassigned' }}</span> }
     </div>
    </div>
    <div class="right">
     <div class="tags"><span class="prio" [attr.data-p]="code(c.priority)" [attr.title]="text(c.priority) + ' priority'">{{ code(c.priority) }}</span>
      @if (c.waitingSince) { <span class="waiting">waiting {{ waited(c.waitingSince) }}</span> }
      @else { <span class="meta"><time [attr.datetime]="c.updatedAt" [attr.title]="fullTime(c.updatedAt)">{{ when(c.updatedAt) }}</time></span> }</div>
     <span class="meta">{{ c.state }}</span>
    </div>
   </a>
  } @empty {
   <div class="esc-empty">
    <div class="big"><rs-icon name="check" [size]="24" /></div>
    <h3>{{ loading() ? 'Loading…' : 'Nothing here' }}</h3>
    <p>{{ work.scope() === 'mine' ? 'No tickets are assigned to you. Unassigned tickets are one filter away.' : 'No open tickets match.' }}</p>
   </div>
  }
 </div>
 @if (work.moreApps().length) {
  <div class="tags" style="margin-top:12px;gap:8px">
   @for (a of work.moreApps(); track a) {
    <button class="btn btn-sm" type="button" (click)="work.loadMore(a)" [disabled]="work.loadingMore() === a"><rs-icon name="refresh" [size]="14" />{{ work.loadingMore() === a ? 'Loading…' : 'Load more from ' + state.appName(a) }}</button>
   }
  </div>
 }
 @for (n of notes(); track n) { <p class="meta" style="margin-top:10px">{{ n }}</p> }
</div>`,
})
export class MyTicketsPage {
 readonly state = inject(AppState);
 readonly work = inject(WorkService);
 readonly scopes: { id: WorkScope; label: string }[] = [{ id: 'mine', label: 'Assigned to me' }, { id: 'unassigned', label: 'Unassigned' }, { id: 'all', label: 'All open' }];
 readonly loading = computed(() => this.work.ticketsLoading());
 readonly notes = computed(() => this.work.notes());
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly hm = hm;
 readonly when = when;
 constructor() {
  let started = false;
  effect(() => { if (!started && this.state.signedIn()) { started = true; untracked(() => this.work.loadTickets()); } });
 }
 code(p: string) { return PRIORITY_CODE[p] ?? 'P4'; }
 text(p: string) { return PRIORITY_TEXT[p] ?? p; }
 waited(since: string) { const m = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }
}
