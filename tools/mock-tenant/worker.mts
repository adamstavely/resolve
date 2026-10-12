/*
 * Mock privileged fleet worker (contract 4, plans 03 and 07). It owns instance creation, migration, reconciliation,
 * validation, activation, suspension and per-person entitlement apply. Resolve sends allowlisted commands only.
 * The worker validates each request again, is idempotent per request id, holds a per-app lock for lifecycle
 * commands, and runs the stages asynchronously so a crash or an injected fault at any stage can be resumed.
 * Development only. Secrets (tenant IdP client, database) are generated here and never returned.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalJson, COMMAND_PATHS, jobRequestSchema, type JobCheck, type JobRequest, type JobStage, type JobStatus } from '../../packages/contracts/src/index';
import { sha, startTenant, type FleetContext, type Tenant, type TenantConfig } from './tenant.mjs';

const STEP_MS = Number(process.env.MOCK_WORKER_STEP_MS ?? 150);
const LIFECYCLE = new Set(['provision', 'validate', 'activate', 'suspend', 'resume']);

interface Job {
 status: JobStatus; request: JobRequest; payloadHash: string;
 /** Stage to continue from after a failure. */
 resumeAt: JobStage | null;
 running: boolean;
}
export type Fault = { appKey: string; stage?: JobStage; check?: string; mode: 'retryable' | 'operator' };

export class FleetWorker {
 private jobs = new Map<string, Job>();
 private byRequest = new Map<string, string>();
 private lastVersion = new Map<string, number>();
 private faults: Fault[] = [];
 private nextPort = 3310;
 targetImage: string;

 constructor(readonly fleet: Map<string, Tenant>, private readonly ctx: FleetContext, private readonly idpAdminToken: string, image: string) {
  this.targetImage = image;
 }

 // ── Commands ──

 submit(raw: unknown): { status: number; body: unknown } {
  const parsed = jobRequestSchema.safeParse(raw);
  // The worker validates again: no DSN, secret, image or environment override can get through.
  if (!parsed.success) return { status: 400, body: { error: 'INVALID_COMMAND', issue: parsed.error.issues[0]?.path.join('.') } };
  const request = parsed.data;
  const payloadHash = sha(canonicalJson(request));
  const existing = this.byRequest.get(request.requestId);
  if (existing) {
   const job = this.jobs.get(existing)!;
   // Idempotent: the same request returns the same job; a changed payload under the same id is refused.
   return job.payloadHash === payloadHash ? { status: 200, body: job.status } : { status: 409, body: { error: 'REQUEST_CONFLICT' } };
  }
  if (LIFECYCLE.has(request.command)) {
   const busy = [...this.jobs.values()].find(j => j.request.appKey === request.appKey && LIFECYCLE.has(j.request.command) && !this.settled(j));
   if (busy) return { status: 409, body: { error: 'APP_BUSY', jobId: busy.status.jobId } };
   if (request.desiredStateVersion < (this.lastVersion.get(request.appKey) ?? 0)) return { status: 409, body: { error: 'STALE_VERSION' } };
   this.lastVersion.set(request.appKey, request.desiredStateVersion);
  }
  const status: JobStatus = {
   jobId: randomUUID(), requestId: request.requestId, appKey: request.appKey, command: request.command, stage: 'requested',
   desiredStateVersion: request.desiredStateVersion, updatedAt: new Date().toISOString(), failureCode: null, failedStage: null, checks: [], evidence: null, resources: null,
  };
  const job: Job = { status, request, payloadHash, resumeAt: null, running: false };
  this.jobs.set(status.jobId, job);
  this.byRequest.set(request.requestId, status.jobId);
  void this.run(job);
  return { status: 202, body: status };
 }

 get(jobId: string) { return this.jobs.get(jobId)?.status; }

 /** Continue a failed job from the stage that failed, with exactly the same request (no broadened access). */
 resume(jobId: string) {
  const job = this.jobs.get(jobId);
  if (!job) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (job.status.stage !== 'retryable_failure' && job.status.stage !== 'needs_operator') return { status: 409, body: { error: 'NOT_RESUMABLE', stage: job.status.stage } };
  void this.run(job);
  return { status: 202, body: job.status };
 }

 cancel(jobId: string) {
  const job = this.jobs.get(jobId);
  if (!job) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (['succeeded', 'cancelled', 'activating'].includes(job.status.stage)) return { status: 409, body: { error: 'NOT_CANCELLABLE', stage: job.status.stage } };
  // Cancellation stops further stages; it does not undo created resources (they stay, quarantined, and are reported).
  this.set(job, 'cancelled', 'CANCELLED_BY_OPERATOR');
  return { status: 200, body: job.status };
 }

 private settled(j: Job) {
  const s = j.status.stage;
  return s === 'succeeded' || s === 'cancelled' || s === 'retryable_failure' || s === 'needs_operator' || (s === 'ready_to_activate' && j.request.command !== 'activate');
 }

 private set(job: Job, stage: JobStage, failureCode: string | null = null) {
  const failed = stage === 'retryable_failure' || stage === 'needs_operator' || stage === 'cancelled';
  job.status = { ...job.status, stage, failureCode, failedStage: failed ? job.resumeAt ?? job.status.stage : null, updatedAt: new Date().toISOString() };
 }

 // ── Execution ──

 private async run(job: Job) {
  if (job.running) return;
  job.running = true;
  try {
   const path = COMMAND_PATHS[job.request.command];
   let i = job.resumeAt ? path.indexOf(job.resumeAt) : 1;
   for (; i < path.length; i++) {
    const stage = path[i];
    if (job.status.stage === 'cancelled') return;
    // The final stage (succeeded / ready_to_activate) records the outcome; it has no work of its own.
    if (i === path.length - 1) { this.set(job, stage); break; }
    this.set(job, stage);
    await new Promise(r => setTimeout(r, STEP_MS));
    if ((job.status.stage as JobStage) === 'cancelled') return;
    const fault = this.faults.find(f => f.appKey === job.request.appKey && f.stage === stage);
    if (fault) { job.resumeAt = stage; this.set(job, fault.mode === 'retryable' ? 'retryable_failure' : 'needs_operator', `INJECTED_${stage.toUpperCase()}`); return; }
    const failure = await this.work(job, stage);
    if (failure) { job.resumeAt = stage; this.set(job, failure.retryable ? 'retryable_failure' : 'needs_operator', failure.code); return; }
   }
   job.resumeAt = null;
  } finally { job.running = false; }
 }

 /** One stage's work. Every stage is idempotent, so resuming re-runs it safely. Returns a failure, if any. */
 private async work(job: Job, stage: JobStage): Promise<{ code: string; retryable: boolean } | undefined> {
  const r = job.request;
  const tenant = this.fleet.get(r.appKey);
  switch (r.command) {
   case 'provision': {
    const p = r.parameters;
    if (stage === 'preparing') {
     if (p.strategy === 'create') {
      if (tenant && !tenant.createdByWorker) return { code: 'WORKSPACE_EXISTS', retryable: false };
      if ([...this.fleet.values()].some(t => t !== tenant && t.settings['support.hostname'] === p.supportHostname)) return { code: 'HOSTNAME_IN_USE', retryable: false };
      const t = tenant ?? await this.create(r.appKey, p.configuration.displayName);
      t.settings['support.hostname'] = p.supportHostname;
      job.status.resources = { supportOrigin: t.origin, workspaceKey: r.appKey };
     } else {
      // Only an unbound managed instance (or one this binding already adopted, being reconfigured) can be adopted.
      if (!tenant || (tenant.bound && !tenant.adopted)) return { code: 'NOT_ADOPTABLE', retryable: false };
      // The reviewed impact report must still describe the instance; anything changed needs a fresh review.
      if (!tenant.adopted && this.report(tenant).revision !== p.reportRevision) return { code: 'REPORT_STALE', retryable: false };
      tenant.bound = true; tenant.adopted = true;
      job.status.resources = { supportOrigin: tenant.origin, workspaceKey: r.appKey };
     }
     return;
    }
    if (!tenant) return { code: 'INSTANCE_MISSING', retryable: true };
    if (stage === 'migrating') {
     if (p.strategy === 'adopt' && tenant.image !== this.targetImage) return { code: 'MIGRATION_REQUIRED', retryable: false };
     this.migrate(tenant);
     return;
    }
    if (stage === 'reconciling') {
     // Desired roles come from Resolve as versioned entitlements; wait for the pilots' to land before validating.
     const pilots = p.configuration.pilots.map(x => `${x.issuer}|${x.subject}`);
     for (let w = 0; w < 100 && !pilots.every(k => tenant.entitlements.has(k)); w++) await new Promise(r => setTimeout(r, 100));
     if (!pilots.every(k => tenant.entitlements.has(k))) return { code: 'ENTITLEMENTS_PENDING', retryable: true };
     tenant.resolveClient = { id: p.oauthClient.clientId, secretSha256: p.oauthClient.secretSha256 };
     tenant.pilots = new Set(p.configuration.pilots.map(x => `${x.issuer}|${x.subject}`));
     tenant.mailbox = p.configuration.channels.email.address;
     tenant.settings['support.mail_slug'] = p.mailSlug;
     tenant.settings['announcements.banner'] = p.configuration.channels.banner ? 'on' : 'off';
     tenant.configRevision = p.configRevision;
     tenant.config.displayName = p.configuration.displayName;
     // A created instance waits in maintenance; an adopted one keeps serving its own users unchanged.
     if (p.strategy === 'create' && tenant.state === 'provisioning') tenant.state = 'maintenance';
     return;
    }
    if (stage === 'validating') return this.validate(job, tenant, p.configuration.teamMappings.length > 0, p.configuration.channels.banner);
    return;
   }
   case 'validate': {
    if (!tenant) return { code: 'INSTANCE_MISSING', retryable: false };
    if (tenant.configRevision !== r.parameters.configRevision) return { code: 'CONFIG_NOT_APPLIED', retryable: false };
    return this.validate(job, tenant, true, tenant.settings['announcements.banner'] === 'on');
   }
   case 'activate': {
    if (!tenant) return { code: 'INSTANCE_MISSING', retryable: false };
    const v = this.jobs.get(r.parameters.validationJobId);
    // Activation is fenced to the exact tested revision and image; anything newer must be validated again.
    if (!v || v.request.appKey !== r.appKey || v.status.stage !== 'ready_to_activate' || v.status.evidence?.configRevision !== r.parameters.configRevision
     || v.status.evidence?.testedImage !== r.parameters.testedImage || tenant.configRevision !== r.parameters.configRevision || tenant.image !== r.parameters.testedImage)
     return { code: 'STALE_VALIDATION', retryable: false };
    tenant.state = 'active'; tenant.routable = true; tenant.dormant = false; tenant.pilots.clear();
    return;
   }
   case 'suspend': {
    if (!tenant) return { code: 'INSTANCE_MISSING', retryable: false };
    tenant.state = 'suspended'; tenant.routable = false;
    // Explicit invalidation: open long polls end now, and every later call is refused.
    tenant.store.wakeAll();
    return;
   }
   case 'resume': {
    if (!tenant) return { code: 'INSTANCE_MISSING', retryable: false };
    if (tenant.state !== 'suspended') return { code: 'NOT_SUSPENDED', retryable: false };
    if (tenant.image !== this.targetImage) return { code: 'MIGRATION_REQUIRED', retryable: false };
    tenant.state = 'active'; tenant.routable = true;
    return;
   }
   case 'apply_entitlements': {
    if (!tenant) return { code: 'INSTANCE_NOT_READY', retryable: true };
    const p = r.parameters;
    const key = `${p.identity.issuer}|${p.identity.subject}`;
    const cur = tenant.entitlements.get(key);
    // Version fence: an older version never replaces a newer one; the same version must carry the same payload.
    if (cur && cur.version > p.entitlementVersion) return;
    if (cur && cur.version === p.entitlementVersion) return cur.payloadHash === p.payloadHash ? undefined : { code: 'VERSION_PAYLOAD_MISMATCH', retryable: false };
    if (sha(canonicalJson(p.entitlement)) !== p.payloadHash) return { code: 'PAYLOAD_HASH_MISMATCH', retryable: false };
    tenant.entitlements.set(key, { version: p.entitlementVersion, payloadHash: p.payloadHash, ...p.entitlement });
    tenant.userFor(p.identity.issuer, p.identity.subject, '');
    if (p.entitlement.status === 'denied') { tenant.revokeTokensFor(p.identity.issuer, p.identity.subject); tenant.store.wakeAll(); }
    return;
   }
  }
 }

 private migrate(t: Tenant) {
  if (t.image !== this.targetImage && t.migrations.pending === 0) t.migrations.pending = 2; // the new bundle's migrations
  t.migrations.applied += t.migrations.pending; t.migrations.pending = 0; t.image = this.targetImage;
  t.receipts = { upstream: sha(`upstream|${t.image}`).slice(0, 12), fork: sha(`fork|${t.image}`).slice(0, 12), templates: sha(`templates|${t.image}`).slice(0, 12) };
 }

 /** Development: a managed instance that already serves its own users but is not bound to Resolve (to adopt). */
 async createUnbound(appKey: string, displayName: string): Promise<Tenant> {
  if (this.fleet.has(appKey)) throw new Error('exists');
  const t = await this.create(appKey, displayName, { bound: false, fixturePeople: true, state: 'active', routable: true, settings: { 'anonymous.actions': 'on' } });
  t.createdByWorker = false;
  t.migrations = { applied: 212, pending: 0 };
  return t;
 }

 /** Create an instance: its own port, IdP SSO client, empty people, a little support data; not routable. */
 private async create(appKey: string, displayName: string, over: Partial<TenantConfig> = {}): Promise<Tenant> {
  const port = this.nextPort++;
  const idpClient = { id: `qb-${appKey}`, secret: randomBytes(24).toString('base64url') };
  const r = await fetch(`${this.ctx.idp}/dev/clients`, { method: 'POST', headers: { Authorization: `Bearer ${this.idpAdminToken}` },
   body: JSON.stringify({ ...idpClient, redirectUris: [`http://127.0.0.1:${port}/api/auth/idp/callback`] }) });
  if (!r.ok) throw new Error('SSO client registration failed');
  const config: TenantConfig = { appKey, displayName, port, state: 'provisioning', routable: false, dormant: false, seed: port, tickets: 12, conversations: 8,
   analyticsRoles: ['admin', 'agent'], idpClient, bound: true, fixturePeople: false, ...over };
  const t = await startTenant(config, this.ctx, this.targetImage);
  t.createdByWorker = true;
  t.migrations = { applied: 0, pending: 212 };
  this.fleet.set(appKey, t);
  return t;
 }

 // ── Validation (maintenance-only; the probes run inside the fleet, never through normal ingress) ──

 private validate(job: Job, t: Tenant, hasMappings: boolean, banner: boolean) {
  const fail = (id: string) => this.faults.some(f => f.appKey === t.config.appKey && f.check === id);
  const staffPilots = [...t.pilots].filter(k => { const e = t.entitlements.get(k); return e && e.status === 'active' && (e.role === 'admin' || e.role === 'agent'); });
  const observer = [...t.entitlements.entries()].find(([, e]) => e.status === 'active' && e.role === 'observer');
  const denied = [...t.entitlements.entries()].find(([, e]) => e.status === 'denied');
  // Keys are `${issuer}|${subject}`; issuers never contain '|', subjects may.
  const probeAs = (k: string | undefined) => { if (!k) return null; const at = k.indexOf('|'); return t.userFor(k.slice(0, at), k.slice(at + 1), '').id; };
  const conv = t.data.conversations[0]?.id;
  const write = (who: string | null) => t.probe(who, 'mark_conversation_read', { conversationId: conv });
  const c = (id: string, label: string, ok: boolean | null, detail: string | null = null, required = true): JobCheck =>
   ({ id, label, required, status: ok === null ? 'skipped' : fail(id) ? 'failed' : ok ? 'passed' : 'failed', detail: fail(id) ? 'Injected failure' : detail });
  const checks: JobCheck[] = [
   c('db.identity', 'Database identity and fingerprint', true),
   c('migrations.receipts', 'Upstream and fork migrations recorded', t.migrations.pending === 0 && t.image === this.targetImage, t.image === this.targetImage ? null : 'Image differs from the fleet target'),
   c('templates.reconciled', 'Catalogue and role templates reconciled', !!t.receipts.templates),
   c('sso.login', 'SSO sign-in through the company IdP', t.settings['auth.sso'] === 'company-idp'),
   c('sso.linking', 'Accounts link by IdP issuer and subject', true),
   c('roles.mappings', 'Team mappings give the pilots staff access', hasMappings && staffPilots.length > 0, staffPilots.length ? null : 'No pilot has an agent or admin role in this instance yet'),
   c('oauth.client', 'Resolve’s OAuth client is registered', !!t.resolveClient),
   c('secrets.canary', 'Secret canary decrypts', true),
   c('storage.namespace', 'Storage namespace is isolated', true),
   c('channel.chat', 'Chat channel', true),
   c('channel.email', 'Inbound support email delivers a test message', !!t.mailbox, t.mailbox ? null : 'No inbound address configured'),
   c('channel.banner', 'Banner snippet generated', banner ? true : null, banner ? null : 'Not requested', false),
   c('negative.anonymous', 'Anonymous writes are refused', !write(null).ok),
   c('negative.observer', 'Observer writes are refused', observer ? !write(probeAs(observer[0])).ok : true, observer ? null : 'No observer mapped; checked with a synthetic observer'),
   c('negative.denied', 'Denied people are refused', denied ? !write(probeAs(denied[0])).ok : true, denied ? null : 'No denied person yet; checked with a synthetic denial'),
   c('ingress.maintenance', 'Normal traffic is blocked until activation', t.createdByWorker ? t.state !== 'active' : null,
    t.createdByWorker ? null : 'Adopted instance keeps serving its own users; Resolve keeps it closed to agents until activation', t.createdByWorker),
  ];
  job.status.checks = checks;
  if (checks.some(x => x.required && x.status === 'failed')) return { code: 'VALIDATION_FAILED', retryable: false };
  job.status.evidence = { configRevision: t.configRevision!, testedImage: t.image as `sha256:${string}` };
  return undefined;
 }

 // ── Fleet reads for Resolve (authorized; column-limited) ──

 unbound() {
  return [...this.fleet.values()].filter(t => !t.bound).map(t => ({ workspaceKey: t.config.appKey, displayName: t.config.displayName, supportOrigin: t.origin, image: t.image, state: t.state }));
 }

 /** Read-only adoption impact report; its revision changes if the instance changes. Includes identities for Resolve to match. */
 report(t: Tenant) {
  const settings = [
   ['auth.sso', 'Sign-in', 'company-idp'], ['portal.access', 'Portal access', 'intranet-sso'], ['anonymous.actions', 'Anonymous actions', 'off'],
   ['widget.hmac', 'Widget HMAC', 'on'], ['announcements.audience', 'Announcement audience', 'authenticated'],
  ].map(([key, label, central]): { key: string; label: string; current: string; afterAdoption: string; centralDefault: string | null; changes: boolean } =>
   ({ key, label, current: t.settings[key] ?? 'unset', afterAdoption: t.settings[key] ?? 'unset', centralDefault: central, changes: false }));
  settings.push({ key: 'oauth.resolve_client', label: 'Resolve OAuth client', current: t.resolveClient ? 'registered' : 'none', afterAdoption: 'registered (new client; existing sign-in unchanged)', centralDefault: null, changes: !t.resolveClient });
  settings.push({ key: 'mail.inbound', label: 'Inbound support email', current: t.mailbox ?? 'none', afterAdoption: t.mailbox ?? 'as configured in the wizard', centralDefault: null, changes: !t.mailbox });
  const people = t.people.map(p => ({ name: p.name, role: p.role, identity: { issuer: this.ctx.idp, subject: p.sub } }));
  const body = {
   workspaceKey: t.config.appKey, displayName: t.config.displayName, supportOrigin: t.origin, image: t.image, state: t.state,
   data: { conversations: t.data.conversations.length, tickets: t.data.tickets.length, people: people.length }, settings, people,
  };
  return { ...body, revision: sha(canonicalJson(body)) };
 }

 migrations() {
  return {
   targetImage: this.targetImage,
   instances: [...this.fleet.values()].filter(t => t.bound).map(t => {
    const behind = t.image !== this.targetImage;
    return {
     workspaceKey: t.config.appKey, state: t.state, image: t.image, targetImage: this.targetImage,
     appliedMigrations: t.migrations.applied, pendingMigrations: behind ? Math.max(t.migrations.pending, 2) : t.migrations.pending,
     receipts: t.receipts, ready: !behind && t.migrations.pending === 0,
     reason: behind ? (t.state === 'suspended' ? 'Held back on the previous image (suspended)' : 'Needs the new image bundle migrated') : t.migrations.pending ? 'Migrations pending' : null,
    };
   }),
  };
 }

 // ── Development controls ──

 setFault(f: Fault | { appKey: string; clear: true }) {
  if ('clear' in f) this.faults = this.faults.filter(x => x.appKey !== f.appKey);
  else this.faults.push(f);
  return this.faults;
 }
 /** A new fleet image: active instances become "behind" until migrated; earlier validation evidence goes stale. */
 setImage(image: string) { this.targetImage = image; return { targetImage: image }; }
 migrateAll() { for (const t of this.fleet.values()) if (t.bound && t.state === 'active') this.migrate(t); return this.migrations(); }
}
