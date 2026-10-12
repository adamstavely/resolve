import { Component, DestroyRef, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { IconComponent, MarkComponent } from './icon.component';
import { AppState } from './state';

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
  <a class="brand" routerLink="/" aria-label="Resolve home">
   <span class="brand-mark"><rs-mark [size]="18" /></span>
   <span class="brand-name">Resolve</span>
   <span class="brand-tag">Unified support operations</span>
  </a>
  <div class="topbar-spacer"></div>
  <div class="topbar-actions">
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
   <ul class="nav-list">
    <li><a class="tab" routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }" ariaCurrentWhenActive="page">
     <span class="nav-ic"><rs-icon name="grid" [size]="17" /></span><span class="tab-name">Home</span></a></li>
    @if (state.can('ticket.read')) {
     <li><a class="tab" routerLink="/tickets" routerLinkActive="active" ariaCurrentWhenActive="page">
      <span class="nav-ic"><rs-icon name="ticket" [size]="17" /></span><span class="tab-name">Tickets</span></a></li>
    }
    @if (state.can('chat.read')) {
     <li><a class="tab" routerLink="/conversations" routerLinkActive="active" ariaCurrentWhenActive="page">
      <span class="nav-ic"><rs-icon name="chat" [size]="17" /></span><span class="tab-name">Conversations</span></a></li>
    }
   </ul>
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
   @if (state.can('audit.read')) {
    <div class="sidenav-label" id="nav-admin">Administration</div>
    <ul class="nav-list" aria-labelledby="nav-admin">
     <li><a class="tab" routerLink="/audit" routerLinkActive="active" ariaCurrentWhenActive="page"><span class="nav-ic"><rs-icon name="doc" [size]="17" /></span><span class="tab-name">Audit</span></a></li>
    </ul>
   }
   <div class="sidenav-label" id="nav-dev">Development</div>
   <ul class="nav-list" aria-labelledby="nav-dev">
    <li><a class="tab" routerLink="/components" routerLinkActive="active" ariaCurrentWhenActive="page"><span class="nav-ic"><rs-icon name="sliders" [size]="17" /></span><span class="tab-name">Component check</span></a></li>
   </ul>
   <div class="sidenav-footer"><span class="status-dot" [attr.data-tone]="state.healthy() ? 'safe' : 'destructive'" aria-hidden="true"></span><p role="status">{{ state.health() }}</p></div>
  </nav>

  <main id="main" class="scroll-area" tabindex="-1">
   <router-outlet />
  </main>
 </div>
</div>`,
})
export class ShellComponent {
 readonly state = inject(AppState);
 readonly dark = signal(initialTheme() === 'dark');
 private readonly router = inject(Router);

 constructor() {
  document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light';
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
