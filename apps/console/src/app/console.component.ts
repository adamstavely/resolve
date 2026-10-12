import { Component, CUSTOM_ELEMENTS_SCHEMA, computed, signal } from '@angular/core';
import { appsResponseSchema, auditPageSchema, BUNDLE_LABELS, type AuditEvent, CAPABILITIES, healthSchema, sessionResponseSchema, whoamiResponseSchema, type AppsResponse, type SessionResponse } from '../../../../packages/contracts/src/index';
import { RESOLVE_ELEMENTS } from './elements';
import { IconComponent, MarkComponent } from './icon.component';

/** Saved preference, else the operating system's. */
function initialTheme(): 'light' | 'dark' {
 try { const saved = localStorage.getItem('resolve-theme'); if (saved === 'light' || saved === 'dark') return saved; } catch { /* ignore */ }
 return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const ACTION_LABELS: Record<string, string> = {
 'session.login': 'Signed in', 'session.logout': 'Signed out', 'grant.connect': 'Connected an app', 'grant.disconnect': 'Disconnected an app',
 'user.manual_disable': 'Blocked access', 'user.manual_enable': 'Lifted an access block', 'user.directory_disable': 'Disabled by directory',
 'user.directory_enable': 'Re-enabled by directory', 'app.client_register': 'Registered an app client',
};

const CONNECTION_LABELS: Record<string, string> = {
 not_connected: 'Not connected', connecting: 'Connecting', connected: 'Connected', reconnect_required: 'Reconnect required',
 revoked: 'Access revoked', denied: 'Denied',
};

function connectMessage(result: string | null, appName = 'the application'): { text: string; alert: boolean } | undefined {
 const app = appName;
 switch (result) {
  case 'connected': return { text: `Connected to ${app}.`, alert: false };
  case 'disconnected': return { text: `Disconnected from ${app}.`, alert: false };
  case 'unavailable': return { text: `${app} is not available right now. Try again later.`, alert: true };
  case 'mismatch': return { text: `The account used at ${app} does not belong to you in Resolve. Sign out of other accounts and try again, or contact support.`, alert: true };
  case 'failed': return { text: `Connecting to ${app} did not complete. Try again.`, alert: true };
  default: return undefined;
 }
}

const SIGNIN_MESSAGES: Record<string, { text: string; alert: boolean }> = {
 failed: { text: 'Sign-in did not complete. Try again; if it keeps failing, contact support.', alert: true },
 denied: { text: 'Your account is disabled in Resolve. Contact an administrator.', alert: true },
 'signed-out': { text: 'You have signed out.', alert: false },
};

@Component({
 selector: 'resolve-root',
 imports: [...RESOLVE_ELEMENTS, IconComponent, MarkComponent],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<a class="skip" href="#main">Skip to main content</a>
<div class="app-bg" aria-hidden="true"></div>
<div class="shell">
 <header class="topbar">
  <a class="brand" href="/" aria-label="Resolve home">
   <span class="brand-mark"><rs-mark [size]="18" /></span>
   <span class="brand-name">Resolve</span>
   <span class="brand-tag">Unified support operations</span>
  </a>
  <div class="topbar-spacer"></div>
  <div class="topbar-actions">
   <button class="icon-btn" type="button" (click)="toggleTheme()" [attr.aria-pressed]="dark()" aria-label="Dark appearance">
    <rs-icon [name]="dark() ? 'sun' : 'moon'" [size]="18" />
   </button>
   @if (session(); as s) {
    @if (s.authenticated) {
     <span class="avatar-btn" [attr.title]="s.user.displayName" aria-hidden="true">{{ initials() }}</span>
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
   <a class="tab" href="#main" aria-current="page"><span class="nav-ic"><rs-icon name="grid" [size]="17" /></span><span class="tab-name">Home</span></a>
   @if (apps(); as list) {
    <div class="sidenav-label" id="nav-apps">Applications</div>
    <ul class="nav-list" aria-labelledby="nav-apps">
     @for (a of list.apps; track a.appKey) {
      <li><a class="tab" [href]="'#app-' + a.appKey">
       <span class="app-glyph" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
       <span class="tab-name">{{ a.displayName }}</span>
       <span class="status-dot" [attr.data-tone]="appTone(a)" [attr.title]="connectionLabel(a.connection.state)"></span>
       <span class="sr-only">, {{ a.servable ? connectionLabel(a.connection.state) : 'unavailable' }}</span>
      </a></li>
     }
    </ul>
   }
   @if (canReadAudit()) {
    <div class="sidenav-label" id="nav-admin">Administration</div>
    <ul class="nav-list" aria-labelledby="nav-admin">
     <li><a class="tab" href="#audit"><span class="nav-ic"><rs-icon name="doc" [size]="17" /></span><span class="tab-name">Audit</span></a></li>
    </ul>
   }
   <div class="sidenav-footer"><span class="status-dot" [attr.data-tone]="healthy() ? 'safe' : 'destructive'" aria-hidden="true"></span><p role="status">{{ health() }}</p></div>
  </nav>

  <main id="main" class="scroll-area" tabindex="-1">
   <div class="launchpad">
    @if (signinMessage(); as m) { <p class="notice" [attr.data-tone]="m.alert ? 'destructive' : 'safe'" [attr.role]="m.alert ? 'alert' : 'status'">{{ m.text }}</p> }

    <section class="lp-hero" aria-labelledby="hero-title">
     <div class="lp-mark" aria-hidden="true"><rs-mark size="100%" variant="hero" /></div>
     <div>
      <h1 class="lp-title" id="hero-title">Resolve: One place to <span class="accent">solve</span> it.</h1>
      <p class="lp-lede">Chats, tickets, and escalations across every connected application. Sign in once, connect each app as yourself, and act with the access your role allows.</p>
     </div>
    </section>

    <div class="lp-cols">
     <div class="stack-lg">
      @if (apps(); as list) {
       <section aria-labelledby="apps-title">
        <div class="section-head"><h2 class="section-label" id="apps-title">Your applications</h2></div>
        <p class="muted small">Connect to each application once. Resolve then acts as you there, with only the access your role needs.</p>
        <div class="app-grid">
         @for (a of list.apps; track a.appKey) {
          <article class="app-card" [id]="'app-' + a.appKey" [attr.aria-labelledby]="'app-name-' + a.appKey" [attr.data-unavailable]="!a.servable || null">
           <div class="app-card-top">
            <span class="app-glyph lg" aria-hidden="true">{{ a.displayName.charAt(0) }}</span>
            <div class="grow">
             <h3 class="app-card-name" [id]="'app-name-' + a.appKey">{{ a.displayName }}</h3>
             <p class="app-card-key mono">{{ a.appKey }}</p>
            </div>
           </div>
           <dl class="app-card-meta">
            <div><dt>Status</dt><dd><span class="status-dot" [attr.data-tone]="a.servable ? 'safe' : 'sensitive'" aria-hidden="true"></span>{{ a.servable ? 'Available' : 'Unavailable (' + a.state + ')' }}</dd></div>
            <div><dt>Your connection</dt><dd>{{ connectionLabel(a.connection.state) }}</dd></div>
            @if (a.connection.state === 'connected') {
             <div><dt>Access</dt><dd class="chips">@for (sc of a.connection.scopes.filter(isToolScope); track sc) { <span class="chip mono">{{ sc }}</span> } @empty { <span class="muted">Sign-in only</span> }</dd></div>
            }
           </dl>
           @if (a.servable && canConnect()) {
            <div class="app-card-actions">
             @if (a.connection.state === 'connected') {
              <button class="btn btn-sm" type="button" (click)="checkConnection(a.appKey, a.displayName)"><rs-icon name="shieldCheck" [size]="15" />Check connection<span class="sr-only"> to {{ a.displayName }}</span></button>
              <form method="post" [action]="'/api/connect/' + a.appKey + '/disconnect'"><button class="btn btn-sm btn-ghost" type="submit">Disconnect<span class="sr-only"> from {{ a.displayName }}</span></button></form>
             } @else {
              <a class="btn btn-sm btn-primary" [href]="'/api/connect/' + a.appKey + '/start'">{{ a.connection.state === 'not_connected' ? 'Connect' : 'Reconnect' }}<span class="sr-only"> to {{ a.displayName }}</span></a>
             }
            </div>
           }
          </article>
         }
        </div>
        <p role="status" class="small muted status-line">{{ connectionCheck() }}</p>
       </section>
      } @else if (session()?.authenticated === false) {
       <section class="card pad" aria-labelledby="signin-title">
        <h2 class="card-title" id="signin-title">Sign in to continue</h2>
        <p class="muted">Use your organization account. Resolve then shows the applications and actions your role allows.</p>
        <a class="btn btn-primary" href="/api/auth/login?returnTo=/">Sign in</a>
       </section>
      }
     </div>

     <aside class="stack-lg" aria-label="Your access">
      <section class="card" aria-labelledby="access-title">
       <div class="card-head"><h2 class="card-title" id="access-title"><rs-icon name="user" [size]="15" />Your access</h2></div>
       <div class="pad">
        @if (session(); as s) {
         @if (s.authenticated) {
          <p class="who">Signed in as {{ s.user.displayName }}{{ s.user.email ? ' (' + s.user.email + ')' : '' }}.
           Roles: {{ roleLabels() || 'none. Ask an administrator for access.' }}</p>
          @if (s.capabilities.length) {
           <ul class="caps">@for (c of s.capabilities; track c) { <li><rs-icon name="check" [size]="14" />{{ capabilitySummary(c) }}</li> }</ul>
          }
         } @else {
          <p class="muted">You are signed out. Sign in with your organization account to see your access.</p>
         }
        } @else { <p class="muted">Checking sign-in…</p> }
       </div>
      </section>
     </aside>
    </div>

    @if (canReadAudit()) {
     <section class="card" id="audit" aria-labelledby="audit-title">
      <div class="card-head">
       <h2 class="card-title" id="audit-title"><rs-icon name="activity" [size]="15" />Audit</h2>
       <span class="card-meta">Read-only</span>
      </div>
      <div class="pad">
       <p class="muted small">Sign-ins, app connections and access changes, newest first.</p>
       <div class="filters">
        <label for="audit-category">Activity
         <select id="audit-category" [value]="auditCategory()" (change)="setAuditFilter('category', $any($event.target).value)">
          <option value="">All</option><option value="session">Sign-in</option><option value="grant">App connections</option><option value="user">Access changes</option>
         </select>
        </label>
        <label for="audit-outcome">Outcome
         <select id="audit-outcome" [value]="auditOutcome()" (change)="setAuditFilter('outcome', $any($event.target).value)">
          <option value="">All</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="denied">Denied</option>
         </select>
        </label>
       </div>
       <div class="table-wrap"><table class="data">
        <caption class="sr-only">Audit events</caption>
        <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Details</th></tr></thead>
        <tbody>
         @for (e of auditEvents(); track e.id) {
          <tr>
           <td class="mono nowrap"><time [attr.datetime]="e.at">{{ formatTime(e.at) }}</time></td>
           <td>{{ e.actor }}@if (e.actorType === 'system') { <span class="muted"> (system)</span> }</td>
           <td>{{ actionLabel(e.operation) }}</td>
           <td><span class="tag" [attr.data-tone]="outcomeTone(e.outcome)">{{ e.outcome }}</span></td>
           <td class="mono small">{{ details(e) }}</td>
          </tr>
         } @empty {
          <tr><td colspan="5" class="muted">{{ auditLoading() ? 'Loading…' : 'No matching events.' }}</td></tr>
         }
        </tbody>
       </table></div>
       @if (auditCursor()) { <button class="btn btn-sm" type="button" (click)="loadAudit(true)" [disabled]="auditLoading()">Load older events</button> }
       <p role="status" class="sr-only">{{ auditStatus() }}</p>
      </div>
     </section>
    }

    <section class="card" aria-labelledby="check-title">
     <div class="card-head"><h2 class="card-title" id="check-title"><rs-icon name="sliders" [size]="15" />Component check</h2><span class="card-meta">Development</span></div>
     <div class="pad">
      <p class="muted small">Angular owns this native form; each field is a form-associated Web Component. Submitting only reads the values in your browser.</p>
      <form class="form-stack" (submit)="submit($event)" (reset)="onReset()">
       <resolve-text-field name="appName" label="Application name" [required]="true" [maxlength]="80"
        hint="The name support staff will see." [(value)]="appName" autocomplete="off"/>
       <resolve-text-field name="contact" label="Support contact email" kind="email" [(value)]="contact" autocomplete="email"/>
       <resolve-combobox name="team" label="Support team" [required]="true" [options]="teams" [(value)]="team"
        placeholder="Choose a team" searchLabel="Search teams" emptyText="No matching team."/>
       <div class="row">
        <button class="btn btn-primary" type="submit">Check form values</button>
        <button class="btn" type="reset">Reset</button>
        <button class="btn btn-ghost" type="button" (click)="discardOpen.set(true)">Discard draft…</button>
       </div>
      </form>
      <p role="status">{{ result() }}</p>
      <p class="muted small">Angular model: {{ appName() || '—' }} · {{ contact() || '—' }} · {{ team() || '—' }}</p>
     </div>
    </section>

    <resolve-confirm-dialog [(open)]="discardOpen" tone="destructive" heading="Discard this draft?"
     description="The values in this local check will be cleared. This does not affect any application."
     confirmLabel="Discard draft" cancelLabel="Keep editing" (confirmed)="discard()"/>
   </div>
  </main>
 </div>
</div>`,
})
export class ConsoleComponent {
 readonly dark = signal(initialTheme() === 'dark');
 readonly health = signal('Checking backend…');
 readonly healthy = signal(false);
 readonly session = signal<SessionResponse | undefined>(undefined);
 readonly roleLabels = computed(() => { const s = this.session(); return s?.authenticated ? s.bundles.map(b => BUNDLE_LABELS[b]).join(', ') : ''; });
 readonly initials = computed(() => { const s = this.session(); return s?.authenticated ? s.user.displayName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() : ''; });
 readonly apps = signal<AppsResponse | undefined>(undefined);
 readonly auditEvents = signal<AuditEvent[]>([]);
 readonly auditCursor = signal<string | null>(null);
 readonly auditLoading = signal(false);
 readonly auditStatus = signal('');
 readonly auditCategory = signal('');
 readonly auditOutcome = signal('');
 readonly canReadAudit = computed(() => { const s = this.session(); return !!s?.authenticated && s.capabilities.includes('audit.read'); });
 readonly connectionCheck = signal('');
 readonly canConnect = computed(() => { const s = this.session(); return !!s?.authenticated && s.capabilities.includes('connection.manage'); });
 private readonly query = new URLSearchParams(location.search);
 readonly signinMessage = computed(() => {
  const name = this.apps()?.apps.find(a => a.appKey === this.query.get('app'))?.displayName ?? this.query.get('app') ?? undefined;
  return SIGNIN_MESSAGES[this.query.get('signin') ?? ''] ?? connectMessage(this.query.get('connect'), name);
 });
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
  document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light';
  fetch('/api/health')
   .then(async r => { if (!r.ok) throw Error(); healthSchema.parse(await r.json()); this.health.set('Resolve API is reachable · contract v1'); this.healthy.set(true); })
   .catch(() => this.health.set('Backend unavailable. Start the API service and reload.'));
  fetch('/api/session', { credentials: 'same-origin' })
   .then(async r => {
    const s = sessionResponseSchema.parse(await r.json());
    this.session.set(s);
    if (s.authenticated && s.capabilities.includes('fleet.view')) this.loadApps();
    if (s.authenticated && s.capabilities.includes('audit.read')) this.loadAudit(false);
   })
   .catch(() => this.session.set({ authenticated: false }));
  // Drop the one-time sign-in result from the address bar so a reload does not repeat it.
  if (this.signinMessage()) history.replaceState(null, '', location.pathname);
 }

 setAuditFilter(which: 'category' | 'outcome', value: string) {
  (which === 'category' ? this.auditCategory : this.auditOutcome).set(value);
  this.loadAudit(false);
 }

 loadAudit(older: boolean) {
  const q = new URLSearchParams({ limit: '25' });
  if (this.auditCategory()) q.set('category', this.auditCategory());
  if (this.auditOutcome()) q.set('outcome', this.auditOutcome());
  if (older && this.auditCursor()) q.set('before', this.auditCursor()!);
  this.auditLoading.set(true);
  fetch('/api/audit?' + q, { credentials: 'same-origin' })
   .then(async r => { if (!r.ok) throw Error(); return auditPageSchema.parse(await r.json()); })
   .then(page => {
    this.auditEvents.update(prev => older ? [...prev, ...page.events] : page.events);
    this.auditCursor.set(page.nextCursor);
    this.auditStatus.set(`${this.auditEvents().length} audit events shown.`);
   })
   .catch(() => this.auditStatus.set('Audit events could not be loaded.'))
   .finally(() => this.auditLoading.set(false));
 }

 formatTime(iso: string) { return new Date(iso).toLocaleString(); }
 actionLabel(op: string) { return ACTION_LABELS[op] ?? op; }
 details(e: AuditEvent) {
  return Object.entries(e.summary).filter(([k]) => !['executor', 'userId', 'targetUserId'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · ');
 }

 loadApps() {
  fetch('/api/apps', { credentials: 'same-origin' })
   .then(async r => { if (!r.ok) throw Error(); this.apps.set(appsResponseSchema.parse(await r.json())); })
   .catch(() => this.connectionCheck.set('Applications could not be loaded. Try again shortly.'));
 }

 appTone(a: AppsResponse['apps'][number]) {
  if (!a.servable) return 'sensitive';
  return a.connection.state === 'connected' ? 'safe' : a.connection.state === 'not_connected' ? 'neutral' : 'destructive';
 }
 outcomeTone(outcome: string) { return outcome === 'succeeded' ? 'safe' : outcome === 'pending' ? 'neutral' : outcome === 'uncertain' ? 'sensitive' : 'destructive'; }

 connectionLabel(state: string) { return CONNECTION_LABELS[state] ?? state; }
 isToolScope(scope: string) { return scope !== 'openid' && scope !== 'offline_access'; }

 checkConnection(appKey: string, name: string) {
  this.connectionCheck.set(`Checking ${name}…`);
  fetch(`/api/apps/${encodeURIComponent(appKey)}/whoami`, { credentials: 'same-origin' }).then(async r => {
   const body = await r.json();
   if (!r.ok) { this.connectionCheck.set(`${name}: ${body.error?.message ?? 'check failed.'}`); if (body.error?.code === 'RECONNECT_REQUIRED') this.loadApps(); return; }
   const who = whoamiResponseSchema.parse(body);
   this.connectionCheck.set(`${name} recognises you as ${who.tenantUserId} with ${who.scopes.filter(s => this.isToolScope(s)).join(', ') || 'sign-in only'}.`);
  }).catch(() => this.connectionCheck.set(`${name}: check failed.`));
 }

 capabilitySummary(id: keyof typeof CAPABILITIES) { return CAPABILITIES[id].summary; }

 toggleTheme() {
  this.dark.update(v => !v);
  document.documentElement.dataset['theme'] = this.dark() ? 'dark' : 'light';
  try { localStorage.setItem('resolve-theme', this.dark() ? 'dark' : 'light'); } catch { /* storage may be unavailable */ }
 }

 submit(event: SubmitEvent) {
  event.preventDefault();
  // Values come from FormData, proving native form association rather than the Angular bindings.
  const data = new FormData(event.target as HTMLFormElement);
  this.result.set(`Form values: ${[...data.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
 }
 onReset() { this.appName.set(''); this.contact.set(''); this.team.set(''); this.result.set('Form reset.'); }
 discard() { this.onReset(); this.result.set('Draft discarded.'); }
}
