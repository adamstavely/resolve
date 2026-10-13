import { Component, computed, DestroyRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { linkResultSchema, subjectContextSchema, type MatchedIssue, type SubjectContext, type SubjectEvent, type ThreadMessage } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { HEALTH_LABEL, ObservabilityService } from '../observability.service';
import { api, AppState, fullTime, relativeTime, send } from '../state';
import { hm, hueOf, initialsOf, SrcComponent, TierBadgeComponent, ToastService } from '../ui';

const snapshotListSchema = z.object({ snapshots: z.array(z.object({ id: z.string(), capturedAt: z.string(), classification: z.string(), noteState: z.string().nullable(), capturedBy: z.string() })) });
const SUBJECT_REASON: Record<string, (app: string) => string> = {
 verified: () => '',
 unverified: app => `${app} did not identify this customer, so only service-level context is shown.`,
 not_reported: app => `${app} does not report verified customer ids yet, so only service-level context is shown.`,
 not_mapped: app => `${app} is not connected to Elastic.`,
 policy_none: app => `${app} is set to service-level context only.`,
 unavailable: () => 'Elastic is unavailable right now. Nothing here is current.',
};
const SUBJECT_TEXT: Record<string, string> = {
 verified: 'Verified customer', unverified: 'Not identified', not_reported: 'Id not reported', not_mapped: 'No Elastic mapping', policy_none: 'Service level only', unavailable: 'Elastic unavailable',
};
type Tab = 'overview' | 'systems' | 'changes' | 'activity';
interface Step { key: string; t: string; d: string; done: boolean; action?: { label: string; run: () => void; primary?: boolean; disabled?: boolean } }
interface TimelineEntry { at: string; text: string; source: string | null; tone: string }

/**
 * Resolve context beside a case (prototype v2 `CaseView` right pane, plan 16): the customer, then tabs for Overview
 * (incident, next steps, facts), Systems (what the systems saw, is it us, log patterns), Changes and Activity.
 * Elastic facts are real; ServiceNow panels (changes, ownership, customer context, knowledge) say they are not
 * connected yet. Facts, observed correlations and coverage limits stay separate; nothing here claims a cause.
 */
@Component({
 selector: 'rs-case-context',
 imports: [IconComponent, NgTemplateOutlet, RouterLink, SrcComponent, TierBadgeComponent],
 template: `
<div class="ctx-inner" role="region" aria-label="System context">
 <div class="ctx-cust">
  <span class="avatar" aria-hidden="true" style="width:40px;height:40px;font-size:15.2px" [style.--ah]="hue()">{{ initials() }}</span>
  <div style="flex:1;min-width:200px">
   <h2 class="nm" style="margin:0">{{ customerName() }}</h2>
   <div class="insp-email">{{ ctx()?.subject?.externalId ?? 'No verified customer id' }}{{ customer().email ? ' · ' + customer().email : '' }}</div>
  </div>
  <span class="insp-status"><span class="status-dot" [attr.data-tone]="ctx()?.subject?.status === 'verified' ? 'safe' : 'neutral'" aria-hidden="true"></span> {{ subjectLabel() }}</span>
  <span class="tier-line" style="font-size:var(--fs-xs)">{{ appName() }} <rs-tier [tier]="tier()" size="sm" /></span>
  <a class="btn btn-ghost btn-sm" [routerLink]="['/apps', appKey()]">Open in {{ appName() }}<rs-icon name="chevR" [size]="14" /></a>
 </div>
 @if (ctx(); as c) {
  @if (c.subject.status !== 'verified' || c.completeness === 'partial') {
   <p class="meta" style="margin:-4px 0 0;font-size:11.5px">{{ subjectReason(c) }}@if (c.completeness === 'partial') { Partial: {{ c.missing.join(', ') }} could not be read. }</p>
  }
 }

 <div class="ctx-tabs" role="tablist" aria-label="Case context">
  @for (t of tabs(); track t.id) {
   <button class="ctx-tab" type="button" role="tab" [id]="'ctab-' + t.id" [attr.aria-selected]="tab() === t.id" [attr.aria-controls]="'cpanel-' + t.id"
    [attr.tabindex]="tab() === t.id ? 0 : -1" [attr.data-on]="tab() === t.id" (click)="tab.set(t.id)" (keydown)="tabKey($event)">
    {{ t.label }}@if (t.n !== null) { <span class="n" [attr.data-tone]="t.n > 0 ? 'sensitive' : null">{{ t.n }}</span> }
   </button>
  }
 </div>

 <div role="tabpanel" [id]="'cpanel-' + tab()" [attr.aria-labelledby]="'ctab-' + tab()" style="display:flex;flex-direction:column;gap:14px">
 @if (ctx(); as c) {
  @switch (tab()) {
   @case ('overview') {
    @if (bannerIssue(); as i) { <ng-container *ngTemplateOutlet="banner; context: { $implicit: i, label: null }" /> }
    <section class="panel" aria-labelledby="steps-title">
     <div class="ph2"><h3 class="pt2" id="steps-title" style="margin:0"><rs-icon name="check" [size]="15" /> Next steps for this {{ kind() === 'ticket' ? 'ticket' : 'chat' }}</h3><span class="lbl">checked against live health · your clearance {{ tier() ? 'T' + tier() : 'not reported' }}</span></div>
     @for (s of steps(); track s.key; let i = $index) {
      <div class="step" [attr.data-done]="s.done">
       <span class="num" aria-hidden="true">@if (s.done) { <rs-icon name="check" [size]="12" /> } @else { {{ i + 1 }} }</span>
       <div style="flex:1;min-width:0"><div class="st">{{ s.t }}@if (s.done) { <span class="sr-only"> (done)</span> }</div><div class="sd">{{ s.d }}</div></div>
       @if (s.action; as a) { <div class="sa"><button class="btn btn-sm" [class.btn-primary]="a.primary && !s.done" [class.btn-ghost]="s.done" type="button" [disabled]="s.done || a.disabled || busy()" (click)="a.run()">{{ a.label }}</button></div> }
      </div>
     }
    </section>
    <div class="facts-grid" style="margin:0;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr))">
     <div class="fact"><div class="k">Service health</div><div class="v">{{ healthText() }}</div></div>
     <div class="fact"><div class="k">Errors · 24h</div><div class="v mono" [style.color]="errorCount(c) ? 'var(--destructive-ink)' : null">{{ c.subject.status === 'verified' ? errorCount(c) : '—' }}</div></div>
     <div class="fact"><div class="k">Events · 24h</div><div class="v mono">{{ c.subject.status === 'verified' ? c.events.length : '—' }}</div></div>
     <div class="fact"><div class="k">Last session</div><div class="v">{{ c.lastSession?.region ?? '—' }}</div></div>
     <div class="fact"><div class="k">Known issues</div><div class="v mono">{{ c.matchedIssues.length }}</div></div>
    </div>
    <div class="two">
     <section class="panel" aria-labelledby="csm-title">
      <div class="ph2"><h3 class="pt2" id="csm-title" style="margin:0">Customer context</h3><rs-src k="CSM" /></div>
      <div class="pnote" style="border-bottom:0">Entitlement, contact preference, case history and satisfaction come from ServiceNow CSM, which is not connected yet.</div>
     </section>
     <section class="panel" aria-labelledby="kb-title">
      <div class="ph2"><h3 class="pt2" id="kb-title" style="margin:0"><rs-icon name="book" [size]="15" /> Suggested knowledge</h3><rs-src k="KB" /></div>
      <div class="pnote" style="border-bottom:0">Suggested articles come from ServiceNow Knowledge, which is not connected yet.</div>
     </section>
    </div>
   }
   @case ('systems') {
    @if (bannerIssue(); as i) { <ng-container *ngTemplateOutlet="banner; context: { $implicit: i, label: 'Active incident' }" /> }
    <div class="two">
     <section class="panel" aria-labelledby="saw-title">
      <div class="ph2"><h3 class="pt2" id="saw-title" style="margin:0"><rs-icon name="activity" [size]="15" /> What the systems saw</h3><span class="lbl">APM + RUM · last {{ hours }}h</span></div>
      <div class="pnote">{{ sawSummary(c) }}</div>
      @if (c.subject.status === 'verified') {
       @for (e of c.events.slice(0, 8); track $index) {
        <div class="prow">
         <span class="dot" [attr.data-tone]="eventTone(e)" style="margin-top:7px" aria-hidden="true"></span>
         <div style="flex:1;min-width:0">
          <div class="tags"><span style="font-weight:580;font-size:var(--fs-sm)">{{ eventTitle(e) }}</span><rs-src [k]="e.source" /></div>
          <div style="font-size:var(--fs-sm);color:var(--ink-2);margin-top:2px">{{ eventDetail(e) }}</div>
          <div class="meta" style="margin-top:4px">{{ e.service }} · <time [attr.datetime]="e.at" [attr.title]="fullTime(e.at)">{{ hm(e.at) }}</time>{{ matchesIssue(e) ? ' · inside a known issue window' : '' }}</div>
          @if (e.traceId) {
           <div class="tags" style="margin-top:8px;gap:10px"><span class="code" style="padding:3px 8px;font-size:11px">trace.id {{ e.traceId }}{{ e.transactionId ? ' · transaction.id ' + e.transactionId : '' }}</span>
            @if (c.kibanaTraceBase) { <a [href]="c.kibanaTraceBase + e.traceId" target="_blank" rel="noopener noreferrer" style="font-size:12px;font-weight:560">Open trace in Kibana ↗<span class="sr-only"> (opens a new tab)</span></a> }</div>
          }
         </div>
        </div>
       } @empty { <div class="prow small">No events for this customer in the window.</div> }
      }
     </section>
     <section class="panel" aria-labelledby="us-title">
      <div class="ph2"><h3 class="pt2" id="us-title" style="margin:0"><rs-icon name="globe" [size]="15" /> Is it us?</h3><rs-src k="SYNTHETICS" /></div>
      <div class="pnote">Latest check by location@if (c.lastSession; as s) { · customer's last session {{ s.region }}}</div>
      @for (m of c.synthetics; track m.monitorId + m.location) {
       <div class="prow" style="align-items:center;padding:9px var(--pad)">
        <span class="dot" [attr.data-tone]="m.status === 'up' ? 'safe' : 'destructive'" aria-hidden="true"></span>
        <div style="flex:1;min-width:0"><div style="font-weight:560;font-size:var(--fs-sm)">{{ m.name }}</div><div class="meta">{{ m.location }} · {{ relativeTime(m.checkedAt) }}</div></div>
        <span class="mono" style="font-size:12px;color:var(--ink-2)">{{ m.status === 'up' ? (m.durationMs !== null ? m.durationMs + ' ms' : 'Passing') : 'Failing' }}</span>
       </div>
      } @empty { <div class="prow small">No synthetic results in the last 15 minutes.</div> }
      @if (failingChecks(c); as f) { <div class="pfoot-warn"><b>{{ f }} failing for everyone.</b> That points to the service, not this account.</div> }
      @else if (c.synthetics.length) { <div class="pfoot-ok"><b>All checks pass.</b> The service looks healthy from the outside.</div> }
     </section>
    </div>
    @if (c.restricted) {
     <section class="panel" aria-labelledby="lp-title">
      <div class="ph2"><h3 class="pt2" id="lp-title" style="margin:0">Log patterns · {{ patternService(c) }}</h3><rs-src k="LOGS · ML" /></div>
      @if (c.patternsStatus === 'available') {
       @for (p of c.patterns; track p.jobId + p.categoryId) {
        <div class="prow" style="flex-direction:column;gap:6px">
         <div class="tags" style="gap:8px"><span class="dot" [attr.data-tone]="p.kind === 'spike' ? 'sensitive' : 'destructive'" aria-hidden="true"></span>
          <b style="font-size:var(--fs-sm)">{{ p.kind === 'spike' ? 'Spike, ' + ratio(p) + 'x normal' : p.kind === 'rare' ? 'Rare since ' + hm(p.at) : 'New since ' + hm(p.at) }}</b>
          <span class="meta">{{ p.actual }} events{{ p.kind === 'spike' ? ' · usually ' + p.typical + ' per ' + p.bucketSpan : '' }} · anomaly score {{ p.score }}</span></div>
         <div class="code">{{ p.pattern }}</div>
        </div>
       } @empty { <div class="prow small">No unusual log patterns in the last hour.</div> }
      } @else if (c.patternsStatus === 'unavailable') { <div class="prow small">Machine-learning results are unavailable right now. That is not the same as no anomalies.</div> }
      @else { <div class="prow small">No log categorization job is mapped for this application.</div> }
      <div class="prow" style="justify-content:space-between;align-items:center"><span class="meta">job {{ jobs(c) }} · last 60m · examples redacted, variable parts masked</span></div>
     </section>
     <section class="panel" aria-labelledby="ll-title">
      <div class="ph2"><h3 class="pt2" id="ll-title" style="margin:0">Log lines · {{ logService(c) }}</h3><rs-src k="LOGS" /></div>
      @for (l of c.logs; track $index) {
       <div class="prow" style="flex-direction:column;gap:6px"><div class="tags" style="gap:8px"><span class="dot" [attr.data-tone]="l.level === 'error' ? 'destructive' : 'sensitive'" aria-hidden="true"></span><b style="font-size:var(--fs-sm)">{{ l.level ?? 'log' }}</b><span class="meta">{{ hm(l.at) }}</span></div><div class="code">{{ l.message }}</div></div>
      } @empty { <div class="prow small">No log lines for this customer in the window.</div> }
      <div class="prow" style="justify-content:space-between;align-items:center"><span class="meta">filtered: service.name, user.id, last {{ hours }}h · redacted</span></div>
     </section>
    } @else {
     <div class="lockline"><rs-icon name="lock" [size]="16" /><div>Trace IDs, log patterns, log lines and Kibana links appear for investigators. A snapshot you capture keeps the facts you can see.</div></div>
    }
    <p class="meta" style="margin:0">{{ c.coverage }} Checked {{ relativeTime(c.fetchedAt) }}.</p>
   }
   @case ('changes') {
    <section class="panel" aria-labelledby="chg-title">
     <div class="ph2"><h3 class="pt2" id="chg-title" style="margin:0"><rs-icon name="branch" [size]="15" /> What changed?</h3><span class="tags"><rs-src k="CHANGE" /><rs-src k="CMDB" /></span></div>
     <div class="pnote" style="border-bottom:0">Deploys, change requests and rollbacks for the services behind {{ appName() }} come from ServiceNow, which is not connected yet.</div>
    </section>
    <section class="panel" aria-labelledby="own-title">
     <div class="ph2"><h3 class="pt2" id="own-title" style="margin:0">Ownership and on-call</h3><span class="tags"><rs-src k="CMDB" /><rs-src k="ON-CALL" /></span></div>
     <div class="pnote" style="border-bottom:0">Service ownership, on-call and the escalation path come from the ServiceNow CMDB, which is not connected yet.</div>
    </section>
   }
   @case ('activity') {
    <section aria-labelledby="act-title">
     <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <h3 id="act-title" style="margin:0;font-size:var(--fs-base);font-weight:620">Recent activity</h3>
      <div class="seg" role="group" aria-label="Timeline sources">
       <button type="button" [attr.data-on]="showSystems()" [attr.aria-pressed]="showSystems()" (click)="showSystems.set(true)">Customer + systems</button>
       <button type="button" [attr.data-on]="!showSystems()" [attr.aria-pressed]="!showSystems()" (click)="showSystems.set(false)">Customer only</button>
      </div>
     </div>
     <ol class="tl" style="list-style:none;margin:0">
      @for (e of timeline(); track $index) {
       <li class="tl-item" [attr.data-tone]="e.tone">
        <span class="knob" [style.background]="e.source ? 'var(--accent)' : null" aria-hidden="true"></span>
        <div class="tl-txt tags" style="gap:8px"><span>{{ e.text }}</span>@if (e.source) { <rs-src [k]="e.source" /> }</div>
        <div class="tl-t"><time [attr.datetime]="e.at" [attr.title]="fullTime(e.at)">{{ relativeTime(e.at) }}</time></div>
       </li>
      } @empty { <li class="tl-item"><div class="tl-txt">Nothing yet.</div></li> }
     </ol>
    </section>
   }
  }
  @if (snapshots().length && tab() !== 'changes') {
   <section class="panel" aria-labelledby="snap-title">
    <div class="ph2"><h3 class="pt2" id="snap-title" style="margin:0"><rs-icon name="layers" [size]="15" /> Evidence snapshots</h3><rs-src k="ELASTIC" /></div>
    @for (s of snapshots(); track s.id) {
     <div class="prow" style="align-items:center"><span class="dot" data-tone="sys" aria-hidden="true"></span>
      <a [routerLink]="['/evidence', s.id]" style="flex:1">{{ fullTime(s.capturedAt) }}</a><span class="meta">{{ s.capturedBy }}</span></div>
    }
   </section>
  }
 } @else { <p class="meta" role="status">{{ error() || 'Loading system context…' }}</p> }
 </div>
 <p class="sr-only" role="status">{{ message() }}</p>
</div>

<ng-template #banner let-i let-label="label">
 <section class="inc-banner" [attr.data-linked]="linked().has(i.issueId)" aria-label="Active incident">
  <span class="inc-ic" aria-hidden="true"><rs-icon [name]="linked().has(i.issueId) ? 'link' : 'alert'" [size]="17" /></span>
  <div class="inc-body">
   <div class="inc-title">
    <span>{{ linked().has(i.issueId) ? 'Linked to ' + issueName(i) + ': ' + i.title : (label ?? (i.customerErrorsInWindow ? 'Known issue affecting this customer' : 'Known issue in ' + appName())) + ': ' + i.title }}</span>
    <rs-src [k]="i.kind === 'case' ? 'CASE' : 'ALERT'" />@if (sloBurning()) { <rs-src k="SLO" /> }
   </div>
   <div class="inc-detail">{{ issueFacts(i) }}@if (i.customerErrorsInWindow) { <b> {{ i.customerErrorsInWindow }} of this customer's errors fall inside this issue's window.</b> }</div>
   <div class="meta" style="margin-top:6px">Matched: {{ i.matched.join('; ') || '—' }}@if (i.missing.length) { · not established: {{ i.missing.join('; ') }} }</div>
  </div>
  @if (kind() === 'ticket' && canLink() && !linked().has(i.issueId)) {
   <div class="inc-actions"><button class="btn btn-sm btn-primary" type="button" (click)="linkTo(i)" [disabled]="busy()"><rs-icon name="link" [size]="14" />Link to {{ issueName(i) }}</button></div>
  }
 </section>
</ng-template>`,
})
export class CaseContextComponent {
 readonly appKey = input.required<string>();
 readonly kind = input.required<'ticket' | 'conversation'>();
 readonly objectId = input.required<string>();
 readonly appName = input<string>('the application');
 readonly messages = input<ThreadMessage[]>([]);
 readonly customer = input<{ name: string | null; email: string | null }>({ name: null, email: null });
 readonly tier = input<number | null>(null);
 /** Whether the person has already replied to the customer (for next steps). */
 readonly replied = input(false);
 /** Asks the page to focus its reply box (next step "Reply to the customer"). */
 readonly reply = output<void>();
 readonly obs = inject(ObservabilityService);
 readonly state = inject(AppState);
 private readonly toast = inject(ToastService);
 readonly ctx = signal<SubjectContext | null>(null);
 readonly error = signal('');
 readonly busy = signal(false);
 readonly message = signal('');
 readonly linked = signal<ReadonlySet<string>>(new Set());
 readonly snapshots = signal<z.infer<typeof snapshotListSchema>['snapshots']>([]);
 readonly showSystems = signal(true);
 readonly tab = signal<Tab>('overview');
 readonly hours = 24;
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly hm = hm;
 private readonly base = computed(() => `/api/apps/${encodeURIComponent(this.appKey())}/${this.kind() === 'ticket' ? 'tickets' : 'conversations'}/${encodeURIComponent(this.objectId())}`);

 readonly tabs = computed(() => {
  const c = this.ctx();
  return [
   { id: 'overview' as Tab, label: 'Overview', n: null },
   { id: 'systems' as Tab, label: 'Systems', n: c && c.subject.status === 'verified' ? this.errorCount(c) : null },
   { id: 'changes' as Tab, label: 'Changes', n: null },
   { id: 'activity' as Tab, label: 'Activity', n: null },
  ];
 });
 tabKey(e: KeyboardEvent) {
  const ids = this.tabs().map(t => t.id);
  const i = ids.indexOf(this.tab());
  const next = e.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : e.key === 'ArrowLeft' ? ids[(i + ids.length - 1) % ids.length] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids.at(-1)! : null;
  if (!next) return;
  e.preventDefault(); this.tab.set(next);
  setTimeout(() => document.getElementById('ctab-' + next)?.focus());
 }

 readonly steps = computed<Step[]>(() => {
  const out: Step[] = [];
  const i = this.bannerIssue();
  if (i && this.kind() === 'ticket') {
   const issue = this.obs.issues().find(x => x.id === i.issueId);
   out.push({ key: 'link', t: `Link to ${this.issueName(i)}`, d: `The ticket shows the issue, and resolving it warns while the issue is active.${issue ? ` ${issue.linkedTickets} other tickets are linked.` : ''}`,
    done: this.linked().has(i.issueId), action: this.canLink() ? { label: this.linked().has(i.issueId) ? 'Linked' : 'Link', run: () => this.linkTo(i), primary: true } : undefined });
  }
  if (i) out.push({ key: 'msg', t: 'Send the known-issue message', d: 'Approved wording comes from the ServiceNow comms plan, which is not connected yet. Write your own reply for now.', done: false });
  out.push({ key: 'reply', t: 'Reply to the customer', d: i ? 'Tell them it is a known issue on our side, and what happens next.' : 'No system issues match this case.', done: this.replied(), action: { label: 'Write', run: () => this.reply.emit() } });
  return out;
 });

 readonly timeline = computed<TimelineEntry[]>(() => {
  const thread: TimelineEntry[] = this.messages().filter(m => !m.isInternal).map(m => ({ at: m.createdAt, text: `${m.senderType === 'visitor' ? 'Customer' : (m.authorName ?? 'Agent')}: ${m.content.slice(0, 120)}`, source: null, tone: 'neutral' }));
  const systems: TimelineEntry[] = this.showSystems() ? (this.ctx()?.events ?? []).map(e => ({ at: e.at, text: `${this.eventTitle(e)} (${this.eventDetail(e)})`, source: e.source, tone: this.eventTone(e) })) : [];
  return [...thread, ...systems].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);
 });

 constructor() {
  effect(() => {
   const base = this.base();
   untracked(() => { this.ctx.set(null); this.linked.set(new Set()); this.message.set(''); this.load(base); });
  });
  // Visible refresh every 60 seconds (plan 12 §6); hidden tabs do not poll.
  const timer = setInterval(() => { if (document.visibilityState === 'visible') this.load(this.base(), true); }, 60_000);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
 }

 load(base = this.base(), quiet = false) {
  if (!this.state.can('observability.subject')) { this.error.set('System context needs the observability subject capability.'); return; }
  api(base + '/observability', subjectContextSchema).then(c => { if (base === this.base()) { this.ctx.set(c); this.error.set(''); } })
   .catch(e => { if (!quiet) this.error.set(e.message ?? 'System context could not be loaded.'); });
  api(base + '/evidence', snapshotListSchema).then(r => { if (base === this.base()) this.snapshots.set(r.snapshots); }).catch(() => {});
 }
 customerName() { return this.customer().name ?? 'Customer'; }
 initials() { return initialsOf(this.customerName()); }
 hue() { return hueOf(this.customerName()); }
 subjectReason(c: SubjectContext) { return SUBJECT_REASON[c.subject.status]?.(this.appName()) ?? ''; }
 subjectLabel() { const s = this.ctx()?.subject?.status; return s ? SUBJECT_TEXT[s] ?? s : 'Checking…'; }
 canLink() { return this.state.can('observability.link') && this.state.can('ticket.read'); }
 issueName(i: MatchedIssue) { return i.kind === 'case' ? i.providerId : 'the known issue'; }
 /** The issue that touches this customer first, else the app's newest issue. */
 readonly bannerIssue = computed(() => { const l = this.ctx()?.matchedIssues ?? []; return l.find(i => i.customerErrorsInWindow > 0) ?? l[0] ?? null; });
 readonly appHealth = computed(() => this.obs.byApp().get(this.appKey()));
 sloBurning() { const s = this.appHealth()?.summary.slos; return !!s && (s.degrading > 0 || s.violated > 0); }
 healthText() { const h = this.appHealth(); return h ? HEALTH_LABEL[h.state] : '—'; }
 issueFacts(i: MatchedIssue) {
  const issue = this.obs.issues().find(x => x.id === i.issueId);
  const burn = this.appHealth()?.summary.slos.worstBurn;
  return [burn ? `${burn.name} (${+(burn.target * 100).toFixed(2)}%) burning ${burn.value.toFixed(1)}x over ${burn.window}.` : '',
   issue?.affected ? `About ${issue.affected.count} customers affected so far (approximate).` : ''].filter(Boolean).join(' ') || `Active since ${hm(i.since)}.`;
 }
 errorCount(c: SubjectContext) { return c.events.filter(e => e.kind === 'error' || e.outcome === 'failure').length; }
 sawSummary(c: SubjectContext) {
  if (c.subject.status !== 'verified') return 'Customer events need a verified customer id.';
  const inIssue = c.events.filter(e => this.matchesIssue(e)).length;
  return `${c.events.length} events for this customer.${inIssue ? ` ${inIssue} fall inside an active issue's window.` : ''}`;
 }
 matchesIssue(e: SubjectEvent) { return (e.kind === 'error' || e.outcome === 'failure') && (this.ctx()?.matchedIssues ?? []).some(i => Date.parse(e.at) >= Date.parse(i.since)); }
 eventTone(e: SubjectEvent) { return e.kind === 'error' || e.outcome === 'failure' ? 'destructive' : e.kind === 'page_load' && (e.durationMs ?? 0) > 4000 ? 'sensitive' : 'safe'; }
 failingChecks(c: SubjectContext) {
  const f = c.synthetics.filter(m => m.status === 'down');
  return f.length ? f.map(m => `${m.name} (${m.location})`).join(', ') + (f.length === 1 ? ' is' : ' are') : null;
 }
 patternService(c: SubjectContext) { return [...new Set(c.patterns.map(p => p.service).filter(Boolean))].join(', ') || 'mapped services'; }
 jobs(c: SubjectContext) { return [...new Set(c.patterns.map(p => p.jobId))].join(', ') || '—'; }
 logService(c: SubjectContext) { return [...new Set(c.logs.map(l => l.service).filter(Boolean))].join(', ') || 'mapped services'; }
 ratio(p: { actual: number; typical: number }) { return Math.round(p.actual / Math.max(p.typical, 1)); }
 eventTitle(e: SubjectEvent) { return e.kind === 'page_load' ? `Page load ${e.name}` : e.name; }
 eventDetail(e: SubjectEvent) {
  const parts = [e.kind === 'error' ? 'error' : e.outcome === 'failure' ? 'failed' : e.outcome === 'success' ? 'succeeded' : 'outcome unknown'];
  if (e.httpStatus) parts.push(`HTTP ${e.httpStatus}`);
  if (e.durationMs !== null) parts.push(`${e.durationMs >= 1000 ? (e.durationMs / 1000).toFixed(1) + ' s' : e.durationMs + ' ms'}`);
  if (e.region) parts.push(e.region);
  return parts.join(', ');
 }
 async linkTo(i: MatchedIssue) {
  this.busy.set(true);
  const res = await send('POST', `/api/apps/${encodeURIComponent(this.appKey())}/observability/issues/${i.issueId}/links`, { requestId: crypto.randomUUID(), ticketIds: [this.objectId()] }, linkResultSchema);
  this.busy.set(false);
  if (!res.ok) { this.message.set(res.error!.message); this.toast.show(res.error!.message); return; }
  this.linked.set(new Set([...this.linked(), i.issueId]));
  this.toast.show(`Linked this ticket to ${this.issueName(i)}`);
  void this.obs.reload();
 }
}
