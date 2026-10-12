import { Component, CUSTOM_ELEMENTS_SCHEMA, effect, inject, signal, untracked, viewChild } from '@angular/core';
import {
 ELASTIC_FAMILIES, FAMILY_LABEL, elasticConnectionListSchema, elasticConnectionSchema, type ElasticConnection, type ElasticFamily,
} from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { RESOLVE_ELEMENTS, ResolveConfirmDialog } from '../elements';
import { api, AppState, focusField, fullTime, send } from '../state';

const FAMILY_STATUS_TEXT: Record<string, string> = {
 supported: 'Available', unsupported: 'Not found for this key', denied: 'Not permitted for this key', error: 'Check failed',
};
const FAMILY_TONE: Record<string, string> = { supported: 'safe', unsupported: 'neutral', denied: 'sensitive', error: 'destructive' };
const FAILURE_TEXT: Record<string, string> = {
 UNAUTHENTICATED: 'Elastic refused the credential. It may be revoked or mistyped.', UNREACHABLE: 'Resolve could not reach this endpoint.',
 TIMEOUT: 'Elastic did not answer in time.', TLS_FAILED: 'The certificate could not be verified. Check the CA bundle.', DNS_FAILED: 'The host name did not resolve.',
 ADDRESS_NOT_ALLOWED: 'The host resolves to an address Resolve may not connect to.', RATE_LIMITED: 'Elastic is rate-limiting Resolve. Try again shortly.',
 HOST_NOT_ALLOWED: 'This host is not on the approved Elastic host list.', REDIRECT_REFUSED: 'Elastic answered with a redirect, which Resolve does not follow.',
};

interface Draft { name: string; elasticsearchUrl: string; kibanaUrl: string; spaceId: string; apiKey: string; caPem: string }
const emptyDraft = (): Draft => ({ name: '', elasticsearchUrl: '', kibanaUrl: '', spaceId: '', apiKey: '', caPem: '' });

/**
 * Integration connections (plan 14, E0). An integration administrator registers Elastic's private endpoints, a Kibana
 * space and a read-only key, then tests it: Resolve records each API family as available, not found, or not
 * permitted. Keys are write-only. The kill switch stops every read at once and keeps evidence and audit.
 */
@Component({
 selector: 'rs-integrations-page',
 imports: [IconComponent, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">Integrations</h1>
  <p class="lp-lede small-lede">Elastic Observability connections that feed service health and customer context. Resolve only reads from Elastic.</p>
 </header>
 @if (message()) { <p class="notice" [attr.data-tone]="error() ? 'destructive' : 'safe'" [attr.role]="error() ? 'alert' : 'status'">{{ message() }}</p> }

 <section class="card" aria-labelledby="conn-title">
  <div class="card-head"><h2 class="card-title" id="conn-title">Elastic connections</h2></div>
  <div class="table-wrap pad-sm"><table class="data">
   <caption class="sr-only">Elastic connections</caption>
   <thead><tr><th scope="col">Connection</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
   <tbody>
    @for (c of connections(); track c.id) {
     <tr>
      <td>{{ c.name }}<div class="muted small">{{ host(c.elasticsearchUrl) }} · space {{ c.spaceId }}</div></td>
      <td>{{ c.discovery?.elasticsearch?.version ?? '—' }}@if (c.discovery?.elasticsearch?.buildFlavor; as f) { <span class="muted small"> ({{ f }})</span> }</td>
      <td><span class="tag" [attr.data-tone]="statusTone(c)">{{ statusText(c) }}</span></td>
      <td><button class="btn btn-sm" type="button" (click)="toggle(c)" [attr.aria-expanded]="open() === c.id" [attr.aria-controls]="'manage-' + c.id">Manage<span class="sr-only"> {{ c.name }}</span></button></td>
     </tr>
     @if (open() === c.id) {
      <tr><td colspan="4" [id]="'manage-' + c.id">
       <div class="manage">
        <dl class="facts">
         <div><dt>Elasticsearch</dt><dd>{{ c.elasticsearchUrl }}</dd></div>
         <div><dt>Kibana</dt><dd>{{ c.kibanaUrl }} (space {{ c.spaceId }})</dd></div>
         <div><dt>Credential</dt><dd>{{ c.credential.kind === 'secret_ref' ? 'Secret reference ' + c.credential.ref : 'Sealed API key' }}, set {{ fullTime(c.credential.rotatedAt) }}</dd></div>
         <div><dt>Certificate trust</dt><dd>{{ c.hasCustomCa ? 'Private CA bundle' : 'System trust store' }}</dd></div>
         @if (c.killSwitch) { <div><dt>Kill switch</dt><dd>On: {{ c.killSwitchReason }}</dd></div> }
        </dl>
        @if (c.discovery; as d) {
         @if (!d.reachable) { <p class="notice" data-tone="destructive">{{ failure(d.failure) }}</p> }
         <div class="table-wrap"><table class="data">
          <caption class="small muted">What this key can read, checked {{ fullTime(d.checkedAt) }}</caption>
          <thead><tr><th scope="col">Data</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
          <tbody>
           @for (f of families; track f) {
            <tr><th scope="row">{{ familyLabel[f] }}</th>
             <td><span class="tag" [attr.data-tone]="familyTone(d.families[f].status)">{{ familyText(d.families[f].status) }}</span></td>
             <td class="muted small">{{ d.families[f].code ?? '' }}</td></tr>
           }
          </tbody>
         </table></div>
        } @else { <p class="muted small">Not tested with the current credential.</p> }
        <div class="row">
         <button class="btn btn-sm" type="button" (click)="test(c)" [disabled]="busy() || c.killSwitch">Test connection</button>
         <button class="btn btn-sm" type="button" (click)="rotating.set(!rotating())" [attr.aria-expanded]="rotating()" [attr.aria-controls]="'rotate-' + c.id">Replace API key</button>
        </div>
        @if (rotating()) {
         <form class="stack-lg" [id]="'rotate-' + c.id" (submit)="rotate($event, c)" aria-label="Replace API key">
          <resolve-text-field name="newApiKey" label="New read-only API key" kind="secret" [required]="true" [(value)]="newKey"
           hint="The old key stops being used immediately. Test the connection afterwards." [error]="fieldErrors()['apiKey'] ?? ''"/>
          <div class="row"><button class="btn btn-sm btn-primary" type="submit" [disabled]="busy()">Save new key</button></div>
         </form>
        }
        <div class="stack-lg">
         <resolve-text-field name="switchReason" label="Reason (recorded in the audit)" [required]="true" [(value)]="switchReason"/>
         <div class="row">
          @if (c.killSwitch) { <button class="btn btn-sm" type="button" (click)="askSwitch(c, false)" [disabled]="busy()">Turn kill switch off…</button> }
          @else { <button class="btn btn-sm" type="button" (click)="askSwitch(c, true)" [disabled]="busy()">Turn kill switch on…</button> }
         </div>
        </div>
       </div>
      </td></tr>
     }
    } @empty { <tr><td colspan="4" class="muted">{{ loading() ? 'Loading…' : 'No Elastic connection yet.' }}</td></tr> }
   </tbody>
  </table></div>
 </section>

 <section class="card" aria-labelledby="add-title">
  <div class="card-head"><h2 class="card-title" id="add-title">Add an Elastic connection</h2></div>
  <form class="pad stack-lg" (submit)="create($event)" novalidate>
   <resolve-text-field name="name" label="Connection name" [required]="true" [maxlength]="80" [(value)]="draft.name" [error]="fieldErrors()['name'] ?? ''"/>
   <resolve-text-field name="elasticsearchUrl" label="Elasticsearch endpoint" kind="url" [required]="true" [(value)]="draft.elasticsearchUrl"
    hint="Private endpoint, https. The host must be on the approved Elastic host list." [error]="fieldErrors()['elasticsearchUrl'] ?? ''"/>
   <resolve-text-field name="kibanaUrl" label="Kibana endpoint" kind="url" [required]="true" [(value)]="draft.kibanaUrl" [error]="fieldErrors()['kibanaUrl'] ?? ''"/>
   <resolve-text-field name="spaceId" label="Kibana space ID" [required]="true" [maxlength]="64" [(value)]="draft.spaceId"
    hint="Where the SLOs, alerts and cases for your applications live." [error]="fieldErrors()['spaceId'] ?? ''"/>
   <resolve-text-field name="apiKey" label="Read-only API key" kind="secret" [required]="true" [(value)]="draft.apiKey"
    hint="Encoded id:key as Elastic issues it. Stored encrypted and never shown again." [error]="fieldErrors()['apiKey'] ?? ''"/>
   <div class="stack-lg">
    <label class="field-label" for="caPem">Private CA bundle (optional)</label>
    <p class="muted small" id="caPem-hint">PEM certificates for a private certificate authority. Certificate checks are never turned off.</p>
    <textarea id="caPem" name="caPem" class="text-input textarea" rows="4" aria-describedby="caPem-hint" [value]="draft.caPem" (input)="draft.caPem = $any($event.target).value"></textarea>
   </div>
   <div class="row"><button class="btn btn-primary" type="submit" [disabled]="busy()"><rs-icon name="plus" [size]="15" />Add connection</button></div>
  </form>
 </section>

 <resolve-confirm-dialog #switchDialogRef [tone]="switchTo() ? 'destructive' : 'default'"
  [heading]="switchTo() ? 'Turn the kill switch on?' : 'Turn the kill switch off?'"
  [description]="switchTo() ? 'Resolve stops reading from this Elastic connection at once. Health and context show as unavailable. Evidence already captured and the audit are kept.' : 'Resolve starts reading from this connection again.'"
  [confirmLabel]="switchTo() ? 'Turn it on' : 'Turn it off'" cancelLabel="Cancel" (confirmed)="applySwitch()"/>
</div>`,
})
export class IntegrationsPage {
 readonly state = inject(AppState);
 readonly connections = signal<ElasticConnection[]>([]);
 readonly loading = signal(true);
 readonly open = signal<string | null>(null);
 readonly busy = signal(false);
 readonly message = signal('');
 readonly error = signal(false);
 readonly fieldErrors = signal<Record<string, string>>({});
 readonly rotating = signal(false);
 readonly newKey = signal('');
 readonly switchReason = signal('');
 readonly switchTo = signal(true);
 readonly switchDialog = viewChild('switchDialogRef', { read: ResolveConfirmDialog });
 readonly families = ELASTIC_FAMILIES as readonly ElasticFamily[];
 readonly familyLabel = FAMILY_LABEL;
 readonly fullTime = fullTime;
 draft: Draft = emptyDraft();
 private switchTarget: ElasticConnection | null = null;

 constructor() {
  let started = false;
  effect(() => {
   if (started || !this.state.can('observability.configure')) return;
   started = true;
   untracked(() => this.load());
  });
 }

 load() {
  api('/api/admin/integrations/connections', elasticConnectionListSchema)
   .then(r => this.connections.set(r.connections)).catch(e => this.fail(e.message)).finally(() => this.loading.set(false));
 }
 host(url: string) { try { return new URL(url).host; } catch { return url; } }
 familyText(s: string) { return FAMILY_STATUS_TEXT[s] ?? s; }
 familyTone(s: string) { return FAMILY_TONE[s] ?? 'neutral'; }
 failure(code: string | null) { return FAILURE_TEXT[code ?? ''] ?? 'The connection test failed.'; }
 statusText(c: ElasticConnection) {
  if (c.killSwitch) return 'Kill switch on';
  if (!c.discovery) return 'Not tested';
  if (!c.discovery.reachable) return 'Unreachable';
  const n = Object.values(c.discovery.families).filter(f => f.status === 'supported').length;
  return `Reachable · ${n} of ${ELASTIC_FAMILIES.length} available`;
 }
 statusTone(c: ElasticConnection) { return c.killSwitch ? 'sensitive' : !c.discovery ? 'neutral' : c.discovery.reachable ? 'safe' : 'destructive'; }
 toggle(c: ElasticConnection) { this.open.set(this.open() === c.id ? null : c.id); this.rotating.set(false); this.newKey.set(''); this.switchReason.set(''); this.message.set(''); }

 private fail(text: string) { this.error.set(true); this.message.set(text); }
 private ok(text: string) { this.error.set(false); this.message.set(text); }
 private replace(c: ElasticConnection) { this.connections.set(this.connections().map(x => (x.id === c.id ? c : x))); }

 async create(event: Event) {
  event.preventDefault();
  this.fieldErrors.set({});
  const d = this.draft;
  const body = { name: d.name.trim(), elasticsearchUrl: d.elasticsearchUrl.trim(), kibanaUrl: d.kibanaUrl.trim(), spaceId: d.spaceId.trim(), apiKey: d.apiKey.trim(), ...(d.caPem.trim() ? { caPem: d.caPem.trim() } : {}) };
  const missing = (['name', 'elasticsearchUrl', 'kibanaUrl', 'spaceId', 'apiKey'] as const).find(k => !body[k]);
  if (missing) { this.fieldErrors.set({ [missing]: 'Fill this in.' }); this.fail('Fill in every required field.'); focusField(missing); return; }
  this.busy.set(true);
  const res = await send('POST', '/api/admin/integrations/connections', body, elasticConnectionSchema);
  this.busy.set(false);
  if (!res.ok) {
   const field = res.error?.field || undefined;
   if (field) this.fieldErrors.set({ [field]: res.error!.message });
   this.fail(res.error!.message); focusField(field);
   return;
  }
  this.draft = emptyDraft();
  this.connections.set([...this.connections(), res.data!].sort((a, b) => a.name.localeCompare(b.name)));
  this.open.set(res.data!.id);
  this.ok(`Added ${res.data!.name}. Test it to see what the key can read.`);
 }

 async test(c: ElasticConnection) {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/integrations/connections/${c.id}/test`, {}, elasticConnectionSchema);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error!.message);
  this.replace(res.data!);
  this.ok(res.data!.discovery?.reachable ? `Tested ${c.name}: ${this.statusText(res.data!)}.` : `Tested ${c.name}: ${this.failure(res.data!.discovery?.failure ?? null)}`);
 }

 async rotate(event: Event, c: ElasticConnection) {
  event.preventDefault();
  this.fieldErrors.set({});
  if (!this.newKey().trim()) { this.fieldErrors.set({ apiKey: 'Enter the new key.' }); focusField('newApiKey'); return; }
  this.busy.set(true);
  const res = await send('POST', `/api/admin/integrations/connections/${c.id}/credential`, { apiKey: this.newKey().trim(), version: c.version }, elasticConnectionSchema);
  this.busy.set(false);
  if (!res.ok) { this.fieldErrors.set({ apiKey: res.error!.message }); return this.fail(res.error!.message); }
  this.replace(res.data!); this.rotating.set(false); this.newKey.set('');
  this.ok(`Replaced the API key for ${c.name}. Test the connection to confirm it.`);
 }

 askSwitch(c: ElasticConnection, on: boolean) {
  if (this.switchReason().trim().length < 3) { this.fail('Give a reason first.'); focusField('switchReason'); return; }
  this.switchTarget = c; this.switchTo.set(on);
  this.switchDialog()?.show();
 }
 async applySwitch() {
  const c = this.switchTarget; if (!c) return;
  this.busy.set(true);
  const res = await send('POST', `/api/admin/integrations/connections/${c.id}/kill-switch`, { killSwitch: this.switchTo(), reason: this.switchReason().trim(), version: c.version }, elasticConnectionSchema);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error!.message);
  this.replace(res.data!); this.switchReason.set('');
  this.ok(res.data!.killSwitch ? `The kill switch is on for ${c.name}. Resolve has stopped reading from it.` : `The kill switch is off for ${c.name}.`);
 }
}
