import { Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { Location } from '@angular/common';
import { receiptSchema, type Receipt } from '../../../../../packages/contracts/src/index';
import { IconComponent, type IconName } from '../icon.component';
import { api, AppState, fullTime } from '../state';

const STAGE_ICON: Record<string, IconName> = { ok: 'check', bad: 'alert', wait: 'clock', na: 'help' };
const STAGE_TEXT: Record<string, string> = { ok: 'Observed', bad: 'Failed', wait: 'Waiting', na: 'Not applicable' };

/**
 * A verified receipt (plan 14, E3; prototype board 3, right). What was actually seen, stage by stage and by whom. While
 * a downstream signal is still expected it re-reads Resolve every few seconds (Resolve's own record, never Elastic).
 */
@Component({
 selector: 'rs-receipt-page',
 imports: [IconComponent],
 template: `
<div class="page rc-page">
 @if (r(); as x) {
  <section class="pf-drawer rc-drawer" aria-labelledby="rc-title">
   <div class="rc-head">
    <span class="rc-badge" [attr.data-state]="x.state" aria-hidden="true"><rs-icon [name]="x.state === 'observed' || x.state === 'accepted' ? 'check' : x.state === 'failed' ? 'alert' : 'clock'" [size]="24" /></span>
    <h1 class="rc-title" id="rc-title" tabindex="-1">{{ x.title }}</h1>
    <p class="rc-sub">{{ x.subtitle }}</p>
   </div>
   <div class="pf-body">
    <div>
     <div class="pf-check-head"><span class="pf-h">Downstream confirmation</span><span class="row-wrap"><span class="src">AUDIT</span><span class="src">APM</span></span></div>
     <ul class="pf-checks">
      @for (s of x.stages; track s.key) {
       <li class="chk"><span class="ic" [attr.data-state]="s.state" aria-hidden="true"><rs-icon [name]="icon(s.state)" [size]="12" /></span>
        <div class="grow"><div class="pf-check-title"><span class="sr-only">{{ stageText(s.state) }}: </span>{{ s.title }}</div>
         <div class="mono ctx-meta">{{ s.source }}@if (s.at) { · <time [attr.datetime]="s.at">{{ time(s.at) }}</time> }@if (s.detail) { · {{ s.detail }} }</div></div></li>
      }
     </ul>
    </div>
    <dl class="rc-facts">
     <div class="rr"><dt class="k">action</dt><dd>{{ x.facts.action }}</dd></div>
     <div class="rr"><dt class="k">target</dt><dd>{{ x.facts.target }}</dd></div>
     <div class="rr"><dt class="k">agent</dt><dd>{{ x.facts.agent }}</dd></div>
     <div class="rr"><dt class="k">application</dt><dd>{{ state.appName(x.appKey) }}</dd></div>
     <div class="rr"><dt class="k">ref</dt><dd>{{ x.facts.ref }}</dd></div>
     @if (x.preflight; as p) { <div class="rr"><dt class="k">pre-flight</dt><dd>{{ p.outcome }}{{ p.overrideReason ? ' · overridden: ' + p.overrideReason : '' }}</dd></div> }
    </dl>
   </div>
   <div class="pf-foot"><div class="row-wrap"><button class="btn btn-primary pf-grow" type="button" (click)="done()">Done</button></div></div>
  </section>
 } @else { <p role="status" class="muted">{{ error() || 'Loading the receipt…' }}</p> }
</div>`,
})
export class ReceiptPage {
 readonly operationId = input.required<string>();
 readonly state = inject(AppState);
 private readonly location = inject(Location);
 readonly r = signal<Receipt | null>(null);
 readonly error = signal('');
 constructor() {
  effect(() => { const id = this.operationId(); untracked(() => this.load(id)); });
  const t = setInterval(() => { const x = this.r(); if (x && (x.state === 'pending' || x.state === 'accepted') && x.stages.some(s => s.state === 'wait')) this.load(x.operationId); }, 5000);
  inject(DestroyRef).onDestroy(() => clearInterval(t));
 }
 load(id: string) { api(`/api/operations/${encodeURIComponent(id)}/receipt`, receiptSchema).then(x => this.r.set(x)).catch(e => this.error.set(e.message)); }
 icon(s: string): IconName { return STAGE_ICON[s] ?? 'help'; }
 stageText(s: string) { return STAGE_TEXT[s] ?? s; }
 time(iso: string) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
 readonly fullTime = fullTime;
 done() { this.location.back(); }
}
