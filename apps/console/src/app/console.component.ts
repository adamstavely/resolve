import { Component, CUSTOM_ELEMENTS_SCHEMA, computed, signal } from '@angular/core';
import { BUNDLE_LABELS, CAPABILITIES, healthSchema, sessionResponseSchema, type SessionResponse } from '../../../../packages/contracts/src/index';
import { RESOLVE_ELEMENTS } from './elements';

type Density = 'compact' | 'balanced' | 'spacious';

const SIGNIN_MESSAGES: Record<string, { text: string; alert: boolean }> = {
 failed: { text: 'Sign-in did not complete. Try again; if it keeps failing, contact support.', alert: true },
 denied: { text: 'Your account is disabled in Resolve. Contact an administrator.', alert: true },
 'signed-out': { text: 'You have signed out.', alert: false },
};

@Component({
 selector: 'resolve-root',
 imports: [...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<a class="skip" href="#main">Skip to main content</a>
<div class="shell">
 <header>
  <div class="brand">resolve<span class="badge"> / foundation</span></div>
  <div class="row">
   <label class="row" for="density">Density
    <select id="density" [value]="density()" (change)="setDensity($any($event.target).value)">
     <option value="compact">Compact</option><option value="balanced">Balanced</option><option value="spacious">Spacious</option>
    </select>
   </label>
   <button class="btn" type="button" (click)="toggleTheme()" [attr.aria-pressed]="dark()">Dark appearance</button>
   @if (session(); as s) {
    @if (s.authenticated) {
     <span class="who">{{ s.user.displayName }}</span>
     <form method="post" action="/api/auth/logout"><button class="btn" type="submit">Sign out</button></form>
    } @else {
     <a class="btn btn-primary" href="/api/auth/login?returnTo=/">Sign in</a>
    }
   }
  </div>
 </header>
 <main id="main" tabindex="-1">
  @if (signinMessage(); as m) { <p class="notice" [attr.role]="m.alert ? 'alert' : 'status'">{{ m.text }}</p> }
  <section class="hero">
   <p class="badge">Phase 1 · Sign-in</p>
   <h1>One place to support<br>every application.</h1>
   <p class="muted">Development workspace for validating Resolve's component and service boundaries. Nothing here connects to an application.</p>
  </section>

  <section class="panel" aria-labelledby="service-title">
   <h2 id="service-title">Service connection</h2>
   <p role="status">{{ health() }}</p>
  </section>

  <section class="panel" aria-labelledby="access-title">
   <h2 id="access-title">Your access</h2>
   @if (session(); as s) {
    @if (s.authenticated) {
     <p>Signed in as {{ s.user.displayName }}{{ s.user.email ? ' (' + s.user.email + ')' : '' }}.
      Roles: {{ roleLabels() || 'none. Ask an administrator for access.' }}</p>
     @if (s.capabilities.length) {
      <ul class="caps">@for (c of s.capabilities; track c) { <li>{{ capabilitySummary(c) }}</li> }</ul>
     }
    } @else {
     <p>You are signed out. Sign in with your organization account to see your access.</p>
    }
   } @else { <p>Checking sign-in…</p> }
  </section>

  <section class="panel" aria-labelledby="check-title">
   <h2 id="check-title">Component check</h2>
   <p class="muted">Angular owns this native form; each field is a form-associated Web Component. Submitting only reads the values in your browser.</p>
   <form class="stack" (submit)="submit($event)" (reset)="onReset()">
    <resolve-text-field name="appName" label="Application name" [required]="true" [maxlength]="80"
     hint="The name support staff will see." [(value)]="appName" autocomplete="off"/>
    <resolve-text-field name="contact" label="Support contact email" kind="email" [(value)]="contact" autocomplete="email"/>
    <resolve-combobox name="team" label="Support team" [required]="true" [options]="teams" [(value)]="team"
     placeholder="Choose a team" searchLabel="Search teams" emptyText="No matching team."/>
    <div class="row">
     <button class="btn btn-primary" type="submit">Check form values</button>
     <button class="btn" type="reset">Reset</button>
     <button class="btn" type="button" (click)="discardOpen.set(true)">Discard draft…</button>
    </div>
   </form>
   <p role="status">{{ result() }}</p>
   <p class="muted">Angular model: {{ appName() || '—' }} · {{ contact() || '—' }} · {{ team() || '—' }}</p>
  </section>

  <resolve-confirm-dialog [(open)]="discardOpen" tone="destructive" heading="Discard this draft?"
   description="The values in this local check will be cleared. This does not affect any application."
   confirmLabel="Discard draft" cancelLabel="Keep editing" (confirmed)="discard()"/>
 </main>
</div>`,
})
export class ConsoleComponent {
 readonly dark = signal(false);
 readonly density = signal<Density>('balanced');
 readonly health = signal('Checking backend…');
 readonly session = signal<SessionResponse | undefined>(undefined);
 readonly roleLabels = computed(() => { const s = this.session(); return s?.authenticated ? s.bundles.map(b => BUNDLE_LABELS[b]).join(', ') : ''; });
 readonly signinMessage = signal<{ text: string; alert: boolean } | undefined>(SIGNIN_MESSAGES[new URLSearchParams(location.search).get('signin') ?? '']);
 readonly appName = signal('');
 readonly contact = signal('');
 readonly team = signal('');
 readonly discardOpen = signal(false);
 readonly result = signal('No values checked yet.');
 readonly teams = [
  { value: 'payroll-sre', label: 'Payroll SRE' },
  { value: 'hr-platform', label: 'HR Platform' },
  { value: 'identity-ops', label: 'Identity Operations' },
 ];

 constructor() {
  fetch('/api/health')
   .then(async r => { if (!r.ok) throw Error(); healthSchema.parse(await r.json()); this.health.set('Resolve API is reachable · contract v1'); })
   .catch(() => this.health.set('Backend unavailable. Start the API service and reload.'));
  fetch('/api/session', { credentials: 'same-origin' })
   .then(async r => this.session.set(sessionResponseSchema.parse(await r.json())))
   .catch(() => this.session.set({ authenticated: false }));
  // Drop the one-time sign-in result from the address bar so a reload does not repeat it.
  if (this.signinMessage()) history.replaceState(null, '', location.pathname);
 }

 capabilitySummary(id: keyof typeof CAPABILITIES) { return CAPABILITIES[id].summary; }

 toggleTheme() { this.dark.update(v => !v); document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light'; }
 setDensity(value: Density) { this.density.set(value); document.documentElement.dataset['density'] = value; }

 submit(event: SubmitEvent) {
  event.preventDefault();
  // Values come from FormData, proving native form association rather than the Angular bindings.
  const data = new FormData(event.target as HTMLFormElement);
  this.result.set(`Form values: ${[...data.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
 }
 onReset() { this.appName.set(''); this.contact.set(''); this.team.set(''); this.result.set('Form reset.'); }
 discard() { this.onReset(); this.result.set('Draft discarded.'); }
}
