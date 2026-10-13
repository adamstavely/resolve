import { Component, computed, effect, ElementRef, inject, Injectable, input, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { z } from 'zod';
import { issueSubscriptionListSchema, linkCandidatesSchema, linkResultSchema, type KnownIssue, type LinkCandidate } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { ObservabilityService } from '../observability.service';
import { api, AppState, fullTime, send } from '../state';
import { hm, SrcComponent, ToastService } from '../ui';

/** The known issue whose bulk-link dialog is open (prototype `LinkIncidentModal`), shared by every page that offers it. */
@Injectable({ providedIn: 'root' })
export class IssueLinkService {
 readonly issue = signal<KnownIssue | null>(null);
 private readonly toast = inject(ToastService);
 open(i: KnownIssue) { this.issue.set(i); }
 close() { this.issue.set(null); }
 /** "Copy customer message": approved wording comes from a ServiceNow comms plan, which is not connected yet. */
 copyMessage(_i: KnownIssue) { this.toast.show('Approved customer messages come from ServiceNow, which is not connected yet.'); }
}

/**
 * Known issues (prototype `KnownIssues` panel; plan 14 E1): active Elastic alerts and open cases, with copy-message
 * and bulk-link actions. Affected counts are approximate counts of instrumented customers. Issues the person asked to
 * hear about that have since cleared are shown first.
 */
@Component({
 selector: 'rs-known-issues',
 imports: [IconComponent, RouterLink, SrcComponent],
 template: `
<section class="panel" aria-labelledby="kn-title">
 <div class="ph2"><h2 class="pt2" id="kn-title"><rs-icon name="alert" [size]="15" />Known issues</h2><rs-src k="ALERTS + CASES" /></div>
 @for (c of cleared(); track c.id) {
  <div class="kn-issue" role="status">
   <div class="tags" style="gap:8px"><span class="dot" data-tone="safe"></span><span class="lbl" style="font-size:10px">{{ name(c.appKey) }} · cleared</span></div>
   <div class="ti">Cleared: {{ c.title }}.</div>
   <div class="st"><span>You asked to be told. Nothing was re-run;
    @if (c.objectKind && c.objectId) { <a [routerLink]="c.objectKind === 'ticket' ? ['/tickets', c.appKey, c.objectId] : ['/inbox', c.appKey, c.objectId]">come back to the {{ c.objectKind }}</a> } @else { check your items }.</span></div>
   <div class="comp-row"><button class="btn btn-sm btn-ghost" type="button" (click)="acknowledge(c.id)">Dismiss<span class="sr-only"> the notice for {{ c.title }}</span></button></div>
  </div>
 }
 @for (i of issues(); track i.id) {
  <div class="kn-issue">
   <div class="tags" style="gap:8px"><span class="dot" data-tone="sensitive"></span><span class="lbl" style="font-size:10px">{{ name(i.appKey) }} · since <time [attr.datetime]="i.since" [attr.title]="fullTime(i.since)">{{ hm(i.since) }}</time></span></div>
   <div class="ti">{{ i.title }}</div>
   <div class="st">
    <span>@if (i.affected; as a) { <b>{{ a.count }}</b> affected<span class="sr-only"> (approximate)</span> } @else { <b>—</b> affected }</span>
    <span><b>{{ i.linkedTickets }}</b> linked tickets</span>
    <span class="mono">{{ i.kind === 'case' ? i.providerId : 'alert' }}</span>
   </div>
   <div class="comp-row">
    <button class="btn btn-sm" type="button" (click)="links.copyMessage(i)"><rs-icon name="copy" [size]="14" />Copy customer message</button>
    @if (canLink()) { <button class="btn btn-sm" type="button" (click)="links.open(i)"><rs-icon name="link" [size]="14" />Bulk-link tickets<span class="sr-only"> to {{ i.title }}</span></button> }
   </div>
  </div>
 } @empty { <div class="kn-issue"><span class="st">{{ obs.loaded() ? 'No known issues right now.' : 'Loading…' }}</span></div> }
</section>`,
})
export class KnownIssuesComponent {
 readonly obs = inject(ObservabilityService);
 readonly state = inject(AppState);
 readonly links = inject(IssueLinkService);
 /** On an application's page, only that application's issues. */
 readonly appKey = input<string | null>(null);
 readonly issues = computed(() => { const k = this.appKey(); return k ? this.obs.issues().filter(i => i.appKey === k) : this.obs.issues(); });
 readonly subscriptions = signal<z.infer<typeof issueSubscriptionListSchema>['subscriptions']>([]);
 readonly cleared = computed(() => this.subscriptions().filter(s => s.cleared && (!this.appKey() || s.appKey === this.appKey())));
 readonly fullTime = fullTime;
 readonly hm = hm;
 constructor() {
  effect(() => { void this.obs.issues(); untracked(() => api('/api/observability/subscriptions', issueSubscriptionListSchema).then(r => this.subscriptions.set(r.subscriptions)).catch(() => {})); });
 }
 canLink() { return this.state.can('observability.link') && this.state.can('ticket.read'); }
 name(appKey: string) { return this.state.appName(appKey); }
 async acknowledge(id: string) {
  await send('POST', `/api/observability/subscriptions/${id}/acknowledge`, {});
  this.subscriptions.update(l => l.filter(s => s.id !== id));
 }
}

/**
 * Link tickets to a known issue (prototype `LinkIncidentModal`). Candidates are open tickets the application changed
 * while the issue was active; the matching evidence is shown per row and only evidence-backed rows start selected.
 * The approved customer message and parent-incident write-back need ServiceNow, which is not connected yet.
 */
@Component({
 selector: 'rs-link-issue-modal',
 imports: [IconComponent, SrcComponent],
 template: `
@if (links.issue(); as inc) {
 <div class="modal-scrim" (click)="close()">
  <div #dlg class="modal" role="dialog" aria-modal="true" aria-labelledby="li-title" tabindex="-1" (click)="$event.stopPropagation()" (keydown.escape)="close()">
   <div class="modal-head">
    <div style="flex:1">
     <div class="tags" style="gap:8px"><rs-src [k]="inc.kind === 'case' ? 'CASE' : 'ALERT'" /><span class="meta" style="font-size:12px">{{ inc.providerId }}</span></div>
     <h2 id="li-title" style="font-size:20px;font-weight:650;letter-spacing:-0.02em;margin-top:6px">Link tickets to: {{ inc.title }}</h2>
     <div style="font-size:var(--fs-sm);color:var(--ink-3);margin-top:4px">{{ state.appName(inc.appKey) }} · since {{ hm(inc.since) }}@if (inc.service) { · service <span class="mono">{{ inc.service }}</span> }</div>
    </div>
    <button class="icon-btn" type="button" (click)="close()" aria-label="Close"><rs-icon name="x" [size]="18" /></button>
   </div>
   <div style="display:flex;flex-wrap:wrap">
    <div style="flex:1.3 1 460px;padding:16px 22px;border-right:1px solid var(--border)">
     <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><span style="font-weight:620">Matching open tickets</span><span class="meta" style="font-size:12px">{{ chosen().size }} of {{ (candidates() ?? []).length }} selected</span></div>
     <div style="font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:8px">{{ coverage() || 'Matched on customer errors in the issue window (Elastic) and open tickets changed while it was active.' }}</div>
     @if (candidates(); as list) {
      <fieldset style="border:0;margin:0;padding:0"><legend class="sr-only">Tickets to link</legend>
       @for (t of list; track t.ticketId) {
        <label class="lrow">
         <input type="checkbox" [checked]="chosen().has(t.ticketId) || t.linked" [disabled]="t.linked || busy()" (change)="toggle(t, $any($event.target).checked)">
         <span class="mono" style="width:88px;flex:none;color:var(--ink-2)">{{ t.reference }}</span>
         <span style="flex:1;min-width:0">{{ t.title }}</span>
         <span class="why">{{ t.linked ? 'already linked' : t.matched.join(', ') || 'changed in window' }}</span>
        </label>
       } @empty { <p class="small muted">No open ticket changed while this issue was active.</p> }
      </fieldset>
     } @else { <p class="small muted" role="status">{{ error() || 'Loading tickets…' }}</p> }
    </div>
    <div style="flex:1 1 340px;padding:16px 22px;display:flex;flex-direction:column;gap:16px">
     <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-weight:620">Customer message</span><rs-src k="COMMS PLAN" /></div>
      <div class="msgbox">Approved customer wording comes from the ServiceNow comms plan, which is not connected yet. Linking does not message customers.</div>
     </div>
     <div>
      <div style="font-weight:620;margin-bottom:8px">What happens next</div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:var(--fs-sm);color:var(--ink-2)">
       <div style="display:flex;gap:10px"><span class="mono" style="color:var(--ink-3);width:16px">1</span>Each ticket is linked to this issue in Resolve and shows it.</div>
       <div style="display:flex;gap:10px"><span class="mono" style="color:var(--ink-3);width:16px">2</span>Closing a linked ticket warns while the issue is still active.</div>
       <div style="display:flex;gap:10px"><span class="mono" style="color:var(--ink-3);width:16px">3</span>Nothing closes automatically when the issue clears; each ticket stays with its owner.</div>
      </div>
     </div>
    </div>
   </div>
   <div class="modal-foot">
    <span class="audit-note" style="flex:1">Recorded in the Resolve audit as {{ state.user()?.displayName }}</span>
    @if (result()) { <span class="small" role="alert">{{ result() }}</span> }
    <button class="btn btn-outline" type="button" (click)="close()">Cancel</button>
    <button class="btn btn-primary" type="button" [disabled]="!chosen().size || busy()" (click)="link(inc)">Link {{ chosen().size }} {{ chosen().size === 1 ? 'ticket' : 'tickets' }}</button>
   </div>
  </div>
 </div>
}`,
})
export class LinkIssueModalComponent {
 readonly links = inject(IssueLinkService);
 readonly state = inject(AppState);
 private readonly obs = inject(ObservabilityService);
 private readonly toast = inject(ToastService);
 readonly candidates = signal<LinkCandidate[] | null>(null);
 readonly coverage = signal('');
 readonly chosen = signal<ReadonlySet<string>>(new Set());
 readonly error = signal('');
 readonly result = signal('');
 readonly busy = signal(false);
 readonly hm = hm;
 private readonly dlg = viewChild<ElementRef<HTMLElement>>('dlg');
 private opener: HTMLElement | null = null;
 private requestId = crypto.randomUUID();

 constructor() {
  effect(() => {
   const i = this.links.issue();
   untracked(() => {
    if (!i) return;
    this.opener = document.activeElement as HTMLElement | null;
    this.candidates.set(null); this.chosen.set(new Set()); this.error.set(''); this.result.set(''); this.requestId = crypto.randomUUID();
    setTimeout(() => this.dlg()?.nativeElement.focus());
    api(`/api/apps/${encodeURIComponent(i.appKey)}/observability/issues/${i.id}/candidates`, linkCandidatesSchema)
     .then(r => { this.candidates.set(r.candidates); this.coverage.set(r.coverage); this.chosen.set(new Set(r.candidates.filter(c => c.suggested && !c.linked).map(c => c.ticketId))); })
     .catch(e => this.error.set(e.message ?? 'Tickets could not be loaded.'));
   });
  });
 }
 toggle(c: LinkCandidate, on: boolean) {
  const next = new Set(this.chosen());
  if (on) next.add(c.ticketId); else next.delete(c.ticketId);
  this.chosen.set(next);
 }
 close() { this.links.close(); setTimeout(() => this.opener?.focus()); }
 async link(i: KnownIssue) {
  this.busy.set(true);
  const res = await send('POST', `/api/apps/${encodeURIComponent(i.appKey)}/observability/issues/${i.id}/links`, { requestId: this.requestId, ticketIds: [...this.chosen()] }, linkResultSchema);
  this.busy.set(false);
  if (!res.ok) { this.result.set(res.error!.message); return; }
  const d = res.data!;
  this.toast.show(`Linked ${d.linked.length} ${d.linked.length === 1 ? 'ticket' : 'tickets'} to ${i.title}${d.refused.length ? ` · ${d.refused.length} not visible to you` : ''}`);
  void this.obs.reload();
  this.close();
 }
}
