import { Component, CUSTOM_ELEMENTS_SCHEMA, computed, signal } from '@angular/core';
import { appsResponseSchema, auditPageSchema, BUNDLE_LABELS, type AuditEvent, CAPABILITIES, healthSchema, sessionResponseSchema, whoamiResponseSchema, type AppsResponse, type SessionResponse } from '../../../../packages/contracts/src/index';
import { RESOLVE_ELEMENTS } from './elements';

type Density = 'compact' | 'balanced' | 'spacious';

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
   <p class="badge">Phase 1 · Identity and connections</p>
   <h1>One place to support<br>every application.</h1>
   <p class="muted">Development workspace. Sign-in and application connections run against local mock services, not real applications.</p>
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

  @if (apps(); as list) {
   <section class="panel" aria-labelledby="apps-title">
    <h2 id="apps-title">Applications</h2>
    <p class="muted">Connect to each application once. Resolve then acts as you there, with only the access your role needs.</p>
    <div class="table-wrap"><table>
     <caption class="sr-only">Registered applications and your connection to each</caption>
     <thead><tr><th scope="col">Application</th><th scope="col">Status</th><th scope="col">Your connection</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
     <tbody>
      @for (a of list.apps; track a.appKey) {
       <tr>
        <th scope="row">{{ a.displayName }}</th>
        <td>{{ a.servable ? 'Available' : 'Unavailable (' + a.state + ')' }}</td>
        <td>{{ connectionLabel(a.connection.state) }}@if (a.connection.state === 'connected') { <span class="muted"> · {{ a.connection.scopes.filter(isToolScope).join(', ') || 'sign-in only' }}</span> }</td>
        <td class="actions">
         @if (a.servable && canConnect()) {
          @if (a.connection.state === 'connected') {
           <button class="btn" type="button" (click)="checkConnection(a.appKey, a.displayName)">Check connection<span class="sr-only"> to {{ a.displayName }}</span></button>
           <form method="post" [action]="'/api/connect/' + a.appKey + '/disconnect'"><button class="btn" type="submit">Disconnect<span class="sr-only"> from {{ a.displayName }}</span></button></form>
          } @else {
           <a class="btn btn-primary" [href]="'/api/connect/' + a.appKey + '/start'">{{ a.connection.state === 'not_connected' ? 'Connect' : 'Reconnect' }}<span class="sr-only"> to {{ a.displayName }}</span></a>
          }
         }
        </td>
       </tr>
      }
     </tbody>
    </table></div>
    <p role="status">{{ connectionCheck() }}</p>
   </section>
  }

  @if (canReadAudit()) {
   <section class="panel" aria-labelledby="audit-title">
    <h2 id="audit-title">Audit</h2>
    <p class="muted">Sign-ins, app connections and access changes, newest first. Read-only.</p>
    <div class="row filters">
     <label class="row" for="audit-category">Activity
      <select id="audit-category" [value]="auditCategory()" (change)="setAuditFilter('category', $any($event.target).value)">
       <option value="">All</option><option value="session">Sign-in</option><option value="grant">App connections</option><option value="user">Access changes</option>
      </select>
     </label>
     <label class="row" for="audit-outcome">Outcome
      <select id="audit-outcome" [value]="auditOutcome()" (change)="setAuditFilter('outcome', $any($event.target).value)">
       <option value="">All</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="denied">Denied</option>
      </select>
     </label>
    </div>
    <div class="table-wrap"><table>
     <caption class="sr-only">Audit events</caption>
     <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Details</th></tr></thead>
     <tbody>
      @for (e of auditEvents(); track e.id) {
       <tr>
        <td><time [attr.datetime]="e.at">{{ formatTime(e.at) }}</time></td>
        <td>{{ e.actor }}@if (e.actorType === 'system') { <span class="muted"> (system)</span> }</td>
        <td>{{ actionLabel(e.operation) }}</td>
        <td>{{ e.outcome }}</td>
        <td class="mono">{{ details(e) }}</td>
       </tr>
      } @empty {
       <tr><td colspan="5">{{ auditLoading() ? 'Loading…' : 'No matching events.' }}</td></tr>
      }
     </tbody>
    </table></div>
    @if (auditCursor()) { <button class="btn" type="button" (click)="loadAudit(true)" [disabled]="auditLoading()">Load older events</button> }
    <p role="status" class="sr-only">{{ auditStatus() }}</p>
   </section>
  }

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
  fetch('/api/health')
   .then(async r => { if (!r.ok) throw Error(); healthSchema.parse(await r.json()); this.health.set('Resolve API is reachable · contract v1'); })
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
