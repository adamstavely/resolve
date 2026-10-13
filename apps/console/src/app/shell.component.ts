import { Component, computed, DestroyRef, effect, HostListener, inject, signal, untracked } from '@angular/core';
import { availabilityResponseSchema, BUNDLE_LABELS, CAPABILITIES, issueSubscriptionListSchema, type CapabilityId } from '../../../../packages/contracts/src/index';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { IconComponent, MarkComponent, type IconName } from './icon.component';
import { CommandPaletteComponent } from './command-palette.component';
import { IssueLinkService, KnownIssuesComponent, LinkIssueModalComponent } from './pages/issues.component';
import { ClearanceService, ToastService } from './ui';
import { WorkService } from './work.service';
import { InboxService } from './inbox.service';
import { HEALTH_LABEL, HEALTH_TONE, ObservabilityService } from './observability.service';
import { api, AppState } from './state';

type AppAvailability = ReturnType<typeof availabilityResponseSchema.parse>['apps'][number];
const PROBLEM_TEXT: Record<NonNullable<AppAvailability['problem']>, string> = {
 not_connected: 'not connected', reconnect_required: 'reconnect required', unsupported: 'not supported yet', unavailable: 'unavailable', dormant: 'idle', failed: 'did not respond',
};

/** Saved preference, else the operating system's. */
function initialTheme(): 'light' | 'dark' {
 try { const saved = localStorage.getItem('resolve-theme'); if (saved === 'light' || saved === 'dark') return saved; } catch { /* ignore */ }
 return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** App shell from the console prototype v2 (plan 16): top bar, side navigation (collapsed in workspaces), routed content. */
@Component({
 selector: 'resolve-root',
 imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, MarkComponent, CommandPaletteComponent, KnownIssuesComponent, LinkIssueModalComponent],
 template: `
<a class="skip" href="#main" (click)="skip($event)">Skip to main content</a>
<div class="shell">
 <div class="app-bg" aria-hidden="true"></div>
 <header class="topbar">
  <a class="brand" routerLink="/" aria-label="Resolve home" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">
   <span class="brand-mark"><rs-mark [size]="18" /></span>
   <span class="brand-name">Resolve</span>
   <span class="brand-tag">Unified support operations</span>
  </a>
  <div class="topbar-spacer"></div>
  @if (state.can('observability.health') && obs.loaded()) {
   <div style="position:relative">
    <button class="inc-btn" type="button" [attr.aria-expanded]="incOpen()" aria-controls="inc-pop" (click)="incOpen.set(!incOpen())">
     <span class="dot" [attr.data-tone]="obs.issues().length ? 'sensitive' : 'safe'" aria-hidden="true"></span>
     {{ obs.issues().length === 0 ? 'No active incidents' : obs.issues().length + ' active ' + (obs.issues().length === 1 ? 'incident' : 'incidents') }}
     <rs-icon name="chevD" [size]="13" />
    </button>
    @if (incOpen()) {
     <div style="position:fixed;inset:0;z-index:59" (click)="incOpen.set(false)" aria-hidden="true"></div>
     <div class="inc-pop" id="inc-pop" role="dialog" aria-label="Known issues" (keydown.escape)="incOpen.set(false)"><rs-known-issues /></div>
    }
   </div>
  }
  @if (state.signedIn()) {
   <button class="cmd-trigger" type="button" (click)="cmdOpen.set(true)" aria-keyshortcuts="Meta+K Control+K">
    <rs-icon name="search" [size]="16" /> Search apps, accounts, tickets…<span class="kbd">⌘K</span>
   </button>
  }
  <div class="topbar-actions">
   <button class="icon-btn" type="button" (click)="toggleTheme()" [attr.aria-pressed]="dark()" aria-label="Dark appearance" title="Toggle theme">
    <rs-icon [name]="dark() ? 'sun' : 'moon'" [size]="18" />
   </button>
   @if (state.signedIn()) {
    <button class="icon-btn" type="button" (click)="notifications()" [attr.aria-label]="cleared() ? 'Notifications, ' + cleared() + ' new' : 'Notifications'" title="Notifications">
     <rs-icon name="bell" [size]="18" />@if (cleared()) { <span class="icon-dot" aria-hidden="true"></span> }
    </button>
   }
   @if (state.session(); as s) {
    @if (s.authenticated) {
     <div style="position:relative">
      <button class="avatar-btn" type="button" [attr.aria-expanded]="menuOpen()" aria-controls="me-menu" [attr.aria-label]="s.user.displayName + ', account and availability'" [attr.title]="s.user.displayName" (click)="menuOpen.set(!menuOpen())">{{ state.initials() }}</button>
      @if (menuOpen()) {
       <div style="position:fixed;inset:0;z-index:59" (click)="menuOpen.set(false)" aria-hidden="true"></div>
       <div class="inc-pop me-pop" id="me-menu" role="dialog" aria-label="Account" (keydown.escape)="menuOpen.set(false)">
        <div class="ph2"><span class="pt2">{{ s.user.displayName }}</span><span class="meta">{{ s.user.email }}</span></div>
        <div class="kn-issue">
         <span class="st">Signed in as {{ s.user.displayName }}{{ s.user.email ? ' (' + s.user.email + ')' : '' }}. Roles: {{ roleLabels() || 'none. Ask an administrator for access.' }}</span>
         @if (s.capabilities.length) {
          <details class="caps-details"><summary>What you can do ({{ s.capabilities.length }})</summary>
           <ul class="caps">@for (c of s.capabilities; track c) { <li><rs-icon name="check" [size]="14" />{{ capabilitySummary(c) }}</li> }</ul>
          </details>
         }
        </div>
        @if (state.can('chat.availability') && availability(); as list) {
         <!-- Explicit availability for chat routing; having Resolve open never makes you available. -->
         <div class="kn-issue">
          <button class="btn btn-sm" type="button" [attr.aria-pressed]="pressed()" [disabled]="availabilityBusy() || !reachable().length"
           (click)="toggleAvailability()" [attr.aria-describedby]="'availability-detail'">
           <span class="status-dot" [attr.data-tone]="pressed() === 'true' ? 'safe' : pressed() === 'mixed' ? 'sensitive' : 'neutral'" aria-hidden="true"></span>
           Available for chats@if (pressed() === 'mixed') { <span class="muted small">({{ availableCount() }} of {{ reachable().length }})</span> }
          </button>
          <span class="st" id="availability-detail">{{ availabilityDetail() }}</span>
         </div>
        }
        <div class="kn-issue">
         <form method="post" action="/api/auth/logout">
          <button class="btn btn-sm btn-ghost" type="submit"><rs-icon name="logout" [size]="15" />Sign out</button>
         </form>
        </div>
       </div>
      }
     </div>
    } @else {
     <a class="btn btn-primary" href="/api/auth/login?returnTo=/">Sign in</a>
    }
   }
  </div>
 </header>

 <div class="workbench">
  <nav class="sidenav" aria-label="Primary" [attr.data-mini]="mini()">
   @if (state.signedIn()) {
   <ul class="nav-list">
    <li><a class="tab" routerLink="/" routerLinkActive #home="routerLinkActive" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page" [attr.data-active]="home.isActive" title="Home" [attr.aria-label]="mini() ? 'Home' : null">
     <span class="nav-ic"><rs-icon name="grid" [size]="17" /></span><span class="tab-name">Home</span></a></li>
    @if (state.can('chat.read')) {
     <li><a class="tab" routerLink="/inbox" title="Inbox" [attr.data-active]="onInbox()" [attr.aria-current]="onInbox() ? 'page' : null" [attr.aria-label]="mini() ? 'Inbox' + (inbox.unreadCount() ? ', ' + inbox.unreadCount() + ' unread' : '') : null">
      <span class="nav-ic"><rs-icon name="inbox" [size]="17" /></span><span class="tab-name">Inbox</span>
      @if (inbox.unreadCount(); as n) {
       <span class="nav-count" aria-hidden="true">{{ n }}{{ inbox.countIsPartial() ? '+' : '' }}</span>
       <span class="sr-only">, {{ inbox.countIsPartial() ? 'at least ' : '' }}{{ n }} unread</span>
      }</a></li>
    }
    @if (state.can('ticket.read')) {
     <li><a class="tab" routerLink="/tickets" title="My tickets" [attr.data-active]="onTickets()" [attr.aria-current]="onTickets() ? 'page' : null" [attr.aria-label]="mini() ? 'My tickets' : null">
      <span class="nav-ic"><rs-icon name="ticket" [size]="17" /></span><span class="tab-name">My tickets</span>
      @if (work.mine() !== null) { <span class="nav-tier" style="margin-left:auto" aria-hidden="true">{{ work.mine() }}</span><span class="sr-only">, {{ work.mine() }} open</span> }
     </a></li>
    }
    <li><a class="tab" routerLink="/escalations" routerLinkActive #esc="routerLinkActive" ariaCurrentWhenActive="page" [attr.data-active]="esc.isActive" title="Escalations" [attr.aria-label]="mini() ? 'Escalations' : null">
     <span class="nav-ic"><rs-icon name="arrowUp" [size]="17" /></span><span class="tab-name">Escalations</span></a></li>
   </ul>
   }
   @if (state.apps(); as list) {
    <div class="sidenav-label" id="nav-apps">Applications</div>
    <ul class="nav-list" aria-labelledby="nav-apps">
     @for (a of list.apps; track a.appKey) {
      <li><a class="tab" [routerLink]="['/apps', a.appKey]" routerLinkActive #rla="routerLinkActive" ariaCurrentWhenActive="page" [attr.data-active]="rla.isActive" [attr.title]="a.displayName" style="position:relative">
       <span class="app-glyph" style="width:26px;height:26px;font-size:12px" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
       <span class="tab-name">{{ a.displayName }}</span>
       @if (serviceHealth(a.appKey); as h) { <span class="nav-health" [attr.data-tone]="healthTone[h]" [attr.title]="'Service ' + healthLabel[h].toLowerCase()" aria-hidden="true"></span> }
       @if (clearance.tierOf(a.appKey); as t) { <span class="nav-tier" [attr.data-tier]="t" aria-hidden="true">T{{ t }}</span> }
       <span class="sr-only">@if (!a.servable) {, unavailable} @else if (a.connection.state !== 'connected') {, {{ a.connection.state.replace('_', ' ') }}}@if (serviceHealth(a.appKey); as h) {, service {{ healthLabel[h].toLowerCase() }}}@if (clearance.tierOf(a.appKey); as t) {, your clearance tier {{ t }}}</span>
      </a></li>
     }
    </ul>
   }
   @if (state.can('audit.read') || state.can('app.register') || state.can('roles.manage') || state.can('users.manage') || state.can('observability.configure') || state.can('broadcast.publish') || state.can('broadcast.app')) {
    <div class="sidenav-label" id="nav-admin">Administration</div>
    <ul class="nav-list" aria-labelledby="nav-admin">
     @for (l of adminLinks(); track l.path) {
      <li><a class="tab" [routerLink]="l.path" routerLinkActive #al="routerLinkActive" ariaCurrentWhenActive="page" [attr.data-active]="al.isActive" [attr.title]="l.label" [attr.aria-label]="mini() ? l.label : null">
       <span class="nav-ic"><rs-icon [name]="l.icon" [size]="17" /></span><span class="tab-name">{{ l.label }}</span></a></li>
     }
    </ul>
   }
   <div class="sidenav-footer" [class.sr-only]="state.healthy()"><span class="status-dot" [attr.data-tone]="state.healthy() ? 'safe' : 'destructive'" aria-hidden="true"></span><p role="status">{{ state.health() }}</p></div>
  </nav>

  <!-- App-wide polite announcements (new customer chats, send results, service health changes); never moves focus. -->
  <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>
  <main id="main" class="scroll-area" [class.ws-mode]="mini()" tabindex="-1">
   <router-outlet />
  </main>
 </div>
 <div class="toast-wrap" role="status" aria-live="polite">
  @for (x of toast.toasts(); track x.id) { <div class="toast"><rs-icon name="check" [size]="16" class="tk" /> {{ x.msg }}</div> }
 </div>
 <rs-link-issue-modal />
 @if (cmdOpen()) { <rs-command-palette (closed)="closeCmd()" /> }
</div>`,
})
export class ShellComponent {
 readonly state = inject(AppState);
 readonly inbox = inject(InboxService);
 readonly observability = inject(ObservabilityService);
 readonly obs = this.observability;
 readonly work = inject(WorkService);
 readonly clearance = inject(ClearanceService);
 readonly toast = inject(ToastService);
 private readonly links = inject(IssueLinkService);
 readonly announcement = signal('');
 readonly incOpen = signal(false);
 readonly menuOpen = signal(false);
 readonly cmdOpen = signal(false);
 readonly url = signal(location.pathname);
 /** Case and application workspaces collapse the navigation to icons (prototype "miniNav"). */
 readonly mini = computed(() => /^\/(tickets|inbox)\/[^/]+\/[^/]+/.test(this.url()) || /^\/apps\/[^/]+/.test(this.url()));
 readonly onTickets = computed(() => /^\/tickets(\/|$)/.test(this.url()));
 readonly onInbox = computed(() => /^\/inbox(\/|$)/.test(this.url()));
 readonly cleared = signal(0);
 readonly roleLabels = computed(() => { const s = this.state.session(); return s?.authenticated ? s.bundles.map(b => BUNDLE_LABELS[b]).join(', ') : ''; });
 capabilitySummary(id: CapabilityId) { return CAPABILITIES[id].summary; }
 readonly adminLinks = computed(() => {
  const l: { path: string; label: string; icon: IconName }[] = [];
  if ((this.state.can('broadcast.publish') || this.state.can('broadcast.app'))) l.push({ path: '/announcements', label: 'Announcements', icon: 'megaphone' });
  if (this.state.can('app.register')) l.push({ path: '/applications', label: 'Applications', icon: 'grid' });
  if (this.state.can('roles.manage') || this.state.can('users.manage')) l.push({ path: '/people', label: 'People and roles', icon: 'users' });
  if (this.state.can('observability.configure')) l.push({ path: '/integrations', label: 'Integrations', icon: 'pulse' });
  if (this.state.can('audit.read')) l.push({ path: '/audit', label: 'Audit', icon: 'doc' });
  return l;
 });
 private cmdOpener: HTMLElement | null = null;
 @HostListener('document:keydown', ['$event']) onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && (this.incOpen() || this.menuOpen())) { this.incOpen.set(false); this.menuOpen.set(false); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && this.state.signedIn()) { e.preventDefault(); this.cmdOpener = document.activeElement as HTMLElement; this.cmdOpen.set(!this.cmdOpen()); }
 }
 closeCmd() { this.cmdOpen.set(false); setTimeout(() => { if (document.activeElement === document.body) this.cmdOpener?.focus(); }); }
 /** Issues you asked to hear about that have cleared (E3) are the notifications. */
 notifications() {
  const n = this.cleared();
  this.toast.show(n ? `${n} ${n === 1 ? 'issue you followed has' : 'issues you followed have'} cleared. See Known issues.` : "You're all caught up");
  if (n) this.incOpen.set(true);
 }
 readonly healthLabel = HEALTH_LABEL;
 readonly healthTone = HEALTH_TONE;
 /** Degraded or critical service health for the nav marker; healthy, unknown and stale show nothing there. */
 serviceHealth(appKey: string) { const s = this.observability.byApp().get(appKey)?.state; return s === 'degraded' || s === 'critical' ? s : null; }
 readonly dark = signal(initialTheme() === 'dark');
 private readonly router = inject(Router);

 constructor() {
  document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light';
  // Agents get live inbox updates (and the unread count) on every page while signed in.
  this.inbox.appName = k => this.state.appName(k);
  effect(() => { if (this.state.can('chat.read')) this.inbox.start(); });
  this.observability.appName = k => this.state.appName(k);
  // One app-wide live region: the latest message from either source.
  effect(() => { const a = this.inbox.announcement(); if (a) untracked(() => this.announcement.set(a)); });
  effect(() => { const a = this.observability.announcement(); if (a) untracked(() => this.announcement.set(a)); });
  effect(() => { if (this.state.can('observability.health')) untracked(() => this.observability.start()); });
  effect(() => { if (this.state.can('chat.availability')) untracked(() => this.loadAvailability()); });
  effect(() => { if (this.state.can('ticket.read')) untracked(() => { this.clearance.load(); this.work.loadTickets(); }); });
  // Opening the bulk-link dialog from the incidents popover replaces the popover.
  effect(() => { if (this.links.issue()) untracked(() => this.incOpen.set(false)); });
  effect(() => { void this.obs.issues(); if (this.state.can('observability.health')) untracked(() => api('/api/observability/subscriptions', issueSubscriptionListSchema).then(r => this.cleared.set(r.subscriptions.filter(x => x.cleared).length)).catch(() => {})); });
  // A custom element has no bootstrap component, so start routing explicitly.
  this.router.initialNavigation();
  // After in-app navigation, move focus to the new page's heading so screen readers announce it (2.4.3).
  let first = true;
  const sub = this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(e => {
   this.url.set((e as NavigationEnd).urlAfterRedirects.split(/[?#]/)[0]);
   this.incOpen.set(false); this.menuOpen.set(false);
   if (first) { first = false; return; }
   if ((e as NavigationEnd).urlAfterRedirects.includes('#')) return;
   queueMicrotask(() => setTimeout(() => (document.querySelector<HTMLElement>('main h1') ?? document.getElementById('main'))?.focus()));
  });
  inject(DestroyRef).onDestroy(() => sub.unsubscribe());
 }

 readonly availability = signal<AppAvailability[] | null>(null);
 readonly availabilityBusy = signal(false);
 /** Apps where availability can be known and changed. */
 readonly reachable = computed(() => (this.availability() ?? []).filter(a => a.status !== 'unknown'));
 readonly availableCount = computed(() => this.reachable().filter(a => a.status === 'available').length);
 readonly pressed = computed(() => { const n = this.availableCount(); return n === 0 ? 'false' : n === this.reachable().length ? 'true' : 'mixed'; });
 readonly availabilityDetail = computed(() => this.describe(this.availability() ?? []));

 private describe(list: AppAvailability[]) {
  const available = list.filter(a => a.status === 'available').map(a => this.state.appName(a.appKey));
  const away = list.filter(a => a.status === 'away').map(a => this.state.appName(a.appKey));
  const other = list.filter(a => a.problem && a.problem !== 'dormant' && a.problem !== 'unavailable').map(a => `${this.state.appName(a.appKey)} (${PROBLEM_TEXT[a.problem!]})`);
  return [available.length ? `Available in ${available.join(', ')}.` : 'Not available for chats in any application.',
   away.length && available.length ? `Away in ${away.join(', ')}.` : '', other.length ? `Unknown in ${other.join(', ')}.` : ''].filter(Boolean).join(' ');
 }

 loadAvailability() {
  api('/api/availability', availabilityResponseSchema).then(r => this.availability.set(r.apps)).catch(() => this.availability.set(null));
 }

 /** Set available everywhere (from away or partly available) or away everywhere; each app reports its own result. */
 async toggleAvailability() {
  const status = this.pressed() === 'true' ? 'away' : 'available';
  this.availabilityBusy.set(true);
  try {
   const r = await fetch('/api/availability', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
   const parsed = availabilityResponseSchema.safeParse(await r.json().catch(() => null));
   if (!parsed.success) throw new Error();
   this.availability.set(parsed.data.apps);
   this.inbox.announce(this.describe(parsed.data.apps));
  } catch {
   this.inbox.announce('Your availability was not changed. Try again.');
  } finally { this.availabilityBusy.set(false); }
 }

 tone(a: { servable: boolean; dormant: boolean; connection: { state: string } }) {
  if (!a.servable) return 'sensitive';
  if (a.dormant) return 'neutral';
  return a.connection.state === 'connected' ? 'safe' : a.connection.state === 'not_connected' ? 'neutral' : 'destructive';
 }

 skip(event: Event) { event.preventDefault(); document.getElementById('main')?.focus(); }

 toggleTheme() {
  this.dark.update(v => !v);
  document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light';
  try { localStorage.setItem('resolve-theme', this.dark() ? 'dark' : 'light'); } catch { /* storage may be unavailable */ }
 }
}
