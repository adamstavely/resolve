import { Component, CUSTOM_ELEMENTS_SCHEMA, signal, viewChild } from '@angular/core';
import { RESOLVE_ELEMENTS, ResolveConfirmDialog } from '../elements';

/** Development page exercising the Web Component bridge (phase 0 component gate). */
@Component({
 selector: 'rs-components-page',
 imports: [...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">Component check</h1>
  <p class="lp-lede small-lede">Development page. Angular owns this native form; each field is a form-associated Web Component. Submitting only reads the values in your browser.</p>
 </header>
 <section class="card" aria-labelledby="check-title">
  <div class="card-head"><h2 class="card-title" id="check-title">Local form</h2><span class="card-meta">Development</span></div>
  <div class="pad">
   <form class="form-stack" (submit)="submit($event)" (reset)="onReset()">
    <resolve-text-field name="appName" label="Application name" [required]="true" [maxlength]="80"
     hint="The name support staff will see." [(value)]="appName" autocomplete="off"/>
    <resolve-text-field name="contact" label="Support contact email" kind="email" [(value)]="contact" autocomplete="email"/>
    <resolve-combobox name="team" label="Support team" [required]="true" [options]="teams" [(value)]="team"
     placeholder="Choose a team" searchLabel="Search teams" emptyText="No matching team."/>
    <div class="row">
     <button class="btn btn-primary" type="submit">Check form values</button>
     <button class="btn" type="reset">Reset</button>
     <button class="btn btn-ghost" type="button" (click)="discardDialog()?.show()">Discard draft…</button>
    </div>
   </form>
   <p role="status">{{ result() }}</p>
   <p class="muted small">Angular model: {{ appName() || '—' }} · {{ contact() || '—' }} · {{ team() || '—' }}</p>
  </div>
 </section>
 <resolve-confirm-dialog #discardDialogRef tone="destructive" heading="Discard this draft?"
  description="The values in this local check will be cleared. This does not affect any application."
  confirmLabel="Discard draft" cancelLabel="Keep editing" (confirmed)="discard()"/>
</div>`,
})
export class ComponentsPage {
 readonly appName = signal('');
 readonly contact = signal('');
 readonly team = signal('');
 readonly discardDialog = viewChild('discardDialogRef', { read: ResolveConfirmDialog });
 readonly result = signal('No values checked yet.');
 readonly teams = [
  { value: 'payroll-sre', label: 'Payroll SRE' },
  { value: 'hr-platform', label: 'HR Platform' },
  { value: 'identity-ops', label: 'Identity Operations' },
 ];
 submit(event: SubmitEvent) {
  event.preventDefault();
  // Values come from FormData, proving native form association rather than the Angular bindings.
  const data = new FormData(event.target as HTMLFormElement);
  this.result.set(`Form values: ${[...data.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
 }
 onReset() { this.appName.set(''); this.contact.set(''); this.team.set(''); this.result.set('Form reset.'); }
 discard() { this.onReset(); this.result.set('Draft discarded.'); }
}
