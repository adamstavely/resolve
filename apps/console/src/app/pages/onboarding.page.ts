import { Component, computed, CUSTOM_ELEMENTS_SCHEMA, DestroyRef, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { z } from 'zod';
import {
 adminUsersResponseSchema, COMMAND_PATHS, onboardingRunSchema, reviewSchema, unboundResponseSchema,
 type JobView, type OnboardingRun, type Review, type WizardStep,
} from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { RESOLVE_ELEMENTS, ResolveConfirmDialog } from '../elements';
import { api, AppState, focusField, fullTime, send } from '../state';
import { RUN_LABEL } from './applications.page';

const runResponse = z.object({ run: onboardingRunSchema });
const dispatchResponse = z.object({ run: onboardingRunSchema, job: z.unknown() });
const optionsSchema = z.object({ supportDomains: z.array(z.string()), bundles: z.array(z.object({ id: z.string(), summary: z.string() })) });
const STEP_TITLES: Record<WizardStep, string> = {
 describe: 'Describe the application', instance: 'Choose the support instance', access: 'Support and access', entry: 'Entry points',
 review: 'Review and provision', validate: 'Validate', activate: 'Activate and hand over',
};
const STEPS = Object.keys(STEP_TITLES) as WizardStep[];
const STAGE_LABEL: Record<string, string> = {
 requested: 'Requested', preparing: 'Preparing', migrating: 'Migrating', reconciling: 'Reconciling', validating: 'Validating', ready_to_activate: 'Validated',
 activating: 'Activating', succeeded: 'Done', retryable_failure: 'Stopped (can resume)', needs_operator: 'Needs an operator', cancelled: 'Cancelled',
};
const RUNNING = new Set(['requested', 'preparing', 'migrating', 'reconciling', 'validating', 'activating']);
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40);

interface Mapping { bundle: string; on: boolean; role: 'admin' | 'agent' | 'observer'; teams: string }

/**
 * Application onboarding wizard (plan 07). Each step saves a server-side draft, so it can be resumed after
 * sign-out or failure. Review fixes the configuration revision that provisioning, validation and activation use.
 * Progress is polled while a job runs, and stage changes are announced politely without moving focus.
 */
@Component({
 selector: 'rs-onboarding-page',
 imports: [RouterLink, IconComponent, ...RESOLVE_ELEMENTS],
 schemas: [CUSTOM_ELEMENTS_SCHEMA],
 template: `
<div class="page">
 <a class="back" routerLink="/applications"><rs-icon name="arrowL" [size]="15" />Applications</a>
 <header class="page-head">
  <p class="eyebrow">Onboarding@if (run(); as r) { · {{ r.environment }} · <span class="tag" [attr.data-tone]="r.status === 'failed' ? 'destructive' : r.status === 'active' ? 'safe' : 'neutral'">{{ runLabel(r.status) }}</span> }</p>
  <h1 class="page-title" tabindex="-1">{{ run()?.applicationName ?? 'Register an application' }}</h1>
 </header>
 @if (loadError()) { <p class="notice" data-tone="destructive" role="alert">{{ loadError() }}</p> }

 <div class="wizard">
  <nav class="card wizard-steps" aria-label="Onboarding steps">
   <ol>
    @for (s of steps; track s; let i = $index) {
     <li>
      <button type="button" class="wstep" [attr.aria-current]="step() === s ? 'step' : null" [disabled]="!reachable(s)" (click)="go(s)">
       <span class="wstep-n" [attr.data-state]="stepState(s)" aria-hidden="true">@if (stepState(s) === 'done') { <rs-icon name="check" [size]="13" /> } @else { {{ i + 1 }} }</span>
       <span class="grow">{{ titles[s] }}<span class="sr-only">, {{ stepState(s) === 'done' ? 'complete' : stepState(s) === 'blocked' ? 'not available yet' : 'to do' }}</span></span>
      </button>
     </li>
    }
   </ol>
   @if (run(); as r) {
    @if (r.blockers.length) {
     <div class="pad-sm"><p class="section-label">Next</p><ul class="blockers">@for (b of r.blockers; track b) { <li>{{ b }}</li> }</ul></div>
    }
    @if (r.status !== 'active' && r.status !== 'cancelled' && state.can('app.register')) {
     <div class="pad-sm"><button class="btn btn-sm btn-ghost" type="button" (click)="cancelDialog()?.show()" [disabled]="busy()">Cancel onboarding…</button></div>
    }
   }
  </nav>

  <section class="card wizard-main" aria-labelledby="step-title">
   <div class="card-head"><h2 class="card-title" id="step-title">{{ titles[step()] }}</h2>@if (saved()) { <span class="card-meta">{{ saved() }}</span> }</div>
   <div class="pad">
    @if (formError(); as e) { <p class="notice" data-tone="destructive" role="alert" id="form-error">{{ e }}
     @if (existingApp()) { <button class="btn btn-sm" type="button" (click)="addEnvironment()">Add the {{ describe().environment }} environment to it</button> } </p> }

    @switch (step()) {
     @case ('describe') {
      <form class="form-stack" (submit)="saveDescribe($event)" novalidate>
       <resolve-text-field name="name" label="Application name" [required]="true" [maxlength]="120" [(value)]="d.name" [error]="fieldError('name')"/>
       <resolve-text-field name="key" label="Application key" [required]="true" [maxlength]="62" [(value)]="d.key" (input)="keyTouched = true"
        hint="Lowercase letters, digits and hyphens. It never changes, even if the application is renamed." [error]="fieldError('key')" [disabled]="locked()"/>
       <resolve-text-field name="description" label="Short description" [maxlength]="500" [(value)]="d.description"/>
       <resolve-text-field name="appUrl" label="Application address" kind="url" [required]="true" [(value)]="d.appUrl"
        hint="The application's own https address. Its support site gets a separate hostname in the next step." [error]="fieldError('appUrl')"/>
       <fieldset class="radio-set" [disabled]="!!run()">
        <legend>Environment</legend>
        <label><input type="radio" name="environment" value="production" [checked]="describe().environment === 'production'" (change)="setEnv('production')">Production</label>
        <label><input type="radio" name="environment" value="test" [checked]="describe().environment === 'test'" (change)="setEnv('test')">Test</label>
       </fieldset>
       <resolve-text-field name="ownerName" label="Accountable owner" [required]="true" [(value)]="d.ownerName" [error]="fieldError('ownerName')"/>
       <resolve-text-field name="ownerEmail" label="Owner's email" kind="email" [required]="true" [(value)]="d.ownerEmail" [error]="fieldError('ownerEmail')"/>
       <resolve-text-field name="supportTeam" label="Support team" [required]="true" [(value)]="d.supportTeam" [error]="fieldError('supportTeam')"/>
       <resolve-text-field name="contact" label="Support contact (optional)" [(value)]="d.contact"/>
       <div class="row"><button class="btn btn-primary" type="submit" [disabled]="busy()">Save and continue</button></div>
      </form>
     }
     @case ('instance') {
      <form class="form-stack" (submit)="saveInstance($event)" novalidate>
       <fieldset class="radio-set">
        <legend>Support instance</legend>
        <label><input type="radio" name="strategy" value="create" [checked]="strategy() === 'create'" (change)="strategy.set('create')">Create a new managed instance</label>
        <label><input type="radio" name="strategy" value="adopt" [checked]="strategy() === 'adopt'" (change)="strategy.set('adopt'); loadUnbound()">Adopt an existing managed instance that is not bound yet</label>
       </fieldset>
       @if (strategy() === 'create') {
        <resolve-text-field name="supportHostname" label="Support hostname" [required]="true" [(value)]="i.supportHostname" [error]="fieldError('supportHostname')"
         [hint]="'Must be under ' + (options()?.supportDomains?.join(' or ') ?? 'an approved support domain') + '. Separate from the application address.'"/>
       } @else {
        <label class="field-label" for="adopt-instance">Unbound instance</label>
        <select id="adopt-instance" name="workspaceKey" [value]="i.workspaceKey()" (change)="i.workspaceKey.set($any($event.target).value)" [attr.aria-describedby]="fieldError('workspaceKey') ? 'adopt-error' : 'adopt-hint'">
         <option value="">Choose an instance</option>
         @for (u of unbound(); track u.workspaceKey) { <option [value]="u.workspaceKey">{{ u.displayName }} ({{ u.workspaceKey }})</option> }
        </select>
        <p class="muted small" id="adopt-hint">Only instances the fleet reports as unbound are listed. Adoption shows what it would change before anything is changed; existing data, sign-in and unmanaged roles stay as they are.</p>
        @if (fieldError('workspaceKey')) { <p class="field-error" id="adopt-error">{{ fieldError('workspaceKey') }}</p> }
       }
       <resolve-text-field name="mailSlug" label="Mail slug" [required]="true" [maxlength]="40" [(value)]="i.mailSlug" hint="Used for the inbound support mailbox." [error]="fieldError('mailSlug')"/>
       <div class="row"><button class="btn btn-primary" type="submit" [disabled]="busy() || locked()">Save and continue</button>
        @if (locked()) { <span class="muted small">Locked after provisioning.</span> }</div>
      </form>
     }
     @case ('access') {
      <form class="form-stack" (submit)="saveAccess($event)" novalidate>
       <p class="muted small">Map each Resolve role bundle to the role and teams it gets in this instance. A bundle without a mapping gets no access here; people outside Resolve's management are not changed.</p>
       <div class="table-wrap"><table class="data">
        <caption class="sr-only">Team mappings</caption>
        <thead><tr><th scope="col">Bundle</th><th scope="col">Role in this instance</th><th scope="col">Teams (comma separated)</th></tr></thead>
        <tbody>
         @for (m of mappings(); track m.bundle) {
          <tr>
           <td><label class="check"><input type="checkbox" [checked]="m.on" (change)="patchMapping(m.bundle, { on: $any($event.target).checked })">Map {{ m.bundle }}</label>
            <div class="muted small">{{ bundleSummary(m.bundle) }}</div></td>
           <td><select [attr.aria-label]="'Role for ' + m.bundle" [value]="m.role" [disabled]="!m.on" (change)="patchMapping(m.bundle, { role: $any($event.target).value })">
            <option value="admin">Admin</option><option value="agent">Agent</option><option value="observer">Observer</option></select></td>
           <td><input class="text-input" [attr.aria-label]="'Teams for ' + m.bundle" [value]="m.teams" [disabled]="!m.on || m.role === 'admin'" placeholder="support, billing"
            (input)="patchMapping(m.bundle, { teams: $any($event.target).value })"></td>
          </tr>
         }
        </tbody>
       </table></div>
       @if (fieldError('teamMappings')) { <p class="field-error">{{ fieldError('teamMappings') }}</p> }
       <fieldset class="pilot-set" name="pilotUserIds" tabindex="-1">
        <legend>Pilots</legend>
        <p class="muted small">Named people who check the instance before it opens: they sign in, read and add a note as themselves. Nothing is simulated.</p>
        <ul class="chips" aria-label="Chosen pilots">
         @for (p of pilots(); track p.id) { <li class="chip">{{ p.name }} <button class="btn-x" type="button" (click)="removePilot(p.id)" [attr.aria-label]="'Remove ' + p.name">×</button></li> }
         @empty { <li class="muted small">No pilots yet.</li> }
        </ul>
        <div class="row">
         <resolve-text-field name="pilotSearch" label="Find a person" [(value)]="pilotQuery" autocomplete="off"/>
         <button class="btn btn-sm" type="button" (click)="searchPeople()">Search</button>
        </div>
        @if (people().length) {
         <ul class="result-list" aria-label="Search results">
          @for (u of people(); track u.id) { <li><span>{{ u.displayName }} <span class="muted small">{{ u.email }} · {{ u.bundles.join(', ') || 'no bundles' }}</span></span>
           <button class="btn btn-sm" type="button" (click)="addPilot(u.id, u.displayName)" [disabled]="!u.enabled || hasPilot(u.id)">Add<span class="sr-only"> {{ u.displayName }} as a pilot</span></button></li> }
         </ul>
        }
        @if (fieldError('pilotUserIds')) { <p class="field-error">{{ fieldError('pilotUserIds') }}</p> }
       </fieldset>
       <div class="row"><button class="btn btn-primary" type="submit" [disabled]="busy()">Save and continue</button></div>
      </form>
     }
     @case ('entry') {
      <form class="form-stack" (submit)="saveEntry($event)" novalidate>
       <p class="muted small">Chat, SSO sign-in and inbound email must pass validation before activation. The banner snippet is optional.</p>
       <resolve-text-field name="emailAddress" label="Inbound support address" kind="email" [required]="true" [(value)]="e.emailAddress" [error]="fieldError('emailAddress')"/>
       <resolve-text-field name="emailOwner" label="Mailbox owner" [required]="true" [(value)]="e.emailOwner" [error]="fieldError('emailOwner')"/>
       <label class="check"><input type="checkbox" name="banner" [checked]="e.banner()" (change)="e.banner.set($any($event.target).checked)">Generate the Everyone banner snippet for the application's team to install</label>
       <div class="row"><button class="btn btn-primary" type="submit" [disabled]="busy()">Save and continue</button></div>
      </form>
     }
     @case ('review') {
      @if (review(); as rv) {
       <div class="review">
        <dl class="facts">
         <div><dt>Application</dt><dd>{{ run()?.steps?.describe?.name }} · {{ run()?.environment }}</dd></div>
         <div><dt>Instance</dt><dd>{{ run()?.steps?.instance?.strategy === 'adopt' ? 'Adopt ' + rv.impact?.displayName : 'Create a new managed instance' }} · <span class="mono">{{ rv.supportOrigin }}</span></dd></div>
         <div><dt>Owner</dt><dd>{{ run()?.steps?.describe?.ownerName }} · {{ run()?.steps?.describe?.supportTeam }}</dd></div>
         <div><dt>Inbound email</dt><dd>{{ run()?.steps?.entry?.emailAddress }}</dd></div>
         <div><dt>Revision</dt><dd class="mono small">{{ rv.configRevision.slice(0, 16) }}</dd></div>
        </dl>
        <h3 class="sub-title">Who gets what</h3>
        <div class="table-wrap"><table class="data"><caption class="sr-only">Grants by bundle</caption>
         <thead><tr><th scope="col">Bundle</th><th scope="col">Role</th><th scope="col">Teams</th><th scope="col">People now</th></tr></thead>
         <tbody>@for (g of rv.grants; track g.bundle) { <tr><td>{{ g.bundle }}</td><td>{{ g.role }}</td><td>{{ g.teams.join(', ') || '—' }}</td><td>{{ g.people }}</td></tr> }</tbody>
        </table></div>
        @if (rv.unmappedBundles.length) { <p class="muted small">Not mapped (no access here): {{ rv.unmappedBundles.join(', ') }}.</p> }
        <h3 class="sub-title">Central defaults</h3>
        <ul class="caps">@for (x of rv.defaults; track x.setting) { <li><rs-icon name="check" [size]="14" /><span>{{ x.setting }}: {{ x.value }} <span class="muted">({{ x.source }})</span></span></li> }</ul>
        @if (rv.impact; as im) {
         <h3 class="sub-title">Adoption impact</h3>
         <p class="small">{{ im.displayName }} has {{ im.data.conversations }} conversations, {{ im.data.tickets }} tickets and {{ im.data.people }} people. No data is moved or deleted.</p>
         <div class="table-wrap"><table class="data"><caption>Settings</caption>
          <thead><tr><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">After adoption</th><th scope="col">Central default</th></tr></thead>
          <tbody>@for (s of im.settings; track s.key) {
           <tr><td>{{ s.label }}</td><td>{{ s.current }}</td><td>{{ s.afterAdoption }}@if (s.changes) { <span class="tag" data-tone="sensitive">changes</span> }</td>
            <td>{{ s.centralDefault ?? '—' }}@if (s.centralDefault && s.centralDefault !== s.current) { <span class="tag" data-tone="sensitive">differs</span> }</td></tr>
          }</tbody>
         </table></div>
         <div class="table-wrap"><table class="data"><caption>People</caption>
          <thead><tr><th scope="col">Person</th><th scope="col">Role now</th><th scope="col">After adoption</th></tr></thead>
          <tbody>@for (p of im.people; track p.name) { <tr><td>{{ p.name }}</td><td>{{ p.role }}</td><td>{{ p.managedAfter ? 'Managed by Resolve (role from the mappings)' : 'Unchanged' }}</td></tr> }</tbody>
         </table></div>
        }
        <div class="row">
         @if (state.can('app.provision')) {
          <button class="btn btn-primary" type="button" (click)="provisionDialog()?.show()" [disabled]="busy() || jobRunning()">{{ run()?.steps?.instance?.strategy === 'adopt' ? 'Adopt and provision…' : 'Provision…' }}</button>
         } @else { <p class="muted small">Someone with provisioning access must dispatch this revision.</p> }
         <button class="btn" type="button" (click)="doReview()" [disabled]="busy()">Review again</button>
        </div>
       </div>
      } @else {
       <p class="small">Review builds the exact configuration that provisioning sends. Any later change needs a new review and validation.</p>
       <div class="row"><button class="btn btn-primary" type="button" (click)="doReview()" [disabled]="busy()">Review configuration</button></div>
      }
     }
     @case ('validate') {
      @if (validation(); as v) {
       <div class="job">
        <p class="small">{{ v.command === 'provision' ? 'Provisioning' : 'Validation' }} · started by {{ v.initiator }} · <time [attr.datetime]="v.createdAt">{{ fullTime(v.createdAt) }}</time>
         @if (v.configRevision !== run()?.configRevision) { · <span class="tag" data-tone="sensitive">older configuration</span> }</p>
        <ol class="stages" aria-label="Stages">
         @for (st of path(v); track st) { <li [attr.data-state]="stageState(v, st)">{{ stageLabel(st) }}<span class="sr-only">, {{ stageState(v, st) }}</span></li> }
        </ol>
        @if (v.failureCode) { <p class="notice" data-tone="destructive" role="alert">Stopped at {{ stageLabel(v.stage) }}: {{ v.failureCode }}</p> }
        @if (v.checks.length) {
         <div class="table-wrap"><table class="data"><caption class="sr-only">Validation checks</caption>
          <thead><tr><th scope="col">Check</th><th scope="col">Result</th></tr></thead>
          <tbody>@for (c of v.checks; track c.id) {
           <tr><td>{{ c.label }}@if (!c.required) { <span class="muted small"> (optional)</span> }@if (c.detail) { <div class="muted small">{{ c.detail }}</div> }</td>
            <td><span class="tag" [attr.data-tone]="c.status === 'passed' ? 'safe' : c.status === 'failed' ? 'destructive' : 'neutral'">{{ c.status }}</span></td></tr>
          }</tbody>
         </table></div>
        }
        <div class="row">
         @if ((v.stage === 'retryable_failure' || v.stage === 'needs_operator') && state.can('app.provision')) {
          <button class="btn" type="button" (click)="resumeJob(v)" [disabled]="busy()">Resume from {{ stageLabel(stageOfFailure(v)) }}</button>
         }
         @if (!jobRunning() && state.can('app.provision') && v.configRevision === run()?.configRevision) {
          <button class="btn" type="button" (click)="doValidate()" [disabled]="busy()">Validate again</button>
         }
         @if (jobRunning() && state.can('app.provision')) { <button class="btn btn-ghost" type="button" (click)="cancelJob(v)" [disabled]="busy()">Cancel job</button> }
        </div>
        <h3 class="sub-title">Pilot check</h3>
        @for (p of run()?.pilot ?? []; track p.at) {
         <p class="small"><span class="tag" [attr.data-tone]="p.passed ? 'safe' : 'destructive'">{{ p.passed ? 'passed' : 'failed' }}</span> {{ p.displayName }} · <time [attr.datetime]="p.at">{{ fullTime(p.at) }}</time>
          @if (p.configRevision !== run()?.configRevision) { <span class="muted"> · older configuration</span> }</p>
        } @empty { <p class="muted small">No pilot has run the check yet.</p> }
        @if (isPilot()) { <a class="btn btn-sm" [routerLink]="['/onboarding', run()!.id, 'pilot']">Run the pilot check yourself</a> }
       </div>
      } @else { <p class="muted small">Provision the instance first.</p> }
     }
     @case ('activate') {
      @if (run()?.status === 'active') {
       <div class="handover">
        <p class="notice" data-tone="safe">Active. Normal routing is on for the tested configuration.</p>
        <dl class="facts">
         <div><dt>Support site</dt><dd class="mono">{{ supportUrl() }}</dd></div>
         <div><dt>Channels</dt><dd>Chat · SSO · inbound email ({{ run()?.steps?.entry?.emailAddress }})@if (run()?.steps?.entry?.banner) { · banner }</dd></div>
         <div><dt>Owners</dt><dd>{{ run()?.steps?.describe?.ownerName }} · {{ run()?.steps?.describe?.supportTeam }}</dd></div>
        </dl>
        @if (run()?.steps?.entry?.banner) {
         <h3 class="sub-title">Banner snippet</h3>
         <p class="muted small">For the application's team to install; it only works with this instance.</p>
         <pre class="snippet" tabindex="0" aria-label="Banner snippet">{{ snippet() }}</pre>
         <div class="row"><button class="btn btn-sm" type="button" (click)="copySnippet()">Copy snippet</button></div>
        }
        <p class="small">The instance is ready, but each agent still connects it for themselves on Home; provisioning gives nobody a token.</p>
        <div class="row"><a class="btn" [routerLink]="['/applications', run()!.workspaceKey]">Manage {{ run()?.applicationName }}</a></div>
       </div>
      } @else {
       <ul class="caps">
        <li><rs-icon [name]="validated() ? 'check' : 'alert'" [size]="14" /><span>Validation passed for the current configuration and image</span></li>
        <li><rs-icon [name]="pilotPassed() ? 'check' : 'alert'" [size]="14" /><span>A pilot passed the pilot check for this configuration</span></li>
       </ul>
       @if (activation(); as a) {
        <p class="small">Activation: <span class="tag" [attr.data-tone]="a.stage === 'succeeded' ? 'safe' : a.failureCode ? 'destructive' : 'neutral'">{{ stageLabel(a.stage) }}</span>@if (a.failureCode) { {{ a.failureCode }} }</p>
       }
       <div class="row">
        @if (state.can('app.activate')) {
         <button class="btn btn-primary" type="button" (click)="activateDialog()?.show()" [disabled]="busy() || !validated() || !pilotPassed() || jobRunning()">Activate…</button>
        } @else { <p class="muted small">Someone with activation access must activate.</p> }
       </div>
      }
     }
    }
   </div>
  </section>
 </div>
 <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>
 <resolve-confirm-dialog #provisionDialogRef [heading]="run()?.steps?.instance?.strategy === 'adopt' ? 'Adopt this instance?' : 'Create the support instance?'"
  [description]="'The fleet worker applies exactly the reviewed configuration (revision ' + (run()?.configRevision?.slice(0, 12) ?? '') + '). The instance stays closed to normal traffic until it is validated and activated.'"
  confirmLabel="Dispatch" cancelLabel="Not yet" (confirmed)="doProvision()"/>
 <resolve-confirm-dialog #activateDialogRef heading="Activate for normal routing?"
  description="People and agents can reach the instance once it is active. Activation applies only to the validated configuration and image."
  confirmLabel="Activate" cancelLabel="Not yet" (confirmed)="doActivate()"/>
 <resolve-confirm-dialog #cancelDialogRef tone="destructive" heading="Cancel this onboarding?"
  description="Nothing more is dispatched. Anything already created is kept and listed, never deleted automatically."
  confirmLabel="Cancel onboarding" cancelLabel="Keep going" (confirmed)="doCancel()"/>
</div>`,
})
export class OnboardingPage {
 readonly runId = input<string>();
 readonly state = inject(AppState);
 private readonly router = inject(Router);
 readonly steps = STEPS;
 readonly titles = STEP_TITLES;
 readonly fullTime = fullTime;
 readonly run = signal<OnboardingRun | undefined>(undefined);
 readonly step = signal<WizardStep>('describe');
 readonly options = signal<z.infer<typeof optionsSchema> | undefined>(undefined);
 readonly review = signal<Review | undefined>(undefined);
 readonly busy = signal(false);
 readonly saved = signal('');
 readonly loadError = signal('');
 readonly formError = signal('');
 readonly errorField = signal('');
 readonly existingApp = signal('');
 readonly announcement = signal('');
 readonly unbound = signal<{ workspaceKey: string; displayName: string }[]>([]);
 readonly people = signal<z.infer<typeof adminUsersResponseSchema>['users']>([]);
 readonly pilots = signal<{ id: string; name: string }[]>([]);
 readonly mappings = signal<Mapping[]>([]);
 readonly strategy = signal<'create' | 'adopt'>('create');
 readonly provisionDialog = viewChild('provisionDialogRef', { read: ResolveConfirmDialog });
 readonly activateDialog = viewChild('activateDialogRef', { read: ResolveConfirmDialog });
 readonly cancelDialog = viewChild('cancelDialogRef', { read: ResolveConfirmDialog });
 pilotQuery = signal('');
 keyTouched = false;
 /** One request id per dispatch intent, so a double click or retry is the same job. */
 private requestIds = new Map<string, string>();
 private poll?: ReturnType<typeof setInterval>;
 private lastStage = '';

 // Step models
 readonly d = { name: signal(''), key: signal(''), description: signal(''), appUrl: signal(''), ownerName: signal(''), ownerEmail: signal(''), supportTeam: signal(''), contact: signal('') };
 readonly describe = signal<{ environment: 'production' | 'test' }>({ environment: 'production' });
 readonly i = { supportHostname: signal(''), workspaceKey: signal(''), mailSlug: signal('') };
 readonly e = { emailAddress: signal(''), emailOwner: signal(''), banner: signal(false) };

 readonly locked = computed(() => !!this.run()?.jobs.some(j => j.command === 'provision' && j.dispatched));
 readonly validation = computed(() => this.run()?.jobs.find(j => j.command === 'provision' || j.command === 'validate'));
 readonly activation = computed(() => this.run()?.jobs.find(j => j.command === 'activate'));
 readonly jobRunning = computed(() => !!this.run()?.jobs.some(j => RUNNING.has(j.stage)));
 readonly validated = computed(() => { const v = this.validation(); return !!v && v.stage === 'ready_to_activate' && v.configRevision === this.run()?.configRevision; });
 readonly pilotPassed = computed(() => !!this.run()?.pilot.some(p => p.passed && p.configRevision === this.run()?.configRevision));
 readonly isPilot = computed(() => !!this.run()?.steps.access?.pilotUserIds.includes(this.myId()));
 readonly supportUrl = computed(() => { const s = this.run()?.steps.instance; return s?.strategy === 'create' ? `https://${s.supportHostname}` : this.run()?.workspaceKey ?? ''; });
 readonly snippet = computed(() => `<script src="${this.supportUrl()}/widget/banner.js" data-audience="everyone" defer></script>`);

 constructor() {
  effect(() => {
   const id = this.runId();
   if (!this.state.can('app.register')) return;
   untracked(() => {
    api('/api/admin/onboarding-options', optionsSchema).then(o => { this.options.set(o); if (!this.mappings().length) this.initMappings(); }).catch(() => {});
    if (id) this.load(id, true); else this.focusHeading();
   });
  });
  // Suggest a key from the name until the person edits the key themselves.
  effect(() => { const name = this.d.name(); untracked(() => { if (!this.keyTouched && !this.run()) this.d.key.set(slug(name)); }); });
  inject(DestroyRef).onDestroy(() => clearInterval(this.poll));
 }

 runLabel(s: string) { return RUN_LABEL[s] ?? s; }
 stageLabel(s: string) { return STAGE_LABEL[s] ?? s; }
 path(j: JobView) { return COMMAND_PATHS[j.command].slice(1); }
 stageOfFailure(j: JobView) { return j.failedStage ?? this.path(j)[0]; }
 stageState(j: JobView, st: JobView['stage']): 'done' | 'current' | 'failed' | 'pending' {
  const p = this.path(j);
  if (p.includes(j.stage)) return st === j.stage ? (RUNNING.has(st) ? 'current' : 'done') : p.indexOf(st) < p.indexOf(j.stage) ? 'done' : 'pending';
  // Failed or cancelled: stages before the failed one are done.
  const at = p.indexOf(j.failedStage ?? p[0]);
  return p.indexOf(st) < at ? 'done' : p.indexOf(st) === at ? 'failed' : 'pending';
 }
 bundleSummary(b: string) { return this.options()?.bundles.find(x => x.id === b)?.summary ?? ''; }
 fieldError(field: string) { return this.errorField() === field ? this.formError() : ''; }

 stepState(s: WizardStep): 'done' | 'todo' | 'blocked' {
  const r = this.run();
  if (!r) return s === 'describe' ? 'todo' : 'blocked';
  const filled = { describe: !!r.steps.describe, instance: !!r.steps.instance, access: !!r.steps.access, entry: !!r.steps.entry };
  if (s in filled) return filled[s as keyof typeof filled] ? 'done' : 'todo';
  if (s === 'review') return r.configRevision ? 'done' : Object.values(filled).every(Boolean) ? 'todo' : 'blocked';
  if (s === 'validate') return this.validated() && this.pilotPassed() ? 'done' : this.validation() ? 'todo' : 'blocked';
  return r.status === 'active' ? 'done' : this.validation() ? 'todo' : 'blocked';
 }
 reachable(s: WizardStep) { return this.stepState(s) !== 'blocked'; }

 go(s: WizardStep) {
  this.step.set(s); this.formError.set(''); this.errorField.set(''); this.existingApp.set(''); this.saved.set('');
  if (s === 'instance' && this.strategy() === 'adopt') this.loadUnbound();
  setTimeout(() => document.getElementById('step-title')?.focus());
 }

 private focusHeading() { setTimeout(() => { if (document.activeElement?.id === 'main') document.querySelector<HTMLElement>('main h1')?.focus(); }); }

 load(id: string, first = false) {
  return api(`/api/admin/onboarding/${encodeURIComponent(id)}`, runResponse).then(r => {
   this.run.set(r.run);
   if (first) { this.fill(r.run); this.step.set(this.firstOpenStep(r.run)); this.focusHeading(); }
   this.trackJobs(r.run);
  }).catch(e => this.loadError.set(e.message));
 }

 private firstOpenStep(r: OnboardingRun): WizardStep {
  if (r.status === 'active') return 'activate';
  for (const s of ['describe', 'instance', 'access', 'entry'] as const) if (!r.steps[s]) return s;
  if (!r.configRevision && !r.jobs.length) return 'review';
  if (this.validatedFor(r) && r.pilot.some(p => p.passed && p.configRevision === r.configRevision)) return 'activate';
  return r.jobs.length ? 'validate' : 'review';
 }
 private validatedFor(r: OnboardingRun) { const v = r.jobs.find(j => j.command === 'provision' || j.command === 'validate'); return !!v && v.stage === 'ready_to_activate' && v.configRevision === r.configRevision; }

 /** Poll while a job runs; announce stage changes politely (never moving focus). */
 private trackJobs(r: OnboardingRun) {
  const latest = r.jobs[0];
  const label = latest ? `${latest.command} ${latest.stage}` : '';
  if (latest && label !== this.lastStage) {
   if (this.lastStage) this.announce(`${latest.command === 'provision' ? 'Provisioning' : latest.command === 'validate' ? 'Validation' : latest.command === 'activate' ? 'Activation' : 'Job'}: ${this.stageLabel(latest.stage)}.`);
   this.lastStage = label;
  }
  const running = r.jobs.some(j => RUNNING.has(j.stage));
  if (running && !this.poll) this.poll = setInterval(() => this.load(r.id), 1000);
  if (!running && this.poll) { clearInterval(this.poll); this.poll = undefined; }
 }
 private announce(text: string) { this.announcement.set(''); setTimeout(() => this.announcement.set(text), 50); }

 private fill(r: OnboardingRun) {
  const s = r.steps;
  this.describe.set({ environment: r.environment });
  if (s.describe) { for (const k of Object.keys(this.d) as (keyof typeof this.d)[]) this.d[k].set(s.describe[k] ?? ''); this.keyTouched = true; }
  if (s.instance) {
   this.strategy.set(s.instance.strategy); this.i.mailSlug.set(s.instance.mailSlug);
   if (s.instance.strategy === 'create') this.i.supportHostname.set(s.instance.supportHostname); else { this.i.workspaceKey.set(s.instance.workspaceKey); this.loadUnbound(); }
  } else if (s.describe) {
   const base = r.environment === 'production' ? s.describe.key : `${s.describe.key}-test`;
   this.i.mailSlug.set(base);
   const domain = this.options()?.supportDomains[r.environment === 'test' ? 1 : 0] ?? this.options()?.supportDomains[0];
   if (domain) this.i.supportHostname.set(`${s.describe.key}.${domain}`);
  }
  if (s.access) {
   this.initMappings(s.access.teamMappings);
   this.pilots.set(s.access.pilotUserIds.map(id => ({ id, name: id === this.myId() ? 'You' : 'Pilot' })));
   this.resolvePilotNames(s.access.pilotUserIds);
  }
  if (s.entry) { this.e.emailAddress.set(s.entry.emailAddress); this.e.emailOwner.set(s.entry.emailOwner); this.e.banner.set(s.entry.banner); }
 }
 private myId() { const s = this.state.session(); return s?.authenticated ? s.user.id : ''; }
 private resolvePilotNames(ids: string[]) {
  api('/api/admin/users?q=', adminUsersResponseSchema).then(r => this.pilots.set(ids.map(id => ({ id, name: r.users.find(u => u.id === id)?.displayName ?? 'Unknown person' })))).catch(() => {});
 }
 initMappings(existing: { bundle: string; role: 'admin' | 'agent' | 'observer'; teams: string[] }[] = []) {
  const bundles = this.options()?.bundles.map(b => b.id) ?? existing.map(m => m.bundle);
  this.mappings.set(bundles.map(b => {
   const m = existing.find(x => x.bundle === b);
   return m ? { bundle: b, on: true, role: m.role, teams: m.teams.join(', ') } : { bundle: b, on: false, role: b === 'fleet-admin' ? 'admin' : b === 'fleet-observer' ? 'observer' : 'agent', teams: '' };
  }));
 }
 patchMapping(bundle: string, p: Partial<Mapping>) { this.mappings.update(list => list.map(m => m.bundle === bundle ? { ...m, ...p } : m)); }

 setEnv(env: 'production' | 'test') { this.describe.set({ environment: env }); }

 private fail(err: { message: string; field?: string; code: string; applicationId?: string } | undefined) {
  this.formError.set(err?.message ?? 'Something went wrong.');
  this.errorField.set(err?.field ?? '');
  this.existingApp.set(err?.code === 'APP_EXISTS' && err.applicationId ? err.applicationId : '');
  if (err?.field) focusField(err.field); else setTimeout(() => document.getElementById('form-error')?.focus());
 }
 private ok(text: string) { this.formError.set(''); this.errorField.set(''); this.saved.set(text); this.announce(text); }

 private describeBody() {
  return { name: this.d.name(), key: this.d.key(), description: this.d.description(), appUrl: this.d.appUrl(), environment: this.describe().environment,
   ownerName: this.d.ownerName(), ownerEmail: this.d.ownerEmail(), supportTeam: this.d.supportTeam(), contact: this.d.contact() };
 }
 async saveDescribe(event: Event, applicationId?: string) {
  event.preventDefault();
  this.busy.set(true);
  const r = this.run();
  if (!r) {
   const res = await send('POST', '/api/admin/onboarding', { describe: this.describeBody(), ...(applicationId ? { applicationId } : {}) }, z.object({ runId: z.string() }));
   this.busy.set(false);
   if (!res.ok) return this.fail(res.error as never);
   await this.router.navigate(['/applications/onboarding', res.data!.runId], { replaceUrl: true });
   return;
  }
  await this.saveStep('describe', this.describeBody(), 'instance');
 }
 addEnvironment() { void this.saveDescribe(new Event('submit'), this.existingApp()); }

 private async saveStep(step: string, data: unknown, next: WizardStep) {
  this.busy.set(true);
  const res = await send('PUT', `/api/admin/onboarding/${this.run()!.id}/steps/${step}`, { data, version: this.run()!.version }, runResponse);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error as never);
  this.run.set(res.data!.run);
  this.review.set(undefined);
  if (step === 'describe') this.fill({ ...res.data!.run, steps: { ...res.data!.run.steps, instance: res.data!.run.steps.instance } });
  this.ok('Saved.');
  this.go(next);
  this.saved.set('Saved');
 }
 saveInstance(event: Event) {
  event.preventDefault();
  const data = this.strategy() === 'create' ? { strategy: 'create', supportHostname: this.i.supportHostname(), mailSlug: this.i.mailSlug() }
   : { strategy: 'adopt', workspaceKey: this.i.workspaceKey(), mailSlug: this.i.mailSlug() };
  return this.saveStep('instance', data, 'access');
 }
 saveAccess(event: Event) {
  event.preventDefault();
  const teamMappings = this.mappings().filter(m => m.on).map(m => ({ bundle: m.bundle, role: m.role, teams: m.role === 'admin' ? [] : m.teams.split(',').map(t => t.trim()).filter(Boolean) }));
  if (!this.e.emailOwner() && this.run()?.steps.describe) this.e.emailOwner.set(this.run()!.steps.describe!.supportTeam);
  return this.saveStep('access', { teamMappings, pilotUserIds: this.pilots().map(p => p.id) }, 'entry');
 }
 saveEntry(event: Event) {
  event.preventDefault();
  return this.saveStep('entry', { emailAddress: this.e.emailAddress(), emailOwner: this.e.emailOwner(), banner: this.e.banner() }, 'review');
 }

 loadUnbound() { api('/api/admin/fleet/unbound', unboundResponseSchema).then(r => this.unbound.set(r.instances)).catch(e => this.fail({ code: 'ERROR', message: e.message })); }
 searchPeople() { api('/api/admin/users?q=' + encodeURIComponent(this.pilotQuery()), adminUsersResponseSchema).then(r => this.people.set(r.users)).catch(e => this.fail({ code: 'ERROR', message: e.message })); }
 hasPilot(id: string) { return this.pilots().some(p => p.id === id); }
 addPilot(id: string, name: string) { if (!this.hasPilot(id)) { this.pilots.update(p => [...p, { id, name }]); this.announce(`${name} added as a pilot.`); } }
 removePilot(id: string) { const p = this.pilots().find(x => x.id === id); this.pilots.update(list => list.filter(x => x.id !== id)); if (p) this.announce(`${p.name} removed.`); }

 async doReview() {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/onboarding/${this.run()!.id}/review`, {}, reviewSchema);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error as never);
  this.review.set(res.data!);
  this.run.set(res.data!.run);
  this.ok('Configuration reviewed.');
 }
 private requestId(kind: string) {
  const key = `${kind}:${this.run()?.configRevision}`;
  if (!this.requestIds.has(key)) this.requestIds.set(key, crypto.randomUUID());
  return this.requestIds.get(key)!;
 }
 private async dispatchJob(kind: 'provision' | 'validate' | 'activate', extra: Record<string, string> = {}) {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/onboarding/${this.run()!.id}/${kind}`, { configRevision: this.run()!.configRevision, requestId: this.requestId(kind), ...extra }, dispatchResponse);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error as never);
  // A new attempt (e.g. after a failure) needs a new request id.
  this.requestIds.delete(`${kind}:${this.run()?.configRevision}`);
  this.run.set(res.data!.run);
  this.trackJobs(res.data!.run);
  this.ok(kind === 'provision' ? 'Provisioning started.' : kind === 'validate' ? 'Validation started.' : 'Activation started.');
  this.go(kind === 'activate' ? 'activate' : 'validate');
 }
 doProvision() { return this.dispatchJob('provision'); }
 doValidate() { return this.dispatchJob('validate'); }
 doActivate() { return this.dispatchJob('activate', { validationJobId: this.validation()!.id }); }
 async resumeJob(j: JobView) {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/jobs/${j.id}/resume`, {});
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error as never);
  this.ok('Resumed.');
  await this.load(this.run()!.id);
 }
 async cancelJob(j: JobView) {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/jobs/${j.id}/cancel`, {});
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error as never);
  this.ok('Job cancelled.');
  await this.load(this.run()!.id);
 }
 async doCancel() {
  this.busy.set(true);
  const res = await send('POST', `/api/admin/onboarding/${this.run()!.id}/cancel`, {}, runResponse);
  this.busy.set(false);
  if (!res.ok) return this.fail(res.error as never);
  this.run.set(res.data!.run);
  this.ok('Onboarding cancelled.');
 }
 async copySnippet() {
  try { await navigator.clipboard.writeText(this.snippet()); this.announce('Snippet copied.'); } catch { this.announce('Copy failed. Select the snippet and copy it.'); }
 }
}
