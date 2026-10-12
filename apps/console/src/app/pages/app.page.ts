import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { clearanceResponseSchema, whoamiResponseSchema } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TONE, ObservabilityService, REASON_TEXT } from '../observability.service';
import { api, AppState, fullTime, relativeTime } from '../state';
import { KnownIssuesComponent } from './service-health.component';

const CONNECTION_LABELS: Record<string, string> = {
 not_connected: 'Not connected', connecting: 'Connecting', connected: 'Connected', reconnect_required: 'Reconnect required', revoked: 'Access revoked', denied: 'Denied',
};
const FAMILY_TEXT: Record<string, string> = { slo: 'SLO', alerts: 'Alerts', synthetics: 'Synthetic check', cases: 'Cases', apm: 'APM', rum: 'RUM', logs: 'Logs' };
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

/**
 * One application (opened from its card or the navigation). Its connection and actions, and the detail behind its
 * health card: every SLO, alert rule and synthetic check that was read, with its fact, source and age.
 */
@Component({
 selector: 'rs-app-page',
 imports: [IconComponent, RouterLink, KnownIssuesComponent],
 template: `
<div class="page">
 @if (app(); as a) {
  <header class="page-head head-row">
   <span class="app-glyph lg" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
   <div class="grow">
    <h1 class="page-title" tabindex="-1">{{ a.displayName }}</h1>
    <p class="muted small">{{ a.description || a.appKey }}</p>
   </div>
   @if (health(); as h) { <span class="health-status"><span class="status-dot" [attr.data-tone]="tone[h.state]" aria-hidden="true"></span>{{ label[h.state] }}</span> }
  </header>
  @if (message(); as m) { <p class="notice" [attr.data-tone]="m.alert ? 'destructive' : 'safe'" [attr.role]="m.alert ? 'alert' : 'status'">{{ m.text }}</p> }

  <div class="lp-cols">
   <div class="stack-lg">
    @if (state.can('observability.health')) {
     <section class="card" aria-labelledby="checked-title">
      <div class="card-head"><h2 class="card-title" id="checked-title"><rs-icon name="pulse" [size]="15" />What was checked</h2><span class="card-meta">Elastic</span></div>
      @if (health(); as h) {
       @if (h.reason) { <p class="pad muted">{{ reasonText(h.reason) }}</p> }
       @else {
        <div class="table-wrap pad-sm"><table class="data">
         <caption>
          @if (h.provenance; as p) {
           {{ h.environment }} · {{ h.state === 'stale' ? 'out of date: last checked' : 'checked' }} <time [attr.datetime]="p.fetchedAt" [attr.title]="fullTime(p.fetchedAt)">{{ relativeTime(p.fetchedAt) }}</time>
           @if (p.completeness === 'partial') { · partial: {{ p.missing.join(', ') }} could not be read }
          }
         </caption>
         <thead><tr><th scope="col">Check</th><th scope="col">Source</th><th scope="col">State</th><th scope="col">What Elastic reported</th></tr></thead>
         <tbody>
          @for (c of h.components; track c.key) {
           <tr><th scope="row">{{ c.label }}</th><td>{{ familyText(c.family) }}</td>
            <td><span class="tag" [attr.data-tone]="tone[c.state]"><rs-icon [name]="icon[c.state]" [size]="13" />{{ label[c.state] }}</span></td>
            <td class="small">{{ c.detail }}</td></tr>
          } @empty { <tr><td colspan="4" class="muted">Nothing configured to check.</td></tr> }
         </tbody>
        </table></div>
        @if (h.summary.synthetics.recent.length) {
         <div class="pad">
          <h3 class="field-label">Recent synthetic runs</h3>
          <ol class="run-list">
           @for (r of h.summary.synthetics.recent.slice().reverse(); track $index) {
            <li><span class="tag" [attr.data-tone]="r.status === 'up' ? 'safe' : 'destructive'">{{ r.status === 'up' ? 'Passed' : 'Failed' }}</span>
             <span>{{ r.label }}</span><time class="muted small" [attr.datetime]="r.checkedAt">{{ relativeTime(r.checkedAt) }}</time></li>
           }
          </ol>
         </div>
        }
       }
      } @else { <p class="pad muted small">{{ obs.loaded() ? 'No health for this application.' : 'Loading…' }}</p> }
     </section>
    }

    <section class="card" aria-labelledby="conn-title">
     <div class="card-head"><h2 class="card-title" id="conn-title"><rs-icon name="shieldCheck" [size]="15" />Your connection</h2></div>
     <div class="pad stack-lg">
      <dl class="facts">
       <div><dt>Status</dt><dd><span class="status-dot" [attr.data-tone]="a.servable ? (a.dormant ? 'neutral' : 'safe') : 'sensitive'" aria-hidden="true"></span>{{ a.servable ? (a.dormant ? 'Idle' : 'Available') : 'Unavailable (' + a.state + ')' }}</dd></div>
       <div><dt>Your connection</dt><dd>{{ connectionLabel(a.connection.state) }}</dd></div>
       @if (state.can('ticket.read')) { <div><dt>Your clearance</dt><dd>{{ tier() ? 'T' + tier() : 'Not reported by ' + a.displayName }}</dd></div> }
       @if (a.connection.state === 'connected') {
        <div><dt>Access</dt><dd class="chips">@for (sc of toolScopes(a.connection.scopes); track sc) { <span class="chip mono">{{ sc }}</span> } @empty { <span class="muted">Sign-in only</span> }</dd></div>
       }
      </dl>
      @if (a.servable && state.can('connection.manage')) {
       <div class="row">
        @if (a.connection.state === 'connected') {
         <button class="btn btn-sm" type="button" (click)="checkConnection(a.appKey, a.displayName)"><rs-icon name="shieldCheck" [size]="15" />Check connection<span class="sr-only"> to {{ a.displayName }}</span></button>
         <form method="post" [action]="'/api/connect/' + a.appKey + '/disconnect'"><button class="btn btn-sm btn-ghost" type="submit">Disconnect<span class="sr-only"> from {{ a.displayName }}</span></button></form>
        } @else {
         <a class="btn btn-sm btn-primary" [href]="'/api/connect/' + a.appKey + '/start'">{{ a.connection.state === 'not_connected' ? 'Connect' : 'Reconnect' }}<span class="sr-only"> to {{ a.displayName }}</span></a>
        }
       </div>
      } @else if (!a.servable) { <p class="muted small">{{ a.displayName }} cannot be connected while it is unavailable.</p> }
      <p role="status" class="small muted">{{ connectionCheck() }}</p>
     </div>
    </section>
   </div>
   <aside class="stack-lg" aria-label="Issues and work">
    @if (state.can('observability.health')) { <rs-known-issues [appKey]="a.appKey" /> }
    @if (state.can('ticket.read')) { <p class="small"><a routerLink="/tickets">Tickets</a> · <a routerLink="/inbox">Inbox</a></p> }
   </aside>
  </div>
 } @else if (state.apps()) {
  <header class="page-head"><h1 class="page-title" tabindex="-1">Application not found</h1></header>
  <p class="notice" data-tone="destructive" role="alert">This application is not registered. <a routerLink="/">Back to Home</a></p>
 } @else { <p role="status" class="muted">Loading…</p> }
</div>`,
})
export class AppPage {
 readonly appKey = input.required<string>();
 readonly state = inject(AppState);
 readonly obs = inject(ObservabilityService);
 readonly label = HEALTH_LABEL;
 readonly tone = HEALTH_TONE;
 readonly icon = HEALTH_ICON;
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly connectionCheck = signal('');
 readonly app = computed(() => this.state.apps()?.apps.find(a => a.appKey === this.appKey()));
 readonly health = computed(() => this.obs.byApp().get(this.appKey()));
 private readonly connectResult = new URLSearchParams(location.search).get('connect');
 readonly message = computed(() => connectMessage(this.connectResult, this.app()?.displayName ?? 'the application'));

 /** Your tier in this app as the app reports it (QB-TIER-1). */
 readonly tier = signal<1 | 2 | 3 | null>(null);
 constructor() {
  let asked = false;
  effect(() => {
   if (asked || !this.state.can('ticket.read')) return;
   asked = true;
   untracked(() => api('/api/clearance', clearanceResponseSchema).then(r => this.tier.set(r.apps.find(x => x.appKey === this.appKey())?.tier ?? null)).catch(() => {}));
  });
  // Drop the one-time connect result from the address bar so a reload does not repeat it.
  if (this.connectResult) history.replaceState(null, '', location.pathname);
 }
 reasonText(r: string) { return REASON_TEXT[r] ?? r; }
 familyText(f: string) { return FAMILY_TEXT[f] ?? f; }
 connectionLabel(s: string) { return CONNECTION_LABELS[s] ?? s; }
 toolScopes(scopes: string[]) { return scopes.filter(s => s !== 'openid' && s !== 'offline_access'); }
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
