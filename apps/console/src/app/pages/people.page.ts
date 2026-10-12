import { Component, CUSTOM_ELEMENTS_SCHEMA, effect, inject, signal, untracked } from '@angular/core';
import { z } from 'zod';
import { adminUsersResponseSchema, type AdminUser } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { RESOLVE_ELEMENTS } from '../elements';
import { api, AppState, focusField, send } from '../state';

const bundlesSchema = z.object({ bundles: z.array(z.object({
 id: z.string(), groups: z.array(z.string()), claimHolders: z.number(), manualHolders: z.number(),
 capabilities: z.array(z.object({ id: z.string(), summary: z.string(), kind: z.string() })),
})) });
const DISABLED_TEXT: Record<string, string> = { manual: 'Blocked by an administrator', directory: 'Disabled in the directory', directory_absent: 'No longer in the directory' };

/**
 * People and role bundles (plan 02). Bundles come from IdP groups at sign-in, or are granted here by an admin with a
 * reason. Every change is audited and reaches each mapped application as a versioned entitlement. Emergency blocks
 * are independent of the directory.
 */
@Component({
 selector: 'rs-people-page',
 imports: [IconComponent, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">People and roles</h1>
  <p class="lp-lede small-lede">Role bundles decide what someone can do in Resolve; per-app team mappings decide what that means inside each application.</p>
 </header>

 @if (state.can('roles.manage')) {
  <section aria-labelledby="bundles-title">
   <h2 class="section-label" id="bundles-title">Role bundles</h2>
   <div class="app-grid">
    @for (b of bundles(); track b.id) {
     <article class="card pad" [attr.aria-labelledby]="'bundle-' + b.id">
      <h3 class="card-title" [id]="'bundle-' + b.id">{{ b.id }}</h3>
      <p class="muted small">{{ b.claimHolders }} from IdP groups · {{ b.manualHolders }} granted here</p>
      <p class="small">IdP groups: {{ b.groups.join(', ') || 'none' }}</p>
      <details class="small"><summary>{{ b.capabilities.length }} capabilities</summary>
       <ul class="caps">@for (c of b.capabilities; track c.id) { <li><rs-icon name="check" [size]="14" /><span>{{ c.summary }}</span></li> }</ul>
      </details>
     </article>
    }
   </div>
  </section>
 }

 <section class="card" aria-labelledby="people-title">
  <div class="card-head"><h2 class="card-title" id="people-title">People</h2></div>
  <div class="pad">
   <form class="row" (submit)="search($event)" role="search" aria-label="Find people">
    <resolve-text-field name="peopleQuery" label="Name or email" [(value)]="query" autocomplete="off"/>
    <button class="btn" type="submit">Search</button>
   </form>
   @if (message()) { <p class="notice" [attr.data-tone]="error() ? 'destructive' : 'safe'" [attr.role]="error() ? 'alert' : 'status'">{{ message() }}</p> }
   <div class="table-wrap"><table class="data"><caption class="sr-only">People</caption>
    <thead><tr><th scope="col">Person</th><th scope="col">Bundles</th><th scope="col">Access</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>
     @for (u of users(); track u.id) {
      <tr>
       <td>{{ u.displayName }}<div class="muted small">{{ u.email }}</div></td>
       <td><ul class="chips" [attr.aria-label]="'Bundles for ' + u.displayName">@for (b of u.bundles; track b) {
        <li class="chip">{{ b }}@if (u.manualBundles.includes(b)) { <span class="muted"> (granted)</span> }</li> } @empty { <li class="muted small">None</li> }</ul></td>
       <td><span class="tag" [attr.data-tone]="u.enabled ? 'safe' : 'destructive'">{{ u.enabled ? 'Enabled' : disabledText(u.disabledReason) }}</span></td>
       <td><button class="btn btn-sm" type="button" (click)="toggle(u)" [attr.aria-expanded]="open() === u.id" [attr.aria-controls]="'manage-' + u.id">Manage<span class="sr-only"> {{ u.displayName }}</span></button></td>
      </tr>
      @if (open() === u.id) {
       <tr><td colspan="4" [id]="'manage-' + u.id">
        <div class="manage">
         <resolve-text-field name="reason" label="Reason (recorded in the audit)" [required]="true" [(value)]="reason"/>
         @if (state.can('roles.manage')) {
          <div class="row">
           <label class="field-label" [attr.for]="'grant-' + u.id">Grant bundle</label>
           <select [id]="'grant-' + u.id" [value]="grantBundle()" (change)="grantBundle.set($any($event.target).value)">
            @for (b of bundles(); track b.id) { <option [value]="b.id" [disabled]="u.bundles.includes(b.id)">{{ b.id }}</option> }
           </select>
           <button class="btn btn-sm" type="button" (click)="bundle(u, grantBundle(), true)" [disabled]="busy()">Grant</button>
          </div>
          @for (b of u.manualBundles; track b) { <button class="btn btn-sm btn-ghost" type="button" (click)="bundle(u, b, false)" [disabled]="busy()">Remove granted {{ b }}</button> }
         }
         @if (state.can('users.manage')) {
          <div class="row">
           @if (u.enabled) { <button class="btn btn-sm" type="button" (click)="access(u, false)" [disabled]="busy()">Block access</button> }
           @else if (u.disabledReason === 'manual') { <button class="btn btn-sm" type="button" (click)="access(u, true)" [disabled]="busy()">Lift block</button> }
           @else { <span class="muted small">Re-enable this person in the directory.</span> }
          </div>
         }
        </div>
       </td></tr>
      }
     } @empty { <tr><td colspan="4" class="muted">{{ searched() ? 'Nobody matches.' : 'Search for a person.' }}</td></tr> }
    </tbody>
   </table></div>
  </div>
 </section>
</div>`,
})
export class PeoplePage {
 readonly state = inject(AppState);
 readonly bundles = signal<z.infer<typeof bundlesSchema>['bundles']>([]);
 readonly users = signal<AdminUser[]>([]);
 readonly query = signal('');
 readonly reason = signal('');
 readonly grantBundle = signal('fleet-agent');
 readonly open = signal<string | null>(null);
 readonly searched = signal(false);
 readonly message = signal('');
 readonly error = signal(false);
 readonly busy = signal(false);
 readonly disabledText = (r: string | null) => DISABLED_TEXT[r ?? ''] ?? 'Disabled';

 constructor() {
  let started = false;
  effect(() => {
   if (started || !(this.state.can('roles.manage') || this.state.can('users.manage'))) return;
   started = true;
   untracked(() => {
    if (this.state.can('roles.manage')) api('/api/admin/bundles', bundlesSchema).then(b => this.bundles.set(b.bundles)).catch(() => {});
    this.load();
   });
  });
 }
 search(event: Event) { event.preventDefault(); this.load(); }
 load() {
  api('/api/admin/users?q=' + encodeURIComponent(this.query()), adminUsersResponseSchema).then(r => { this.users.set(r.users); this.searched.set(true); })
   .catch(e => { this.error.set(true); this.message.set(e.message); });
 }
 toggle(u: AdminUser) { this.open.set(this.open() === u.id ? null : u.id); this.reason.set(''); this.message.set(''); }
 private needReason() {
  if (this.reason().trim().length >= 5) return false;
  this.error.set(true); this.message.set('Give a reason of at least 5 characters.'); focusField('reason');
  return true;
 }
 async bundle(u: AdminUser, bundle: string, grant: boolean) {
  if (this.needReason()) return;
  this.busy.set(true);
  const res = await send('POST', `/api/admin/users/${u.id}/bundles`, { bundle, grant, reason: this.reason() });
  this.busy.set(false);
  this.error.set(!res.ok);
  this.message.set(res.ok ? `${grant ? 'Granted' : 'Removed'} ${bundle} for ${u.displayName}. Applications are updated through their mappings.` : res.error!.message);
  this.load();
 }
 async access(u: AdminUser, enabled: boolean) {
  if (this.needReason()) return;
  this.busy.set(true);
  const res = await send('POST', `/api/admin/users/${u.id}/access`, { enabled, reason: this.reason() });
  this.busy.set(false);
  this.error.set(!res.ok);
  this.message.set(res.ok ? `${enabled ? 'Lifted the block for' : 'Blocked'} ${u.displayName}.` : res.error!.message);
  this.load();
 }
}
