import { Component, CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { healthSchema } from '../../../../packages/contracts/src/index';
import { RESOLVE_ELEMENTS } from './elements';

type Density = 'compact' | 'balanced' | 'spacious';

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
  </div>
 </header>
 <main id="main" tabindex="-1">
  <section class="hero">
   <p class="badge">Phase 0 · Component gate</p>
   <h1>One place to support<br>every application.</h1>
   <p class="muted">Development workspace for validating Resolve's component and service boundaries. Nothing here connects to an application.</p>
  </section>

  <section class="panel" aria-labelledby="service-title">
   <h2 id="service-title">Service connection</h2>
   <p role="status">{{ health() }}</p>
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
 }

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
