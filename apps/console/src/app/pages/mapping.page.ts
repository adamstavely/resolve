import { Component, CUSTOM_ELEMENTS_SCHEMA, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
 FAMILY_LABEL, elasticConnectionListSchema, mappingListSchema, mappingViewSchema, type ElasticAppMapping, type ElasticConnection, type MappingView,
} from '../../../../../packages/contracts/src/index';
import { RESOLVE_ELEMENTS } from '../elements';
import { api, AppState, focusField, fullTime, send } from '../state';

const PREVIEW_TEXT: Record<string, string> = {
 ok: 'Found', empty: 'Nothing in the last 24 hours', missing: 'Some ids not found', denied: 'Not permitted for this key', error: 'Check failed', not_configured: 'Not configured',
};
const PREVIEW_TONE: Record<string, string> = { ok: 'safe', empty: 'neutral', missing: 'destructive', denied: 'destructive', error: 'destructive', not_configured: 'neutral' };
const STATE_TEXT: Record<string, string> = { draft: 'Draft: not polled', active: 'Active: polled', disabled: 'Disabled' };

interface Form {
 environment: string; connectionId: string; services: string; apm: string; rum: string; logs: string; synthetics: string;
 sloIds: string; monitorIds: string; alertRuleIds: string; caseTags: string; deepLinkBase: string; subjectPolicy: 'verified_external_id' | 'none';
}
const list = (s: string) => s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
const DEFAULTS: Form = {
 environment: 'production', connectionId: '', services: '', apm: 'traces-apm-*, logs-apm.error-*', rum: 'traces-apm.rum-*', logs: '', synthetics: 'synthetics-*',
 sloIds: '', monitorIds: '', alertRuleIds: '', caseTags: '', deepLinkBase: '', subjectPolicy: 'verified_external_id',
};

/** Parse "name environment [labels.app=value]" lines. */
export function parseServices(text: string): ElasticAppMapping['services'] | string {
 const out: ElasticAppMapping['services'] = [];
 for (const [n, line] of text.split('\n').map(l => l.trim()).filter(Boolean).entries()) {
  const [name, environment, disc, ...rest] = line.split(/\s+/);
  if (!name || !environment || rest.length) return `Line ${n + 1}: write the service name, its environment, and optionally labels.app=value or service.namespace=value.`;
  let discriminator: ElasticAppMapping['services'][number]['discriminator'] = null;
  if (disc) {
   const m = disc.match(/^(labels\.app|service\.namespace)=(.+)$/);
   if (!m) return `Line ${n + 1}: the third part must be labels.app=value or service.namespace=value.`;
   discriminator = { field: m[1] as 'labels.app' | 'service.namespace', value: m[2] };
  }
  out.push({ name, environment, discriminator });
 }
 return out.length ? out : 'Name at least one service.';
}

/**
 * Elastic mapping for one application (plan 14, E1). Saving keeps it as a draft; it is polled only after a preview
 * shows every configured id resolves and an isolation check shows it shares nothing with another app's mapping.
 */
@Component({
 selector: 'rs-mapping-page',
 imports: [RouterLink, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page">
 <header class="page-head">
  <p class="small"><a routerLink="/integrations">Integrations</a></p>
  <h1 class="page-title" tabindex="-1">Elastic mapping: {{ state.appName(appKey()) }}</h1>
  <p class="lp-lede small-lede">Which Elastic data belongs to this application. Resolve reads only what is named here, and polls it only once the checks pass.</p>
 </header>
 @if (message()) { <p class="notice" [attr.data-tone]="error() ? 'destructive' : 'safe'" [attr.role]="error() ? 'alert' : 'status'">{{ message() }}</p> }

 @if (view(); as v) {
  <section class="card pad" aria-labelledby="status-title">
   <h2 class="card-title" id="status-title">Status</h2>
   <dl class="facts">
    <div><dt>State</dt><dd><span class="tag" [attr.data-tone]="v.state === 'active' ? 'safe' : 'neutral'">{{ stateText(v.state) }}</span></dd></div>
    <div><dt>Revision</dt><dd>{{ v.revision }}</dd></div>
    <div><dt>Preview</dt><dd>{{ v.preview ? (v.preview.passed ? 'Passed' : 'Did not pass') + ', ' + fullTime(v.preview.checkedAt) : 'Not run for this revision' }}</dd></div>
    <div><dt>Isolation check</dt><dd>{{ v.isolation ? (v.isolation.passed ? 'Passed' : 'Did not pass') + ', ' + fullTime(v.isolation.checkedAt) : 'Not run for this revision' }}</dd></div>
   </dl>
   <div class="row">
    @if (v.state !== 'active') { <button class="btn btn-primary" type="button" (click)="setState('active')" [disabled]="busy() || !v.preview?.passed || !v.isolation?.passed">Activate</button> }
    @else {
     <button class="btn" type="button" (click)="refresh()" [disabled]="busy()">Check health now</button>
     <button class="btn" type="button" (click)="setState('disabled')" [disabled]="busy()">Disable</button>
    }
   </div>
   @if (v.state !== 'active' && !(v.preview?.passed && v.isolation?.passed)) { <p class="muted small">Pass the preview and the isolation check to activate.</p> }
  </section>
 }

 @if (!ready()) { <p role="status" class="muted">Loading…</p> } @else {
 <section class="card" aria-labelledby="map-title">
  <div class="card-head"><h2 class="card-title" id="map-title">Mapping</h2></div>
  <form class="pad stack-lg" (submit)="save($event)" novalidate>
   <resolve-text-field name="environment" label="Environment" [required]="true" [maxlength]="64" [(value)]="f.environment" [disabled]="!!view()"
    hint="One mapping per application and environment."/>
   <div class="stack-lg">
    <label class="field-label" for="connectionId">Elastic connection</label>
    <select id="connectionId" name="connectionId" class="text-input" [value]="f.connectionId" (change)="f.connectionId = $any($event.target).value">
     <option value="">Choose a connection</option>
     @for (c of connections(); track c.id) { <option [value]="c.id">{{ c.name }}{{ c.killSwitch ? ' (kill switch on)' : '' }}</option> }
    </select>
   </div>
   <div class="stack-lg">
    <label class="field-label" for="services">Services (required)</label>
    <p class="muted small" id="services-hint">One per line: service name, environment, and for a service shared with other applications, labels.app=value or service.namespace=value. A service name alone does not separate applications.</p>
    <textarea id="services" name="services" class="text-input textarea" rows="4" aria-describedby="services-hint" [attr.aria-invalid]="fieldErrors()['services'] ? true : null"
     [value]="f.services" (input)="f.services = $any($event.target).value"></textarea>
    @if (fieldErrors()['services']; as e) { <p class="field-error"><span class="sr-only">Error: </span>{{ e }}</p> }
   </div>
   <resolve-text-field name="apm" label="APM data streams" [(value)]="f.apm" hint="Comma-separated, e.g. traces-apm-*, logs-apm.error-*" [error]="fieldErrors()['indices.apm'] ?? ''"/>
   <resolve-text-field name="rum" label="Real user monitoring data streams" [(value)]="f.rum" [error]="fieldErrors()['indices.rum'] ?? ''"/>
   <resolve-text-field name="logs" label="Log data streams" [(value)]="f.logs" [error]="fieldErrors()['indices.logs'] ?? ''"/>
   <resolve-text-field name="synthetics" label="Synthetics data streams" [(value)]="f.synthetics" [error]="fieldErrors()['indices.synthetics'] ?? ''"/>
   <resolve-text-field name="sloIds" label="SLO ids" [(value)]="f.sloIds" hint="As shown in Kibana, comma-separated." [error]="fieldErrors()['sloIds'] ?? ''"/>
   <resolve-text-field name="monitorIds" label="Synthetic monitor ids" [(value)]="f.monitorIds" [error]="fieldErrors()['monitorIds'] ?? ''"/>
   <resolve-text-field name="alertRuleIds" label="Alerting rule ids" [(value)]="f.alertRuleIds" [error]="fieldErrors()['alertRuleIds'] ?? ''"/>
   <resolve-text-field name="caseTags" label="Case tags" [(value)]="f.caseTags" hint="Open Elastic cases with any of these tags are shown as known issues." [error]="fieldErrors()['caseTags'] ?? ''"/>
   <resolve-text-field name="deepLinkBase" label="Kibana address for links (optional)" kind="url" [(value)]="f.deepLinkBase" [error]="fieldErrors()['deepLinkBase'] ?? ''"/>
   <div class="stack-lg">
    <label class="field-label" for="subjectPolicy">Customer matching</label>
    <select id="subjectPolicy" name="subjectPolicy" class="text-input" [value]="f.subjectPolicy" (change)="f.subjectPolicy = $any($event.target).value">
     <option value="verified_external_id">The application's verified customer id (user.id)</option>
     <option value="none">Service-level only</option>
    </select>
   </div>
   <div class="row"><button class="btn btn-primary" type="submit" [disabled]="busy()">{{ view() ? 'Save changes' : 'Save draft' }}</button>
    @if (view()?.state === 'active') { <span class="muted small">Saving returns the mapping to draft until it is checked again.</span> }</div>
  </form>
 </section>
 }

 @if (view(); as v) {
  <section class="card" aria-labelledby="preview-title">
   <div class="card-head"><h2 class="card-title" id="preview-title">Preview</h2></div>
   <div class="pad stack-lg">
    <p class="muted small">Reads each configured source once (the last 24 hours; synthetics from the last 24 hours too) so you can see what this mapping finds.</p>
    <resolve-text-field name="testSubject" label="Known test customer id (optional)" [(value)]="testSubject" hint="A synthetic customer the application identifies; the preview counts their events."/>
    <div class="row"><button class="btn" type="button" (click)="preview()" [disabled]="busy()">Run preview</button></div>
    @if (v.preview; as p) {
     <div class="table-wrap"><table class="data">
      <caption>Preview {{ p.passed ? 'passed' : 'did not pass' }}, {{ fullTime(p.checkedAt) }}@if (p.testSubjectEvents !== null) { · {{ p.testSubjectEvents }} events for the test customer }</caption>
      <thead><tr><th scope="col">Source</th><th scope="col">Result</th><th scope="col">Found</th><th scope="col">Detail</th></tr></thead>
      <tbody>@for (r of p.families; track r.family) {
       <tr><th scope="row">{{ familyLabel[r.family] }}</th><td><span class="tag" [attr.data-tone]="previewTone(r.status)">{{ previewText(r.status) }}</span></td>
        <td>{{ r.status === 'not_configured' ? '—' : r.found }}</td><td class="small">{{ r.missingIds.length ? 'Not found: ' + r.missingIds.join(', ') : (r.code ?? '') }}</td></tr>
      }</tbody>
     </table></div>
    }
   </div>
  </section>

  <section class="card" aria-labelledby="iso-title">
   <div class="card-head"><h2 class="card-title" id="iso-title">Isolation check</h2></div>
   <div class="pad stack-lg">
    <p class="muted small">Compares this mapping with every other application mapped on the same connection: no event may match both, and no SLO, monitor, rule or case tag may be claimed by both.</p>
    <div class="row"><button class="btn" type="button" (click)="isolation()" [disabled]="busy()">Run isolation check</button></div>
    @if (v.isolation; as iso) {
     @if (!iso.comparedWith.length) { <p class="small">No other application is mapped on this connection yet. Run the check again after mapping another one.</p> }
     @else {
      <div class="table-wrap"><table class="data">
       <caption>Isolation {{ iso.passed ? 'passed' : 'did not pass' }}, {{ fullTime(iso.checkedAt) }}</caption>
       <thead><tr><th scope="col">Other application</th><th scope="col">Shared events (24 hours)</th><th scope="col">Shared ids</th></tr></thead>
       <tbody>@for (c of iso.comparedWith; track c.appKey + c.environment) {
        <tr><th scope="row">{{ state.appName(c.appKey) }} ({{ c.environment }})</th>
         <td><span class="tag" [attr.data-tone]="c.overlappingEvents ? 'destructive' : 'safe'">{{ c.overlappingEvents }}</span></td>
         <td>{{ c.sharedIds.join(', ') || 'None' }}</td></tr>
       }</tbody>
      </table></div>
     }
    }
   </div>
  </section>
 }
</div>`,
})
export class MappingPage {
 readonly appKey = input.required<string>();
 readonly state = inject(AppState);
 readonly view = signal<MappingView | null>(null);
 readonly connections = signal<ElasticConnection[]>([]);
 readonly message = signal('');
 readonly error = signal(false);
 readonly busy = signal(false);
 readonly fieldErrors = signal<Record<string, string>>({});
 readonly testSubject = signal('');
 /** The form appears only once the saved mapping and connections are loaded, so a late load never overwrites input. */
 readonly ready = signal(false);
 readonly familyLabel = FAMILY_LABEL;
 readonly fullTime = fullTime;
 f: Form = { ...DEFAULTS };

 constructor() {
  let started = false;
  effect(() => {
   if (started || !this.state.can('observability.configure')) return;
   started = true;
   untracked(() => Promise.all([
    api('/api/admin/integrations/connections', elasticConnectionListSchema),
    api('/api/admin/integrations/mappings', mappingListSchema),
   ]).then(([c, m]) => {
    this.connections.set(c.connections);
    const mine = m.mappings.find(x => x.appKey === this.appKey());
    if (mine) this.load(mine); else if (c.connections[0]) this.f.connectionId = c.connections[0].id;
    this.ready.set(true);
   }).catch(e => this.fail(e.message)));
  });
 }
 stateText(s: string) { return STATE_TEXT[s] ?? s; }
 previewText(s: string) { return PREVIEW_TEXT[s] ?? s; }
 previewTone(s: string) { return PREVIEW_TONE[s] ?? 'neutral'; }
 private fail(t: string) { this.error.set(true); this.message.set(t); }
 private ok(t: string) { this.error.set(false); this.message.set(t); }

 private load(m: MappingView) {
  this.view.set(m);
  const x = m.mapping;
  this.f = {
   environment: x.environment, connectionId: x.connectionId,
   services: x.services.map(s => [s.name, s.environment, s.discriminator ? `${s.discriminator.field}=${s.discriminator.value}` : ''].filter(Boolean).join(' ')).join('\n'),
   apm: x.indices.apm.join(', '), rum: x.indices.rum.join(', '), logs: x.indices.logs.join(', '), synthetics: x.indices.synthetics.join(', '),
   sloIds: x.sloIds.join(', '), monitorIds: x.monitorIds.join(', '), alertRuleIds: x.alertRuleIds.join(', '), caseTags: x.caseTags.join(', '),
   deepLinkBase: x.deepLinkBase ?? '', subjectPolicy: x.subjectPolicy,
  };
 }

 async save(event: Event) {
  event.preventDefault();
  this.fieldErrors.set({});
  const services = parseServices(this.f.services);
  if (typeof services === 'string') { this.fieldErrors.set({ services }); this.fail(services); focusField('services'); return; }
  if (!this.f.connectionId) { this.fail('Choose an Elastic connection.'); focusField('connectionId'); return; }
  const mapping: ElasticAppMapping = {
   appKey: this.appKey(), environment: this.f.environment.trim(), connectionId: this.f.connectionId,
   indices: { apm: list(this.f.apm), rum: list(this.f.rum), logs: list(this.f.logs), synthetics: list(this.f.synthetics) },
   services, sloIds: list(this.f.sloIds), monitorIds: list(this.f.monitorIds), alertRuleIds: list(this.f.alertRuleIds), caseTags: list(this.f.caseTags),
   deepLinkBase: this.f.deepLinkBase.trim() || null, subjectPolicy: this.f.subjectPolicy,
  };
  this.busy.set(true);
  const res = await send('PUT', '/api/admin/integrations/mappings', { mapping, version: this.view()?.version ?? null }, mappingViewSchema);
  this.busy.set(false);
  if (!res.ok) {
   const field = res.error?.field || '';
   if (field) this.fieldErrors.set({ [field]: res.error!.message });
   this.fail(res.error!.message); focusField(field.split('.').pop());
   return;
  }
  this.load(res.data!);
  this.ok('Saved as a draft. Run the preview and the isolation check, then activate.');
 }

 private async act(path: string, body: unknown, done: (v: MappingView) => string) {
  const v = this.view(); if (!v) return;
  this.busy.set(true);
  const res = await send('POST', `/api/admin/integrations/mappings/${encodeURIComponent(v.appKey)}/${encodeURIComponent(v.environment)}/${path}`, body, mappingViewSchema);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error!.message);
  this.load(res.data!);
  this.ok(done(res.data!));
 }
 preview() { return this.act('preview', this.testSubject().trim() ? { testSubject: this.testSubject().trim() } : {}, v => v.preview?.passed ? 'Preview passed.' : 'The preview did not pass. See what was not found below.'); }
 isolation() { return this.act('isolation', {}, v => v.isolation?.passed ? 'Isolation check passed.' : 'The isolation check did not pass: this mapping shares data with another application.'); }
 setState(state: 'active' | 'disabled') { return this.act('state', { state, version: this.view()!.version }, v => v.state === 'active' ? 'Active. The first health check runs now.' : 'Disabled. Resolve no longer polls this mapping.'); }
 async refresh() {
  const v = this.view(); if (!v) return;
  const res = await send('POST', `/api/admin/integrations/mappings/${encodeURIComponent(v.appKey)}/${encodeURIComponent(v.environment)}/refresh`, {});
  if (res.ok) this.ok('A health check runs as soon as a worker is free.'); else this.fail(res.error!.message);
 }
}
