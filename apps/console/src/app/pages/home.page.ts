import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { BUNDLE_LABELS, CAPABILITIES, dashboardResponseSchema, whoamiResponseSchema, type CapabilityId, type DashboardResponse, type KpiMetric } from '../../../../../packages/contracts/src/index';
import { IconComponent, MarkComponent } from '../icon.component';
import { api, AppState, fullTime, relativeTime } from '../state';

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
 imports: [IconComponent, MarkComponent, RouterLink],
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
     <div class="section-head"><h2 class="section-label" id="apps-title">Your applications</h2></div>
     <p class="muted small">Connect to each application once. Resolve then acts as you there, with only the access your role needs.</p>
     <div class="app-grid">
      @for (a of list.apps; track a.appKey) {
       <article class="app-card" [id]="'app-' + a.appKey" [attr.aria-labelledby]="'app-name-' + a.appKey" [attr.data-unavailable]="!a.servable || null">
        <div class="app-card-top">
         <span class="app-glyph lg" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
         <div class="grow">
          <h3 class="app-card-name" [id]="'app-name-' + a.appKey">{{ a.displayName }}</h3>
          <p class="app-card-key mono">{{ a.appKey }}</p>
         </div>
        </div>
        <dl class="app-card-meta">
         <div><dt>Status</dt><dd><span class="status-dot" [attr.data-tone]="statusTone(a)" aria-hidden="true"></span>{{ statusLabel(a) }}</dd></div>
         <div><dt>Your connection</dt><dd>{{ connectionLabel(a.connection.state) }}</dd></div>
         @if (a.connection.state === 'connected') {
          <div><dt>Access</dt><dd class="chips">@for (sc of toolScopes(a.connection.scopes); track sc) { <span class="chip mono">{{ sc }}</span> } @empty { <span class="muted">Sign-in only</span> }</dd></div>
         }
        </dl>
        @if (a.servable && state.can('connection.manage')) {
         <div class="app-card-actions">
          @if (a.connection.state === 'connected') {
           <button class="btn btn-sm" type="button" (click)="checkConnection(a.appKey, a.displayName)"><rs-icon name="shieldCheck" [size]="15" />Check connection<span class="sr-only"> to {{ a.displayName }}</span></button>
           <form method="post" [action]="'/api/connect/' + a.appKey + '/disconnect'"><button class="btn btn-sm btn-ghost" type="submit">Disconnect<span class="sr-only"> from {{ a.displayName }}</span></button></form>
          } @else {
           <a class="btn btn-sm btn-primary" [href]="'/api/connect/' + a.appKey + '/start'">{{ a.connection.state === 'not_connected' ? 'Connect' : 'Reconnect' }}<span class="sr-only"> to {{ a.displayName }}</span></a>
          }
         </div>
        }
       </article>
      }
     </div>
     <p role="status" class="small muted status-line">{{ connectionCheck() || state.appsError() }}</p>
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
 readonly kpis = KPIS;
 readonly dashboard = signal<DashboardResponse | undefined>(undefined);
 readonly loading = signal(false);
 readonly dashError = signal('');
 readonly connectionCheck = signal('');
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
 toolScopes(scopes: string[]) { return scopes.filter(s => s !== 'openid' && s !== 'offline_access'); }
 activityLabel(kind: string) { return ACTIVITY_LABELS[kind] ?? kind; }
 capabilitySummary(id: CapabilityId) { return CAPABILITIES[id].summary; }

 checkConnection(appKey: string, name: string) {
  this.connectionCheck.set(`Checking ${name}…`);
  fetch(`/api/apps/${encodeURIComponent(appKey)}/whoami`, { credentials: 'same-origin' }).then(async r => {
   const body = await r.json();
   if (!r.ok) { this.connectionCheck.set(`${name}: ${body.error?.message ?? 'check failed.'}`); if (body.error?.code === 'RECONNECT_REQUIRED') this.state.loadApps(); return; }
   const who = whoamiResponseSchema.parse(body);
   this.connectionCheck.set(`${name} recognises you as ${who.tenantUserId} with ${this.toolScopes(who.scopes).join(', ') || 'sign-in only'}.`);
  }).catch(() => this.connectionCheck.set(`${name}: check failed.`));
 }
}
