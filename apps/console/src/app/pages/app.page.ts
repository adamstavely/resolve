import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { dashboardResponseSchema, liveActivitySchema, whoamiResponseSchema, type AppHealth } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { HEALTH_ICON, HEALTH_LABEL, HEALTH_TONE, ObservabilityService, REASON_TEXT } from '../observability.service';
import { api, AppState, fullTime, relativeTime } from '../state';
import { BannerModalComponent } from './banner-modal.component';
import { IssueLinkService } from './issues.component';
import { ToolRailComponent, type RailTool } from './tools.component';
import { ClearanceService, hm, SrcComponent, TierBadgeComponent } from '../ui';
import { PRIORITY_CODE, WorkService } from '../work.service';
import type { z } from 'zod';

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
 * Application workspace (prototype v2 `Workspace`, plan 16): tool rail | overview, changes and activity | ownership,
 * your open tickets, account search and your connection. The overview's service health panel lists what was checked:
 * every SLO, alert rule and synthetic check that was read, with its fact, source and age.
 */
@Component({
 selector: 'rs-app-page',
 imports: [BannerModalComponent, IconComponent, NgTemplateOutlet, RouterLink, SrcComponent, TierBadgeComponent, ToolRailComponent],
 template: `
@if (app(); as a) {
<div class="case" data-kind="app">
 <rs-tool-rail [appName]="a.displayName" subtitle="Account tools" [tier]="tier()" [tools]="railTools()" (run)="runTool($event)" />

 <div class="conv">
  <div class="conv-head" style="padding-bottom:0">
   <div class="ctx-cust" style="padding:4px 0 12px">
    <span class="app-glyph" style="width:40px;height:40px;font-size:18.4px" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
    <div style="flex:1;min-width:180px">
     <h1 class="nm" tabindex="-1" style="margin:0">{{ a.displayName }}</h1>
     <div style="font-size:var(--fs-xs);color:var(--ink-3)">{{ a.description || a.appKey }}</div>
    </div>
    @if (health(); as h) { <span class="insp-status"><span class="status-dot" [attr.data-tone]="tone[h.state]" aria-hidden="true"></span> {{ label[h.state] }}</span> }
    <span class="tier-line" style="font-size:var(--fs-xs)">Your clearance <rs-tier [tier]="tier()" size="sm" /></span>
   </div>
   <div class="ctx-tabs" role="tablist" aria-label="Application" style="background:transparent;border-bottom:0;position:static">
    @for (t of tabs(); track t.id) {
     <button class="ctx-tab" type="button" role="tab" [id]="'atab-' + t.id" [attr.aria-selected]="tab() === t.id" [attr.aria-controls]="'apanel'" [attr.tabindex]="tab() === t.id ? 0 : -1"
      [attr.data-on]="tab() === t.id" (click)="tab.set(t.id)" (keydown)="tabKey($event)">{{ t.label }}@if (t.n) { <span class="n" data-tone="sensitive">{{ t.n }}</span> }</button>
    }
   </div>
  </div>
  <div class="appbody" id="apanel" role="tabpanel" [attr.aria-labelledby]="'atab-' + tab()">
   @if (message(); as m) { <p class="notice" [attr.data-tone]="m.alert ? 'destructive' : 'safe'" [attr.role]="m.alert ? 'alert' : 'status'" style="margin:0">{{ m.text }}</p> }
   @switch (tab()) {
    @case ('overview') {
     <div class="facts-grid" style="margin:0;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr))">
      <div class="fact"><div class="k">SLO</div><div class="v mono" style="font-size:var(--fs-sm)">{{ health() ? sloLine(health()!) : '—' }}</div></div>
      <div class="fact"><div class="k">Active alerts</div><div class="v mono" [style.color]="health()?.summary?.activeAlerts ? 'var(--sensitive-ink)' : null">{{ health()?.summary?.activeAlerts ?? '—' }}</div></div>
      <div class="fact"><div class="k">Synthetics</div><div class="v" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
       @if (health()?.summary?.synthetics?.recent?.length) {
        <span class="ticks" aria-hidden="true">@for (r of health()!.summary.synthetics.recent; track $index) { <i [class.f]="r.status === 'down'"></i> }</span><span class="mono">{{ passed() }}/{{ health()!.summary.synthetics.recent.length }}</span>
       } @else { <span class="mono">—</span> }</div></div>
      <div class="fact"><div class="k">Open tickets</div><div class="v mono">{{ openTickets() ?? '—' }}</div></div>
     </div>
     @if (state.can('observability.health')) {
      @if (issue(); as i) {
       <section class="inc-banner" aria-label="Active incident">
        <span class="inc-ic" aria-hidden="true"><rs-icon name="alert" [size]="17" /></span>
        <div class="inc-body">
         <div class="inc-title"><span>{{ i.title }}</span><rs-src [k]="i.kind === 'case' ? 'CASE' : 'ALERT'" /></div>
         <div class="inc-detail">Active since {{ hm(i.since) }}.@if (i.affected; as af) { <b> About {{ af.count }} customers affected · {{ i.linkedTickets }} linked tickets.</b> }</div>
         <div class="meta" style="margin-top:6px">{{ i.kind === 'case' ? 'case ' + i.providerId : 'alert' }}@if (i.service) { · {{ i.service }} } · {{ i.environment }}</div>
         <div class="inc-actions" style="margin-top:10px">
          <button class="btn btn-sm" type="button" (click)="links.copyMessage(i)"><rs-icon name="copy" [size]="14" />Copy customer message</button>
          @if (state.can('observability.link') && state.can('ticket.read')) { <button class="btn btn-sm btn-primary" type="button" (click)="links.open(i)"><rs-icon name="link" [size]="14" />Bulk-link tickets</button> }
         </div>
        </div>
       </section>
      } @else if (health() && !health()!.reason) {
       <section class="inc-banner" data-linked="true" style="align-items:center" aria-label="No active incidents">
        <span class="inc-ic" style="background:var(--safe-soft);color:var(--safe)" aria-hidden="true"><rs-icon name="check" [size]="17" /></span>
        <div class="inc-body"><div class="inc-title"><span>No active incidents on {{ a.displayName }}</span><rs-src k="ALERTS" /></div><div class="inc-detail">{{ health()!.state === 'healthy' ? 'All SLOs within budget and every synthetic check passing.' : 'No open case or active alert. See what was checked below.' }}</div></div>
       </section>
      }
      <section class="panel" aria-labelledby="checked-title">
       <div class="ph2"><h2 class="pt2" id="checked-title" style="margin:0"><rs-icon name="activity" [size]="15" /> Service health · what was checked</h2><span class="tags"><rs-src k="APM" /><rs-src k="SLO" /><rs-src k="SYNTHETICS" /></span></div>
       @if (health(); as h) {
        @if (h.reason) { <div class="pnote" style="border-bottom:0">{{ reasonText(h.reason) }}</div> }
        @else {
         @if (h.provenance; as p) { <div class="pnote">{{ h.environment }} · {{ h.state === 'stale' ? 'out of date: last checked' : 'checked' }} <time [attr.datetime]="p.fetchedAt" [attr.title]="fullTime(p.fetchedAt)">{{ relativeTime(p.fetchedAt) }}</time>@if (p.completeness === 'partial') { · partial: {{ p.missing.join(', ') }} could not be read }</div> }
         <div style="overflow-x:auto">
          <table class="tbl" style="font-size:var(--fs-sm)">
           <caption class="sr-only">What was checked for {{ a.displayName }}</caption>
           <thead><tr><th scope="col" style="padding-left:var(--pad)">Check</th><th scope="col">Source</th><th scope="col">State</th><th scope="col">What Elastic reported</th></tr></thead>
           <tbody>
            @for (c of h.components; track c.key) {
             <tr><td style="padding-left:var(--pad)"><span class="tags" style="gap:8px;flex-wrap:nowrap"><span class="dot" [attr.data-tone]="tone[c.state]" aria-hidden="true"></span><span class="mono">{{ c.label }}</span></span></td>
              <td>{{ familyText(c.family) }}</td><td>{{ label[c.state] }}</td><td style="color:var(--ink-2)">{{ c.detail }}</td></tr>
            } @empty { <tr><td colspan="4" style="padding-left:var(--pad)">Nothing configured to check.</td></tr> }
           </tbody>
          </table>
         </div>
         @if (h.summary.synthetics.recent.length) {
          <div class="prow" style="flex-direction:column;gap:6px">
           <span class="lbl" style="font-size:10px">Recent synthetic runs</span>
           <ol style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px">
            @for (r of h.summary.synthetics.recent.slice().reverse(); track $index) {
             <li class="tags" style="gap:8px;font-size:var(--fs-xs)"><span class="dot" [attr.data-tone]="r.status === 'up' ? 'safe' : 'destructive'" aria-hidden="true"></span><span>{{ r.status === 'up' ? 'Passed' : 'Failed' }}</span><span>{{ r.label }}</span><time class="meta" [attr.datetime]="r.checkedAt">{{ relativeTime(r.checkedAt) }}</time></li>
            }
           </ol>
          </div>
         }
        }
       } @else { <div class="pnote" style="border-bottom:0">{{ obs.loaded() ? 'No health for this application.' : 'Loading…' }}</div> }
      </section>
     }
     <ng-container *ngTemplateOutlet="changed" />
    }
    @case ('changes') { <ng-container *ngTemplateOutlet="changed" /> }
    @case ('activity') {
     <section class="panel" aria-labelledby="ra-title">
      <div class="ph2"><h2 class="pt2" id="ra-title" style="margin:0"><rs-icon name="activity" [size]="15" /> Recent actions on {{ a.displayName }}</h2><rs-src k="AUDIT" /></div>
      @for (r of actions(); track $index) {
       <div class="prow" style="align-items:center">
        <span class="dot" [attr.data-tone]="r.verification === 'verified' ? 'safe' : r.verification === 'awaiting' ? 'sensitive' : 'neutral'" aria-hidden="true"></span>
        <div style="flex:1;min-width:0">
         <div style="font-size:var(--fs-sm)">@if (r.operationId) { <a [routerLink]="['/receipts', r.operationId]">{{ r.action }}</a> } @else { {{ r.action }} }</div>
         <div class="feed-line2"><span>{{ r.own ? 'you' : r.actor }}</span>@if (r.target) { <span>·</span><span>{{ r.target }}</span> }<span>·</span><span>{{ hm(r.at) }}</span></div>
        </div>
        @if (r.verification === 'verified') { <span class="verif" data-s="ok">✓ verified in logs</span> } @else if (r.verification === 'awaiting') { <span class="verif" data-s="wait">awaiting confirmation</span> }
       </div>
      } @empty { <div class="pnote" style="border-bottom:0">No actions on {{ a.displayName }} in the last 24 hours.</div> }
     </section>
    }
   }
  </div>
 </div>

 <div class="ctx">
  <div class="ctx-inner">
   <section class="panel" aria-labelledby="own-title">
    <div class="ph2"><h2 class="pt2" id="own-title" style="margin:0">Ownership and on-call</h2><span class="tags"><rs-src k="CMDB" /><rs-src k="ON-CALL" /></span></div>
    <div class="pnote" style="border-bottom:0">Service ownership, on-call and the escalation path come from the ServiceNow CMDB, which is not connected yet.</div>
   </section>
   @if (state.can('chat.read') || state.can('ticket.read')) {
    <section class="panel" aria-labelledby="yt-title">
     <div class="ph2"><h2 class="pt2" id="yt-title" style="margin:0"><rs-icon name="inbox" [size]="15" /> Your open tickets</h2><rs-src k="QUACKBACK" /></div>
     @if (!mine().length) { <div class="pnote" style="border-bottom:0">No tickets assigned to you on {{ a.displayName }}.</div> }
     @else {
      <div style="padding:6px">
       @for (c of mine(); track c.kind + c.id) {
        <a class="qrow" [routerLink]="[c.kind === 'ticket' ? '/tickets' : '/inbox', c.appKey, c.id]">
         <span class="ch-ic" style="width:30px;height:30px" aria-hidden="true"><rs-icon [name]="c.channel === 'chat' ? 'chat' : 'mail'" [size]="14" />@if (c.channel === 'chat') { <span class="live"></span> }</span>
         <div style="flex:1;min-width:0"><div class="qt">{{ c.subject }}</div><div class="feed-line2"><span>{{ c.ref }}</span>@if (c.customer) { <span>·</span><span>{{ c.customer }}</span> }</div></div>
         @if (c.waitingSince) { <span class="waiting">{{ waited(c.waitingSince) }}</span> } @else { <span class="prio" [attr.data-p]="code(c.priority)">{{ code(c.priority) }}</span> }
        </a>
       }
      </div>
     }
    </section>
   }
   <section class="panel" aria-labelledby="fa-title">
    <div class="ph2"><h2 class="pt2" id="fa-title" style="margin:0"><rs-icon name="users" [size]="15" /> Find an account</h2></div>
    <div class="pnote" style="border-bottom:0">Account search and the account inspector come from {{ a.displayName }}'s account tools, which are not connected yet.</div>
   </section>
   <section class="panel" aria-labelledby="conn-title">
    <div class="ph2"><h2 class="pt2" id="conn-title" style="margin:0"><rs-icon name="shieldCheck" [size]="15" /> Your connection</h2></div>
    <div style="padding:11px var(--pad)">
     <div class="kv"><span class="k">Status</span><span><span class="status-dot" [attr.data-tone]="a.servable ? (a.dormant ? 'neutral' : 'safe') : 'sensitive'" aria-hidden="true" style="margin-right:6px"></span>{{ a.servable ? (a.dormant ? 'Idle' : 'Available') : 'Unavailable (' + a.state + ')' }}</span></div>
     <div class="kv"><span class="k">Your connection</span><span>{{ connectionLabel(a.connection.state) }}</span></div>
     @if (a.connection.state === 'connected') {
      <div class="kv"><span class="k">Access</span><span class="tags" style="justify-content:flex-end">@for (sc of toolScopes(a.connection.scopes); track sc) { <span class="state-chip">{{ sc }}</span> } @empty { <span>Sign-in only</span> }</span></div>
     }
     @if (a.servable && state.can('connection.manage')) {
      <div class="comp-row" style="margin-top:10px">
       @if (a.connection.state === 'connected') {
        <button class="btn btn-sm" type="button" (click)="checkConnection(a.appKey, a.displayName)"><rs-icon name="shieldCheck" [size]="14" />Check connection<span class="sr-only"> to {{ a.displayName }}</span></button>
        <form method="post" [action]="'/api/connect/' + a.appKey + '/disconnect'" style="margin:0"><button class="btn btn-sm btn-ghost" type="submit">Disconnect<span class="sr-only"> from {{ a.displayName }}</span></button></form>
       } @else {
        <a class="btn btn-sm btn-primary" [href]="'/api/connect/' + a.appKey + '/start'">{{ a.connection.state === 'not_connected' ? 'Connect' : 'Reconnect' }}<span class="sr-only"> to {{ a.displayName }}</span></a>
       }
      </div>
     } @else if (!a.servable) { <p class="small muted" style="margin:8px 0 0">{{ a.displayName }} cannot be connected while it is unavailable.</p> }
     <p role="status" class="small muted" style="margin:6px 0 0">{{ connectionCheck() }}</p>
    </div>
   </section>
  </div>
 </div>
</div>
@if (bannerOpen()) { <rs-banner-modal [appKey]="a.appKey" [appName]="a.displayName" (closed)="bannerOpen.set(false)" /> }
<ng-template #changed>
 <section class="panel" aria-labelledby="chg-title">
  <div class="ph2"><h2 class="pt2" id="chg-title" style="margin:0"><rs-icon name="branch" [size]="15" /> What changed?</h2><span class="tags"><rs-src k="CHANGE" /><rs-src k="CMDB" /></span></div>
  <div class="pnote" style="border-bottom:0">Deploys, change requests and rollbacks come from ServiceNow, which is not connected yet.</div>
 </section>
</ng-template>
} @else if (state.apps()) {
 <div class="esc-page">
  <h1 class="esc-h1" tabindex="-1">Application not found</h1>
  <p class="notice" data-tone="destructive" role="alert" style="margin-top:12px">This application is not registered. <a routerLink="/">Back to Home</a></p>
 </div>
} @else { <p role="status" class="meta" style="padding:24px">Loading…</p> }`,
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

 private readonly clearance = inject(ClearanceService);
 private readonly work = inject(WorkService);
 readonly links = inject(IssueLinkService);
 readonly hm = hm;
 /** Your tier in this app as the app reports it (QB-TIER-1). */
 readonly tier = computed(() => this.clearance.tierOf(this.appKey()));
 readonly tab = signal<'overview' | 'changes' | 'activity'>('overview');
 /** "Create banner" (owner decision 2026-10-12): for banner publishers, and for anyone this application reports at Tier 1 or higher. */
 readonly railTools = computed<RailTool[]>(() => {
  const can = this.state.can('broadcast.publish') || (this.state.can('broadcast.app') && !!this.tier());
  return can ? [{ id: 'banner', name: 'Create banner', icon: 'megaphone', cat: 'Announcements' }] : [];
 });
 readonly bannerOpen = signal(false);
 runTool(t: RailTool) { if (t.id === 'banner') this.bannerOpen.set(true); }
 readonly tabs = computed(() => [{ id: 'overview' as const, label: 'Overview', n: this.health()?.summary?.activeAlerts || null }, { id: 'changes' as const, label: 'Changes', n: null }, { id: 'activity' as const, label: 'Activity', n: null }]);
 readonly issue = computed(() => { const l = this.obs.issues().filter(i => i.appKey === this.appKey()); return l.find(i => i.kind === 'case') ?? l[0] ?? null; });
 readonly mine = computed(() => this.work.items().filter(i => i.appKey === this.appKey() && i.assigneeName === this.state.user()?.displayName));
 readonly actions = signal<z.infer<typeof liveActivitySchema>['entries']>([]);
 readonly openCount = signal<number | null>(null);
 openTickets() { return this.openCount(); }
 passed() { return this.health()?.summary.synthetics.recent.filter(r => r.status === 'up').length ?? 0; }
 code(p: string) { return PRIORITY_CODE[p] ?? 'P4'; }
 waited(since: string) { const m = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }
 sloLine(h: AppHealth) {
  const s = h.summary.slos;
  if (h.reason) return '—';
  if (!s.total) return 'Not configured';
  if (!s.degrading && !s.violated) return s.healthy ? 'All within budget' : 'No data';
  if (s.worstBurn) return `${s.worstBurn.name} ${+(s.worstBurn.target * 100).toFixed(2)}% · burning ${s.worstBurn.value.toFixed(1)}x`;
  return s.violated ? 'Violated' : 'Degrading';
 }
 tabKey(e: KeyboardEvent) {
  const ids = this.tabs().map(t => t.id); const i = ids.indexOf(this.tab());
  const next = e.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : e.key === 'ArrowLeft' ? ids[(i + ids.length - 1) % ids.length] : null;
  if (!next) return;
  e.preventDefault(); this.tab.set(next); setTimeout(() => document.getElementById('atab-' + next)?.focus());
 }
 constructor() {
  effect(() => { if (this.state.can('ticket.read')) untracked(() => { this.clearance.load(); this.work.loadTickets(); }); });
  effect(() => {
   const key = this.appKey(); void this.obs.health();
   if (!this.state.can('observability.health')) return;
   untracked(() => api('/api/observability/activity', liveActivitySchema).then(r => { if (key === this.appKey()) this.actions.set(r.entries.filter(e => e.appKey === key).slice(0, 12)); }).catch(() => {}));
  });
  effect(() => {
   const key = this.appKey();
   if (!this.state.can('dashboard.view')) return;
   untracked(() => api('/api/dashboard', dashboardResponseSchema).then(d => {
    const r = d.apps.find(a => a.appKey === key); const m = r?.status === 'ok' ? r.data.metrics.openTickets : null;
    if (key === this.appKey()) this.openCount.set(m && m.status === 'available' ? m.value : null);
   }).catch(() => {}));
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
