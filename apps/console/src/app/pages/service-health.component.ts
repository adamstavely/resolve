import { Component, computed, inject, input, signal } from '@angular/core';
import { linkCandidatesSchema, linkResultSchema, type KnownIssue, type LinkCandidate } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { ObservabilityService } from '../observability.service';
import { api, AppState, fullTime, relativeTime, send } from '../state';

/**
 * Known issues (plan 14, E1): active Elastic alerts and open cases. Affected counts are approximate counts of
 * instrumented customers. Linking tickets needs a person to choose each one; nothing is pre-selected without
 * evidence Resolve can check.
 */
@Component({
 selector: 'rs-known-issues',
 imports: [IconComponent],
 template: `
<section class="card" aria-labelledby="issues-title">
 <div class="card-head"><h2 class="card-title" id="issues-title"><rs-icon name="alert" [size]="15" />Known issues</h2><span class="card-meta">Elastic alerts and cases</span></div>
 <ol class="feed">
  @for (i of issues(); track i.id) {
   <li class="issue">
    <div class="grow">
     <p class="feed-meta mono">{{ name(i.appKey) }} · since <time [attr.datetime]="i.since" [attr.title]="fullTime(i.since)">{{ relativeTime(i.since) }}</time> · {{ i.kind === 'case' ? 'Case' : 'Alert' }} {{ i.providerId }}</p>
     <p class="issue-title">{{ i.title }}</p>
     <p class="feed-meta">
      @if (i.affected; as a) { <span>About {{ a.count }} affected customers</span><span class="muted"> (approximate; instrumented customers with errors since it began)</span> · }
      <span>{{ i.linkedTickets }} linked {{ i.linkedTickets === 1 ? 'ticket' : 'tickets' }}</span>
     </p>
     @if (canLink()) {
      <button class="btn btn-sm" type="button" (click)="toggle(i)" [attr.aria-expanded]="reviewing()?.id === i.id" [attr.aria-controls]="'link-' + i.id">Link tickets…<span class="sr-only"> to {{ i.title }}</span></button>
     }
     @if (reviewing()?.id === i.id) {
      <div class="link-review" [id]="'link-' + i.id" role="group" [attr.aria-label]="'Link tickets to ' + i.title">
       @if (candidates(); as list) {
        <p class="muted small">{{ coverage() }}</p>
        <fieldset class="candidate-list"><legend class="sr-only">Tickets</legend>
         @for (c of list; track c.ticketId) {
          <label class="candidate">
           <input type="checkbox" [checked]="chosen().has(c.ticketId) || c.linked" [disabled]="c.linked || busy()" (change)="choose(c, $any($event.target).checked)">
           <span><b>{{ c.reference }}</b> {{ c.title }}
            <span class="muted small"> · {{ c.linked ? 'already linked' : c.matched.join(', ') }}</span></span>
          </label>
         } @empty { <p class="muted small">No open ticket changed while this issue was active.</p> }
        </fieldset>
        <div class="row">
         <button class="btn btn-sm btn-primary" type="button" (click)="link(i)" [disabled]="busy() || !chosen().size">Link {{ chosen().size }} {{ chosen().size === 1 ? 'ticket' : 'tickets' }}</button>
         <button class="btn btn-sm btn-ghost" type="button" (click)="reviewing.set(null)">Cancel</button>
        </div>
       } @else { <p class="muted small" role="status">{{ reviewError() || 'Loading your tickets…' }}</p> }
      </div>
     }
    </div>
   </li>
  } @empty { <li class="muted small">{{ obs.loaded() ? 'No known issues right now.' : 'Loading…' }}</li> }
 </ol>
 <p class="sr-only" role="status" aria-live="polite">{{ result() }}</p>
 @if (result()) { <p class="pad small" [attr.data-tone]="resultError() ? 'destructive' : null">{{ result() }}</p> }
</section>`,
})
export class KnownIssuesComponent {
 readonly obs = inject(ObservabilityService);
 readonly state = inject(AppState);
 /** On an application's page, only that application's issues. */
 readonly appKey = input<string | null>(null);
 readonly issues = computed(() => { const k = this.appKey(); return k ? this.obs.issues().filter(i => i.appKey === k) : this.obs.issues(); });
 readonly reviewing = signal<KnownIssue | null>(null);
 readonly candidates = signal<LinkCandidate[] | null>(null);
 readonly coverage = signal('');
 readonly chosen = signal<ReadonlySet<string>>(new Set());
 readonly reviewError = signal('');
 readonly result = signal('');
 readonly resultError = signal(false);
 readonly busy = signal(false);
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 private requestId = crypto.randomUUID();
 canLink() { return this.state.can('observability.link') && this.state.can('ticket.read'); }
 name(appKey: string) { return this.state.appName(appKey); }

 toggle(i: KnownIssue) {
  if (this.reviewing()?.id === i.id) { this.reviewing.set(null); return; }
  this.reviewing.set(i); this.candidates.set(null); this.chosen.set(new Set()); this.reviewError.set(''); this.result.set('');
  this.requestId = crypto.randomUUID();
  api(`/api/apps/${encodeURIComponent(i.appKey)}/observability/issues/${i.id}/candidates`, linkCandidatesSchema)
   .then(r => { this.candidates.set(r.candidates); this.coverage.set(r.coverage); this.chosen.set(new Set(r.candidates.filter(c => c.suggested && !c.linked).map(c => c.ticketId))); })
   .catch(e => this.reviewError.set(e.message ?? 'Your tickets could not be loaded.'));
 }
 choose(c: LinkCandidate, on: boolean) {
  const next = new Set(this.chosen());
  if (on) next.add(c.ticketId); else next.delete(c.ticketId);
  this.chosen.set(next);
 }
 async link(i: KnownIssue) {
  this.busy.set(true);
  const res = await send('POST', `/api/apps/${encodeURIComponent(i.appKey)}/observability/issues/${i.id}/links`, { requestId: this.requestId, ticketIds: [...this.chosen()] }, linkResultSchema);
  this.busy.set(false);
  this.resultError.set(!res.ok);
  if (!res.ok) { this.result.set(res.error!.message); return; }
  const d = res.data!;
  this.result.set(`Linked ${d.linked.length} ${d.linked.length === 1 ? 'ticket' : 'tickets'} to ${i.title}.${d.refused.length ? ` ${d.refused.length} could not be linked: you cannot see them in ${this.name(i.appKey)}.` : ''}`);
  this.reviewing.set(null);
  void this.obs.reload();
 }
}
