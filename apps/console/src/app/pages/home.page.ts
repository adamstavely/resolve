import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { BUNDLE_LABELS, CAPABILITIES, clearanceResponseSchema, dashboardResponseSchema, type CapabilityId, type DashboardResponse, type KpiMetric } from '../../../../../packages/contracts/src/index';
import { IconComponent, MarkComponent } from '../icon.component';
import { KnownIssuesComponent, LiveActivityComponent } from './service-health.component';
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TONE, ObservabilityService, REASON_TEXT } from '../observability.service';
import type { AppHealth, ElasticFamily } from '../../../../../packages/contracts/src/index';
import { api, AppState, fullTime, relativeTime } from '../state';

const rank = (s: string) => ({ critical: 3, degraded: 2, healthy: 1 } as Record<string, number>)[s] ?? 0;
const pilotRunsSchema = z.object({ runs: z.array(z.object({ runId: z.string(), applicationName: z.string(), environment: z.string(), workspaceKey: z.string(), status: z.string(), done: z.boolean() })) });
const KPIS: { key: KpiMetric; label: string; hint: string }[] = [
 { key: 'openTickets', label: 'Open tickets', hint: 'Visible to you' },
 { key: 'unassignedTickets', label: 'Unassigned', hint: 'Open, no individual owner' },
 { key: 'awaitingResponse', label: 'Customers awaiting response', hint: 'Waiting on support' },
 { key: 'slaBreached', label: 'SLA breached', hint: 'Open, past due' },
 { key: 'slaApproaching', label: 'SLA approaching', hint: 'Due within 30 minutes' },
 { key: 'recentActivity', label: 'Activity, 24 hours', hint: 'Messages and changes' },
];
const ACTIVITY_LABELS: Record<string, string> = {
 customer_message: 'Customer message', agent_reply: 'Agent reply', internal_note: 'Internal note', assignment: 'Assignment', status_change: 'Status change', ticket_created: 'Ticket created',
};
const MISSING: Record<string, string> = {
 suspended: 'suspended', dormant: 'idle', not_connected: 'not connected', reconnect_required: 'reconnect required', denied: 'no access',
 not_permitted: 'no analytics access', not_implemented: 'not supported', timeout: 'timed out', tenant_error: 'error', incompatible: 'incompatible',
};
const CONNECTION_LABELS: Record<string, string> = {
 not_connected: 'Not connected', connecting: 'Connecting', connected: 'Connected', reconnect_required: 'Reconnect required', revoked: 'Access revoked', denied: 'Denied',
};
const SIGNIN_MESSAGES: Record<string, { text: string; alert: boolean }> = {
 failed: { text: 'Sign-in did not complete. Try again; if it keeps failing, contact support.', alert: true },
 denied: { text: 'Your account is disabled in Resolve. Contact an administrator.', alert: true },
 'signed-out': { text: 'You have signed out.', alert: false },
};
function connectMessage(result: string | null, app: string) {
 switch (result) {
  case 'connected': return { text: `Connected to ${app}.`, alert: false };
  case 'disconnected': return { text: `Disconnected from ${app}.`, alert: false };
  case 'unavailable': return { text: `${app} is not available right now. Try again later.`, alert: true };
  case 'mismatch': return { text: `The account used at ${app} does not belong to you in Resolve. Sign out of other accounts and try again, or contact support.`, alert: true };
  case 'failed': return { text: `Connecting to ${app} did not complete. Try again.`, alert: true };
  default: return undefined;
 }
}

@Component({
 selector: 'rs-home-page',
 imports: [IconComponent, MarkComponent, RouterLink, KnownIssuesComponent, LiveActivityComponent],
 template: `
<div class="launchpad">
 @if (message(); as m) { <p class="notice" [attr.data-tone]="m.alert ? 'destructive' : 'safe'" [attr.role]="m.alert ? 'alert' : 'status'">{{ m.text }}</p> }

 @if (pendingPilots().length) {
  <section class="card pad pilot-card" aria-labelledby="pilot-title">
   <h2 class="card-title" id="pilot-title"><rs-icon name="shieldCheck" [size]="15" />Pilot checks</h2>
   <ul class="caps">
    @for (p of pendingPilots(); track p.runId) {
     <li><span>You are a pilot for {{ p.applicationName }} ({{ p.environment }}). <a [routerLink]="['/onboarding', p.runId, 'pilot']">Run the pilot check<span class="sr-only"> for {{ p.applicationName }}</span></a></span></li>
    }
   </ul>
  </section>
 }

 <section class="lp-hero" aria-labelledby="hero-title">
  <div class="lp-mark" aria-hidden="true"><rs-mark size="100%" variant="hero" /></div>
  <div>
   <h1 class="lp-title" id="hero-title" tabindex="-1">Resolve: One place to <span class="accent">solve</span> it.</h1>
   <p class="lp-lede">Chats, tickets, and escalations across every connected application. Sign in once, connect each app as yourself, and act with the access your role allows.</p>
  </div>
 </section>

 @if (state.can('dashboard.view')) {
  <section aria-labelledby="kpi-title">
   <div class="section-head">
    <h2 class="section-label" id="kpi-title">Across your applications</h2>
    <button class="btn btn-sm btn-ghost" type="button" (click)="loadDashboard()" [disabled]="loading()"><rs-icon name="refresh" [size]="14" />Refresh</button>
   </div>
   @if (dashError()) { <p class="notice" data-tone="destructive" role="alert">{{ dashError() }}</p> }
   <ul class="kpi-grid">
    @for (k of kpis; track k.key) {
     <li class="kpi" [attr.aria-busy]="loading() || null">
      <span class="kpi-label">{{ k.label }}</span>
      @if (dashboard(); as d) {
       @if (d.totals[k.key].value !== null) { <span class="kpi-value mono">{{ d.totals[k.key].value }}</span> }
       @else { <span class="kpi-value mono muted" aria-label="Unavailable">—</span> }
       <span class="kpi-cover">{{ coverage(d, k.key) }}</span>
      } @else { <span class="kpi-value mono muted">…</span><span class="kpi-cover">{{ k.hint }}</span> }
     </li>
    }
   </ul>
   @if (dormantApps().length) {
    <div class="row dormant-row">
     @for (a of dormantApps(); track a.appKey) {
      <button class="btn btn-sm" type="button" (click)="wake(a.appKey)">Load {{ a.displayName }}</button>
     }
     <span class="muted small">Idle applications are not counted until you load them. Loading starts the application.</span>
    </div>
   }
  </section>
 }

 <div class="lp-cols">
  <div class="stack-lg">
   @if (state.apps(); as list) {
    <section aria-labelledby="apps-title">
     <div class="section-head"><h2 class="section-label" id="apps-title">Your applications{{ healthOn() ? ' · live health' : '' }}</h2></div>
     @if (!healthOn()) { <p class="muted small">Open an application to connect to it. Resolve then acts as you there, with only the access your role needs.</p> }
     <div class="app-grid" [class.health-grid]="healthOn()">
      @for (a of list.apps; track a.appKey) {
       <article class="app-card" [class.health-card]="healthOn()" [id]="'app-' + a.appKey" [attr.aria-labelledby]="'app-name-' + a.appKey" [attr.data-unavailable]="!a.servable || null">
        <div class="app-card-top">
         <span class="app-glyph lg" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
         <div class="grow">
          <h3 class="app-card-name"><a class="card-link" [id]="'app-name-' + a.appKey" [routerLink]="['/apps', a.appKey]">{{ a.displayName }}</a></h3>
          <p class="app-card-tag">{{ a.description || a.appKey }}</p>
         </div>
         @if (healthOn()) {
          @if (healthOf(a.appKey); as h) { <span class="health-status"><span class="status-dot" [attr.data-tone]="healthTone[h.state]" aria-hidden="true"></span>{{ healthLabel[h.state] }}</span> }
         }
        </div>
        @if (healthOn()) {
         @if (issueFor(a.appKey); as i) { <div class="hc-issue">{{ i.title }}</div> }
         <div class="hc-rows">
          @if (healthOf(a.appKey); as h) {
           @if (h.reason) { <p class="hc-reason">{{ reasonText(h.reason) }}</p> }
           @else {
            <div class="hrow"><span class="k">SLO</span><span class="mono">{{ sloLine(h) }}</span></div>
            <div class="hrow"><span class="k">Active alerts</span><span class="mono">{{ h.summary.activeAlerts }}</span></div>
            <div class="hrow"><span class="k">Synthetics</span>
             @if (h.summary.synthetics.recent.length) {
              <span class="hrow-v"><span class="ticks" aria-hidden="true">@for (r of h.summary.synthetics.recent; track $index) { <i [attr.data-down]="r.status === 'down' || null"></i> }</span>
               <span class="mono">{{ passed(h) }}/{{ h.summary.synthetics.recent.length }}</span>
               <span class="sr-only">: {{ passed(h) }} of the last {{ h.summary.synthetics.recent.length }} runs passed{{ h.summary.synthetics.failing.length ? '; failing now: ' + h.summary.synthetics.failing.join(', ') : '' }}</span></span>
             } @else { <span class="mono">{{ h.summary.synthetics.configured ? 'No recent results' : 'Not configured' }}</span> }
            </div>
           }
          }
         </div>
         <div class="hc-foot">
          <span>Your clearance @if (clearanceOf(a.appKey) !== '—') { <b class="mono">{{ clearanceOf(a.appKey) }}</b> } @else { <b class="mono" aria-hidden="true">—</b><span class="sr-only">not reported</span> }</span>
          @if (openTickets(a.appKey); as n) { <span><b class="mono">{{ n.value }}</b> open tickets</span> }
          @else if (!a.servable) { <span>Unavailable ({{ a.state }})</span> }
         </div>
        } @else {
         <dl class="app-card-meta">
          <div><dt>Status</dt><dd><span class="status-dot" [attr.data-tone]="statusTone(a)" aria-hidden="true"></span>{{ statusLabel(a) }}</dd></div>
          <div><dt>Your connection</dt><dd>{{ connectionLabel(a.connection.state) }}</dd></div>
         </dl>
        }
       </article>
      }
     </div>
     @if (healthOn()) {
      <p class="hc-source mono">Health from Elastic SLOs, alerting rules and Synthetics@if (refreshedAt(); as t) { · refreshed <time [attr.datetime]="t" [attr.title]="fullTime(t)">{{ relativeTime(t) }}</time>}</p>
     }
     <p role="status" class="small muted status-line">{{ state.appsError() }}</p>
    </section>
   } @else if (state.session()?.authenticated === false) {
    <section class="card pad" aria-labelledby="signin-title">
     <h2 class="card-title" id="signin-title">Sign in to continue</h2>
     <p class="muted">Use your organization account. Resolve then shows the applications and actions your role allows.</p>
     <a class="btn btn-primary" href="/api/auth/login?returnTo=/">Sign in</a>
    </section>
   }
  </div>

  <aside class="stack-lg" aria-label="Activity and access">
   @if (state.can('observability.health')) { <rs-known-issues /><rs-live-activity /> }
   @if (state.can('dashboard.view')) {
    <section class="card" aria-labelledby="activity-title">
     <div class="card-head"><h2 class="card-title" id="activity-title"><rs-icon name="activity" [size]="15" />Recent activity</h2><span class="card-meta">Latest per app</span></div>
     @if (dashboard(); as d) {
      <ol class="feed">
       @for (e of d.activity.slice(0, 12); track e.id) {
        <li>
         <span class="feed-dot" [attr.data-kind]="e.kind" aria-hidden="true"></span>
         <div class="grow">
          <a class="feed-title" [routerLink]="['/', e.itemType === 'ticket' ? 'tickets' : 'inbox', e.appKey, e.itemId]">{{ e.title }}</a>
          <p class="feed-meta mono">{{ activityLabel(e.kind) }} · {{ state.appName(e.appKey) }}@if (e.actorName) { · {{ e.actorName }} } · <time [attr.datetime]="e.at" [attr.title]="fullTime(e.at)">{{ relativeTime(e.at) }}</time></p>
         </div>
        </li>
       } @empty { <li class="muted small">No recent activity from connected applications.</li> }
      </ol>
     } @else { <p class="pad muted small">Loading…</p> }
    </section>
   }
   <section class="card" aria-labelledby="access-title">
    <div class="card-head"><h2 class="card-title" id="access-title"><rs-icon name="user" [size]="15" />Your access</h2></div>
    <div class="pad">
     @if (state.session(); as s) {
      @if (s.authenticated) {
       <p class="who">Signed in as {{ s.user.displayName }}{{ s.user.email ? ' (' + s.user.email + ')' : '' }}.
        Roles: {{ roleLabels() || 'none. Ask an administrator for access.' }}</p>
       @if (s.capabilities.length) {
        <details class="caps-details"><summary>What you can do ({{ s.capabilities.length }})</summary>
         <ul class="caps">@for (c of s.capabilities; track c) { <li><rs-icon name="check" [size]="14" />{{ capabilitySummary(c) }}</li> }</ul>
        </details>
       }
      } @else { <p class="muted">You are signed out. Sign in with your organization account to see your access.</p> }
     } @else { <p class="muted">Checking sign-in…</p> }
    </div>
   </section>
  </aside>
 </div>
</div>`,
})
export class HomePage {
 readonly state = inject(AppState);
 readonly obs = inject(ObservabilityService);
 readonly healthLabel = HEALTH_LABEL;
 readonly healthTone = HEALTH_TONE;
 readonly healthIcon = HEALTH_ICON;
 readonly healthOn = computed(() => this.state.can('observability.health'));
 /** Service health per app (worst environment), from Elastic via Resolve's snapshots (plan 14, E1; prototype board 2). */
 healthOf(appKey: string) { return this.obs.byApp().get(appKey); }
 /** The app's current issue in one line: an open case (named by people) before an alert reason. */
 issueFor(appKey: string) { const list = this.obs.issues().filter(i => i.appKey === appKey); return list.find(i => i.kind === 'case') ?? list[0]; }
 reasonText(r: string) { return REASON_TEXT[r] ?? r; }
 missingText(m: ElasticFamily[]) { return m.join(', ') || 'some data'; }
 passed(h: AppHealth) { return h.summary.synthetics.recent.filter(r => r.status === 'up').length; }
 sloLine(h: AppHealth) {
  const s = h.summary.slos;
  if (!s.total) return 'Not configured';
  const worst = h.components.filter(c => c.family === 'slo').sort((a, b) => rank(b.state) - rank(a.state))[0];
  if (!s.degrading && !s.violated) return s.healthy ? 'All within budget' : 'No data';
  // As the prototype: "Transfers 99.5% · burning 4.2x", with the burn rate only when Elastic reported one.
  if (s.worstBurn) return `${s.worstBurn.name} ${+(s.worstBurn.target * 100).toFixed(2)}% · burning ${s.worstBurn.value.toFixed(1)}x`;
  return `${worst?.label ?? 'SLO'} · ${s.violated ? 'violated' : 'degrading'}`;
 }
 openTickets(appKey: string) {
  const r = this.dashboard()?.apps.find(a => a.appKey === appKey);
  const m = r?.status === 'ok' ? r.data.metrics.openTickets : null;
  return m && m.status === 'available' ? { value: m.value } : null;
 }
 /** Your tier per app as each application reports it (QB-TIER-1); "—" when it reports none or cannot be asked. */
 readonly clearance = signal<Record<string, 1 | 2 | 3 | null>>({});
 clearanceOf(appKey: string) { const t = this.clearance()[appKey]; return t ? `T${t}` : '—'; }
 /** The oldest refresh among apps with current health, so "refreshed" never overstates freshness. */
 readonly refreshedAt = computed(() => this.obs.health().map(h => h.provenance?.fetchedAt).filter((t): t is string => !!t).sort()[0] ?? null);
 readonly kpis = KPIS;
 readonly dashboard = signal<DashboardResponse | undefined>(undefined);
 readonly loading = signal(false);
 readonly dashError = signal('');
 readonly include = signal<ReadonlySet<string>>(new Set());
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 private readonly query = new URLSearchParams(location.search);
 readonly roleLabels = computed(() => { const s = this.state.session(); return s?.authenticated ? s.bundles.map(b => BUNDLE_LABELS[b]).join(', ') : ''; });
 readonly message = computed(() => SIGNIN_MESSAGES[this.query.get('signin') ?? ''] ?? connectMessage(this.query.get('connect'), this.state.appName(this.query.get('app') ?? '') || 'the application'));
 readonly dormantApps = computed(() => (this.state.apps()?.apps ?? []).filter(a => a.servable && a.dormant && !this.include().has(a.appKey) && a.connection.state === 'connected'));

 constructor() {
  // Drop the one-time sign-in/connect result from the address bar so a reload does not repeat it.
  if (this.query.get('signin') || this.query.get('connect')) history.replaceState(null, '', location.pathname);
  // Load once the session (which may still be in flight) grants the dashboard.
  let started = false;
  effect(() => { if (!started && this.state.can('dashboard.view')) { started = true; untracked(() => this.loadDashboard()); } });
  let tiers = false;
  effect(() => { if (!tiers && this.state.can('ticket.read')) { tiers = true; untracked(() => api('/api/clearance', clearanceResponseSchema).then(r => this.clearance.set(Object.fromEntries(r.apps.map(a => [a.appKey, a.tier])))).catch(() => {})); } });
  let pilots = false;
  effect(() => { if (!pilots && this.state.can('connection.manage')) { pilots = true; untracked(() => api('/api/onboarding/pilot-runs', pilotRunsSchema).then(r => this.pilotRuns.set(r.runs)).catch(() => {})); } });
 }
 /** Onboarding runs where this person is a named pilot. */
 readonly pilotRuns = signal<z.infer<typeof pilotRunsSchema>['runs']>([]);
 readonly pendingPilots = computed(() => this.pilotRuns().filter(p => !p.done));

 loadDashboard() {
  this.loading.set(true);
  const q = this.include().size ? '?include=' + [...this.include()].join(',') : '';
  api('/api/dashboard' + q, dashboardResponseSchema)
   .then(d => { this.dashboard.set(d); this.dashError.set(''); })
   .catch(e => this.dashError.set(e.message ?? 'The dashboard could not be loaded.'))
   .finally(() => this.loading.set(false));
 }

 /** Explicit user request: include an idle application, which starts it. */
 wake(appKey: string) { this.include.update(s => new Set([...s, appKey])); this.loadDashboard(); }

 coverage(d: DashboardResponse, key: KpiMetric) {
  const t = d.totals[key];
  const total = t.included.length + t.missing.length;
  if (!t.missing.length) return `All ${total} applications`;
  const why = t.missing.map(m => `${this.state.appName(m.appKey)} ${MISSING[m.reason] ?? m.reason}`).join(', ');
  return `${t.included.length} of ${total} applications · ${why}`;
 }

 statusLabel(a: { servable: boolean; dormant: boolean; state: string; health: { status: string } }) {
  if (!a.servable) return `Unavailable (${a.state})`;
  if (a.dormant) return 'Idle';
  return a.health.status === 'ok' ? 'Available' : a.health.status === 'incompatible' ? 'Incompatible version' : a.health.status === 'unreachable' ? 'Not responding' : 'Available';
 }
 statusTone(a: { servable: boolean; dormant: boolean; health: { status: string } }) {
  return !a.servable ? 'sensitive' : a.dormant ? 'neutral' : a.health.status === 'ok' ? 'safe' : 'destructive';
 }
 connectionLabel(state: string) { return CONNECTION_LABELS[state] ?? state; }
 activityLabel(kind: string) { return ACTIVITY_LABELS[kind] ?? kind; }
 capabilitySummary(id: CapabilityId) { return CAPABILITIES[id].summary; }
}
