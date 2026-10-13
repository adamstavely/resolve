import { Component, computed, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, effect, ElementRef, inject, input, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { activityResponseSchema, conversationDetailResponseSchema, evidenceSnapshotSchema, ticketDetailResponseSchema, type ConversationActivity, type ThreadMessage } from '../../../../../packages/contracts/src/index';
import { MessageSender, postAction } from '../actions';
import { IconComponent } from '../icon.component';
import { InboxService } from '../inbox.service';
import { HEALTH_LABEL, ObservabilityService } from '../observability.service';
import { api, AppState, fullTime, send } from '../state';
import { ClearanceService, hm, hueOf, initialsOf, ToastService } from '../ui';
import { chatRef, PRIORITY_CODE, PRIORITY_TEXT, WorkService } from '../work.service';
import { BannerModalComponent } from './banner-modal.component';
import { CaseContextComponent } from './case-context.component';
import { ComposerComponent } from './composer.component';
import { ThreadComponent } from './thread.component';
import { ToolDrawerComponent, ToolRailComponent, type DrawerTool, type RailTool } from './tools.component';

type TicketDetail = z.infer<typeof ticketDetailResponseSchema>['detail'];
type ConversationDetail = z.infer<typeof conversationDetailResponseSchema>['detail'];
/** Viewing is refreshed while the thread is open and the page visible; the tenant expires it shortly after. */
const VIEWING_REFRESH_MS = 20_000;
const names = (list: string[]) => list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
const TICKET_STATE: Record<string, string> = { open: 'Open', pending: 'Waiting on customer', closed: 'Resolved' };
const CHAT_STATE: Record<string, string> = { open: 'Open', snoozed: 'Snoozed', closed: 'Closed' };

/**
 * Case workspace (prototype v2 `CaseView`, plan 16): tool rail | conversation | Resolve context. One page for tickets
 * (`/tickets/:app/:id`) and chats (`/inbox/:app/:id`). Replies, notes and actions go out as you, from the application's
 * own record; nothing is shown as done until the application confirms it.
 */
@Component({
 selector: 'rs-case-page',
 imports: [BannerModalComponent, RouterLink, IconComponent, ThreadComponent, ComposerComponent, CaseContextComponent, ToolRailComponent, ToolDrawerComponent],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="case">
 <rs-tool-rail [appName]="appName()" [subtitle]="'Tools for ' + refLabel()" [tier]="tier()" [tools]="tools()" (run)="runTool($event)" />

 <div class="conv">
  <div class="conv-head">
   <div class="conv-crumb">
    <a class="btn btn-ghost btn-sm" style="height:24px;padding:0 6px;margin-left:-6px" [routerLink]="kind() === 'ticket' ? '/tickets' : '/inbox'"><rs-icon name="arrowL" [size]="13" /> {{ kind() === 'ticket' ? 'My tickets' : 'Inbox' }}</a>
    <span style="flex:1"></span>
    @if (loadedAt(); as t) { <span class="tags" style="color:var(--teal-ink);gap:6px;white-space:nowrap;flex-wrap:nowrap"><rs-icon name="refresh" [size]="12" /> Synced · {{ hm(t) }}</span> }
   </div>
   @if (view(); as v) {
    <div class="tags" style="margin-top:6px;gap:8px">
     <span class="sn">{{ kind() === 'ticket' ? 'TICKET' : 'CHAT' }}</span><span class="mono" style="font-size:12px">{{ v.ref }}</span>
     <span class="pillx"><rs-icon [name]="kind() === 'conversation' ? 'chat' : 'mail'" [size]="12" /> {{ kind() === 'conversation' ? 'Live chat' : 'Email' }}</span>
     @if (v.waitingSince) { <span class="waiting">customer waiting {{ waited(v.waitingSince) }}</span> }
    </div>
    <h1 class="conv-subj" tabindex="-1">{{ v.subject }}</h1>
    <div class="conv-meta">
     <div class="tk"><span class="lbl" style="font-size:9.5px">Priority</span><span class="v">{{ code(v.priority) }} · {{ ptext(v.priority) }}</span></div>
     <div class="tk"><span class="lbl" style="font-size:9.5px">State</span><span class="v">{{ v.state }}</span></div>
     <div class="tk"><span class="lbl" style="font-size:9.5px">Owner</span><span class="v">{{ v.owner ?? 'Unassigned' }}</span></div>
     @if (sla(); as s) {
      <div class="tk" style="flex:1;min-width:180px">
       <span class="lbl" style="font-size:9.5px">Resolution SLA</span>
       <div style="display:flex;align-items:center;gap:8px;margin-top:3px"><div class="sla-bar" aria-hidden="true"><i [style.width.%]="s.pct" [style.background]="s.tone"></i></div><span class="mono" style="font-size:12px;font-weight:600" [attr.title]="s.title">{{ s.left }}</span></div>
      </div>
     }
    </div>
   } @else if (error()) {
    <h1 class="conv-subj" tabindex="-1">{{ kind() === 'ticket' ? 'Ticket' : 'Chat' }} unavailable</h1>
    <p class="notice" data-tone="destructive" role="alert" style="margin:8px 0 12px">{{ error() }}</p>
   } @else { <p class="meta" role="status" style="padding:12px 0">Loading…</p> }
  </div>

  <div class="thread" #threadEl tabindex="0" aria-label="Conversation">
   @if (messages(); as list) { <rs-thread [messages]="list" [attachmentBase]="base() + '/attachments/'" [hue]="hue()" /> }
   @if (customerTyping()) { <div class="msg" data-k="customer"><span class="avatar" aria-hidden="true" style="width:28px;height:28px;font-size:10.6px" [style.--ah]="hue()">{{ initials() }}</span><span class="typing" aria-hidden="true"><i></i><i></i><i></i></span></div> }
  </div>

  @if (view() && canWrite()) {
   <div class="composer" [attr.data-mode]="composer()?.kind() ?? 'reply'">
    @if (kind() === 'conversation') { <p class="meta presence-line" role="status" aria-live="polite" [style.margin]="activityText() ? '0 0 6px' : '0'">{{ activityText() }}</p> }
    @if (actionMessage()) { <p class="small" [attr.role]="actionError() ? 'alert' : 'status'" style="margin:0 0 6px">{{ actionMessage() }}</p> }
    @for (k of [key()]; track k) {
     <rs-composer [fieldId]="kind() + '-composer'" [canReply]="canReply()" [canNote]="canNote()" [pending]="sender.pending()"
      [customerName]="view()!.customer" [channel]="kind() === 'conversation' ? 'chat' : 'email'" [refLabel]="refLabel()"
      [initialDraft]="drafts.get(k) ?? ''" (draftChange)="drafts.set(k, $event)" (typing)="onTyping($event)"
      [uploadPath]="'/api/apps/' + encode(app()) + '/uploads'" [target]="{ type: kind(), id: id() }"
      (send)="sender.send($event)" (retry)="sender.retry($event)" (check)="sender.check($event)" (discard)="sender.discard($event)" />
    }
    @if (sender.lastSent(); as l) { <p class="meta" style="margin:6px 0 0"><a [routerLink]="['/receipts', l.operationId]">View the receipt for your {{ l.kind }}</a></p> }
   </div>
  }
 </div>

 <div class="ctx">
  @if (view(); as v) {
   @if (state.can('observability.subject')) {
    <rs-case-context #context [appKey]="app()" [kind]="kind()" [objectId]="id()" [appName]="appName()" [messages]="messages() ?? []"
     [customer]="{ name: v.customer, email: v.email }" [tier]="tier()" [replied]="replied()" (reply)="focusReply()" />
   } @else {
    <div class="ctx-inner"><div class="lockline"><rs-icon name="lock" [size]="16" /><div>Customer and system context appear for people with observability access.</div></div></div>
   }
  }
 </div>
</div>
<rs-tool-drawer #drawer [appKey]="app()" [kind]="kind()" [objectId]="id()" [targetName]="view()?.customer ?? null" [refLabel]="refLabel()" [tier]="tier()"
 (diverted)="diverted($event)" (finished)="reload()" />
@if (bannerOpen()) { <rs-banner-modal [appKey]="app()" [appName]="appName()" (closed)="bannerOpen.set(false)" /> }`,
})
export class CasePage {
 readonly app = input.required<string>();
 readonly id = input.required<string>();
 /** Route data: which kind of item this page shows. */
 readonly kind = input.required<'ticket' | 'conversation'>();
 readonly state = inject(AppState);
 readonly inbox = inject(InboxService);
 readonly obs = inject(ObservabilityService);
 private readonly clearance = inject(ClearanceService);
 private readonly work = inject(WorkService);
 private readonly toast = inject(ToastService);
 readonly bannerOpen = signal(false);
 readonly ticket = signal<TicketDetail | undefined>(undefined);
 readonly conversation = signal<ConversationDetail | undefined>(undefined);
 readonly error = signal('');
 readonly loadedAt = signal<string | null>(null);
 readonly actionMessage = signal('');
 readonly actionError = signal(false);
 readonly activity = signal<ConversationActivity | undefined>(undefined);
 readonly drafts = new Map<string, string>(); // in memory only: drafts can contain customer data (plan 09)
 readonly hm = hm;
 readonly fullTime = fullTime;
 readonly encode = encodeURIComponent;
 readonly composer = viewChild(ComposerComponent);
 readonly drawer = viewChild.required<ToolDrawerComponent>('drawer');
 readonly context = viewChild<CaseContextComponent>('context');
 private readonly threadEl = viewChild<ElementRef<HTMLElement>>('threadEl');
 private signalled?: { app: string; id: string };
 private viewingTimer?: ReturnType<typeof setInterval>;
 private generation = 0;

 readonly key = computed(() => `${this.kind()}/${this.app()}/${this.id()}`);
 readonly base = computed(() => `/api/apps/${encodeURIComponent(this.app())}/${this.kind() === 'ticket' ? 'tickets' : 'conversations'}/${encodeURIComponent(this.id())}`);
 readonly appName = computed(() => this.state.appName(this.app()));
 readonly tier = computed(() => this.clearance.tierOf(this.app()));
 /** One sender per item, bound to that item's path, so a send still in flight never lands on another item (review R09). */
 readonly senderFor = computed(() => { const path = this.base() + '/messages'; const key = this.key(); return new MessageSender(() => path, () => { if (key === this.key()) this.reload(); }, t => this.inbox.announce(t)); });
 get sender() { return this.senderFor(); }
 readonly messages = computed<ThreadMessage[] | null>(() => this.kind() === 'ticket' ? this.ticket()?.messages ?? null : this.conversation()?.messages ?? null);

 /** The header facts of either kind, as the prototype lays them out. */
 readonly view = computed(() => {
  if (this.kind() === 'ticket') {
   const d = this.ticket(); if (!d) return null;
   return { ref: d.ticket.reference, subject: d.ticket.title, priority: d.ticket.priority, state: d.ticket.status.name || TICKET_STATE[d.ticket.status.category],
    category: d.ticket.status.category as string, owner: d.ticket.assigneeName, waitingSince: null as string | null, version: d.ticket.version,
    customer: d.messages.find(m => m.senderType === 'visitor')?.authorName ?? null, email: null as string | null, unread: false };
  }
  const d = this.conversation(); if (!d) return null;
  const c = d.conversation;
  return { ref: chatRef(c.id), subject: c.subject ?? 'Conversation', priority: c.priority, state: CHAT_STATE[c.status] ?? c.status, category: c.status as string,
   owner: c.assigneeName, waitingSince: c.waitingSince, version: c.version, customer: c.visitorName, email: c.visitorEmail, unread: c.unread };
 });
 readonly refLabel = computed(() => this.view()?.ref ?? this.id());
 readonly isMine = computed(() => !!this.view()?.owner && this.view()!.owner === this.state.user()?.displayName);
 readonly replied = computed(() => { const m = this.messages() ?? []; const last = [...m].reverse().find(x => !x.isInternal && x.senderType !== 'system'); return !!last && last.senderType === 'agent'; });
 readonly sla = computed(() => {
  const t = this.ticket()?.ticket; if (this.kind() !== 'ticket' || !t || (!t.slaDueAt && !t.slaBreachedAt)) return null;
  if (t.slaBreachedAt) return { pct: 100, tone: 'var(--destructive)', left: 'Breached', title: 'Breached ' + fullTime(t.slaBreachedAt) };
  const start = Date.parse(t.createdAt), due = Date.parse(t.slaDueAt!), now = Date.now();
  const pct = Math.min(100, Math.max(0, Math.round((now - start) / Math.max(due - start, 1) * 100)));
  const mins = Math.max(0, Math.round((due - now) / 60000));
  return { pct, tone: pct > 85 ? 'var(--destructive)' : pct > 60 ? 'var(--sensitive)' : 'var(--safe)', left: mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`, title: 'Due ' + fullTime(t.slaDueAt!) };
 });
 canReply() { return this.kind() === 'ticket' ? this.state.can('ticket.reply') : this.state.can('chat.reply'); }
 canNote() { return this.kind() === 'ticket' ? this.state.can('ticket.note') : this.state.can('chat.note'); }
 canWrite() { return this.canReply() || this.canNote(); }
 code(p: string) { return PRIORITY_CODE[p] ?? 'P4'; }
 ptext(p: string) { return PRIORITY_TEXT[p] ?? p; }
 initials() { return initialsOf(this.view()?.customer ?? 'Customer'); }
 hue() { return hueOf(this.view()?.customer ?? 'Customer'); }
 waited(since: string) { const m = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; }

 /** Tools for this item: what the application lets this person do, through Resolve. */
 readonly tools = computed<RailTool[]>(() => {
  const v = this.view(); if (!v) return [];
  const out: RailTool[] = [];
  const health = this.obs.byApp().get(this.app());
  const warn = health && (health.state === 'degraded' || health.state === 'critical') ? `${this.appName()} ${HEALTH_LABEL[health.state].toLowerCase()}` : null;
  if (this.kind() === 'ticket') {
   if (this.state.can('ticket.assign')) out.push({ id: this.isMine() ? 'unassign' : 'assign', name: this.isMine() ? 'Unassign me' : 'Assign to me', icon: 'user', cat: 'Ticket' });
   if (this.state.can('ticket.status')) {
    if (v.category !== 'pending' && v.category !== 'closed') out.push({ id: 'pending', name: 'Waiting on customer', icon: 'clock', cat: 'Ticket' });
    if (v.category !== 'closed') out.push({ id: 'close', name: 'Resolve ticket', icon: 'shieldCheck', cat: 'Ticket', warn });
    else out.push({ id: 'reopen', name: 'Reopen ticket', icon: 'refresh', cat: 'Ticket' });
   }
  } else {
   if (this.state.can('chat.assign')) out.push({ id: this.isMine() ? 'unassign' : 'assign', name: this.isMine() ? 'Unassign me' : 'Assign to me', icon: 'user', cat: 'Chat' });
   if (this.state.can('chat.status')) {
    if (v.category === 'open') out.push({ id: 'snooze', name: 'Snooze chat', icon: 'clock', cat: 'Chat' });
    if (v.category !== 'closed') out.push({ id: 'close', name: 'Close chat', icon: 'shieldCheck', cat: 'Chat', warn });
    else out.push({ id: 'reopen', name: 'Reopen chat', icon: 'refresh', cat: 'Chat' });
   }
   if (this.state.can('chat.mark_read') && v.unread) out.push({ id: 'read', name: 'Mark read for team', icon: 'check', cat: 'Chat' });
  }
  if (this.state.can('observability.link') && this.state.can('observability.subject')) out.push({ id: 'evidence', name: 'Capture evidence snapshot', icon: 'layers', cat: 'Evidence' });
  if (this.state.can('broadcast.publish') || (this.state.can('broadcast.app') && !!this.tier())) out.push({ id: 'banner', name: 'Create banner', icon: 'megaphone', cat: 'Announcements' });
  return out;
 });

 constructor() {
  effect(() => {
   void [this.kind(), this.app(), this.id()];
   untracked(() => {
    this.stopViewing();
    this.ticket.set(undefined); this.conversation.set(undefined); this.error.set(''); this.actionMessage.set(''); this.activity.set(undefined);
    this.reload(true);
   });
  });
  // Viewing signals need the session (the page can load before it): start once both are known.
  effect(() => {
   void this.key();
   if (this.kind() === 'conversation' && this.state.signedIn()) untracked(() => { this.startViewing(); this.loadActivity(); });
  });
  effect(() => { if (this.state.can('ticket.read') || this.state.can('chat.read')) untracked(() => this.clearance.load()); });
  // Keep the newest message in view (prototype).
  effect(() => { void this.messages()?.length; void this.customerTyping(); setTimeout(() => { const el = this.threadEl()?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }); });
  const offChange = this.inbox.onChange((appKey, detail, itemId) => {
   if (this.kind() !== 'conversation' || appKey !== this.app() || itemId !== this.id()) return;
   if (detail) { if (!this.conversation() || detail.conversation.version >= this.conversation()!.conversation.version) this.conversation.set(detail); }
   else this.error.set('This conversation is no longer available to you.');
  });
  const offActivity = this.inbox.onActivity((appKey, itemId) => { if (this.kind() === 'conversation' && appKey === this.app() && itemId === this.id()) this.loadActivity(); });
  const onVisibility = () => document.visibilityState === 'visible' ? this.startViewing() : this.stopViewing();
  const onPageHide = () => this.stopViewing(true);
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', onPageHide);
  inject(DestroyRef).onDestroy(() => {
   offChange(); offActivity(); this.stopViewing();
   document.removeEventListener('visibilitychange', onVisibility); removeEventListener('pagehide', onPageHide);
  });
 }

 /** Re-read the item; responses for an item no longer shown, or older than the latest request, are ignored. */
 reload(focus = false) {
  const gen = ++this.generation;
  const key = this.key();
  const done = () => { if (focus) setTimeout(() => { if (document.activeElement?.id === 'main') document.querySelector<HTMLElement>('main h1')?.focus(); }); };
  if (this.kind() === 'ticket') {
   api(this.base(), ticketDetailResponseSchema).then(r => { if (gen === this.generation && key === this.key()) { this.ticket.set(r.detail); this.loadedAt.set(new Date().toISOString()); } })
    .catch(e => { if (key === this.key()) this.error.set(e.message); }).finally(done);
  } else {
   api(this.base(), conversationDetailResponseSchema).then(r => {
    if (gen !== this.generation || key !== this.key()) return;
    this.conversation.set(r.detail); this.loadedAt.set(new Date().toISOString());
    this.inbox.upsert(this.app(), r.detail);
   }).catch(e => { if (key === this.key()) this.error.set(e.message); }).finally(done);
  }
 }

 focusReply() { this.composer()?.setKind('reply'); document.getElementById(this.kind() + '-composer')?.focus(); }

 runTool(t: RailTool) {
  if (t.id === 'banner') { this.bannerOpen.set(true); return; }
  const v = this.view()!;
  const ticket = this.kind() === 'ticket';
  const act = (suffix: string, body: object, success: string) => async (pre?: { preflightId: string; override?: { reason: string } }) => {
   const r = await postAction(this.base() + suffix, { ...body, ...(pre ?? {}) });
   if (r.ok) { this.toast.show(`${success} · ${this.refLabel()}`); this.work.refresh(); }
   else if (r.operation?.next === 'refresh_and_retry') this.reload();
   return { ok: r.ok, message: r.ok ? success : r.message, operationId: r.operation?.id };
  };
  const target = ticket ? 'ticket' : 'chat';
  const tools: Record<string, DrawerTool> = {
   assign: { id: 'assign', name: 'Assign to me', icon: 'user', risk: 'safe', verb: 'Assign to me', desc: `You become the owner of this ${target} in ${this.appName()}. The application records the change as you.`,
    run: act('/assign', { assignee: 'me', expectedVersion: v.version }, 'Assigned to you') },
   unassign: { id: 'unassign', name: 'Unassign me', icon: 'user', risk: 'safe', verb: 'Unassign', desc: `The ${target} goes back to the team queue in ${this.appName()}.`,
    run: act('/assign', { assignee: 'unassigned', expectedVersion: v.version }, 'Unassigned') },
   pending: { id: 'pending', name: 'Waiting on customer', icon: 'clock', risk: 'safe', verb: 'Set waiting on customer', desc: 'Marks the ticket as waiting for the customer to reply.',
    run: act('/status', { statusCategory: 'pending', expectedVersion: v.version }, 'Status updated') },
   reopen: { id: 'reopen', name: ticket ? 'Reopen ticket' : 'Reopen chat', icon: 'refresh', risk: 'safe', verb: 'Reopen', desc: `Opens the ${target} again.`,
    run: act('/status', ticket ? { statusCategory: 'open', expectedVersion: v.version } : { status: 'open', expectedVersion: v.version }, ticket ? 'Status updated' : 'Conversation reopened') },
   snooze: { id: 'snooze', name: 'Snooze chat', icon: 'clock', risk: 'safe', verb: 'Snooze', desc: 'Moves the chat out of the open queue until the customer writes again.',
    run: act('/status', { status: 'snoozed', expectedVersion: v.version }, 'Conversation snoozed') },
   close: { id: 'close', name: ticket ? 'Resolve ticket' : 'Close chat', icon: 'shieldCheck', risk: 'sensitive', verb: ticket ? 'Resolve ticket' : 'Close chat', gated: ticket ? 'ticket.close' : 'conversation.close',
    desc: ticket ? 'Marks the ticket resolved. Checked first against live service health and known issues for this customer.' : 'Closes the chat. Checked first against live service health and known issues for this customer.',
    run: act('/status', ticket ? { statusCategory: 'closed', expectedVersion: v.version } : { status: 'closed', expectedVersion: v.version }, ticket ? 'Status updated' : 'Conversation closed') },
   read: { id: 'read', name: 'Mark read for team', icon: 'check', risk: 'safe', verb: 'Mark read', desc: 'Clears the unread mark for your whole support team (shared, not per person).',
    run: act('/read', {}, 'Marked read for your team') },
   evidence: { id: 'evidence', name: 'Capture evidence snapshot', icon: 'layers', risk: 'safe', verb: 'Capture snapshot',
    desc: 'Saves the system facts you can see now, bound to this item, and adds an internal note that links to it. The snapshot never changes afterwards.',
    run: async () => {
     const res = await send('POST', this.base() + '/evidence', { requestId: crypto.randomUUID() }, evidenceSnapshotSchema);
     if (!res.ok) return { ok: false, message: res.error!.message };
     const s = res.data!;
     this.context()?.load();
     this.toast.show(`Evidence snapshot captured · ${this.refLabel()}`);
     return { ok: true, message: s.note.state === 'succeeded' ? 'Snapshot captured, and an internal note links to it.' : s.note.state === 'uncertain'
      ? 'Snapshot captured. The application did not confirm the internal note; check it before trying again.' : 'Snapshot captured. The internal note could not be added.',
      link: { label: 'View the snapshot', route: ['/evidence', s.id] } };
    } },
  };
  const tool = tools[t.id];
  if (tool) void this.drawer().open(tool);
 }
 diverted(text: string) { this.actionError.set(false); this.actionMessage.set(text); this.toast.show(text); this.context()?.load(); }

 // ── Viewing and typing (chats): explicit, short-lived signals sent only while this person has the thread open ──
 readonly customerTyping = computed(() => !!this.activity()?.visitor.typing);
 readonly activityText = computed(() => {
  const a = this.activity(), v = this.view();
  if (!a || !v) return '';
  const customer = v.customer ?? 'The customer';
  const typing = a.agents.filter(x => x.activity === 'typing').map(x => x.name);
  const viewing = a.agents.filter(x => x.activity === 'viewing').map(x => x.name);
  return [a.visitor.typing ? `${customer} is typing…` : a.visitor.online ? `${customer} is online` : '',
   typing.length ? `${names(typing)} ${typing.length > 1 ? 'are' : 'is'} writing a reply` : '',
   viewing.length ? `${names(viewing)} ${viewing.length > 1 ? 'are' : 'is'} viewing` : ''].filter(Boolean).join(' · ');
 });
 private get canSignal() { return this.kind() === 'conversation' && (this.state.can('chat.reply') || this.state.can('chat.note')); }
 private signal(target: { app: string; id: string }, activity: 'viewing' | 'typing' | 'stopped', keepalive = false) {
  const path = `/api/apps/${encodeURIComponent(target.app)}/conversations/${encodeURIComponent(target.id)}/activity`;
  // Best effort: a lost signal simply expires at the application.
  fetch(path, { method: 'POST', credentials: 'same-origin', keepalive, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity }) }).catch(() => {});
 }
 private startViewing() {
  if (!this.canSignal || document.visibilityState !== 'visible') return;
  const s = { app: this.app(), id: this.id() };
  this.signalled = s;
  this.signal(s, 'viewing');
  clearInterval(this.viewingTimer);
  this.viewingTimer = setInterval(() => { if (this.signalled) this.signal(this.signalled, 'viewing'); }, VIEWING_REFRESH_MS);
 }
 private stopViewing(keepalive = false) {
  clearInterval(this.viewingTimer);
  if (this.signalled) { this.signal(this.signalled, 'stopped', keepalive); this.signalled = undefined; }
 }
 onTyping(typing: boolean) { if (this.signalled) this.signal(this.signalled, typing ? 'typing' : 'viewing'); }
 loadActivity() {
  const key = this.key();
  api(this.base() + '/activity', activityResponseSchema).then(r => { if (key === this.key()) this.activity.set(r.activity); }).catch(() => this.activity.set(undefined));
 }
}
