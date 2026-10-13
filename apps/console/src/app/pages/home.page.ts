import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { BUNDLE_LABELS, CAPABILITIES, dashboardResponseSchema, type CapabilityId, type DashboardResponse, type KpiMetric } from '../../../../../packages/contracts/src/index';
import { IconComponent, MarkComponent } from '../icon.component';
import { LiveActivityComponent } from './service-health.component';
import { KnownIssuesComponent } from './issues.component';
import { ClearanceService, TierBadgeComponent } from '../ui';
import { WorkService } from '../work.service';
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
 imports: [IconComponent, MarkComponent, RouterLink, KnownIssuesComponent, LiveActivityComponent, TierBadgeComponent],
 template: `
<div class="launchpad">
 @if (message(); as m) { <p class="notice" [attr.data-tone]="m.alert ? 'destructive' : 'safe'" [attr.role]="m.alert ? 'alert' : 'status'" style="margin-bottom:18px">{{ m.text }}</p> }
 @if (pendingPilots().length) {
  <section class="panel" aria-labelledby="pilot-title" style="margin-bottom:18px">
   <div class="ph2"><h2 class="pt2" id="pilot-title"><rs-icon name="shieldCheck" [size]="15" />Pilot checks</h2></div>
   @for (p of pendingPilots(); track p.runId) {
    <div class="prow"><span>You are a pilot for {{ p.applicationName }} ({{ p.environment }}). <a [routerLink]="['/onboarding', p.runId, 'pilot']">Run the pilot check<span class="sr-only"> for {{ p.applicationName }}</span></a></span></div>
   }
  </section>
 }

 <div class="lp-hero">
  <div class="lp-mark" aria-hidden="true"><rs-mark size="100%" variant="hero" /></div>
  <div class="lp-hero-text">
   @if (state.user(); as u) {
    <h1 class="lp-title" tabindex="-1">{{ greeting() }}, <span class="accent">{{ firstName() }}</span>.</h1>
    <p class="lp-lede">{{ lede() }}</p>
   } @else {
    <h1 class="lp-title" tabindex="-1">Resolve: One place to <span class="accent">solve</span> it.</h1>
    <p class="lp-lede">Chats, tickets, and escalations across every connected application. Sign in once, connect each app as yourself, and act with the access your role allows.</p>
   }
  </div>
 </div>

 @if (state.apps(); as list) {
  <div class="lp-cols">
   <section aria-labelledby="apps-title">
    <h2 class="section-label" id="apps-title" style="margin:0 0 12px">Your applications{{ healthOn() ? ' · live health' : '' }}</h2>
    <div class="app-grid stagger">
     @for (a of list.apps; track a.appKey) {
      <article class="app-card" [id]="'app-' + a.appKey" [attr.aria-labelledby]="'app-name-' + a.appKey">
       <div class="app-card-top">
        <span class="app-glyph" style="width:38px;height:38px;font-size:17px" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
        <div style="flex:1;min-width:0">
         <h3 class="app-card-name" style="margin:0"><a class="card-link" [id]="'app-name-' + a.appKey" [routerLink]="['/apps', a.appKey]">{{ a.displayName }}</a></h3>
         <div class="app-card-tag">{{ a.description || a.appKey }}</div>
        </div>
        @if (healthOn() && healthOf(a.appKey); as h) {
         <span class="app-stat" style="font-weight:560;color:var(--ink-2)"><span class="status-dot" [attr.data-tone]="healthTone[h.state]" aria-hidden="true"></span> {{ healthLabel[h.state] }}</span>
        } @else if (!healthOn()) {
         <span class="app-stat" style="font-weight:560;color:var(--ink-2)"><span class="status-dot" [attr.data-tone]="statusTone(a)" aria-hidden="true"></span> {{ statusLabel(a) }}</span>
        }
       </div>
       @if (healthOn()) {
        @if (issueFor(a.appKey); as i) { <div class="app-issue">{{ i.title }}</div> }
        <div style="border-top:1px solid var(--border);padding-top:6px">
         @if (healthOf(a.appKey); as h) {
          @if (h.reason) { <div class="hrow"><span class="k">{{ reasonText(h.reason) }}</span></div> }
          @else {
           <div class="hrow"><span class="k">SLO</span><span class="mono">{{ sloLine(h) }}</span></div>
           <div class="hrow"><span class="k">Active alerts</span><span class="mono">{{ h.summary.activeAlerts }}</span></div>
           <div class="hrow"><span class="k">Synthetics</span>
            @if (h.summary.synthetics.recent.length) {
             <span style="display:flex;align-items:center;gap:8px"><span class="ticks" aria-hidden="true">@for (r of h.summary.synthetics.recent; track $index) { <i [class.f]="r.status === 'down'"></i> }</span>
              <span class="mono">{{ passed(h) }}/{{ h.summary.synthetics.recent.length }}</span>
              <span class="sr-only">: {{ passed(h) }} of the last {{ h.summary.synthetics.recent.length }} runs passed{{ h.summary.synthetics.failing.length ? '; failing now: ' + h.summary.synthetics.failing.join(', ') : '' }}</span></span>
            } @else { <span class="mono">{{ h.summary.synthetics.configured ? 'No recent results' : 'Not configured' }}</span> }
           </div>
          }
         } @else { <div class="hrow"><span class="k">{{ obs.loaded() ? 'No health for this application' : 'Loading…' }}</span></div> }
        </div>
       } @else {
        <div style="border-top:1px solid var(--border);padding-top:6px">
         <div class="hrow"><span class="k">Your connection</span><span>{{ connectionLabel(a.connection.state) }}</span></div>
        </div>
       }
       <div class="divider"></div>
       <div class="app-card-foot">
        <span class="tier-line">Your clearance <rs-tier [tier]="clearance.tierOf(a.appKey)" size="sm" /></span>
        @if (openTickets(a.appKey); as n) { <span class="app-stat"><b>{{ n.value }}</b> open tickets</span> }
        @else if (!a.servable) { <span class="app-stat">Unavailable</span> }
       </div>
      </article>
     }
    </div>
    @if (healthOn()) {
     <div class="meta" style="margin-top:10px">Health from Elastic SLOs, alerting rules and Synthetics@if (refreshedAt(); as t) { · refreshed <time [attr.datetime]="t" [attr.title]="fullTime(t)">{{ relativeTime(t) }}</time>}</div>
    }
    <p role="status" class="small muted">{{ state.appsError() }}</p>
   </section>

   <div class="side-stack">
    @if (state.can('ticket.read')) {
     <section class="panel" aria-labelledby="mt-title">
      <div class="panel-head">
       <h2 class="t" id="mt-title" style="margin:0"><rs-icon name="ticket" [size]="15" /> My tickets</h2>
       <a class="btn btn-ghost btn-sm" routerLink="/tickets">View all</a>
      </div>
      <div class="panel-body">
       @for (c of myItems(); track c.kind + c.appKey + c.id) {
        <a class="esc-row" style="width:100%;color:var(--ink)" [routerLink]="[c.kind === 'ticket' ? '/tickets' : '/inbox', c.appKey, c.id]">
         <span class="ch-ic" style="width:28px;height:28px" aria-hidden="true"><rs-icon [name]="c.channel === 'chat' ? 'chat' : 'mail'" [size]="14" />@if (c.channel === 'chat') { <span class="live"></span> }</span>
         <div style="flex:1;min-width:0">
          <div style="font-size:var(--fs-sm);font-weight:500">{{ c.subject }}</div>
          <div class="feed-line2"><span>{{ c.ref }}</span><span>·</span><span>{{ state.appName(c.appKey) }}</span></div>
         </div>
         @if (c.waitingSince) { <span class="waiting">{{ waited(c.waitingSince) }}</span> }
        </a>
       } @empty { <p class="feed-line2" style="padding:10px">{{ work.ticketsLoading() ? 'Loading…' : 'Nothing assigned to you.' }}</p> }
      </div>
     </section>
    }
    @if (state.can('observability.health')) { <rs-known-issues /><rs-live-activity /> }
   </div>
  </div>
 } @else if (state.session()?.authenticated === false) {
  <section class="panel" aria-labelledby="signin-title" style="max-width:560px">
   <div class="ph2"><h2 class="pt2" id="signin-title">Sign in to continue</h2></div>
   <div class="prow" style="flex-direction:column;align-items:flex-start">
    <p class="muted" style="margin:0">Use your organization account. Resolve then shows the applications and actions your role allows.</p>
    <a class="btn btn-primary" href="/api/auth/login?returnTo=/">Sign in</a>
   </div>
  </section>
 }
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
 /** Your tier per app as each application reports it (QB-TIER-1). */
 readonly clearance = inject(ClearanceService);
 readonly work = inject(WorkService);
 readonly myItems = computed(() => this.work.items().filter(i => i.assigneeName === this.state.user()?.displayName).slice(0, 3));
 readonly firstName = computed(() => this.state.user()?.displayName.split(/\s+/)[0] ?? '');
 greeting() { const h = new Date().getHours(); return h < 5 ? 'Still on shift' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
 lede() {
  if (!this.healthOn()) return 'Chats and tickets across every connected application, with the access your role allows.';
  const n = this.obs.issues().length;
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  if (!n) return 'No known issues are live right now.';
  return `${n === 1 ? 'One known issue is' : `${words[n] ?? n} known issues are`} live right now. If a customer's problem matches one, link it instead of escalating.`;
 }
 waited(since: string) { const m = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }
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
