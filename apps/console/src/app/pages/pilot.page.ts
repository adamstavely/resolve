import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { z } from 'zod';
import { jobCheckSchema, pilotEvidenceSchema } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { api, AppState, fullTime, send } from '../state';

const pilotSchema = z.object({
 runId: z.string(), applicationName: z.string(), environment: z.string(), workspaceKey: z.string().nullable(), status: z.string(),
 configRevision: z.string().nullable(), connected: z.boolean(), checks: z.array(pilotEvidenceSchema),
});
const resultSchema = z.object({ passed: z.boolean(), checks: z.array(jobCheckSchema) });

/**
 * Pilot check (plan 07 step 6). A named pilot connects to the instance while it is still closed to everyone else,
 * then Resolve reads its queue and adds an internal note as them. The result is evidence for activation.
 */
@Component({
 selector: 'rs-pilot-page',
 imports: [IconComponent],
 template: `
<div class="page">
 <header class="page-head">
  <p class="eyebrow">Pilot check</p>
  <h1 class="page-title" tabindex="-1">{{ info()?.applicationName ?? 'Pilot check' }}</h1>
  <p class="lp-lede small-lede">You were named as a pilot. Check the new instance as yourself before it opens to everyone.</p>
 </header>
 @if (error()) { <p class="notice" data-tone="destructive" role="alert">{{ error() }}</p> }
 @if (info(); as p) {
  <section class="card" aria-labelledby="pilot-steps">
   <div class="card-head"><h2 class="card-title" id="pilot-steps">Steps</h2><span class="card-meta">{{ p.environment }}</span></div>
   <div class="pad">
    <ol class="pilot-list">
     <li><strong>Connect.</strong> Sign in to the instance through company SSO.
      @if (p.connected) { <span class="tag" data-tone="safe">Connected</span> }
      @else { <a class="btn btn-sm" [href]="'/api/connect/' + p.workspaceKey + '/start'">Connect to {{ p.applicationName }}</a> }</li>
     <li><strong>Run the check.</strong> Resolve reads the queue with your access and adds an internal note as you. Both are recorded in the audit.
      <div class="row"><button class="btn btn-primary" type="button" (click)="run()" [disabled]="busy() || p.status !== 'ready'">Run the pilot check</button>
       @if (p.status !== 'ready') { <span class="muted small">Available once validation passes.</span> }</div></li>
    </ol>
    @if (result(); as r) {
     <p class="notice" [attr.data-tone]="r.passed ? 'safe' : 'destructive'" role="status">{{ r.passed ? 'The pilot check passed.' : 'The pilot check did not pass.' }}</p>
     <ul class="caps">@for (c of r.checks; track c.id) { <li><rs-icon [name]="c.status === 'passed' ? 'check' : 'alert'" [size]="14" /><span>{{ c.label }}@if (c.detail) { <span class="muted"> — {{ c.detail }}</span> }</span></li> }</ul>
    }
    @if (p.checks.length) {
     <h3 class="sub-title">Your earlier checks</h3>
     @for (c of p.checks; track c.at) { <p class="small"><span class="tag" [attr.data-tone]="c.passed ? 'safe' : 'destructive'">{{ c.passed ? 'passed' : 'failed' }}</span> <time [attr.datetime]="c.at">{{ fullTime(c.at) }}</time>
      @if (c.configRevision !== p.configRevision) { <span class="muted"> · older configuration</span> }</p> }
    }
   </div>
  </section>
 }
</div>`,
})
export class PilotPage {
 readonly runId = input.required<string>();
 readonly state = inject(AppState);
 readonly info = signal<z.infer<typeof pilotSchema> | undefined>(undefined);
 readonly result = signal<z.infer<typeof resultSchema> | undefined>(undefined);
 readonly error = signal('');
 readonly busy = signal(false);
 readonly fullTime = fullTime;
 constructor() {
  effect(() => { const id = this.runId(); if (this.state.can('connection.manage')) untracked(() => this.load(id)); });
 }
 load(id: string) {
  return api(`/api/onboarding/${encodeURIComponent(id)}/pilot`, pilotSchema).then(p => this.info.set(p)).catch(e => this.error.set(e.message));
 }
 async run() {
  this.busy.set(true); this.error.set('');
  const res = await send('POST', `/api/onboarding/${encodeURIComponent(this.runId())}/pilot`, {}, resultSchema);
  this.busy.set(false);
  if (!res.ok) { this.error.set(res.error!.message); return; }
  this.result.set(res.data);
  await this.load(this.runId());
 }
}
