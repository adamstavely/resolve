import { Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { availabilityResponseSchema } from '../../../../packages/contracts/src/index';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { IconComponent, MarkComponent } from './icon.component';
import { InboxService } from './inbox.service';
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

/** App shell from the console prototype: top bar, side navigation, routed content. */
@Component({
 selector: 'resolve-root',
 imports: [RouterOutlet, RouterLink, RouterLinkActive, IconComponent, MarkComponent],
 template: `
<a class="skip" href="#main" (click)="skip($event)">Skip to main content</a>
<div class="app-bg" aria-hidden="true"></div>
<div class="shell">
 <header class="topbar">
  <a class="brand" routerLink="/" aria-label="Resolve home" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">
   <span class="brand-mark"><rs-mark [size]="18" /></span>
   <span class="brand-name">Resolve</span>
   <span class="brand-tag">Unified support operations</span>
  </a>
  <div class="topbar-spacer"></div>
  <div class="topbar-actions">
   @if (state.can('chat.availability') && availability(); as list) {
    <!-- Explicit availability for chat routing; having Resolve open never makes you available. -->
    <button class="btn btn-sm availability" type="button" [attr.aria-pressed]="pressed()" [disabled]="availabilityBusy() || !reachable().length"
     (click)="toggleAvailability()" [attr.title]="availabilityDetail()" [attr.aria-describedby]="'availability-detail'">
     <span class="status-dot" [attr.data-tone]="pressed() === 'true' ? 'safe' : pressed() === 'mixed' ? 'sensitive' : 'neutral'" aria-hidden="true"></span>
     Available for chats@if (pressed() === 'mixed') { <span class="muted small">({{ availableCount() }} of {{ reachable().length }})</span> }
    </button>
    <span class="sr-only" id="availability-detail">{{ availabilityDetail() }}</span>
   }
   <button class="icon-btn" type="button" (click)="toggleTheme()" [attr.aria-pressed]="dark()" aria-label="Dark appearance">
    <rs-icon [name]="dark() ? 'sun' : 'moon'" [size]="18" />
   </button>
   @if (state.session(); as s) {
    @if (s.authenticated) {
     <span class="avatar-btn" [attr.title]="s.user.displayName" aria-hidden="true">{{ state.initials() }}</span>
     <form method="post" action="/api/auth/logout">
      <button class="icon-btn" type="submit" aria-label="Sign out" title="Sign out"><rs-icon name="logout" [size]="18" /></button>
     </form>
    } @else {
     <a class="btn btn-primary" href="/api/auth/login?returnTo=/">Sign in</a>
    }
   }
  </div>
 </header>

 <div class="workbench">
  <nav class="sidenav" aria-label="Primary">
   @if (state.can('chat.read') || state.can('ticket.read') || state.can('broadcast.publish')) {
   <ul class="nav-list">
    @if (state.can('chat.read')) {
     <li><a class="tab" routerLink="/inbox" routerLinkActive="active" ariaCurrentWhenActive="page">
      <span class="nav-ic"><rs-icon name="inbox" [size]="17" /></span><span class="tab-name">Inbox</span>
      @if (inbox.unreadCount(); as n) {
       <span class="nav-count" aria-hidden="true">{{ n }}{{ inbox.countIsPartial() ? '+' : '' }}</span>
       <span class="sr-only">, {{ inbox.countIsPartial() ? 'at least ' : '' }}{{ n }} unread</span>
      }</a></li>
    }
    @if (state.can('ticket.read')) {
     <li><a class="tab" routerLink="/tickets" routerLinkActive="active" ariaCurrentWhenActive="page">
      <span class="nav-ic"><rs-icon name="ticket" [size]="17" /></span><span class="tab-name">Tickets</span></a></li>
    }
    @if (state.can('broadcast.publish')) {
     <li><a class="tab" routerLink="/announcements" routerLinkActive="active" ariaCurrentWhenActive="page">
      <span class="nav-ic"><rs-icon name="megaphone" [size]="17" /></span><span class="tab-name">Announcements</span></a></li>
    }
   </ul>
   }
   @if (state.apps(); as list) {
    <div class="sidenav-label" id="nav-apps">Applications</div>
    <ul class="nav-list" aria-labelledby="nav-apps">
     @for (a of list.apps; track a.appKey) {
      <li><a class="tab" routerLink="/" [fragment]="'app-' + a.appKey">
       <span class="app-glyph" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
       <span class="tab-name">{{ a.displayName }}</span>
       <span class="status-dot" [attr.data-tone]="tone(a)" aria-hidden="true"></span>
       <span class="sr-only">, {{ !a.servable ? 'unavailable' : a.dormant ? 'idle' : a.connection.state.replace('_', ' ') }}</span>
      </a></li>
     }
    </ul>
   }
   @if (state.can('audit.read') || state.can('app.register') || state.can('roles.manage') || state.can('users.manage') || state.can('observability.configure')) {
    <div class="sidenav-label" id="nav-admin">Administration</div>
    <ul class="nav-list" aria-labelledby="nav-admin">
     @if (state.can('app.register')) {
      <li><a class="tab" routerLink="/applications" routerLinkActive="active" ariaCurrentWhenActive="page"><span class="nav-ic"><rs-icon name="grid" [size]="17" /></span><span class="tab-name">Applications</span></a></li>
     }
     @if (state.can('roles.manage') || state.can('users.manage')) {
      <li><a class="tab" routerLink="/people" routerLinkActive="active" ariaCurrentWhenActive="page"><span class="nav-ic"><rs-icon name="users" [size]="17" /></span><span class="tab-name">People and roles</span></a></li>
     }
     @if (state.can('observability.configure')) {
      <li><a class="tab" routerLink="/integrations" routerLinkActive="active" ariaCurrentWhenActive="page"><span class="nav-ic"><rs-icon name="pulse" [size]="17" /></span><span class="tab-name">Integrations</span></a></li>
     }
     @if (state.can('audit.read')) {
      <li><a class="tab" routerLink="/audit" routerLinkActive="active" ariaCurrentWhenActive="page"><span class="nav-ic"><rs-icon name="doc" [size]="17" /></span><span class="tab-name">Audit</span></a></li>
     }
    </ul>
   }
   <div class="sidenav-footer"><span class="status-dot" [attr.data-tone]="state.healthy() ? 'safe' : 'destructive'" aria-hidden="true"></span><p role="status">{{ state.health() }}</p></div>
  </nav>

  <!-- App-wide polite announcements (new customer chats, send results); never moves focus. -->
  <p class="sr-only" role="status" aria-live="polite">{{ inbox.announcement() }}</p>
  <main id="main" class="scroll-area" tabindex="-1">
   <router-outlet />
  </main>
 </div>
</div>`,
})
export class ShellComponent {
 readonly state = inject(AppState);
 readonly inbox = inject(InboxService);
 readonly dark = signal(initialTheme() === 'dark');
 private readonly router = inject(Router);

 constructor() {
  document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light';
  // Agents get live inbox updates (and the unread count) on every page while signed in.
  this.inbox.appName = k => this.state.appName(k);
  effect(() => { if (this.state.can('chat.read')) this.inbox.start(); });
  effect(() => { if (this.state.can('chat.availability')) untracked(() => this.loadAvailability()); });
  // A custom element has no bootstrap component, so start routing explicitly.
  this.router.initialNavigation();
  // After in-app navigation, move focus to the new page's heading so screen readers announce it (2.4.3).
  let first = true;
  const sub = this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(e => {
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
