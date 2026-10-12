import { Component, effect, inject, signal, untracked } from '@angular/core';
import { auditPageSchema, type AuditEvent } from '../../../../../packages/contracts/src/index';
import { api, AppState, fullTime } from '../state';

const ACTION_LABELS: Record<string, string> = {
 'session.login': 'Signed in', 'session.logout': 'Signed out', 'grant.connect': 'Connected an app', 'grant.disconnect': 'Disconnected an app',
 'user.manual_disable': 'Blocked access', 'user.manual_enable': 'Lifted an access block', 'user.directory_disable': 'Disabled by directory',
 'user.directory_enable': 'Re-enabled by directory', 'app.client_register': 'Registered an app client',
};

@Component({
 selector: 'rs-audit-page',
 template: `
<div class="page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">Audit</h1>
  <p class="lp-lede small-lede">Sign-ins, app connections and access changes, newest first. Read-only.</p>
 </header>
 @if (!state.can('audit.read') && state.session()) {
  <p class="notice" data-tone="destructive" role="alert">You do not have access to the audit log.</p>
 } @else {
  <section class="card" aria-labelledby="audit-title">
   <div class="card-head"><h2 class="card-title" id="audit-title">Events</h2><span class="card-meta">Read-only</span></div>
   <div class="pad">
    <div class="filters" role="group" aria-label="Filter audit events">
     <label for="audit-category">Activity
      <select id="audit-category" [value]="category()" (change)="setFilter('category', $any($event.target).value)">
       <option value="">All</option><option value="session">Sign-in</option><option value="grant">App connections</option><option value="user">Access changes</option>
      </select>
     </label>
     <label for="audit-outcome">Outcome
      <select id="audit-outcome" [value]="outcome()" (change)="setFilter('outcome', $any($event.target).value)">
       <option value="">All</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="denied">Denied</option>
      </select>
     </label>
    </div>
    <div class="table-wrap"><table class="data">
     <caption class="sr-only">Audit events</caption>
     <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Details</th></tr></thead>
     <tbody>
      @for (e of events(); track e.id) {
       <tr>
        <td class="mono nowrap"><time [attr.datetime]="e.at">{{ fullTime(e.at) }}</time></td>
        <td>{{ e.actor }}@if (e.actorType === 'system') { <span class="muted"> (system)</span> }</td>
        <td>{{ actionLabel(e.operation) }}</td>
        <td><span class="tag" [attr.data-tone]="tone(e.outcome)">{{ e.outcome }}</span></td>
        <td class="mono small">{{ details(e) }}</td>
       </tr>
      } @empty {
       <tr><td colspan="5" class="muted">{{ loading() ? 'Loading…' : 'No matching events.' }}</td></tr>
      }
     </tbody>
    </table></div>
    @if (cursor()) { <button class="btn btn-sm" type="button" (click)="load(true)" [disabled]="loading()">Load older events</button> }
    <p role="status" class="sr-only">{{ status() }}</p>
   </div>
  </section>
 }
</div>`,
})
export class AuditPage {
 readonly state = inject(AppState);
 readonly events = signal<AuditEvent[]>([]);
 readonly cursor = signal<string | null>(null);
 readonly loading = signal(false);
 readonly status = signal('');
 readonly category = signal('');
 readonly outcome = signal('');
 readonly fullTime = fullTime;

 constructor() {
  let started = false;
  effect(() => { if (!started && this.state.can('audit.read')) { started = true; untracked(() => this.load(false)); } });
 }

 setFilter(which: 'category' | 'outcome', value: string) { (which === 'category' ? this.category : this.outcome).set(value); this.load(false); }

 load(older: boolean) {
  const q = new URLSearchParams({ limit: '25' });
  if (this.category()) q.set('category', this.category());
  if (this.outcome()) q.set('outcome', this.outcome());
  if (older && this.cursor()) q.set('before', this.cursor()!);
  this.loading.set(true);
  api('/api/audit?' + q, auditPageSchema)
   .then(page => {
    this.events.update(prev => older ? [...prev, ...page.events] : page.events);
    this.cursor.set(page.nextCursor);
    this.status.set(`${this.events().length} audit events shown.`);
   })
   .catch(() => this.status.set('Audit events could not be loaded.'))
   .finally(() => this.loading.set(false));
 }

 actionLabel(op: string) { return ACTION_LABELS[op] ?? op; }
 tone(outcome: string) { return outcome === 'succeeded' ? 'safe' : outcome === 'pending' ? 'neutral' : outcome === 'uncertain' ? 'sensitive' : 'destructive'; }
 details(e: AuditEvent) {
  return Object.entries(e.summary).filter(([k]) => !['executor', 'userId', 'targetUserId'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · ');
 }
}
