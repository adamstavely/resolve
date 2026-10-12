import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { ACTION_POLICIES, preflightSchema, type Preflight, type PreflightAction } from '../../../../../packages/contracts/src/index';
import { IconComponent, type IconName } from '../icon.component';
import { AppState, send } from '../state';

const ICON: Record<string, IconName> = { ok: 'check', warn: 'alert', bad: 'alert', unknown: 'help' };
const STATE_TEXT: Record<string, string> = { ok: 'Passed', warn: 'Warning', bad: 'Problem', unknown: 'Not known' };

/**
 * Pre-flight check before closing a ticket or conversation (plan 14, E3; prototype board 3, left). The checks,
 * the conclusion and the choices: go ahead, run anyway with a reason (an advisory warning only), or link the item to
 * the known issue and be told when it clears. The result is stored with the action log. Focus returns to the control
 * that opened it.
 */
@Component({
 selector: 'rs-preflight-dialog',
 imports: [IconComponent],
 template: `
<dialog #dlg class="pf-drawer" role="alertdialog" aria-labelledby="pf-title" [attr.aria-describedby]="pf() ? 'pf-conclusion' : null" (cancel)="cancel($event)">
 <div class="pf-head">
  <div class="pf-head-row">
   <span class="pf-icon" aria-hidden="true"><rs-icon name="shieldCheck" [size]="18" /></span>
   <div class="grow">
    <h2 class="pf-title" id="pf-title">{{ title() }}</h2>
    <div class="row-wrap pf-chips"><span class="mono pf-impact">{{ (pf()?.impact ?? 'low') === 'low' ? 'Low impact' : 'High impact' }}</span><span class="mono ctx-meta">Policy v{{ pf()?.policyVersion ?? 1 }}</span></div>
   </div>
   <button type="button" class="pf-x" aria-label="Close" (click)="close(false)"><rs-icon name="close" [size]="16" /></button>
  </div>
  <div class="pf-target">
   <span class="pf-avatar" aria-hidden="true">{{ initials() }}</span>
   <div class="grow"><div class="pf-target-name">{{ customerName() || 'Customer' }}</div><div class="mono ctx-meta">{{ pf()?.customer?.externalId ?? 'No verified customer id' }}</div></div>
   <span class="lbl">target</span>
  </div>
 </div>
 <div class="pf-body">
  <div class="pf-check-head"><span class="pf-h">Pre-flight check</span><span class="row-wrap"><span class="src">APM</span><span class="src">SLO</span><span class="src">ALERTS</span></span></div>
  @if (pf(); as p) {
   <ul class="pf-checks">
    @for (c of p.checks; track $index) {
     <li class="chk"><span class="ic" [attr.data-state]="c.state" aria-hidden="true"><rs-icon [name]="icon(c.state)" [size]="12" /></span>
      <div class="grow"><div class="pf-check-title"><span class="sr-only">{{ stateText(c.state) }}: </span>{{ c.title }}</div><div class="pf-check-detail">{{ c.detail }}</div></div></li>
    }
   </ul>
   @if (p.conclusion) {
    <div class="pf-conclusion" id="pf-conclusion" [attr.data-tone]="p.outcome === 'warn' ? 'warn' : 'neutral'">
     @if (p.outcome === 'warn') { <b>{{ kind() === 'ticket' ? 'Resolving' : 'Closing' }} now will most likely not fix this for the customer.</b> } {{ p.conclusion }}
    </div>
   } @else { <p class="sr-only" id="pf-conclusion">All checks passed.</p> }
   @if (overriding()) {
    <div class="stack-lg">
     <label class="field-label" for="pf-reason">Why go ahead anyway? (recorded in the audit)</label>
     <textarea id="pf-reason" class="text-input textarea" rows="2" [value]="reason()" (input)="reason.set($any($event.target).value)"></textarea>
    </div>
   }
  } @else { <p class="muted small" role="status">{{ error() || 'Checking…' }}</p> }
 </div>
 <div class="pf-foot">
  <div class="mono ctx-meta">Pre-flight result is saved with the action log</div>
  <div class="row-wrap">
   @if (pf(); as p) {
    @if (p.outcome === 'warn') {
     @if (overriding()) {
      <button class="btn" type="button" (click)="overriding.set(false)">Back</button>
      <button class="btn btn-primary pf-grow" type="button" (click)="runAnyway()" [disabled]="reason().trim().length < 5">Run anyway</button>
     } @else {
      @if (p.overridable) { <button class="btn" type="button" (click)="overriding.set(true)">Run anyway</button> }
      <button class="btn btn-primary pf-grow" type="button" (click)="linkAndNotify()" autofocus>{{ kind() === 'ticket' && p.suggestedIssue ? 'Link to ' + issueName(p) + ' and notify me' : 'Keep open and notify me' }}</button>
     }
    } @else if (p.outcome !== 'block') {
     <button class="btn" type="button" (click)="close(false)" autofocus>Keep open</button>
     <button class="btn btn-primary pf-grow" type="button" (click)="proceed()">{{ verb() }}</button>
    } @else { <button class="btn" type="button" (click)="close(false)" autofocus>Keep open</button> }
   } @else { <button class="btn" type="button" (click)="close(false)" autofocus>Keep open</button> }
  </div>
  @if (message()) { <p class="small" role="status">{{ message() }}</p> }
 </div>
</dialog>`,
})
export class PreflightDialogComponent {
 readonly appKey = input.required<string>();
 readonly kind = input.required<'ticket' | 'conversation'>();
 readonly objectId = input.required<string>();
 readonly customerName = input<string | null>(null);
 /** Go ahead: dispatch the action with this pre-flight (and an override reason, if one was given). */
 readonly confirmed = output<{ preflightId: string; override?: { reason: string } }>();
 /** Linked and/or subscribed instead of acting. */
 readonly diverted = output<string>();
 readonly cancelled = output<void>();
 readonly state = inject(AppState);
 readonly pf = signal<Preflight | null>(null);
 readonly error = signal('');
 readonly message = signal('');
 readonly overriding = signal(false);
 readonly reason = signal('');
 private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');
 private opener: HTMLElement | null = null;
 private action: PreflightAction = 'ticket.close';

 title() { return ACTION_POLICIES[this.action].label; }
 verb() { return ACTION_POLICIES[this.action].verb; }
 icon(s: string): IconName { return ICON[s] ?? 'help'; }
 stateText(s: string) { return STATE_TEXT[s] ?? s; }
 initials() { return (this.customerName() ?? 'Customer').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
 issueName(p: Preflight) { return p.suggestedIssue!.kind === 'case' ? p.suggestedIssue!.providerId : 'the known issue'; }
 private base() { return `/api/apps/${encodeURIComponent(this.appKey())}/${this.kind() === 'ticket' ? 'tickets' : 'conversations'}/${encodeURIComponent(this.objectId())}`; }

 async open(action: PreflightAction) {
  this.action = action;
  this.opener = document.activeElement as HTMLElement | null;
  this.pf.set(null); this.error.set(''); this.message.set(''); this.overriding.set(false); this.reason.set('');
  this.dlg().nativeElement.showModal();
  const res = await send('POST', this.base() + '/preflight', { action }, preflightSchema);
  if (res.ok) this.pf.set(res.data!); else this.error.set(res.error!.message);
  // The buttons change once the result arrives; keep focus inside on the safe choice.
  setTimeout(() => this.dlg().nativeElement.querySelector<HTMLElement>('[autofocus]')?.focus());
 }
 close(done: boolean) {
  this.dlg().nativeElement.close();
  if (!done) this.cancelled.emit();
  setTimeout(() => this.opener?.focus());
 }
 cancel(e: Event) { e.preventDefault(); this.close(false); }
 proceed() { const p = this.pf()!; this.close(true); this.confirmed.emit({ preflightId: p.id }); }
 runAnyway() { const p = this.pf()!; this.close(true); this.confirmed.emit({ preflightId: p.id, override: { reason: this.reason().trim() } }); }
 async linkAndNotify() {
  const p = this.pf()!;
  const issue = p.suggestedIssue;
  if (!issue) { this.close(false); return; }
  if (this.kind() === 'ticket') {
   const l = await send('POST', `/api/apps/${encodeURIComponent(this.appKey())}/observability/issues/${issue.issueId}/links`, { requestId: crypto.randomUUID(), ticketIds: [this.objectId()] });
   if (!l.ok) { this.message.set(l.error!.message); return; }
  }
  const s = await send('POST', `/api/observability/issues/${issue.issueId}/subscribe`, { objectKind: this.kind(), objectId: this.objectId() });
  if (!s.ok) { this.message.set(s.error!.message); return; }
  this.close(true);
  this.diverted.emit(this.kind() === 'ticket' ? `Linked to ${this.issueName(p)}. You'll be told when it clears; the ticket stays open.` : `Kept open. You'll be told when ${this.issueName(p)} clears.`);
 }
}
