import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { applicationsResponseSchema, migrationsResponseSchema } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { api, AppState } from '../state';

type Applications = z.infer<typeof applicationsResponseSchema>;
type Migrations = z.infer<typeof migrationsResponseSchema>;
export const LIFECYCLE_TONE: Record<string, string> = { draft: 'neutral', onboarding: 'sensitive', ready: 'sensitive', active: 'safe', suspended: 'destructive', retired: 'neutral' };
export const RUN_LABEL: Record<string, string> = {
 draft: 'Draft', reviewed: 'Reviewed', provisioning: 'Provisioning', validating: 'Validating', ready: 'Ready to activate', activating: 'Activating', active: 'Active', failed: 'Needs attention', cancelled: 'Cancelled',
};

/** Applications registered through onboarding, apps managed elsewhere, and the fleet's migration status (plan 07, plan 03). */
@Component({
 selector: 'rs-applications-page',
 imports: [RouterLink, IconComponent],
 template: `
<div class="page">
 <header class="page-head head-row">
  <div class="grow">
   <h1 class="page-title" tabindex="-1">Applications</h1>
   <p class="lp-lede small-lede">Register an application, attach its support instance, and follow it to activation.</p>
  </div>
  @if (state.can('app.register')) { <a class="btn btn-primary" routerLink="/applications/onboarding/new"><rs-icon name="plus" [size]="15" />Register application</a> }
 </header>
 @if (error()) { <p class="notice" data-tone="destructive" role="alert">{{ error() }}</p> }

 <section class="card" aria-labelledby="registered-title">
  <div class="card-head"><h2 class="card-title" id="registered-title">Registered</h2><span class="card-meta">{{ data()?.applications?.length ?? 0 }} applications</span></div>
  <div class="table-wrap pad-sm"><table class="data">
   <caption class="sr-only">Registered applications and their environments</caption>
   <thead><tr><th scope="col">Application</th><th scope="col">Environment</th><th scope="col">Instance</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
   <tbody>
    @for (a of data()?.applications ?? []; track a.id) {
     @for (b of a.bindings; track b.workspaceKey) {
      <tr>
       <td><span class="row-link">{{ a.name }}</span><div class="muted small">{{ a.ownerName }} · {{ a.supportTeam }}</div></td>
       <td>{{ b.environment }}</td>
       <td><span class="mono small">{{ b.supportHostname ?? b.workspaceKey }}</span><div class="muted small">{{ b.strategy === 'adopt' ? 'Adopted instance' : 'Managed instance' }}</div></td>
       <td><span class="tag" [attr.data-tone]="tone(b.lifecycle)">{{ b.lifecycle }}</span>
        @if (b.runStatus && b.lifecycle !== 'active') { <div class="muted small">{{ runLabel(b.runStatus) }}</div> }</td>
       <td class="actions-cell">
        @if (b.runId && b.lifecycle !== 'active' && b.runStatus !== 'cancelled') { <a class="btn btn-sm" [routerLink]="['/applications/onboarding', b.runId]">Continue onboarding<span class="sr-only"> for {{ a.name }} {{ b.environment }}</span></a> }
        @if (b.lifecycle === 'active' || b.lifecycle === 'suspended') { <a class="btn btn-sm" [routerLink]="['/applications', b.workspaceKey]">Manage<span class="sr-only"> {{ a.name }} {{ b.environment }}</span></a> }
       </td>
      </tr>
     }
     @for (d of a.drafts; track d.runId) {
      <tr>
       <td><span class="row-link">{{ a.name }}</span></td><td>{{ d.environment }}</td><td class="muted small">Not chosen yet</td>
       <td><span class="tag">draft</span></td>
       <td class="actions-cell"><a class="btn btn-sm" [routerLink]="['/applications/onboarding', d.runId]">Continue onboarding<span class="sr-only"> for {{ a.name }} {{ d.environment }}</span></a></td>
      </tr>
     }
    } @empty {
     <tr><td colspan="5" class="muted">{{ loading() ? 'Loading applications…' : 'No applications registered through onboarding yet.' }}</td></tr>
    }
   </tbody>
  </table></div>
 </section>

 @if (data()?.external?.length) {
  <section class="card" aria-labelledby="external-title">
   <div class="card-head"><h2 class="card-title" id="external-title">Managed outside onboarding</h2><span class="card-meta">Registry</span></div>
   <div class="table-wrap pad-sm"><table class="data">
    <caption class="sr-only">Applications in the fleet registry that were not onboarded through Resolve</caption>
    <thead><tr><th scope="col">Application</th><th scope="col">Registry state</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>
     @for (x of data()!.external; track x.appKey) {
      <tr><td>{{ x.displayName }} <span class="mono muted small">{{ x.appKey }}</span></td>
       <td><span class="tag" [attr.data-tone]="x.state === 'active' ? 'safe' : x.state === 'suspended' ? 'destructive' : 'neutral'">{{ x.state }}</span></td>
       <td class="actions-cell"><a class="btn btn-sm" [routerLink]="['/applications', x.appKey]">Manage<span class="sr-only"> {{ x.displayName }}</span></a></td></tr>
     }
    </tbody>
   </table></div>
  </section>
 }

 <section class="card" aria-labelledby="migrations-title">
  <div class="card-head"><h2 class="card-title" id="migrations-title">Fleet image and migrations</h2>
   @if (migrations(); as m) { <span class="card-meta mono" [attr.title]="m.targetImage">Target {{ short(m.targetImage) }}</span> }</div>
  <div class="table-wrap pad-sm"><table class="data">
   <caption class="sr-only">Each instance's image, migrations and readiness for the fleet's target image</caption>
   <thead><tr><th scope="col">Instance</th><th scope="col">State</th><th scope="col">Image</th><th scope="col">Migrations</th><th scope="col">Receipts</th><th scope="col">Ready</th></tr></thead>
   <tbody>
    @for (i of migrations()?.instances ?? []; track i.workspaceKey) {
     <tr>
      <td class="mono">{{ i.workspaceKey }}</td>
      <td>{{ i.state }}</td>
      <td class="mono small" [attr.title]="i.image">{{ short(i.image) }}</td>
      <td>{{ i.appliedMigrations }} applied@if (i.pendingMigrations) { · <strong>{{ i.pendingMigrations }} pending</strong> }</td>
      <td class="mono small">{{ i.receipts.upstream ?? '—' }} / {{ i.receipts.fork ?? '—' }}</td>
      <td><span class="tag" [attr.data-tone]="i.ready ? 'safe' : 'sensitive'">{{ i.ready ? 'Ready' : 'Not ready' }}</span>@if (i.reason) { <div class="muted small">{{ i.reason }}</div> }</td>
     </tr>
    } @empty { <tr><td colspan="6" class="muted">{{ migrationsError() || 'Loading…' }}</td></tr> }
   </tbody>
  </table></div>
 </section>
</div>`,
})
export class ApplicationsPage {
 readonly state = inject(AppState);
 readonly data = signal<Applications | undefined>(undefined);
 readonly migrations = signal<Migrations | undefined>(undefined);
 readonly loading = signal(true);
 readonly error = signal('');
 readonly migrationsError = signal('');
 readonly tone = (l: string) => LIFECYCLE_TONE[l] ?? 'neutral';
 readonly runLabel = (s: string) => RUN_LABEL[s] ?? s;
 readonly short = (image: string) => image.replace(/^sha256:/, '').slice(0, 12);

 constructor() {
  let started = false;
  effect(() => {
   if (started || !this.state.can('app.register')) return;
   started = true;
   untracked(() => {
    api('/api/admin/applications', applicationsResponseSchema).then(d => this.data.set(d)).catch(e => this.error.set(e.message)).finally(() => this.loading.set(false));
    api('/api/admin/fleet/migrations', migrationsResponseSchema).then(m => this.migrations.set(m)).catch(e => this.migrationsError.set(e.message));
   });
  });
 }
}
