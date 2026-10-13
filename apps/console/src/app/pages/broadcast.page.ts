import { Component, computed, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Location } from '@angular/common';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { broadcastReviewSchema, broadcastViewSchema, type BroadcastReview, type BroadcastView, type DeliveryView } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { RESOLVE_ELEMENTS, ResolveConfirmDialog } from '../elements';
import { ClearanceService } from '../ui';
import { api, AppState, focusField, fullTime, send } from '../state';
import { STATUS_LABEL, STATUS_TONE } from './broadcasts.page';

const viewResponse = z.object({ broadcast: broadcastViewSchema });
const REASON_TEXT: Record<string, string> = {
 not_registered: 'Not registered', suspended: 'Suspended', not_open: 'Not open yet', not_connected: 'You are not connected', reconnect_required: 'Reconnect required',
 missing_scope: 'Your connection lacks announcement access: reconnect', unsupported: 'Does not support fleet announcements yet', unreachable: 'Did not respond',
 author_not_authorized: 'The author can no longer publish',
};
const STATE_LABEL: Record<string, string> = { pending: 'Sending', blocked: 'Not delivered', succeeded: 'Published', failed: 'Failed', uncertain: 'Not confirmed' };
const STATE_TONE: Record<string, string> = { pending: 'neutral', blocked: 'sensitive', succeeded: 'safe', failed: 'destructive', uncertain: 'sensitive' };
const KINDS = ['info', 'warning', 'critical', 'maintenance', 'success'] as const;
const KIND_LABEL: Record<string, string> = { info: 'Information', warning: 'Warning', critical: 'Critical', maintenance: 'Maintenance', success: 'Resolved / success' };
/** datetime-local value <-> ISO (the input has no time zone; it is the browser's local time). */
const toIso = (local: string) => local ? new Date(local).toISOString() : null;
const toLocal = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/**
 * One banner (plan 08): write and preview, choose All registered apps or Selected apps, review the exact recipients
 * and their readiness, and publish (confirming a partial delivery when some apps cannot take it). Afterwards: per-app
 * results with Check result / Send again, Edit (a new revision, version-checked in each app) and Archive.
 */
@Component({
 selector: 'rs-broadcast-page',
 imports: [RouterLink, IconComponent, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page">
 <a class="back" routerLink="/announcements"><rs-icon name="arrowL" [size]="15" />Announcements</a>
 <header class="page-head">
  <p class="eyebrow">Banner@if (view(); as v) { · <span class="tag" [attr.data-tone]="statusTone(v.status)">{{ statusLabel(v.status) }}</span> · by {{ v.author }} }</p>
  <h1 class="page-title" tabindex="-1">{{ view()?.content?.title ?? 'New banner' }}</h1>
 </header>
 @if (error(); as e) { <p class="notice" data-tone="destructive" role="alert" id="form-error" tabindex="-1">{{ e }}</p> }
 @if (message()) { <p class="notice" data-tone="safe" role="status">{{ message() }}</p> }

 @if (editing()) {
  <div class="lp-cols">
   <section class="card" aria-labelledby="edit-title">
    <div class="card-head"><h2 class="card-title" id="edit-title">{{ view() && view()!.status !== 'draft' ? 'Edit the published banner' : 'Banner' }}</h2></div>
    <form class="pad form-stack" (submit)="save($event)" novalidate>
     <label class="field-label" for="kind">Type of notice</label>
     <select id="kind" name="kind" [value]="kind()" (change)="kind.set($any($event.target).value)" aria-describedby="kind-hint">
      @for (k of kinds; track k) { <option [value]="k">{{ kindLabel(k) }}</option> }
     </select>
     <p class="muted small" id="kind-hint">What kind of notice this is. Each application shows it in its own banner design; Resolve sends only the content.</p>
     <resolve-text-field name="title" label="Title" [required]="true" [maxlength]="140" [(value)]="title" [error]="fieldError('content.title')"/>
     <label class="field-label" for="body">Message (optional, plain text)</label>
     <textarea id="body" name="body" class="text-input textarea" rows="3" maxlength="500" [value]="body()" (input)="body.set($any($event.target).value)"></textarea>
     <resolve-text-field name="linkUrl" label="Link address (optional, https)" kind="url" [(value)]="linkUrl" [error]="fieldError('content.link.url')"/>
     <resolve-text-field name="linkLabel" label="Link text" [maxlength]="60" [(value)]="linkLabel" [error]="fieldError('content.link.label')"/>
     <fieldset class="radio-set" name="surfaces" tabindex="-1">
      <legend>Show on</legend>
      <label class="check"><input type="checkbox" [checked]="portal()" (change)="portal.set($any($event.target).checked)">Support portal</label>
      <label class="check"><input type="checkbox" [checked]="embed()" (change)="embed.set($any($event.target).checked)">Inside the application (needs the banner script installed by the app's team)</label>
      @if (fieldError('content.surfaces')) { <p class="field-error">{{ fieldError('content.surfaces') }}</p> }
     </fieldset>
     @if (!published()) {
      <fieldset class="radio-set" name="targeting" tabindex="-1">
       <legend>Send to</legend>
       @if (!tierOnly()) {
        <label><input type="radio" name="mode" value="all" [checked]="mode() === 'all'" (change)="mode.set('all')">All registered apps</label>
        <label><input type="radio" name="mode" value="selected" [checked]="mode() === 'selected'" (change)="mode.set('selected')">Selected apps</label>
       } @else { <p class="small muted">You can send banners to the applications where you hold Tier 1 or higher.</p> }
       @if (mode() === 'selected') {
        <ul class="app-checklist" aria-label="Applications">
         @for (a of choosable(); track a.appKey) {
          <li><label class="check"><input type="checkbox" [checked]="selected().includes(a.appKey)" (change)="toggleApp(a.appKey, $any($event.target).checked)">{{ a.displayName }}
           <span class="muted small">{{ !a.servable ? (a.state === 'suspended' ? 'suspended' : 'not open') : a.connection.state === 'connected' ? 'connected' : 'not connected' }}</span></label></li>
         } @empty { <li class="small muted">{{ tierOnly() ? 'No application reports Tier 1 or higher for you.' : 'No applications.' }}</li> }
        </ul>
       }
       @if (fieldError('targeting.apps')) { <p class="field-error">{{ fieldError('targeting.apps') }}</p> }
      </fieldset>
      <label class="field-label" for="publishAt">Publish at (optional; empty publishes when you confirm)</label>
      <input id="publishAt" name="publishAt" class="text-input" type="datetime-local" [value]="publishAt()" (input)="publishAt.set($any($event.target).value)">
     }
     <label class="field-label" for="expiresAt">Expires (optional)</label>
     <input id="expiresAt" name="expiresAt" class="text-input" type="datetime-local" [value]="expiresAt()" (input)="expiresAt.set($any($event.target).value)" [attr.aria-describedby]="fieldError('content.expiresAt') ? 'expiry-error' : null">
     @if (fieldError('content.expiresAt')) { <p class="field-error" id="expiry-error">{{ fieldError('content.expiresAt') }}</p> }
     <div class="row">
      @if (published()) {
       <button class="btn btn-primary" type="submit" [disabled]="busy()">Publish changes</button>
       <button class="btn" type="button" (click)="editingPublished.set(false)">Cancel</button>
      } @else { <button class="btn btn-primary" type="submit" [disabled]="busy()">Save and review</button> }
     </div>
    </form>
   </section>
   <aside class="card" aria-labelledby="preview-title">
    <div class="card-head"><h2 class="card-title" id="preview-title">Content</h2><span class="card-meta">Everyone</span></div>
    <div class="pad">
     <div role="group" aria-label="Banner preview"><dl class="content-preview">
      <div><dt>Type</dt><dd>{{ kindLabel(kind()) }}</dd></div>
      <div><dt>Title</dt><dd>{{ title() || '—' }}</dd></div>
      <div><dt>Message</dt><dd>{{ body() || '—' }}</dd></div>
      <div><dt>Link</dt><dd>@if (linkUrl() && linkLabel()) { {{ linkLabel() }} <span class="muted mono small">{{ linkUrl() }}</span> } @else { — }</dd></div>
     </dl></div>
     <p class="muted small">This is the content Resolve sends. Each application draws it with its own banner widget and styles for this type of notice,
      keeps its own ordering, and always lets people dismiss it.</p>
    </div>
   </aside>
  </div>
 }

 @if (review(); as rv) {
  <section class="card" aria-labelledby="review-title">
   <div class="card-head"><h2 class="card-title" id="review-title">Review recipients</h2><span class="card-meta">{{ ready(rv) }} ready · {{ blocked(rv) }} not ready</span></div>
   <div class="pad">
    @if (rv.followsRegistry) { <p class="small">Scheduled for all registered apps: applications registered before the publish time are included too, and readiness is checked again then.</p> }
    <div class="table-wrap"><table class="data"><caption class="sr-only">Recipients and readiness</caption>
     <thead><tr><th scope="col">Application</th><th scope="col">Readiness</th></tr></thead>
     <tbody>@for (r of rv.recipients; track r.appKey) {
      <tr><td>{{ r.displayName }}</td><td><span class="tag" [attr.data-tone]="r.state === 'ready' ? 'safe' : 'sensitive'">{{ r.state === 'ready' ? 'Ready' : 'Not ready' }}</span>@if (r.reason) { <span class="small"> {{ reasonText(r.reason) }}</span> }</td></tr>
     }</tbody>
    </table></div>
    @if (blocked(rv)) {
     <label class="check"><input type="checkbox" name="confirmPartial" [checked]="confirmPartial()" (change)="confirmPartial.set($any($event.target).checked)">
      Publish to the {{ ready(rv) }} ready application{{ ready(rv) === 1 ? '' : 's' }} only. The {{ blocked(rv) }} not ready will be recorded as not delivered; you can send to them later.</label>
    }
    <div class="row">
     <button class="btn btn-primary" type="button" (click)="publishDialog()?.show()" [disabled]="busy() || (blocked(rv) > 0 && !confirmPartial())">{{ isScheduled() ? 'Schedule…' : 'Publish…' }}</button>
     <button class="btn" type="button" (click)="review.set(undefined)">Back to editing</button>
    </div>
   </div>
  </section>
 }

 @if (view(); as v) {
  @if (v.status !== 'draft') {
   @if (v.notes.length) { <ul class="notes card pad" aria-label="Notes">@for (n of v.notes; track n) { <li>{{ n }}</li> }</ul> }
   <section class="card" aria-labelledby="deliveries-title">
    <div class="card-head"><h2 class="card-title" id="deliveries-title">Delivery by application</h2><span class="card-meta">Revision {{ v.revision }}</span></div>
    <div class="table-wrap pad-sm"><table class="data"><caption class="sr-only">Publication result in each application</caption>
     <thead><tr><th scope="col">Application</th><th scope="col">Result</th><th scope="col">Surfaces</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
     <tbody>@for (d of v.deliveries; track d.appKey) {
      <tr>
       <td>{{ d.displayName }}</td>
       <td><span class="tag" [attr.data-tone]="stateTone(d.state)">{{ stateLabel(d.state) }}</span>
        @if (d.reason) { <div class="small">{{ reasonText(d.reason) }}</div> }@if (d.failureCode) { <div class="muted small mono">{{ d.failureCode }}</div> }
        @if (d.archive) { <div class="small">Archive: {{ d.archive.state }}@if (d.archive.failureCode) { <span class="mono"> {{ d.archive.failureCode }}</span> }</div> }</td>
       <td class="small">@if (d.surfaces; as s) { Portal: {{ s.portal === 'published' ? 'published' : '—' }} · In app: {{ s.embed === 'published' ? 'published' : s.embed === 'not_installed' ? 'script not installed' : '—' }} } @else { — }</td>
       <td class="actions-cell">@if (v.canAct && v.status !== 'archived') {
        @if (d.state === 'uncertain') { <button class="btn btn-sm" type="button" (click)="act('reconcile', d)" [disabled]="busy()">Check result<span class="sr-only"> for {{ d.displayName }}</span></button> }
        @if (d.state === 'failed' || d.state === 'blocked') { <button class="btn btn-sm" type="button" (click)="act('retry', d)" [disabled]="busy()">Send again<span class="sr-only"> to {{ d.displayName }}</span></button> }
       }</td>
      </tr>
     } @empty { <tr><td colspan="4" class="muted">{{ v.status === 'scheduled' ? 'Recipients are fixed when it publishes.' : 'No deliveries.' }}</td></tr> }</tbody>
    </table></div>
    @if (v.canAct && v.status !== 'archived') {
     <div class="pad row">
      @if (!editing() && v.status !== 'scheduled') { <button class="btn" type="button" (click)="startEditPublished()">Edit…</button> }
      <button class="btn" type="button" (click)="archiveDialog()?.show()" [disabled]="busy()">{{ v.status === 'scheduled' ? 'Cancel scheduled banner…' : 'Archive everywhere…' }}</button>
     </div>
    } @else if (!v.canAct) { <p class="pad muted small">Only {{ v.author }} can change this banner: it is published as them.</p> }
   </section>
  }
 }
 <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>
 <resolve-confirm-dialog #publishDialogRef [heading]="isScheduled() ? 'Schedule this banner?' : 'Publish this banner?'"
  [description]="'It is published as you, to everyone in ' + (review() ? ready(review()!) : 0) + ' application(s)' + (blockedCount() ? ', and recorded as not delivered in ' + blockedCount() + '.' : '.')"
  [confirmLabel]="isScheduled() ? 'Schedule' : 'Publish'" cancelLabel="Not yet" (confirmed)="publish()"/>
 <resolve-confirm-dialog #archiveDialogRef tone="destructive" [heading]="view()?.status === 'scheduled' ? 'Cancel this scheduled banner?' : 'Archive this banner everywhere?'"
  description="It is removed in each application that has it. A banner someone edited inside an application is reported, not overwritten."
  confirmLabel="Archive" cancelLabel="Keep it" (confirmed)="archive()"/>
</div>`,
})
export class BroadcastPage {
 readonly id = input<string>();
 /** Query parameter from an application's "Create banner" tool (bound by the router). */
 readonly app = input<string>();
 readonly state = inject(AppState);
 private readonly location = inject(Location);
 readonly kinds = KINDS;
 readonly fullTime = fullTime;
 readonly view = signal<BroadcastView | undefined>(undefined);
 readonly review = signal<BroadcastReview | undefined>(undefined);
 readonly error = signal('');
 readonly errorField = signal('');
 readonly message = signal('');
 readonly announcement = signal('');
 readonly busy = signal(false);
 readonly editingPublished = signal(false);
 readonly confirmPartial = signal(false);
 readonly publishDialog = viewChild('publishDialogRef', { read: ResolveConfirmDialog });
 readonly archiveDialog = viewChild('archiveDialogRef', { read: ResolveConfirmDialog });
 // Form
 readonly kind = signal<(typeof KINDS)[number]>('info');
 readonly title = signal('');
 readonly body = signal('');
 readonly linkUrl = signal('');
 readonly linkLabel = signal('');
 readonly portal = signal(true);
 readonly embed = signal(true);
 readonly mode = signal<'all' | 'selected'>('all');
 private readonly clearance = inject(ClearanceService);
 canAuthor() { return this.state.can('broadcast.publish') || this.state.can('broadcast.app'); }
 /** Tier-scoped authors (owner decision 2026-10-12): banners only to applications where they hold Tier 1 or higher. */
 readonly tierOnly = computed(() => !this.state.can('broadcast.publish') && this.state.can('broadcast.app'));
 readonly choosable = computed(() => (this.state.apps()?.apps ?? []).filter(a => !this.tierOnly() || !!this.clearance.tierOf(a.appKey)));
 readonly selected = signal<string[]>([]);
 readonly publishAt = signal('');
 readonly expiresAt = signal('');
 readonly published = computed(() => !!this.view() && this.view()!.status !== 'draft');
 readonly editing = computed(() => !this.published() ? !this.review() : this.editingPublished());
 readonly isScheduled = computed(() => !!this.publishAt() && Date.parse(toIso(this.publishAt())!) > Date.now() + 5000);
 readonly blockedCount = computed(() => this.review() ? this.blocked(this.review()!) : 0);
 private requestId = crypto.randomUUID();
 private poll?: ReturnType<typeof setInterval>;
 private lastStatus = '';

 constructor() {
  effect(() => {
   const id = this.id();
   if (!this.canAuthor()) return;
   untracked(() => {
    if (id) { this.load(id, true); return; }
    // From an application's "Create banner" tool: that application, preselected.
    const app = this.app();
    if (app) { this.mode.set('selected'); this.selected.set([app]); }
    else if (this.tierOnly()) this.mode.set('selected');
    this.focusHeading();
   });
  });
  inject(DestroyRef).onDestroy(() => clearInterval(this.poll));
 }

 statusLabel(s: string) { return STATUS_LABEL[s] ?? s; }
 statusTone(s: string) { return STATUS_TONE[s] ?? 'neutral'; }
 stateLabel(s: string) { return STATE_LABEL[s] ?? s; }
 stateTone(s: string) { return STATE_TONE[s] ?? 'neutral'; }
 reasonText(r: string) { return REASON_TEXT[r] ?? r; }
 kindLabel(k: string) { return KIND_LABEL[k] ?? k; }
 ready(rv: BroadcastReview) { return rv.recipients.filter(r => r.state === 'ready').length; }
 blocked(rv: BroadcastReview) { return rv.recipients.filter(r => r.state === 'blocked').length; }
 fieldError(f: string) { return this.errorField() === f ? this.error() : ''; }
 toggleApp(key: string, on: boolean) { this.selected.update(l => on ? [...new Set([...l, key])] : l.filter(k => k !== key)); }
 private focusHeading() { setTimeout(() => { if (document.activeElement?.id === 'main') document.querySelector<HTMLElement>('main h1')?.focus(); }); }
 private say(t: string) { this.announcement.set(''); setTimeout(() => this.announcement.set(t), 50); }

 load(id: string, first = false) {
  return api(`/api/broadcasts/${encodeURIComponent(id)}`, viewResponse).then(r => {
   const v = r.broadcast;
   this.view.set(v);
   if (first) { this.fill(v); this.focusHeading(); }
   if (this.lastStatus && v.status !== this.lastStatus) this.say(`Banner: ${this.statusLabel(v.status)}.`);
   this.lastStatus = v.status;
   const live = v.status === 'publishing' || v.status === 'scheduled' || v.deliveries.some(d => d.state === 'pending');
   if (live && !this.poll) this.poll = setInterval(() => this.load(id), 1500);
   if (!live && this.poll) { clearInterval(this.poll); this.poll = undefined; }
  }).catch(e => this.error.set(e.message));
 }

 private fill(v: BroadcastView) {
  const c = v.content;
  this.kind.set(c.kind); this.title.set(c.title); this.body.set(c.body ?? ''); this.linkUrl.set(c.link?.url ?? ''); this.linkLabel.set(c.link?.label ?? '');
  this.portal.set(c.surfaces.includes('portal')); this.embed.set(c.surfaces.includes('embed'));
  this.publishAt.set(toLocal(c.publishAt)); this.expiresAt.set(toLocal(c.expiresAt));
  this.mode.set(v.targeting.mode); this.selected.set(v.targeting.mode === 'selected' ? v.targeting.apps : []);
 }

 private content() {
  return {
   kind: this.kind(), title: this.title().trim(), body: this.body().trim() || null,
   link: this.linkUrl().trim() ? { url: this.linkUrl().trim(), label: this.linkLabel().trim() } : null,
   surfaces: [...(this.portal() ? ['portal'] : []), ...(this.embed() ? ['embed'] : [])], audience: 'everyone',
   publishAt: this.published() ? null : toIso(this.publishAt()), expiresAt: toIso(this.expiresAt()),
  };
 }
 private fail(e: { message: string; field?: string } | undefined) {
  this.error.set(e?.message ?? 'Something went wrong.'); this.errorField.set(e?.field ?? ''); this.message.set('');
  const field = ({ 'content.title': 'title', 'content.link.url': 'linkUrl', 'content.link.label': 'linkLabel', 'content.surfaces': 'surfaces', 'targeting.apps': 'targeting', 'content.expiresAt': 'expiresAt' } as Record<string, string>)[e?.field ?? ''];
  if (field) focusField(field); else setTimeout(() => document.getElementById('form-error')?.focus());
 }

 async save(event: Event) {
  event.preventDefault();
  if (this.published()) return this.revise();
  this.busy.set(true);
  const draft = { content: this.content(), targeting: this.mode() === 'all' ? { mode: 'all' } : { mode: 'selected', apps: this.selected() } };
  const v = this.view();
  const res = v
   ? await send('PUT', `/api/broadcasts/${v.id}`, { draft, version: v.version }, viewResponse)
   : await send('POST', '/api/broadcasts', draft, z.object({ id: z.string() }));
  if (!res.ok) { this.busy.set(false); return this.fail(res.error); }
  const id = v?.id ?? (res.data as { id: string }).id;
  // Keep the address shareable without re-routing (which would rebuild this page mid-save).
  if (!v) this.location.replaceState(`/announcements/${id}`);
  await this.load(id);
  const rv = await send('POST', `/api/broadcasts/${id}/review`, {}, z.object({ review: broadcastReviewSchema }));
  this.busy.set(false);
  if (!rv.ok) return this.fail(rv.error);
  this.error.set(''); this.errorField.set('');
  this.review.set(rv.data!.review); this.confirmPartial.set(false);
  this.say(`Review: ${this.ready(rv.data!.review)} ready, ${this.blocked(rv.data!.review)} not ready.`);
  setTimeout(() => document.getElementById('review-title')?.focus());
 }

 async publish() {
  const rv = this.review()!;
  this.busy.set(true);
  const res = await send('POST', `/api/broadcasts/${rv.broadcastId}/publish`, { reviewHash: rv.reviewHash, requestId: this.requestId, confirmPartial: this.confirmPartial() }, viewResponse);
  this.busy.set(false);
  if (!res.ok) { if (res.error?.code === 'STALE_REVIEW') this.review.set(undefined); return this.fail(res.error); }
  this.review.set(undefined);
  this.message.set(this.isScheduled() ? 'Scheduled.' : 'Publishing started.');
  this.view.set(res.data!.broadcast);
  await this.load(rv.broadcastId);
 }

 startEditPublished() { this.fill(this.view()!); this.editingPublished.set(true); this.requestId = crypto.randomUUID(); setTimeout(() => document.getElementById('edit-title')?.focus()); }
 private async revise() {
  const v = this.view()!;
  this.busy.set(true);
  const res = await send('POST', `/api/broadcasts/${v.id}/revise`, { content: this.content(), version: v.version, requestId: this.requestId }, viewResponse);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error);
  this.editingPublished.set(false); this.message.set('Changes are being published.');
  await this.load(v.id);
 }
 async act(kind: 'reconcile' | 'retry', d: DeliveryView) {
  this.busy.set(true);
  const res = await send('POST', `/api/broadcasts/${this.view()!.id}/deliveries/${encodeURIComponent(d.appKey)}/${kind}`, {}, viewResponse);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error);
  this.error.set(''); this.message.set(kind === 'reconcile' ? `${d.displayName}: checked with the application.` : `${d.displayName}: sent again.`);
  await this.load(this.view()!.id);
 }
 async archive() {
  this.busy.set(true);
  const res = await send('POST', `/api/broadcasts/${this.view()!.id}/archive`, { requestId: crypto.randomUUID() }, viewResponse);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error);
  this.message.set('Archived.');
  await this.load(this.view()!.id);
 }
}
