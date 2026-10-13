import { Component, computed, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { preflightSchema, receiptSchema, type Preflight, type PreflightAction, type Receipt } from '../../../../../packages/contracts/src/index';
import { IconComponent, type IconName } from '../icon.component';
import { api, AppState, send } from '../state';
import { hueOf, initialsOf, SrcComponent, TierBadgeComponent } from '../ui';

export interface RailTool { id: string; name: string; icon: IconName; cat: string; warn?: string | null; disabled?: boolean }

/**
 * Tool rail (prototype v2 `ToolRail`): the application, your clearance there, and the tools for this case grouped by
 * category. Ticket and chat tools run through Resolve; account tools need the application's account-action tools,
 * which are not connected yet, and say so in place.
 */
@Component({
 selector: 'rs-tool-rail',
 host: { style: 'display:contents' },
 imports: [IconComponent, TierBadgeComponent],
 template: `
<aside class="rail" [attr.aria-label]="appName() + ' tools'">
 <div class="rail-head">
  <div class="rail-app">
   <span class="app-glyph" style="width:32px;height:32px;font-size:14.7px" aria-hidden="true">{{ appName().charAt(0) }}</span>
   <div style="flex:1;min-width:0">
    <div class="rail-app nm">{{ appName() }}</div>
    <div class="ty">{{ subtitle() }}</div>
   </div>
  </div>
  <div class="rail-clear"><span class="lbl">Your clearance here</span><rs-tier [tier]="tier()" size="sm" /></div>
 </div>
 <div class="rail-tools">
  @for (g of groups(); track g.cat) {
   <div role="group" [attr.aria-label]="g.cat">
    <div class="rail-cat" aria-hidden="true">{{ g.cat }}</div>
    @for (t of g.tools; track t.id) {
     <button class="tool-item" type="button" [disabled]="t.disabled" (click)="run.emit(t)" [attr.title]="t.warn ?? null">
      <span class="tool-ico" aria-hidden="true"><rs-icon [name]="t.icon" [size]="15" /></span>
      <span class="tool-name">{{ t.name }}</span>
      @if (t.warn) { <span class="nav-health" aria-hidden="true"></span><span class="sr-only">, {{ t.warn }}</span> }
     </button>
    }
   </div>
  }
  <div role="group" aria-label="Account">
   <div class="rail-cat" aria-hidden="true">Account</div>
   <div class="lockline" style="margin:2px 4px;padding:10px 12px;font-size:var(--fs-xs)"><rs-icon name="lock" [size]="14" /><div>Account tools (password resets, refunds, limits) come from {{ appName() }}'s account actions, which are not connected yet.</div></div>
  </div>
 </div>
</aside>`,
})
export class ToolRailComponent {
 readonly appName = input.required<string>();
 readonly subtitle = input('Tools');
 readonly tier = input<number | null>(null);
 readonly tools = input<RailTool[]>([]);
 readonly run = output<RailTool>();
 readonly groups = computed(() => {
  const cats = [...new Set(this.tools().map(t => t.cat))];
  return cats.map(cat => ({ cat, tools: this.tools().filter(t => t.cat === cat) }));
 });
}

/** A tool the drawer can run: optional pre-flight, then the action, then a verified receipt. */
export interface DrawerTool {
 id: string; name: string; icon: IconName; desc: string; verb: string;
 risk: 'safe' | 'sensitive' | 'destructive';
 /** Pre-flight policy (ticket.close / conversation.close); without it the drawer goes straight to the form. */
 gated?: PreflightAction;
 /** Performs the action; returns the operation id for its receipt, or an error message. */
 run: (pre?: { preflightId: string; override?: { reason: string } }) => Promise<{ ok: boolean; message: string; operationId?: string; link?: { label: string; route: unknown[] } }>;
}
const RISK_TEXT: Record<string, string> = { safe: 'Safe', sensitive: 'Sensitive', destructive: 'Destructive' };
const CHECK_STATE: Record<string, 'ok' | 'bad' | 'warn' | 'wait'> = { ok: 'ok', bad: 'bad', warn: 'warn', unknown: 'wait' };
const CHECK_ICON: Record<string, IconName> = { ok: 'check', bad: 'x', warn: 'alert', wait: 'dot' };
const STAGE_TEXT: Record<string, string> = { ok: 'Observed', bad: 'Failed', wait: 'Waiting', na: 'Not applicable' };

/**
 * Tool drawer (prototype v2 `ToolDrawer`): pre-flight health check, then run (or run anyway with a reason, or link to
 * the known issue instead), then downstream confirmation from the operation's receipt. A modal dialog: focus moves in
 * and returns to the tool that opened it; Escape closes.
 */
@Component({
 selector: 'rs-tool-drawer',
 host: { style: 'display:contents' },
 imports: [IconComponent, RouterLink, SrcComponent],
 template: `
@if (tool(); as t) {
 <div class="drawer-scrim" (click)="close()" aria-hidden="true"></div>
 <div #panel class="drawer" role="dialog" aria-modal="true" aria-labelledby="dr-title" tabindex="-1" (keydown)="onKey($event)">
  <div class="drawer-head">
   <div class="drawer-top">
    <div class="drawer-tool">
     <span class="tool-ico" aria-hidden="true"><rs-icon [name]="t.icon" [size]="19" /></span>
     <div>
      <h2 class="drawer-title" id="dr-title" style="margin:0">{{ t.name }}</h2>
      <div style="display:flex;gap:8px;margin-top:5px"><span class="risk-tag risk-sm" [attr.data-risk]="t.risk"><i class="risk-dot"></i> {{ riskText(t.risk) }}</span>
       @if (t.gated) { <span class="tool-tier-mini" style="align-self:center">Policy v{{ pf()?.policyVersion ?? 1 }}</span> }</div>
     </div>
    </div>
    <button class="icon-btn" type="button" (click)="close()" aria-label="Close"><rs-icon name="x" [size]="18" /></button>
   </div>
   @if (stage() !== 'done') { <p class="drawer-desc">{{ t.desc }}</p> }
   <div class="drawer-target">
    <span class="avatar" aria-hidden="true" style="width:28px;height:28px;font-size:10.6px" [style.--ah]="hue()">{{ initials() }}</span>
    <div style="flex:1;min-width:0">
     <div style="font-size:var(--fs-sm);font-weight:600">{{ targetName() || 'Customer' }}</div>
     <div class="insp-email">{{ pf()?.customer?.externalId ?? 'No verified customer id' }} · {{ refLabel() }}</div>
    </div>
    <span class="lbl">target</span>
   </div>
  </div>

  @switch (stage()) {
   @case ('checking') {
    <div class="drawer-body"><p class="meta" role="status">Checking live service health…</p></div>
    <div class="drawer-foot"><button class="btn btn-outline" type="button" (click)="close()">Cancel</button></div>
   }
   @case ('preflight') {
    @if (pf(); as p) {
     <div class="drawer-body">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-weight:620;font-size:var(--fs-sm)">Pre-flight check</span><span class="tags">@for (s of sources(p); track s) { <rs-src [k]="s" /> }</span></div>
      <ul style="list-style:none;margin:0;padding:0">
       @for (c of p.checks; track $index) {
        <li class="chk"><span class="cic" [attr.data-s]="checkState(c.state)" aria-hidden="true"><rs-icon [name]="checkIcon(c.state)" [size]="12" /></span>
         <div style="flex:1"><div class="t"><span class="sr-only">{{ c.state === 'ok' ? 'Passed' : c.state === 'unknown' ? 'Not known' : 'Problem' }}: </span>{{ c.title }}</div><div class="d">{{ c.detail }}</div></div></li>
       }
      </ul>
      <div class="pf-advice" [attr.data-v]="p.outcome === 'block' ? 'fail' : 'warn'">
       @if (p.outcome === 'warn') { <b>{{ t.gated === 'ticket.close' ? 'Resolving' : 'Closing' }} now will most likely not fix this for the customer.</b> }
       @else if (p.outcome === 'block') { <b>This action is blocked.</b> }
       {{ p.conclusion }}
      </div>
      @if (overriding()) {
       <div class="field" style="margin-top:16px">
        <label for="dr-reason">Why go ahead anyway? <span class="req" aria-hidden="true">*</span><span class="sr-only">(required, recorded in the audit)</span></label>
        <textarea id="dr-reason" class="textarea" [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="What did you confirm?"></textarea>
       </div>
      }
     </div>
     <div class="drawer-foot">
      <div class="audit-note"><rs-icon name="shield" [size]="13" /> Pre-flight result is saved with the action log</div>
      @if (message()) { <p class="small" role="alert" style="margin:0">{{ message() }}</p> }
      <div style="display:flex;gap:8px">
       @if (p.outcome === 'block') { <button class="btn btn-primary btn-full" type="button" (click)="close()" data-autofocus>Keep open</button> }
       @else if (overriding()) {
        <button class="btn btn-outline" type="button" (click)="overriding.set(false)">Back</button>
        <button class="btn btn-primary btn-full" type="button" [attr.data-risk]="t.risk" [disabled]="reason().trim().length < 5 || busy()" (click)="go(p.id, reason().trim())">Run anyway</button>
       } @else {
        @if (p.overridable) { <button class="btn btn-outline" type="button" (click)="overriding.set(true)">Run anyway</button> }
        <button class="btn btn-primary btn-full" type="button" [disabled]="busy()" (click)="divert(p)" data-autofocus>{{ p.suggestedIssue && kind() === 'ticket' ? 'Link to ' + issueName(p) + ' and notify me' : 'Keep open and notify me' }}</button>
       }
      </div>
     </div>
    }
   }
   @case ('form') {
    <div class="drawer-body">
     @if (t.risk !== 'safe') {
      <div class="risk-banner" [attr.data-risk]="t.risk"><rs-icon [name]="t.risk === 'destructive' ? 'alert' : 'shield'" [size]="18" class="ri" />
       <div class="rt"><b>{{ t.risk === 'destructive' ? 'Destructive & irreversible.' : 'Sensitive action.' }}</b> {{ t.risk === 'destructive' ? 'This permanently changes the record and notifies affected parties.' : 'The customer sees the change, and it is recorded against the ' + (kind() === 'ticket' ? 'ticket' : 'chat') + '.' }}</div></div>
     }
     @if (pf(); as p) {
      <div class="pf-mini">
       <div class="tags" style="justify-content:space-between;padding:8px 0 2px"><span class="lbl" style="font-size:10px">Pre-flight</span><span class="tags">@for (s of sources(p); track s) { <rs-src [k]="s" /> }</span></div>
       <ul style="list-style:none;margin:0;padding:0">
        @for (c of p.checks; track $index) {
         <li class="chk"><span class="cic" [attr.data-s]="checkState(c.state)" aria-hidden="true"><rs-icon [name]="checkIcon(c.state)" [size]="12" /></span>
          <div style="flex:1"><div class="t"><span class="sr-only">{{ c.state === 'ok' ? 'Passed' : c.state === 'unknown' ? 'Not known' : 'Problem' }}: </span>{{ c.title }}</div><div class="d">{{ c.detail }}</div></div></li>
        }
       </ul>
       @if (p.conclusion) { <p class="d" style="font-size:var(--fs-xs);color:var(--ink-3);margin:2px 0 8px">{{ p.conclusion }}</p> }
      </div>
     }
    </div>
    <div class="drawer-foot">
     <div class="audit-note"><rs-icon name="shield" [size]="13" /> Signed as {{ state.user()?.displayName }} · logged to {{ refLabel() }}</div>
     @if (message()) { <p class="small" role="alert" style="margin:0">{{ message() }}</p> }
     <div style="display:flex;gap:8px">
      <button class="btn btn-outline" type="button" (click)="close()" data-autofocus>Cancel</button>
      <button class="btn btn-primary btn-full" type="button" [attr.data-risk]="t.risk" [disabled]="busy()" (click)="go(pf()?.id)">{{ busy() ? 'Working…' : t.verb }}</button>
     </div>
    </div>
   }
   @case ('done') {
    <div class="drawer-body">
     <div style="text-align:center;padding:6px 0 14px">
      <div class="tool-done" style="padding:0"><div class="ok" style="margin-bottom:12px" [style.background]="receiptBad() ? 'var(--destructive-soft)' : null" [style.color]="receiptBad() ? 'var(--destructive)' : null"><rs-icon [name]="receiptBad() ? 'alert' : 'check'" [size]="26" /></div></div>
      <div style="font-weight:650;font-size:18px;letter-spacing:-0.02em" tabindex="-1" data-autofocus>{{ receipt()?.title ?? t.name + ' complete' }}</div>
      <div style="font-size:var(--fs-sm);color:var(--ink-3);margin-top:4px">{{ receipt()?.subtitle ?? resultMessage() }}</div>
     </div>
     @if (receipt(); as r) {
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px"><span style="font-weight:620;font-size:var(--fs-sm)">Downstream confirmation</span><span class="tags"><rs-src k="AUDIT" /><rs-src k="APM" /></span></div>
      <ul style="list-style:none;margin:0 0 16px;padding:0" role="status">
       @for (s of r.stages; track s.key) {
        <li class="chk"><span class="cic" [attr.data-s]="s.state === 'na' ? 'wait' : s.state" aria-hidden="true">@if (s.state !== 'wait' && s.state !== 'na') { <rs-icon [name]="s.state === 'ok' ? 'check' : 'x'" [size]="12" /> }</span>
         <div style="flex:1"><div class="t" [style.color]="s.state === 'wait' || s.state === 'na' ? 'var(--ink-3)' : null"><span class="sr-only">{{ stageText(s.state) }}: </span>{{ s.title }}</div>
          <div class="meta" style="font-size:11px">{{ s.source }}{{ s.at ? ' · ' + time(s.at) : s.state === 'wait' ? ' · checking…' : '' }}{{ s.detail ? ' · ' + s.detail : '' }}</div></div></li>
       }
      </ul>
      <dl class="receipt" style="margin:0">
       <div class="rr"><dt class="k">action</dt><dd style="margin:0">{{ r.facts.action }}</dd></div>
       <div class="rr"><dt class="k">target</dt><dd style="margin:0">{{ r.facts.target }}</dd></div>
       <div class="rr"><dt class="k">agent</dt><dd style="margin:0">{{ r.facts.agent }}</dd></div>
       <div class="rr"><dt class="k">tier</dt><dd style="margin:0">{{ tier() ? 'T' + tier() : '—' }}</dd></div>
       <div class="rr"><dt class="k">ref</dt><dd style="margin:0">{{ r.facts.ref }}</dd></div>
      </dl>
     }
    </div>
    <div class="drawer-foot" style="flex-direction:row">
     @if (resultLink(); as l) { <a class="btn btn-outline btn-full" [routerLink]="$any(l.route)" (click)="close()">{{ l.label }}</a> }
     @else if (receipt(); as r) { <a class="btn btn-outline btn-full" [routerLink]="['/receipts', r.operationId]" (click)="close()"><rs-icon name="doc" [size]="16" />Open the receipt</a> }
     <button class="btn btn-primary" type="button" (click)="close()">Done</button>
    </div>
   }
  }
 </div>
}`,
})
export class ToolDrawerComponent {
 readonly appKey = input.required<string>();
 readonly kind = input.required<'ticket' | 'conversation'>();
 readonly objectId = input.required<string>();
 readonly targetName = input<string | null>(null);
 readonly refLabel = input('this item');
 readonly tier = input<number | null>(null);
 /** Linked or subscribed instead of acting (message for the page). */
 readonly diverted = output<string>();
 /** The drawer closed after an action ran (the page re-reads its item). */
 readonly finished = output<void>();
 readonly state = inject(AppState);
 readonly tool = signal<DrawerTool | null>(null);
 readonly stage = signal<'checking' | 'preflight' | 'form' | 'done'>('form');
 readonly pf = signal<Preflight | null>(null);
 readonly overriding = signal(false);
 readonly reason = signal('');
 readonly busy = signal(false);
 readonly message = signal('');
 readonly resultMessage = signal('');
 readonly resultLink = signal<{ label: string; route: unknown[] } | null>(null);
 readonly receipt = signal<Receipt | null>(null);
 readonly receiptBad = computed(() => this.receipt()?.state === 'failed');
 private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
 private opener: HTMLElement | null = null;
 private ran = false;
 private timer?: ReturnType<typeof setInterval>;

 constructor() { inject(DestroyRef).onDestroy(() => clearInterval(this.timer)); }
 riskText(r: string) { return RISK_TEXT[r] ?? r; }
 checkState(s: string) { return CHECK_STATE[s] ?? 'wait'; }
 checkIcon(s: string): IconName { return CHECK_ICON[CHECK_STATE[s] ?? 'wait']; }
 stageText(s: string) { return STAGE_TEXT[s] ?? s; }
 initials() { return initialsOf(this.targetName() ?? 'Customer'); }
 hue() { return hueOf(this.targetName() ?? 'Customer'); }
 time(iso: string) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
 sources(p: Preflight) { return [...new Set(p.checks.flatMap(c => c.sources))]; }
 issueName(p: Preflight) { return p.suggestedIssue!.kind === 'case' ? p.suggestedIssue!.providerId : 'the known issue'; }
 private base() { return `/api/apps/${encodeURIComponent(this.appKey())}/${this.kind() === 'ticket' ? 'tickets' : 'conversations'}/${encodeURIComponent(this.objectId())}`; }

 async open(t: DrawerTool) {
  this.opener = document.activeElement as HTMLElement | null;
  this.tool.set(t); this.pf.set(null); this.overriding.set(false); this.reason.set(''); this.message.set(''); this.receipt.set(null); this.resultLink.set(null); this.resultMessage.set(''); this.ran = false;
  clearInterval(this.timer);
  this.stage.set(t.gated ? 'checking' : 'form');
  this.focusIn();
  if (!t.gated) return;
  const res = await send('POST', this.base() + '/preflight', { action: t.gated }, preflightSchema);
  if (this.tool() !== t) return;
  if (!res.ok) { this.stage.set('form'); this.message.set(res.error!.message); return; }
  this.pf.set(res.data!);
  // As the prototype: a problem shows the pre-flight first; a clean result goes straight to the form with it inline.
  this.stage.set(res.data!.outcome === 'warn' || res.data!.outcome === 'block' ? 'preflight' : 'form');
  this.focusIn();
 }
 close() {
  clearInterval(this.timer);
  const ran = this.ran;
  this.tool.set(null);
  if (ran) this.finished.emit();
  setTimeout(() => this.opener?.focus());
 }
 async go(preflightId?: string, overrideReason?: string) {
  const t = this.tool()!;
  this.busy.set(true); this.message.set('');
  const r = await t.run(preflightId ? { preflightId, ...(overrideReason ? { override: { reason: overrideReason } } : {}) } : undefined);
  this.busy.set(false);
  if (!r.ok) { this.message.set(r.message); return; }
  this.ran = true;
  this.resultMessage.set(r.message); this.resultLink.set(r.link ?? null);
  this.stage.set('done');
  if (r.operationId) {
   const id = r.operationId;
   const load = () => api(`/api/operations/${encodeURIComponent(id)}/receipt`, receiptSchema).then(x => { this.receipt.set(x); if (!x.stages.some(s => s.state === 'wait')) clearInterval(this.timer); }).catch(() => {});
   void load();
   this.timer = setInterval(load, 4000);
  }
  this.focusIn();
 }
 async divert(p: Preflight) {
  const issue = p.suggestedIssue;
  if (!issue) { this.close(); return; }
  this.busy.set(true);
  if (this.kind() === 'ticket') {
   const l = await send('POST', `/api/apps/${encodeURIComponent(this.appKey())}/observability/issues/${issue.issueId}/links`, { requestId: crypto.randomUUID(), ticketIds: [this.objectId()] });
   if (!l.ok) { this.busy.set(false); this.message.set(l.error!.message); return; }
  }
  const s = await send('POST', `/api/observability/issues/${issue.issueId}/subscribe`, { objectKind: this.kind(), objectId: this.objectId() });
  this.busy.set(false);
  if (!s.ok) { this.message.set(s.error!.message); return; }
  this.ran = true;
  this.diverted.emit(this.kind() === 'ticket' ? `Linked to ${this.issueName(p)}. You'll be told when it clears; the ticket stays open.` : `Kept open. You'll be told when ${this.issueName(p)} clears.`);
  this.close();
 }
 onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
  if (e.key !== 'Tab') return;
  // Keep focus inside the dialog.
  const el = this.panel()?.nativeElement; if (!el) return;
  const f = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea, input, [tabindex="0"]')];
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1)!.focus(); }
  else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
 }
 private focusIn() { setTimeout(() => { const el = this.panel()?.nativeElement; (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el)?.focus(); }); }
}
