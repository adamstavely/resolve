import { Component, computed, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { evidenceSnapshotSchema, linkResultSchema, subjectContextSchema, type MatchedIssue, type SubjectContext, type SubjectEvent } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { HEALTH_LABEL, ObservabilityService } from '../observability.service';
import { api, AppState, fullTime, relativeTime, send } from '../state';

const snapshotListSchema = z.object({ snapshots: z.array(z.object({ id: z.string(), capturedAt: z.string(), classification: z.string(), noteState: z.string().nullable(), capturedBy: z.string() })) });
const SUBJECT_TEXT: Record<string, (app: string, id: string | null) => string> = {
 verified: app => `${app} identified this customer through its signed sign-in.`,
 unverified: app => `${app} did not identify this customer, so only service-level context is shown.`,
 not_reported: app => `${app} does not report verified customer ids yet, so only service-level context is shown.`,
 not_mapped: app => `${app} is not connected to Elastic.`,
 policy_none: app => `${app} is set to service-level context only.`,
 unavailable: () => 'Elastic is unavailable right now. Nothing below is current.',
};
interface ThreadMessage { senderType: string; isInternal: boolean; authorName: string | null; content: string; createdAt: string }
interface TimelineEntry { at: string; text: string; system: boolean; source?: string }

/**
 * Customer and system context beside a ticket or conversation (plan 14, E2; prototype board 1). Facts, observed
 * correlations and coverage limits are shown separately; nothing here claims a cause. Refreshes every 60 seconds
 * while the page is visible, keeping focus where it is.
 */
@Component({
 selector: 'rs-system-context',
 imports: [IconComponent, RouterLink],
 template: `
<section class="sysctx" aria-labelledby="sysctx-title">
 <h2 class="sr-only" id="sysctx-title">System context</h2>
 @if (ctx(); as c) {
  <div class="ctx-customer">
   <span class="ctx-avatar" aria-hidden="true">{{ initials() }}</span>
   <div class="grow">
    <div class="ctx-name">{{ customerName() }}</div>
    <div class="mono ctx-ids">{{ c.subject.externalId ?? 'No verified customer id' }}{{ customerEmail() ? ' · ' + customerEmail() : '' }}</div>
    <p class="small ctx-subject">{{ subjectText(c) }}@if (c.completeness === 'partial') { Partial: {{ c.missing.join(', ') }} could not be read. }</p>
   </div>
   <div class="ctx-customer-side">
    @if (c.subject.status === 'verified') { <span class="mono ctx-matched">matched on user.id {{ c.subject.externalId }}</span> }
    @if (state.can('observability.link') && c.subject.status !== 'not_mapped') {
     <button class="btn btn-sm" type="button" (click)="capture()" [disabled]="busy()"><rs-icon name="doc" [size]="14" />Capture evidence snapshot</button>
    }
   </div>
  </div>
  <p role="status" class="small">{{ captureMessage() }}@if (lastCaptured(); as id) { <a [routerLink]="['/evidence', id]">View the snapshot</a> }</p>

  @if (bannerIssue(); as i) {
   <section class="ctx-incident" aria-label="Active incident">
    <span class="ctx-incident-icon" aria-hidden="true"><rs-icon name="alert" [size]="18" /></span>
    <div class="ctx-incident-body">
     <div class="row-wrap"><span class="ctx-incident-title">{{ i.customerErrorsInWindow ? 'Known issue affecting this customer' : 'Known issue in ' + appName() }}: {{ i.title }}</span>
      <span class="src">{{ i.kind === 'case' ? 'CASE' : 'ALERT' }}</span>@if (sloBurning()) { <span class="src">SLO</span> }</div>
     <div class="ctx-incident-text">
      {{ issueFacts(i) }}
      @if (i.customerErrorsInWindow) { <b>{{ i.customerErrorsInWindow }} of this customer's errors fall inside this issue's window.</b> }
     </div>
     <div class="mono ctx-incident-meta">Matched: {{ i.matched.join('; ') }}@if (i.missing.length) { · not established: {{ i.missing.join('; ') }}}@if (c.restricted) { · {{ i.kind }} {{ i.providerId }}}</div>
    </div>
    @if (kind() === 'ticket' && state.can('observability.link') && state.can('ticket.read')) {
     <div class="row-wrap"><button class="btn btn-sm btn-primary" type="button" (click)="linkTo(i.issueId)" [disabled]="busy() || linked().has(i.issueId)">{{ linked().has(i.issueId) ? 'Linked' : 'Link to ' + (i.kind === 'case' ? 'case ' + i.providerId : 'this issue') }}</button></div>
    }
   </section>
  }

  <div class="ctx-facts">
   <div class="fact"><div class="k">Service health</div><div class="v">{{ healthText() }}</div></div>
   <div class="fact"><div class="k">Errors · 24h</div><div class="v mono" [class.ctx-bad]="errorCount(c) > 0">{{ c.subject.status === 'verified' ? errorCount(c) : '—' }}</div></div>
   <div class="fact"><div class="k">Events · 24h</div><div class="v mono">{{ c.subject.status === 'verified' ? c.events.length : '—' }}</div></div>
   <div class="fact"><div class="k">Last session</div><div class="v">{{ c.lastSession?.region ?? '—' }}</div></div>
   <div class="fact"><div class="k">Known issues</div><div class="v mono">{{ c.matchedIssues.length }}</div></div>
  </div>

  <div class="ctx-pair">
   <section class="card ctx-wide" aria-labelledby="saw-title">
    <div class="card-head"><h3 class="card-title" id="saw-title"><rs-icon name="activity" [size]="15" />What the systems saw</h3><span class="lbl">APM + RUM · last {{ hours }}h</span></div>
    <div class="ctx-bar">{{ sawSummary(c) }}</div>
    @if (c.subject.status === 'verified') {
     @for (e of c.events.slice(0, 8); track $index) {
      <div class="ctx-row">
       <span class="status-dot" [attr.data-tone]="eventTone(e)" aria-hidden="true"></span>
       <div class="grow">
        <div class="row-wrap"><span class="ctx-event-title">{{ eventTitle(e) }}</span><span class="src">{{ e.source }}</span></div>
        <div class="ctx-event-detail">{{ eventDetail(e) }}</div>
        <div class="mono ctx-meta">{{ e.service }} · <time [attr.datetime]="e.at" [attr.title]="fullTime(e.at)">{{ relativeTime(e.at) }}</time>{{ matchesIssue(e) ? ' · inside a known issue window' : '' }}</div>
        @if (e.traceId) {
         <div class="row-wrap ctx-trace"><span class="code">trace.id {{ e.traceId }}{{ e.transactionId ? ' · transaction.id ' + e.transactionId : '' }}</span>
          @if (c.kibanaTraceBase) { <a [href]="c.kibanaTraceBase + e.traceId" target="_blank" rel="noopener noreferrer">Open trace in Kibana ↗<span class="sr-only"> (opens a new tab)</span></a> }</div>
        }
       </div>
      </div>
     } @empty { <div class="ctx-row muted small">No events for this customer in the window.</div> }
    }
   </section>

   <section class="card ctx-narrow" aria-labelledby="us-title">
    <div class="card-head"><h3 class="card-title" id="us-title"><rs-icon name="pulse" [size]="15" />Is it us?</h3><span class="src">SYNTHETICS</span></div>
    <div class="ctx-bar">Latest check by location@if (c.lastSession; as s) {; customer's last session {{ s.region }} (browser monitoring)}</div>
    @for (m of c.synthetics; track m.monitorId + m.location) {
     <div class="ctx-row ctx-row-center">
      <span class="status-dot" [attr.data-tone]="m.status === 'up' ? 'safe' : 'destructive'" aria-hidden="true"></span>
      <div class="grow"><div class="ctx-check">{{ m.name }}</div><div class="mono ctx-meta">{{ m.location }} · <time [attr.datetime]="m.checkedAt">{{ relativeTime(m.checkedAt) }}</time></div></div>
      <span class="mono ctx-result">{{ m.status === 'up' ? (m.durationMs !== null ? m.durationMs + ' ms' : 'Passing') : 'Failing' }}</span>
     </div>
    } @empty { <div class="ctx-row muted small">No synthetic results in the last 15 minutes.</div> }
    @if (failingChecks(c); as f) {
     <div class="ctx-us-foot"><b>{{ f }} failing for everyone.</b> That points to the service, not this account. It does not rule out a problem with the account itself.</div>
    }
   </section>
  </div>

  <div class="ctx-pair ctx-pair-gap">
   <section class="ctx-wide" aria-labelledby="act-title">
    <div class="ctx-act-head">
     <h3 class="ctx-h" id="act-title">Recent activity</h3>
     <div class="seg" role="group" aria-label="Timeline sources">
      <button type="button" [attr.data-on]="showSystems()" [attr.aria-pressed]="showSystems()" (click)="showSystems.set(true)">Customer + systems</button>
      <button type="button" [attr.data-on]="!showSystems()" [attr.aria-pressed]="!showSystems()" (click)="showSystems.set(false)">Customer only</button>
     </div>
    </div>
    <ol class="ctx-timeline">
     @for (t of timeline(); track $index) {
      <li class="tl-item"><span class="status-dot" [attr.data-tone]="t.system ? 'accent' : 'neutral'" aria-hidden="true"></span>
       <div class="row-wrap"><span class="ctx-tl-text">{{ t.text }}</span>@if (t.source) { <span class="src">{{ t.source }}</span> }</div>
       <div class="mono ctx-meta"><time [attr.datetime]="t.at" [attr.title]="fullTime(t.at)">{{ relativeTime(t.at) }}</time></div></li>
     } @empty { <li class="muted small">Nothing yet.</li> }
    </ol>
   </section>
   @if (c.restricted) {
    <section class="card ctx-narrow" aria-labelledby="logs-title">
     <div class="card-head"><h3 class="card-title" id="logs-title">Log lines · {{ logService(c) }}</h3><span class="src">LOGS</span></div>
     @for (l of c.logs; track $index) {
      <div class="ctx-row ctx-col"><div class="row-wrap"><span class="status-dot" [attr.data-tone]="l.level === 'error' ? 'destructive' : 'sensitive'" aria-hidden="true"></span><b class="small">{{ l.level ?? 'log' }}</b><span class="mono ctx-meta">{{ relativeTime(l.at) }}</span></div>
       <div class="code">{{ l.message }}</div></div>
     } @empty { <div class="ctx-row muted small">No log lines for this customer in the window.</div> }
     <div class="ctx-row ctx-row-center"><span class="mono ctx-meta grow">filtered: service.name, user.id, last {{ hours }}h · redacted</span></div>
    </section>
   } @else {
    <div class="ctx-lock ctx-narrow"><rs-icon name="lock" [size]="16" /><div>Trace IDs, log lines and Kibana links appear for investigators. A snapshot you capture keeps the facts you can see.</div></div>
   }
  </div>
  <p class="small muted">{{ c.coverage }} Checked <time [attr.datetime]="c.fetchedAt">{{ relativeTime(c.fetchedAt) }}</time>.</p>
  @if (snapshots().length) {
   <div class="small">Snapshots of this {{ kind() }}:
    <ul class="inline-list">@for (s of snapshots(); track s.id) { <li><a [routerLink]="['/evidence', s.id]">{{ fullTime(s.capturedAt) }}</a> ({{ s.capturedBy }})</li> }</ul>
   </div>
  }
 } @else { <p class="muted small" role="status">{{ error() || 'Loading system context…' }}</p> }
</section>`,
})
export class SystemContextComponent {
 readonly appKey = input.required<string>();
 readonly kind = input.required<'ticket' | 'conversation'>();
 readonly objectId = input.required<string>();
 readonly appName = input<string>('the application');
 readonly messages = input<ThreadMessage[]>([]);
 readonly customer = input<{ name: string | null; email: string | null }>({ name: null, email: null });
 readonly obs = inject(ObservabilityService);
 readonly linked = signal<ReadonlySet<string>>(new Set());
 readonly state = inject(AppState);
 readonly ctx = signal<SubjectContext | null>(null);
 readonly error = signal('');
 readonly busy = signal(false);
 readonly captureMessage = signal('');
 readonly lastCaptured = signal<string | null>(null);
 readonly snapshots = signal<z.infer<typeof snapshotListSchema>['snapshots']>([]);
 readonly showSystems = signal(true);
 readonly hours = 24;
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 private requestId = crypto.randomUUID();
 private readonly base = computed(() => `/api/apps/${encodeURIComponent(this.appKey())}/${this.kind() === 'ticket' ? 'tickets' : 'conversations'}/${encodeURIComponent(this.objectId())}`);

 readonly timeline = computed<TimelineEntry[]>(() => {
  const thread: TimelineEntry[] = this.messages().filter(m => !m.isInternal).map(m => ({ at: m.createdAt, text: `${m.senderType === 'visitor' ? 'Customer' : (m.authorName ?? 'Agent')}: ${m.content.slice(0, 120)}`, system: false }));
  const systems: TimelineEntry[] = this.showSystems() ? (this.ctx()?.events ?? []).map(e => ({ at: e.at, text: `${this.eventTitle(e)} (${this.eventDetail(e)})`, system: true, source: e.source })) : [];
  return [...thread, ...systems].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);
 });

 constructor() {
  effect(() => {
   const base = this.base();
   untracked(() => { this.ctx.set(null); this.lastCaptured.set(null); this.captureMessage.set(''); this.requestId = crypto.randomUUID(); this.load(base); });
  });
  // Visible refresh every 60 seconds (plan 12 §6); hidden tabs do not poll.
  const timer = setInterval(() => { if (document.visibilityState === 'visible') this.load(this.base(), true); }, 60_000);
  inject(DestroyRef).onDestroy(() => clearInterval(timer));
 }

 load(base: string, quiet = false) {
  api(base + '/observability', subjectContextSchema).then(c => { if (base === this.base()) { this.ctx.set(c); this.error.set(''); } })
   .catch(e => { if (!quiet) this.error.set(e.message ?? 'System context could not be loaded.'); });
  api(base + '/evidence', snapshotListSchema).then(r => { if (base === this.base()) this.snapshots.set(r.snapshots); }).catch(() => {});
 }
 customerName() { return this.customer().name ?? 'Customer'; }
 customerEmail() { return this.customer().email; }
 initials() { return this.customerName().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
 /** The banner shows the issue that touches this customer first, else the app's newest issue. */
 readonly bannerIssue = computed(() => { const l = this.ctx()?.matchedIssues ?? []; return l.find(i => i.customerErrorsInWindow > 0) ?? l[0] ?? null; });
 readonly appHealth = computed(() => this.obs.byApp().get(this.appKey()));
 sloBurning() { const s = this.appHealth()?.summary.slos; return !!s && (s.degrading > 0 || s.violated > 0); }
 healthText() { const h = this.appHealth(); return h ? HEALTH_LABEL[h.state] : '—'; }
 issueFacts(i: MatchedIssue) {
  const issue = this.obs.issues().find(x => x.id === i.issueId);
  const burn = this.appHealth()?.summary.slos.worstBurn;
  const parts = [i.kind === 'alert' ? '' : `Case ${i.providerId}.`, burn ? `${burn.name} (${+(burn.target * 100).toFixed(2)}%) burning ${burn.value.toFixed(1)}x over ${burn.window}.` : '',
   issue?.affected ? `About ${issue.affected.count} customers affected so far (approximate).` : ''];
  return parts.filter(Boolean).join(' ');
 }
 errorCount(c: SubjectContext) { return c.events.filter(e => e.kind === 'error' || e.outcome === 'failure').length; }
 sawSummary(c: SubjectContext) {
  if (c.subject.status !== 'verified') return 'Customer events need a verified customer id.';
  const inIssue = c.events.filter(e => this.matchesIssue(e)).length;
  return `${c.events.length} events for this customer.${inIssue ? ` ${inIssue} fall inside an active issue's window.` : ''}`;
 }
 matchesIssue(e: SubjectEvent) {
  return (e.kind === 'error' || e.outcome === 'failure') && (this.ctx()?.matchedIssues ?? []).some(i => Date.parse(e.at) >= Date.parse(i.since));
 }
 eventTone(e: SubjectEvent) { return e.kind === 'error' || e.outcome === 'failure' ? 'destructive' : e.kind === 'page_load' && (e.durationMs ?? 0) > 4000 ? 'sensitive' : 'safe'; }
 failingChecks(c: SubjectContext) {
  const f = c.synthetics.filter(m => m.status === 'down');
  return f.length ? f.map(m => `${m.name} (${m.location})`).join(', ') + (f.length === 1 ? ' is' : ' are') : null;
 }
 logService(c: SubjectContext) { return [...new Set(c.logs.map(l => l.service).filter(Boolean))].join(', ') || 'mapped services'; }
 async linkTo(issueId: string) {
  this.busy.set(true);
  const res = await send('POST', `/api/apps/${encodeURIComponent(this.appKey())}/observability/issues/${issueId}/links`, { requestId: crypto.randomUUID(), ticketIds: [this.objectId()] }, linkResultSchema);
  this.busy.set(false);
  if (!res.ok) { this.captureMessage.set(res.error!.message); return; }
  this.linked.set(new Set([...this.linked(), issueId]));
  this.captureMessage.set('Linked this ticket to the known issue.');
  void this.obs.reload();
 }
 subjectText(c: SubjectContext) { return SUBJECT_TEXT[c.subject.status]?.(this.appName(), c.subject.externalId) ?? ''; }
 eventTitle(e: SubjectEvent) { return e.kind === 'error' ? e.name : e.kind === 'page_load' ? `Page load ${e.name}` : e.name; }
 eventDetail(e: SubjectEvent) {
  const parts = [e.kind === 'error' ? 'error' : e.outcome === 'failure' ? 'failed' : e.outcome === 'success' ? 'succeeded' : 'outcome unknown'];
  if (e.httpStatus) parts.push(`HTTP ${e.httpStatus}`);
  if (e.durationMs !== null) parts.push(`${e.durationMs >= 1000 ? (e.durationMs / 1000).toFixed(1) + ' s' : e.durationMs + ' ms'}`);
  if (e.region) parts.push(e.region);
  return parts.join(', ');
 }
 async capture() {
  this.busy.set(true);
  const res = await send('POST', this.base() + '/evidence', { requestId: this.requestId }, evidenceSnapshotSchema);
  this.busy.set(false);
  if (!res.ok) { this.captureMessage.set(res.error!.message); return; }
  const s = res.data!;
  this.lastCaptured.set(s.id);
  this.requestId = crypto.randomUUID();
  this.captureMessage.set(s.note.state === 'succeeded' ? 'Snapshot captured, and an internal note links to it.' : s.note.state === 'uncertain'
   ? 'Snapshot captured. The application did not confirm the internal note; check it before trying again.' : 'Snapshot captured. The internal note could not be added.');
  this.load(this.base(), true);
 }
}
