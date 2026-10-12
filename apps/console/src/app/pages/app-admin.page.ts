import { Component, computed, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { appAdminSchema, type AppAdmin, type JobView } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { RESOLVE_ELEMENTS, ResolveConfirmDialog } from '../elements';
import { api, AppState, fullTime, send } from '../state';
import { LIFECYCLE_TONE } from './applications.page';

const RUNNING = new Set(['requested', 'preparing', 'migrating', 'reconciling', 'validating', 'activating']);
interface Row { bundle: string; on: boolean; role: 'admin' | 'agent' | 'observer'; teams: string }

/**
 * One application's administration (plan 00 phase 4): lifecycle (suspend/resume with confirmation), team mappings
 * (version-checked; every change re-applies entitlements), entitlement sync, and its privileged job history.
 */
@Component({
 selector: 'rs-app-admin-page',
 imports: [RouterLink, IconComponent, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page">
 <a class="back" routerLink="/applications"><rs-icon name="arrowL" [size]="15" />Applications</a>
 @if (view(); as v) {
  <header class="page-head head-row">
   <div class="grow">
    <p class="eyebrow mono">{{ v.appKey }}</p>
    <h1 class="page-title" tabindex="-1">{{ v.displayName }}</h1>
    <p class="row">
     @if (v.lifecycle) { <span class="tag" [attr.data-tone]="tone(v.lifecycle)">Resolve: {{ v.lifecycle }}</span> } @else { <span class="tag">Managed outside onboarding</span> }
     @if (v.registryState) { <span class="tag" [attr.data-tone]="v.registryState === 'active' ? 'safe' : v.registryState === 'suspended' ? 'destructive' : 'neutral'">Fleet: {{ v.registryState }}</span> }
    </p>
   </div>
   @if (state.can('app.lifecycle')) {
    @if (v.registryState === 'active') { <button class="btn" type="button" (click)="suspendDialog()?.show()" [disabled]="busy() || running()">Suspend…</button> }
    @if (v.registryState === 'suspended') { <button class="btn btn-primary" type="button" (click)="resumeDialog()?.show()" [disabled]="busy() || running()">Resume…</button> }
   }
  </header>
  @if (message()) { <p class="notice" [attr.data-tone]="error() ? 'destructive' : 'safe'" [attr.role]="error() ? 'alert' : 'status'">{{ message() }}</p> }
  @if (state.can('app.lifecycle') && v.registryState === 'active') {
   <label class="filters">Suspension reason
    <select [value]="reason()" (change)="reason.set($any($event.target).value)"><option value="operator">Operator request</option><option value="upgrade_hold">Held back for an upgrade</option><option value="security">Security</option></select>
   </label>
  }

  <section class="card" aria-labelledby="mappings-title">
   <div class="card-head"><h2 class="card-title" id="mappings-title">Team mappings</h2><span class="card-meta">Version {{ v.mappingsVersion }}</span></div>
   <div class="pad">
    <p class="muted small">Each mapped bundle gets this role and these teams for everyone who holds it. Unmapped bundles get no access here. Changes are applied to the instance as versioned entitlements.</p>
    <div class="table-wrap"><table class="data"><caption class="sr-only">Team mappings</caption>
     <thead><tr><th scope="col">Bundle</th><th scope="col">Role</th><th scope="col">Teams (comma separated)</th></tr></thead>
     <tbody>@for (m of rows(); track m.bundle) {
      <tr>
       <td><label class="check"><input type="checkbox" [checked]="m.on" [disabled]="!state.can('roles.manage')" (change)="patch(m.bundle, { on: $any($event.target).checked })">Map {{ m.bundle }}</label></td>
       <td><select [attr.aria-label]="'Role for ' + m.bundle" [value]="m.role" [disabled]="!m.on || !state.can('roles.manage')" (change)="patch(m.bundle, { role: $any($event.target).value })">
        <option value="admin">Admin</option><option value="agent">Agent</option><option value="observer">Observer</option></select></td>
       <td><input class="text-input" [attr.aria-label]="'Teams for ' + m.bundle" [value]="m.teams" [disabled]="!m.on || m.role === 'admin' || !state.can('roles.manage')" (input)="patch(m.bundle, { teams: $any($event.target).value })"></td>
      </tr>
     }</tbody>
    </table></div>
    @if (state.can('roles.manage')) { <div class="row"><button class="btn btn-primary" type="button" (click)="saveMappings()" [disabled]="busy()">Save mappings</button></div> }
   </div>
  </section>

  <section class="card" aria-labelledby="ent-title">
   <div class="card-head"><h2 class="card-title" id="ent-title">Entitlement sync</h2></div>
   <div class="pad">
    <p class="small">{{ v.entitlements.users }} managed people · {{ v.entitlements.applied }} applied · {{ v.entitlements.pending }} pending · {{ v.entitlements.failed }} failed</p>
    @if (v.entitlements.failed && state.can('roles.manage')) { <button class="btn btn-sm" type="button" (click)="retry()" [disabled]="busy()">Retry failed applies</button> }
   </div>
  </section>

  <section class="card" aria-labelledby="jobs-title">
   <div class="card-head"><h2 class="card-title" id="jobs-title">Fleet jobs</h2></div>
   <div class="table-wrap pad-sm"><table class="data"><caption class="sr-only">Privileged jobs for this application, newest first</caption>
    <thead><tr><th scope="col">When</th><th scope="col">Command</th><th scope="col">By</th><th scope="col">Stage</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>@for (j of v.jobs; track j.id) {
     <tr><td class="nowrap"><time [attr.datetime]="j.createdAt">{{ fullTime(j.createdAt) }}</time></td><td>{{ j.command }}</td><td>{{ j.initiator }}</td>
      <td><span class="tag" [attr.data-tone]="stageTone(j)">{{ j.stage }}</span>@if (j.failureCode) { <div class="muted small mono">{{ j.failureCode }}</div> }</td>
      <td>@if ((j.stage === 'retryable_failure' || j.stage === 'needs_operator') && canAct(j)) { <button class="btn btn-sm" type="button" (click)="resume(j)" [disabled]="busy()">Resume<span class="sr-only"> {{ j.command }}</span></button> }</td></tr>
    } @empty { <tr><td colspan="5" class="muted">No jobs yet.</td></tr> }</tbody>
   </table></div>
  </section>
 } @else if (loadError()) {
  <header class="page-head"><h1 class="page-title" tabindex="-1">Application unavailable</h1></header>
  <p class="notice" data-tone="destructive" role="alert">{{ loadError() }}</p>
 } @else { <p role="status" class="muted">Loading…</p> }
 <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>
 <resolve-confirm-dialog #suspendDialogRef tone="destructive" heading="Suspend this instance?"
  description="The fleet stops routing it and ends open connections. Nothing is deleted; mail for it is queued. Agents see it as unavailable until it is resumed."
  confirmLabel="Suspend" cancelLabel="Keep it running" (confirmed)="lifecycle('suspend')"/>
 <resolve-confirm-dialog #resumeDialogRef heading="Resume this instance?" description="Routing resumes on the fleet's current image. An instance held back on an older image must be migrated first."
  confirmLabel="Resume" cancelLabel="Not yet" (confirmed)="lifecycle('resume')"/>
</div>`,
})
export class AppAdminPage {
 readonly appKey = input.required<string>();
 readonly state = inject(AppState);
 readonly view = signal<AppAdmin | undefined>(undefined);
 readonly rows = signal<Row[]>([]);
 readonly loadError = signal('');
 readonly message = signal('');
 readonly error = signal(false);
 readonly busy = signal(false);
 readonly reason = signal<'operator' | 'upgrade_hold' | 'security'>('operator');
 readonly announcement = signal('');
 readonly fullTime = fullTime;
 readonly suspendDialog = viewChild('suspendDialogRef', { read: ResolveConfirmDialog });
 readonly resumeDialog = viewChild('resumeDialogRef', { read: ResolveConfirmDialog });
 readonly running = computed(() => !!this.view()?.jobs.some(j => RUNNING.has(j.stage)));
 private poll?: ReturnType<typeof setInterval>;
 private lastStage = '';

 constructor() {
  effect(() => { const key = this.appKey(); if (this.state.can('app.register')) untracked(() => this.load(key, true)); });
  inject(DestroyRef).onDestroy(() => clearInterval(this.poll));
 }
 tone(l: string) { return LIFECYCLE_TONE[l] ?? 'neutral'; }
 stageTone(j: JobView) { return j.stage === 'succeeded' || j.stage === 'ready_to_activate' ? 'safe' : RUNNING.has(j.stage) ? 'neutral' : 'destructive'; }
 canAct(j: JobView) { return this.state.can(j.command === 'activate' ? 'app.activate' : j.command === 'suspend' || j.command === 'resume' ? 'app.lifecycle' : 'app.provision'); }

 load(key: string, first = false) {
  return api(`/api/admin/apps/${encodeURIComponent(key)}`, appAdminSchema).then(v => {
   this.view.set(v);
   if (first) {
    this.rows.set((['fleet-admin', 'fleet-agent', 'fleet-observer', 'announcement-author'] as const).map(b => {
     const m = v.teamMappings.find(x => x.bundle === b);
     return m ? { bundle: b, on: true, role: m.role, teams: m.teams.join(', ') } : { bundle: b, on: false, role: b === 'fleet-admin' ? 'admin' : b === 'fleet-observer' ? 'observer' : 'agent', teams: '' };
    }));
    setTimeout(() => { if (document.activeElement?.id === 'main') document.querySelector<HTMLElement>('main h1')?.focus(); });
   }
   const latest = v.jobs[0];
   const label = latest ? `${latest.command}:${latest.stage}` : '';
   if (this.lastStage && label !== this.lastStage && latest) this.say(`${latest.command}: ${latest.stage.replace(/_/g, ' ')}.`);
   this.lastStage = label;
   if (this.running() && !this.poll) this.poll = setInterval(() => this.load(this.appKey()), 1000);
   if (!this.running() && this.poll) { clearInterval(this.poll); this.poll = undefined; }
  }).catch(e => this.loadError.set(e.message));
 }
 private say(t: string) { this.announcement.set(''); setTimeout(() => this.announcement.set(t), 50); }
 private result(ok: boolean, text: string) { this.error.set(!ok); this.message.set(text); }
 patch(bundle: string, p: Partial<Row>) { this.rows.update(list => list.map(r => r.bundle === bundle ? { ...r, ...p } : r)); }

 async saveMappings() {
  this.busy.set(true);
  const teamMappings = this.rows().filter(r => r.on).map(r => ({ bundle: r.bundle, role: r.role, teams: r.role === 'admin' ? [] : r.teams.split(',').map(t => t.trim()).filter(Boolean) }));
  const res = await send('PUT', `/api/admin/apps/${encodeURIComponent(this.appKey())}/mappings`, { teamMappings, version: this.view()!.mappingsVersion });
  this.busy.set(false);
  this.result(res.ok, res.ok ? 'Mappings saved. Entitlements are being applied.' : res.error!.message);
  await this.load(this.appKey());
 }
 async retry() {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/apps/${encodeURIComponent(this.appKey())}/entitlements/retry`, {});
  this.busy.set(false);
  this.result(res.ok, res.ok ? 'Failed applies queued again.' : res.error!.message);
  await this.load(this.appKey());
 }
 async lifecycle(cmd: 'suspend' | 'resume') {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/apps/${encodeURIComponent(this.appKey())}/${cmd}`, { requestId: crypto.randomUUID(), ...(cmd === 'suspend' ? { reason: this.reason() } : {}) });
  this.busy.set(false);
  this.result(res.ok, res.ok ? (cmd === 'suspend' ? 'Suspension started.' : 'Resume started.') : res.error!.message);
  await this.load(this.appKey());
 }
 async resume(j: JobView) {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/jobs/${j.id}/resume`, {});
  this.busy.set(false);
  this.result(res.ok, res.ok ? 'Resumed.' : res.error!.message);
  await this.load(this.appKey());
 }
}
