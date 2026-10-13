import { Component, DestroyRef, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { broadcastReviewSchema, broadcastViewSchema, type BroadcastReview, type BroadcastView } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { api, AppState, send } from '../state';
import { ToastService } from '../ui';
import { STATUS_LABEL } from './broadcasts.page';

const KINDS = ['info', 'warning', 'critical', 'maintenance', 'success'] as const;
const KIND_LABEL: Record<string, string> = { info: 'Information', warning: 'Warning', critical: 'Critical', maintenance: 'Maintenance', success: 'Resolved / success' };
const BLOCK_TEXT: Record<string, string> = {
 not_registered: 'it is not registered', suspended: 'it is suspended', not_open: 'it is not open yet', not_connected: 'you are not connected to it',
 reconnect_required: 'you need to reconnect to it', missing_scope: 'your connection lacks announcement access (reconnect)', unsupported: 'it does not support fleet announcements yet',
 unreachable: 'it did not respond', author_not_authorized: 'you can no longer publish to it',
};
const toIso = (local: string) => local ? new Date(local).toISOString() : null;
const viewResponse = z.object({ broadcast: broadcastViewSchema });

/**
 * Banner for one application (owner decision 2026-10-12): opened from the application's "Create banner" tool, it
 * writes, reviews and publishes an Everyone banner to that application only, without leaving the workspace. Same
 * rules as the Announcements page: the server re-checks the author's right (broadcast role, or Tier 1+ there), the
 * review binds publication to this content and recipient, and a repeated publish is the same publication.
 */
@Component({
 selector: 'rs-banner-modal',
 imports: [IconComponent, RouterLink],
 template: `
<div class="modal-scrim" (click)="close()">
 <div #dlg class="modal" role="dialog" aria-modal="true" aria-labelledby="bn-title" tabindex="-1" style="width:720px" (click)="$event.stopPropagation()" (keydown)="onKey($event)">
  <div class="modal-head">
   <div style="flex:1">
    <div class="tags" style="gap:8px"><span class="src">BANNER</span><span class="meta" style="font-size:12px">Everyone · {{ appName() }} only</span></div>
    <h2 id="bn-title" style="font-size:20px;font-weight:650;letter-spacing:-0.02em;margin-top:6px">{{ stage() === 'done' ? (view()?.content?.title ?? 'Banner') : 'New banner for ' + appName() }}</h2>
    <div style="font-size:var(--fs-sm);color:var(--ink-3);margin-top:4px">Each application shows it in its own banner design; Resolve sends only the content, as you.</div>
   </div>
   <button class="icon-btn" type="button" (click)="close()" aria-label="Close"><rs-icon name="x" [size]="18" /></button>
  </div>

  @switch (stage()) {
   @case ('write') {
    <form id="bn-form" style="padding:16px 22px" (submit)="review($event)" novalidate>
     <div class="field">
      <label for="bn-kind">Type of notice</label>
      <select id="bn-kind" class="select" [value]="kind()" (change)="kind.set($any($event.target).value)">
       @for (k of kinds; track k) { <option [value]="k">{{ kindLabel(k) }}</option> }
      </select>
     </div>
     <div class="field">
      <label for="bn-title-input">Title <span class="req" aria-hidden="true">*</span><span class="sr-only">(required)</span></label>
      <input id="bn-title-input" class="input" maxlength="140" [value]="title()" (input)="title.set($any($event.target).value)" [attr.aria-invalid]="fieldErr() === 'content.title' || null" [attr.aria-describedby]="fieldErr() === 'content.title' ? 'bn-error' : null" />
     </div>
     <div class="field">
      <label for="bn-body">Message <span class="meta">(optional, plain text)</span></label>
      <textarea id="bn-body" class="textarea" maxlength="500" [value]="body()" (input)="body.set($any($event.target).value)"></textarea>
     </div>
     <div style="display:flex;gap:12px;flex-wrap:wrap">
      <div class="field" style="flex:2 1 260px"><label for="bn-url">Link address <span class="meta">(optional, https)</span></label>
       <input id="bn-url" class="input" type="url" [value]="linkUrl()" (input)="linkUrl.set($any($event.target).value)" [attr.aria-invalid]="fieldErr() === 'content.link.url' || null" /></div>
      <div class="field" style="flex:1 1 180px"><label for="bn-label">Link text</label>
       <input id="bn-label" class="input" [value]="linkLabel()" (input)="linkLabel.set($any($event.target).value)" [attr.aria-invalid]="fieldErr() === 'content.link.label' || null" /></div>
     </div>
     <fieldset class="field" style="border:0;padding:0;margin:0 0 16px">
      <legend style="font-size:var(--fs-sm);font-weight:500;margin-bottom:6px">Show on</legend>
      <label class="tags" style="gap:8px;font-size:var(--fs-sm);font-weight:400"><input type="checkbox" [checked]="portal()" (change)="portal.set($any($event.target).checked)"> Support portal</label>
      <label class="tags" style="gap:8px;font-size:var(--fs-sm);font-weight:400;margin-top:6px"><input type="checkbox" [checked]="embed()" (change)="embed.set($any($event.target).checked)"> Inside the application (needs the banner script installed by the app's team)</label>
     </fieldset>
     <div style="display:flex;gap:12px;flex-wrap:wrap">
      <div class="field" style="flex:1 1 220px"><label for="bn-at">Publish at <span class="meta">(optional)</span></label>
       <input id="bn-at" class="input" type="datetime-local" [value]="publishAt()" (input)="publishAt.set($any($event.target).value)" /></div>
      <div class="field" style="flex:1 1 220px"><label for="bn-exp">Expires at <span class="meta">(optional)</span></label>
       <input id="bn-exp" class="input" type="datetime-local" [value]="expiresAt()" (input)="expiresAt.set($any($event.target).value)" [attr.aria-invalid]="fieldErr() === 'content.expiresAt' || null" /></div>
     </div>
    </form>
   }
   @case ('review') {
    @if (rv(); as r) {
     <div style="padding:16px 22px;display:flex;flex-direction:column;gap:14px">
      <div class="msgbox"><b style="color:var(--ink)">{{ title() }}</b>@if (body()) { <div style="margin-top:4px">{{ body() }}</div> }@if (linkUrl()) { <div class="meta" style="margin-top:6px">{{ linkLabel() || linkUrl() }} · {{ linkUrl() }}</div> }</div>
      <div>
       <div style="font-weight:620;margin-bottom:6px">Recipient</div>
       @for (x of r.recipients; track x.appKey) {
        <div class="chk"><span class="cic" [attr.data-s]="x.state === 'ready' ? 'ok' : 'bad'" aria-hidden="true"><rs-icon [name]="x.state === 'ready' ? 'check' : 'x'" [size]="12" /></span>
         <div style="flex:1"><div class="t">{{ x.displayName }}</div><div class="d">{{ x.state === 'ready' ? 'Ready to receive it' : 'Cannot receive it now: ' + blockText(x.reason) }}</div></div></div>
       }
      </div>
      <p class="meta" style="margin:0">{{ publishAt() ? 'Publishes at ' + localTime(publishAt()) + '.' : 'Publishes when you confirm.' }} Recorded in the Resolve audit as {{ state.user()?.displayName }}.</p>
     </div>
    }
   }
   @case ('done') {
    <div style="padding:16px 22px;display:flex;flex-direction:column;gap:12px" role="status">
     @if (view(); as v) {
      <div class="tags" style="gap:8px"><span class="dot" [attr.data-tone]="v.status === 'published' ? 'safe' : v.status === 'scheduled' || v.status === 'publishing' ? 'sys' : 'sensitive'" aria-hidden="true"></span><b>{{ statusLabel(v.status) }}</b></div>
      @for (d of v.deliveries; track d.appKey) {
       <div class="kv"><span class="k">{{ d.displayName }}</span><span>{{ d.state }}@if (d.surfaces; as s) { · portal {{ s.portal === 'published' ? 'published' : '—' }} · in app {{ s.embed === 'published' ? 'published' : s.embed === 'not_installed' ? 'script not installed' : '—' }} }</span></div>
      }
      @for (n of v.notes; track n) { <p class="small" style="margin:0">{{ n }}</p> }
     }
    </div>
   }
  }

  <div class="modal-foot">
   @if (error()) { <span class="small" role="alert" id="bn-error" style="flex:1;color:var(--destructive-ink)">{{ error() }}</span> } @else { <span class="audit-note" style="flex:1">Banner to {{ appName() }} only</span> }
   @switch (stage()) {
    @case ('write') {
     <button class="btn btn-outline" type="button" (click)="close()">Cancel</button>
     <button class="btn btn-primary" type="submit" form="bn-form" [disabled]="busy()">{{ busy() ? 'Checking…' : 'Review' }}</button>
    }
    @case ('review') {
     <button class="btn btn-outline" type="button" (click)="stage.set('write')" [disabled]="busy()">Back</button>
     <button class="btn btn-primary" type="button" (click)="publish()" [disabled]="busy() || !ready()" data-autofocus>{{ busy() ? 'Publishing…' : publishAt() ? 'Schedule banner' : 'Publish banner' }}</button>
    }
    @case ('done') {
     @if (view(); as v) { <a class="btn btn-outline" [routerLink]="['/announcements', v.id]" (click)="close()">Open in Announcements</a> }
     <button class="btn btn-primary" type="button" (click)="close()" data-autofocus>Done</button>
    }
   }
  </div>
 </div>
</div>`,
})
export class BannerModalComponent {
 readonly appKey = input.required<string>();
 readonly appName = input.required<string>();
 readonly closed = output<void>();
 readonly state = inject(AppState);
 private readonly toast = inject(ToastService);
 readonly kinds = KINDS;
 readonly stage = signal<'write' | 'review' | 'done'>('write');
 readonly kind = signal<(typeof KINDS)[number]>('info');
 readonly title = signal('');
 readonly body = signal('');
 readonly linkUrl = signal('');
 readonly linkLabel = signal('');
 readonly portal = signal(true);
 readonly embed = signal(true);
 readonly publishAt = signal('');
 readonly expiresAt = signal('');
 readonly busy = signal(false);
 readonly error = signal('');
 readonly fieldErr = signal('');
 readonly rv = signal<BroadcastReview | null>(null);
 readonly view = signal<BroadcastView | null>(null);
 private id: string | null = null;
 private version = 0;
 private requestId = crypto.randomUUID();
 private opener = document.activeElement as HTMLElement | null;
 private timer?: ReturnType<typeof setInterval>;
 private readonly dlg = viewChild<ElementRef<HTMLElement>>('dlg');

 constructor() { inject(DestroyRef).onDestroy(() => clearInterval(this.timer)); }
 ngAfterViewInit() { this.focusIn('#bn-title-input'); }
 kindLabel(k: string) { return KIND_LABEL[k] ?? k; }
 statusLabel(s: string) { return STATUS_LABEL[s] ?? s; }
 blockText(r: string | null) { return BLOCK_TEXT[r ?? ''] ?? 'it is not ready'; }
 localTime(local: string) { return new Date(local).toLocaleString(); }
 ready() { return !!this.rv()?.recipients.some(x => x.state === 'ready') || !!this.publishAt(); }

 private draft() {
  return {
   content: {
    kind: this.kind(), title: this.title().trim(), body: this.body().trim() || null,
    link: this.linkUrl().trim() ? { url: this.linkUrl().trim(), label: this.linkLabel().trim() } : null,
    surfaces: [...(this.portal() ? ['portal'] : []), ...(this.embed() ? ['embed'] : [])], audience: 'everyone',
    publishAt: toIso(this.publishAt()), expiresAt: toIso(this.expiresAt()),
   },
   targeting: { mode: 'selected', apps: [this.appKey()] },
  };
 }
 private fail(e: { message: string; field?: string } | undefined) {
  this.error.set(e?.message ?? 'Something went wrong.'); this.fieldErr.set(e?.field ?? '');
  const id = ({ 'content.title': 'bn-title-input', 'content.link.url': 'bn-url', 'content.link.label': 'bn-label', 'content.expiresAt': 'bn-exp' } as Record<string, string>)[e?.field ?? ''];
  if (id) setTimeout(() => document.getElementById(id)?.focus());
 }

 /** Save the draft (create or update), then review its one recipient. */
 async review(e: Event) {
  e.preventDefault();
  this.busy.set(true); this.error.set(''); this.fieldErr.set('');
  const draft = this.draft();
  const saved = this.id
   ? await send('PUT', `/api/broadcasts/${this.id}`, { draft, version: this.version }, viewResponse)
   : await send('POST', '/api/broadcasts', draft, z.object({ id: z.string() }));
  if (!saved.ok) { this.busy.set(false); return this.fail(saved.error); }
  if (!this.id) this.id = (saved.data as { id: string }).id;
  this.version = (await api(`/api/broadcasts/${this.id}`, viewResponse)).broadcast.version;
  const r = await send('POST', `/api/broadcasts/${this.id}/review`, {}, z.object({ review: broadcastReviewSchema }));
  this.busy.set(false);
  if (!r.ok) return this.fail(r.error);
  this.rv.set(r.data!.review); this.stage.set('review');
  this.focusIn('[data-autofocus]');
 }

 async publish() {
  const r = this.rv()!;
  this.busy.set(true); this.error.set('');
  const res = await send('POST', `/api/broadcasts/${r.broadcastId}/publish`, { reviewHash: r.reviewHash, requestId: this.requestId, confirmPartial: false }, viewResponse);
  this.busy.set(false);
  if (!res.ok) { if (res.error?.code === 'STALE_REVIEW') this.stage.set('write'); return this.fail(res.error); }
  this.view.set(res.data!.broadcast); this.stage.set('done');
  this.toast.show(`${this.publishAt() ? 'Banner scheduled' : 'Banner publishing'} · ${this.appName()}`);
  this.focusIn('[data-autofocus]');
  // Follow delivery until the application confirms (or reports a problem).
  this.timer = setInterval(async () => {
   const v = await api(`/api/broadcasts/${r.broadcastId}`, viewResponse).catch(() => null);
   if (v) this.view.set(v.broadcast);
   if (v && !['publishing', 'draft'].includes(v.broadcast.status)) clearInterval(this.timer);
  }, 2000);
 }

 close() { clearInterval(this.timer); this.closed.emit(); setTimeout(() => this.opener?.focus()); }
 onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
  if (e.key !== 'Tab') return;
  const el = this.dlg()?.nativeElement; if (!el) return;
  const f = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea')];
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1)!.focus(); }
  else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
 }
 private focusIn(sel: string) { setTimeout(() => { const el = this.dlg()?.nativeElement; (el?.querySelector<HTMLElement>(sel) ?? el)?.focus(); }); }
}
