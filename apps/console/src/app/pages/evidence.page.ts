import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { evidenceSnapshotSchema, type EvidenceSnapshot, type SubjectEvent } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { HEALTH_LABEL } from '../observability.service';
import { api, AppState, fullTime, relativeTime, send } from '../state';

const SUBJECT_TEXT: Record<string, string> = {
 verified: 'Customer identified by the application', unverified: 'Customer not identified by the application', not_reported: 'The application does not report customer ids',
 not_mapped: 'Application not connected to Elastic', policy_none: 'Service-level only by policy', unavailable: 'Elastic was unavailable',
};
const CLASS_TEXT: Record<string, string> = { service: 'Service level', subject: 'Customer level', restricted: 'Restricted' };
const NOTE_TEXT: Record<string, string> = { succeeded: 'Internal note added', pending: 'Internal note pending', failed: 'Internal note not added', uncertain: 'Internal note not confirmed' };

/**
 * One evidence snapshot (plan 14, E2; prototype board 4, evidence section). Numbered facts with their sources, as the
 * capturer could see them at capture time. Access is re-checked on every view; restricted items are hidden and
 * counted for viewers without the investigator role. The hash shows the record is unchanged, not that it is true.
 */
@Component({
 selector: 'rs-evidence-page',
 imports: [IconComponent, RouterLink],
 template: `
<div class="page">
 @if (snap(); as s) {
  <div class="row-wrap">
   <span class="lbl ev-eyebrow">Evidence snapshot</span>
   <span class="ev-badge" [attr.data-tone]="s.classification === 'restricted' ? 'destructive' : 'neutral'">{{ classText(s.classification) }}</span>
   <span class="ev-badge" [attr.data-tone]="s.hashVerified ? 'safe' : 'destructive'">{{ s.hashVerified ? 'Unchanged since capture' : 'Does not match its hash' }}</span>
  </div>
  <h1 class="ev-title" tabindex="-1">{{ state.appName(s.appKey) }} {{ s.objectKind }}: evidence at {{ time(s.capturedAt) }}</h1>
  <div class="ev-meta">{{ state.appName(s.appKey) }} · <a [routerLink]="itemLink(s)">Open the {{ s.objectKind }}</a> · captured by {{ s.capturedBy }} · {{ relativeTime(s.capturedAt) }} · {{ subjectText(s.subjectStatus) }}</div>

  <div class="ctx-pair ev-cols">
   <div class="ev-main">
    <section class="card" aria-labelledby="ev-title">
     <div class="card-head"><h2 class="card-title" id="ev-title"><rs-icon name="doc" [size]="15" />Evidence snapshot</h2><span class="mono ctx-meta">captured {{ fullTime(s.capturedAt) }} · window {{ fullTime(s.requested.from) }} to {{ fullTime(s.requested.to) }}</span></div>

     <div class="sec">
      <div class="sh"><span class="cite">1</span><b>Service health at time of capture</b><span class="src">ALERTS</span><span class="src">SLO</span><span class="src">SYNTHETICS</span></div>
      @if (s.facts.health; as h) {
       <p class="ev-text">{{ healthLabel[h.state] }}.@if (h.summary.slos.worstBurn; as b) { {{ b.name }} ({{ pct(b.target) }}) burning {{ b.value.toFixed(1) }}x over {{ b.window }}. } {{ h.summary.activeAlerts }} active alerts. Synthetics {{ h.summary.synthetics.passing }} of {{ h.summary.synthetics.total }} passing{{ h.summary.synthetics.failing.length ? ' (failing: ' + h.summary.synthetics.failing.join(', ') + ')' : '' }}.</p>
      } @else { <p class="ev-text muted">No health was available.</p> }
      @for (i of s.facts.issues; track i.issueId) {
       <p class="ev-text"><span class="status-dot" data-tone="sensitive" aria-hidden="true"></span> {{ i.kind === 'case' ? 'Case ' + i.providerId : 'Alert' }}: {{ i.title }} (since {{ time(i.since) }}). Matched: {{ i.matched.join('; ') }}.@if (i.missing.length) { Not established: {{ i.missing.join('; ') }}.}</p>
      }
     </div>

     <div class="sec">
      <div class="sh"><span class="cite">2</span><b>Customer events vs. issue windows</b><span class="src">APM</span><span class="src">RUM</span></div>
      @if (s.facts.events.length) {
       <div class="table-wrap"><table class="tbl">
        <caption class="sr-only">Customer events</caption>
        <thead><tr><th scope="col">Event</th><th scope="col">When</th><th scope="col">Service</th><th scope="col">System finding</th></tr></thead>
        <tbody>@for (e of s.facts.events; track $index) {
         <tr><td class="mono">{{ e.name }}</td><td class="mono">{{ time(e.at) }}</td><td class="mono">{{ e.service }}</td>
          <td><span class="status-dot" [attr.data-tone]="failed(e) ? 'sensitive' : 'neutral'" aria-hidden="true"></span> {{ finding(s, e) }}</td></tr>
        }</tbody>
       </table></div>
      } @else { <p class="ev-text muted">{{ s.subjectStatus === 'verified' ? 'No events for this customer in the window.' : 'Customer events need a verified customer id.' }}</p> }
      @if (s.facts.restricted.traces.length) { <div class="mono ctx-meta">trace.id {{ traceIds(s) }}</div> }
     </div>

     <div class="sec">
      <div class="sh"><span class="cite">3</span><b>Last session</b><span class="src">RUM</span></div>
      <p class="ev-text">{{ s.facts.lastSession ? s.facts.lastSession.region + ', ' + time(s.facts.lastSession.at) + ' (from browser monitoring).' : 'No browser session in the window.' }}</p>
     </div>

     <div class="sec">
      <div class="sh"><span class="cite">4</span><b>Restricted detail</b><span class="src">LOGS</span><span class="src">APM</span></div>
      @if (s.hiddenRestricted) { <p class="ev-text"><rs-icon name="lock" [size]="13" /> {{ s.hiddenRestricted }} trace ids and log lines are in this snapshot. They are shown to investigators.</p> }
      @else if (s.facts.restricted.logs.length) {
       @for (l of s.facts.restricted.logs; track $index) { <div class="code ev-code">{{ l.message }}</div><div class="mono ctx-meta">{{ l.level ?? 'log' }} · {{ l.service }} · {{ time(l.at) }}</div> }
      } @else { <p class="ev-text muted">None captured.</p> }
     </div>

     <div class="sec">
      <div class="sh"><span class="cite">5</span><b>Already tried</b><span class="src">AUDIT</span></div>
      @for (a of s.facts.alreadyTried; track $index) {
       <div class="row-wrap ev-text"><span class="status-dot" [attr.data-tone]="a.outcome === 'succeeded' ? 'safe' : 'sensitive'" aria-hidden="true"></span>{{ operationText(a.operation) }} · {{ a.actor }} · {{ time(a.at) }}
        <span class="mono ev-outcome" [attr.data-tone]="a.outcome === 'succeeded' ? 'safe' : 'sensitive'">{{ a.outcome }} in the application</span></div>
      } @empty { <p class="ev-text muted">Nothing recorded in Resolve for this {{ s.objectKind }}.</p> }
     </div>
    </section>
   </div>

   <aside class="ev-side">
    <section class="card" aria-labelledby="rec-title">
     <div class="card-head"><h2 class="card-title" id="rec-title">Snapshot record</h2><span class="lbl">immutable</span></div>
     <dl class="facts pad">
      <div><dt>Completeness</dt><dd>{{ s.completeness }}</dd></div>
      <div><dt>Classification</dt><dd>{{ classText(s.classification) }}</dd></div>
      <div><dt>Content hash</dt><dd class="mono small" [attr.title]="s.contentHash">{{ s.contentHash.slice(0, 16) }}…</dd></div>
      <div><dt>Hash check</dt><dd>{{ s.hashVerified ? 'Matches' : 'Does not match' }}</dd></div>
      <div><dt>Expires</dt><dd>{{ fullTime(s.expiresAt) }}</dd></div>
      <div><dt>Internal note</dt><dd>{{ noteText(s.note.state) }}</dd></div>
      @if (s.previousId) { <div><dt>Previous</dt><dd><a [routerLink]="['/evidence', s.previousId]">Earlier snapshot</a></dd></div> }
     </dl>
     <p class="pad small muted">The hash shows this record has not changed since it was captured. It does not show that the facts were right.</p>
     <div class="pad row">
      @if (state.can('observability.link')) { <button class="btn btn-sm" type="button" (click)="refresh(s)" [disabled]="busy()">Capture a fresh snapshot</button> }
      @if (state.can('observability.restricted')) { <a class="btn btn-sm btn-ghost" [href]="'/api/evidence/' + s.id + '?download=1'">Export JSON</a> }
     </div>
     <p role="status" class="pad small">{{ message() }}</p>
    </section>
   </aside>
  </div>
 } @else { <p role="status" class="muted">{{ error() || 'Loading…' }}</p> }
</div>`,
})
export class EvidencePage {
 readonly id = input.required<string>();
 readonly state = inject(AppState);
 private readonly router = inject(Router);
 readonly snap = signal<EvidenceSnapshot | null>(null);
 readonly error = signal('');
 readonly busy = signal(false);
 readonly message = signal('');
 readonly healthLabel = HEALTH_LABEL;
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly windows = computed(() => (this.snap()?.facts.issues ?? []).map(i => ({ since: Date.parse(i.since), label: i.kind === 'case' ? `case ${i.providerId}` : 'the active alert' })));
 constructor() {
  effect(() => { const id = this.id(); untracked(() => { this.snap.set(null); api(`/api/evidence/${encodeURIComponent(id)}`, evidenceSnapshotSchema).then(s => this.snap.set(s)).catch(e => this.error.set(e.message)); }); });
 }
 time(iso: string) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
 pct(v: number) { return `${+(v * 100).toFixed(2)}%`; }
 subjectText(s: string) { return SUBJECT_TEXT[s] ?? s; }
 classText(c: string) { return CLASS_TEXT[c] ?? c; }
 noteText(s: string | null) { return s ? NOTE_TEXT[s] ?? s : 'None'; }
 itemLink(s: EvidenceSnapshot) { return s.objectKind === 'ticket' ? ['/tickets', s.appKey, s.objectId] : ['/inbox', s.appKey, s.objectId]; }
 failed(e: SubjectEvent) { return e.kind === 'error' || e.outcome === 'failure'; }
 /** Facts and observed overlap only: an event inside an issue window is not proof the issue caused it. */
 finding(s: EvidenceSnapshot, e: SubjectEvent) {
  const inside = this.windows().filter(w => Date.parse(e.at) >= w.since).map(w => w.label);
  const what = e.kind === 'error' ? `Error${e.httpStatus ? ' HTTP ' + e.httpStatus : ''}` : e.outcome === 'failure' ? `Failed${e.httpStatus ? ' HTTP ' + e.httpStatus : ''}` : e.kind === 'page_load' ? `Page load ${e.durationMs !== null ? (e.durationMs / 1000).toFixed(1) + ' s' : ''}` : 'Succeeded';
  return this.failed(e) && inside.length ? `${what} · inside ${inside.join(' and ')}` : this.failed(e) ? `${what} · outside any known issue window` : what;
 }
 traceIds(s: EvidenceSnapshot) { return s.facts.restricted.traces.map(t => t.traceId.slice(0, 12)).join(', '); }
 operationText(op: string) { return op.replace(/^(ticket|conversation)\./, '').replace('_', ' ').replace(/^./, c => c.toUpperCase()); }
 async refresh(s: EvidenceSnapshot) {
  this.busy.set(true);
  const path = `/api/apps/${encodeURIComponent(s.appKey)}/${s.objectKind === 'ticket' ? 'tickets' : 'conversations'}/${encodeURIComponent(s.objectId)}/evidence`;
  const res = await send('POST', path, { requestId: crypto.randomUUID(), previousId: s.id }, evidenceSnapshotSchema);
  this.busy.set(false);
  if (!res.ok) { this.message.set(res.error!.message); return; }
  void this.router.navigate(['/evidence', res.data!.id]);
 }
}
