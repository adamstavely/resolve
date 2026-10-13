import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent } from '../icon.component';

const FILTERS = [{ id: 'active', label: 'Active' }, { id: 'pending', label: 'Pending' }, { id: 'in-review', label: 'In review' }, { id: 'resolved', label: 'Resolved' }, { id: 'all', label: 'All' }];

/**
 * Escalation queue (prototype v2 `Escalations`, plan 16). The tier-escalation and approval workflow is not connected
 * yet, so the queue shows its layout with no figures rather than invented ones, and says what to do meanwhile.
 */
@Component({
 selector: 'rs-escalations-page',
 imports: [IconComponent, RouterLink],
 template: `
<div class="esc-page">
 <div class="esc-page-head">
  <div class="esc-eyebrow">Console-wide</div>
  <h1 class="esc-h1" tabindex="-1">Escalation queue</h1>
  <p class="esc-sub">Requests routed above an agent's clearance. Approve or deny the ones waiting on your tier, and track everything in flight across your applications.</p>
 </div>

 <div class="esc-stats">
  <div class="esc-stat" data-tone="sensitive"><div class="n" aria-label="not available">—</div><div class="l">Pending review</div></div>
  <div class="esc-stat" data-tone="accent"><div class="n" aria-label="not available">—</div><div class="l">In review</div></div>
  <div class="esc-stat" data-tone="destructive"><div class="n" aria-label="not available">—</div><div class="l">High priority open</div></div>
  <div class="esc-stat" data-tone="safe"><div class="n" aria-label="not available">—</div><div class="l">Resolved today</div></div>
 </div>

 <div class="esc-toolbar">
  <div class="esc-filters" role="group" aria-label="Filter escalations">
   @for (f of filters; track f.id) {
    <button class="esc-filter" type="button" [attr.data-on]="filter() === f.id" [attr.aria-pressed]="filter() === f.id" (click)="filter.set(f.id)">{{ f.label }}</button>
   }
  </div>
  <div class="esc-toolbar-meta">Not connected</div>
 </div>

 <div class="esc-list">
  <div class="esc-empty">
   <div class="big" style="background:var(--elevate-soft);color:var(--elevate)"><rs-icon name="lock" [size]="24" /></div>
   <h2 style="font-size:16px;color:var(--ink-2);margin:0 0 6px;font-weight:600">Escalations are not connected yet</h2>
   <p>Requests routed above an agent's clearance land here once the tier-escalation and approval workflow is connected. Until then, capture an evidence snapshot on the ticket and hand it over in the application. <a routerLink="/tickets">Go to My tickets</a></p>
  </div>
 </div>
</div>`,
})
export class EscalationsPage {
 readonly filters = FILTERS;
 readonly filter = signal('active');
}
