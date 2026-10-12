import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/*
 * Phase 4 exit criteria (plan 00) against the mock fleet and worker: maintenance-only validation before activation,
 * version-fenced role jobs, suspended-tenant recovery, no DSN/secret in Resolve's commands, and failed jobs that
 * resume without broadening access. Every test onboards its own application.
 */
// Each test provisions, validates and activates real (mock) instances through the worker.
test.describe.configure({ timeout: 120_000 });
const ORIGIN = 'http://127.0.0.1:4200';
const FLEET = 'http://127.0.0.1:3300';
const tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const key = (p: string) => `${p}${Math.random().toString(36).slice(2, 7)}`;
const H = { Origin: ORIGIN };
const fleet = (path: string, body?: unknown) => fetch(FLEET + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const tenantPort = async (appKey: string) => ((await fleet('/dev/fleet')) as { appKey: string; port: number }[]).find(t => t.appKey === appKey)!.port;

async function signedIn(browser: Browser, name: string) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
 return page;
}
async function me(page: Page) { return (await (await page.request.get('/api/session')).json()).user as { id: string; displayName: string }; }
async function runOf(page: Page, runId: string) { return (await (await page.request.get(`/api/admin/onboarding/${runId}`)).json()).run; }
async function waitRun(page: Page, runId: string, until: (r: { status: string; jobs: { stage: string }[] }) => boolean) {
 let r;
 await expect.poll(async () => until(r = await runOf(page, runId)), { timeout: 20_000 }).toBe(true);
 return r!;
}

/** Steps 1–4 through the API (the wizard itself is exercised in the first test). */
async function draft(admin: Page, appKey: string, opts: { adopt?: string; mappings?: unknown[]; pilots?: string[] } = {}) {
 const start = await admin.request.post('/api/admin/onboarding', { headers: H, data: { describe: {
  name: `App ${appKey}`, key: appKey, description: '', appUrl: `https://${appKey}.corp.internal`, environment: 'production', ownerName: 'Owner', ownerEmail: 'owner@example.test', supportTeam: 'Support', contact: '' } } });
 expect(start.status()).toBe(201);
 const { runId } = await start.json();
 const put = async (step: string, data: unknown) => {
  const r = await admin.request.put(`/api/admin/onboarding/${runId}/steps/${step}`, { headers: H, data: { data, version: (await runOf(admin, runId)).version } });
  expect(r.status(), await r.text()).toBe(200);
 };
 await put('instance', opts.adopt ? { strategy: 'adopt', workspaceKey: opts.adopt, mailSlug: appKey } : { strategy: 'create', supportHostname: `${appKey}.support.corp.internal`, mailSlug: appKey });
 await put('access', { teamMappings: opts.mappings ?? [{ bundle: 'fleet-admin', role: 'admin', teams: [] }, { bundle: 'fleet-agent', role: 'agent', teams: ['support'] }], pilotUserIds: opts.pilots ?? [(await me(admin)).id] });
 await put('entry', { emailAddress: `${appKey}@support.corp.internal`, emailOwner: 'Support', banner: false });
 return runId as string;
}
async function reviewAndProvision(admin: Page, runId: string) {
 const review = await (await admin.request.post(`/api/admin/onboarding/${runId}/review`, { headers: H, data: {} })).json();
 const r = await admin.request.post(`/api/admin/onboarding/${runId}/provision`, { headers: H, data: { configRevision: review.configRevision, requestId: crypto.randomUUID() } });
 expect(r.status(), await r.text()).toBe(202);
 return review.configRevision as string;
}
const connected = (page: Page) => expect(page.getByText(/^Connected to /)).toBeVisible();
async function pilotCheck(pilot: Page, runId: string, workspaceKey: string) {
 await pilot.goto(`/api/connect/${workspaceKey}/start`);
 await connected(pilot);
 const r = await pilot.request.post(`/api/onboarding/${runId}/pilot`, { headers: H, data: {} });
 expect((await r.json()).passed).toBe(true);
}
async function activate(admin: Page, runId: string) {
 const run = await runOf(admin, runId);
 const v = run.jobs.find((j: { command: string }) => j.command === 'provision' || j.command === 'validate');
 const r = await admin.request.post(`/api/admin/onboarding/${runId}/activate`, { headers: H, data: { configRevision: run.configRevision, requestId: crypto.randomUUID(), validationJobId: v.id } });
 expect(r.status(), await r.text()).toBe(202);
 return waitRun(admin, runId, x => x.status === 'active');
}
/** A fully onboarded, active application (create strategy), with Ada as admin and pilot. */
async function onboarded(admin: Page, prefix: string, mappings?: unknown[]) {
 const appKey = key(prefix);
 const runId = await draft(admin, appKey, { mappings });
 await reviewAndProvision(admin, runId);
 await waitRun(admin, runId, r => r.status === 'ready');
 await pilotCheck(admin, runId, appKey);
 await activate(admin, runId);
 return { appKey, runId };
}

test('an admin registers and onboards an application through the wizard, and it opens only after validation and a pilot check', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const sam = await signedIn(browser, 'Sam Agent');
 const appKey = key('wiz');
 await ada.goto('/applications');
 await ada.getByRole('link', { name: 'Register application' }).click();
 await expect(ada.getByRole('heading', { level: 1, name: 'Register an application' })).toBeVisible();
 expect((await new AxeBuilder({ page: ada }).withTags(tags).analyze()).violations).toEqual([]);

 // Step 1: a field error is associated with its field and focused.
 await ada.getByLabel('Application name').fill(`Wizard ${appKey}`);
 await ada.getByLabel('Application key').fill(appKey);
 await ada.getByLabel('Application address').fill('http://not-https.example');
 await ada.getByLabel('Accountable owner').fill('Olu Owner');
 await ada.getByLabel("Owner's email").fill('olu@example.test');
 await ada.getByLabel('Support team').fill('Payroll support');
 await ada.getByRole('button', { name: 'Save and continue' }).click();
 await expect(ada.getByLabel('Application address')).toBeFocused();
 await ada.getByLabel('Application address').fill(`https://${appKey}.corp.internal`);
 await ada.getByRole('button', { name: 'Save and continue' }).click();

 // Step 2: create, with a hostname under the approved domain (proposed from the key).
 await expect(ada.getByRole('heading', { name: 'Choose the support instance' })).toBeVisible();
 await expect(ada.getByLabel('Support hostname')).toHaveValue(`${appKey}.support.corp.internal`);
 await ada.getByLabel('Support hostname').fill(`${appKey}.example.com`);
 await ada.getByRole('button', { name: 'Save and continue' }).click();
 await expect(ada.getByRole('alert').first()).toContainText('Support hostnames must be under');
 await ada.getByLabel('Support hostname').fill(`${appKey}.support.corp.internal`);
 await ada.getByRole('button', { name: 'Save and continue' }).click();

 // Step 3: mappings and a pilot.
 await expect(ada.getByRole('heading', { name: 'Support and access' })).toBeVisible();
 await ada.getByLabel('Map fleet-admin').check();
 await ada.getByLabel('Map fleet-agent').check();
 await ada.getByLabel('Teams for fleet-agent').fill('support');
 await ada.getByLabel('Find a person').fill('Ada');
 await ada.getByRole('button', { name: 'Search' }).click();
 await ada.getByRole('button', { name: 'Add Ada Admin as a pilot' }).click();
 await ada.getByRole('button', { name: 'Save and continue' }).click();

 // Step 4: the required email channel.
 await expect(ada.getByRole('heading', { name: 'Entry points' })).toBeVisible();
 await ada.getByLabel('Inbound support address').fill(`${appKey}@support.corp.internal`);
 await ada.getByLabel('Mailbox owner').fill('Payroll support');
 await ada.getByLabel(/Generate the Everyone banner snippet/).check();
 await ada.getByRole('button', { name: 'Save and continue' }).click();

 // Review, then dispatch. Double-clicking Dispatch is one job.
 await ada.getByRole('button', { name: 'Review configuration' }).click();
 await expect(ada.getByRole('table', { name: 'Grants by bundle' })).toContainText('fleet-agent');
 expect((await new AxeBuilder({ page: ada }).withTags(tags).analyze()).violations).toEqual([]);
 await ada.getByRole('button', { name: 'Provision…' }).click();
 await ada.getByRole('button', { name: 'Dispatch' }).click();
 const runId = ada.url().split('/').pop()!;

 // Validation runs while the instance stays closed: Sam (not a pilot) cannot connect yet.
 await expect(ada.getByRole('table', { name: 'Validation checks' })).toContainText('Inbound support email delivers a test message');
 await waitRun(ada, runId, r => r.status === 'ready');
 await sam.goto(`/api/connect/${appKey}/start`);
 await expect(sam.getByText(/is not available right now/)).toBeVisible();
 expect((await new AxeBuilder({ page: ada }).withTags(tags).analyze()).violations).toEqual([]);

 // Activation is refused until a pilot has checked this configuration.
 const blocked = await ada.request.post(`/api/admin/onboarding/${runId}/activate`, { headers: H,
  data: { configRevision: (await runOf(ada, runId)).configRevision, requestId: crypto.randomUUID(), validationJobId: (await runOf(ada, runId)).jobs[0].id } });
 expect((await blocked.json()).error.code).toBe('PILOT_REQUIRED');

 // Ada is the pilot: Home tells her; she connects (the tenant admits pilots only) and runs the check.
 await ada.goto('/');
 await ada.getByRole('link', { name: `Run the pilot check for Wizard ${appKey}` }).click();
 await ada.getByRole('link', { name: /Connect to/ }).click();
 await connected(ada);
 await ada.goto(`/onboarding/${runId}/pilot`);
 await ada.getByRole('button', { name: 'Run the pilot check' }).click();
 await expect(ada.getByText('The pilot check passed.')).toBeVisible();
 await expect(ada.getByText(/Added an internal note as yourself/)).toBeVisible();

 // Activate from the wizard.
 await ada.goto(`/applications/onboarding/${runId}`);
 await ada.getByRole('button', { name: /Activate and hand over/ }).click();
 await ada.getByRole('button', { name: 'Activate…' }).click();
 await ada.getByRole('button', { name: 'Activate', exact: true }).click();
 await expect(ada.getByText('Active. Normal routing is on for the tested configuration.')).toBeVisible({ timeout: 15_000 });
 await expect(ada.getByLabel('Banner snippet')).toContainText(`https://${appKey}.support.corp.internal/widget/banner.js`);

 // Open for normal use now: Sam connects and reads with the role the mapping gave him.
 await sam.goto(`/api/connect/${appKey}/start`);
 await connected(sam);
 expect((await sam.request.get(`/api/apps/${appKey}/conversations?status=open`)).status()).toBe(200);
 await ada.context().close(); await sam.context().close();
});

test('repeated dispatch is one job; requests carry no DSN or secret; non-admins cannot administer', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const sam = await signedIn(browser, 'Sam Agent');
 const appKey = key('idem');
 const runId = await draft(ada, appKey);
 const review = await (await ada.request.post(`/api/admin/onboarding/${runId}/review`, { headers: H, data: {} })).json();
 const body = { configRevision: review.configRevision, requestId: crypto.randomUUID() };
 const [a, b] = await Promise.all([1, 2].map(() => ada.request.post(`/api/admin/onboarding/${runId}/provision`, { headers: H, data: body })));
 const ids = [(await a.json()).job?.id, (await b.json()).job?.id].filter(Boolean);
 expect(new Set(ids).size).toBe(1);
 await waitRun(ada, runId, r => r.status === 'ready');
 expect(((await fleet('/dev/fleet')) as { appKey: string }[]).filter(t => t.appKey === appKey)).toHaveLength(1);
 // The stored command has the secret's hash only; nothing resembling a DSN or password.
 const run = await runOf(ada, runId);
 const text = JSON.stringify(run);
 expect(text).not.toMatch(/postgres:\/\/|password|secret"/i);
 // Capabilities are enforced by the API, not just hidden in the UI.
 for (const [method, path] of [['GET', '/api/admin/applications'], ['POST', `/api/admin/onboarding/${runId}/review`], ['POST', `/api/admin/apps/${appKey}/suspend`], ['GET', '/api/admin/bundles']] as const) {
  const r = method === 'GET' ? await sam.request.get(path) : await sam.request.post(path, { headers: H, data: { requestId: crypto.randomUUID() } });
  expect(r.status(), path).toBe(403);
 }
 // Not activated: cancel, which keeps (and reports) the created instance rather than deleting it.
 expect((await ada.request.post(`/api/admin/onboarding/${runId}/cancel`, { headers: H, data: {} })).status()).toBe(200);
 expect((await runOf(ada, runId)).status).toBe('cancelled');
 await ada.context().close(); await sam.context().close();
});

test('a failed stage resumes from where it stopped, and a changed configuration needs validating and piloting again', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const appKey = key('fail');
 const runId = await draft(ada, appKey);
 await fleet('/dev/worker/fault', { appKey, stage: 'migrating', mode: 'retryable' });
 const rev1 = await reviewAndProvision(ada, runId);
 const failed = await waitRun(ada, runId, r => r.status === 'failed');
 expect(failed.jobs[0]).toMatchObject({ stage: 'retryable_failure', failedStage: 'migrating', failureCode: 'INJECTED_MIGRATING' });
 await fleet('/dev/worker/fault', { appKey, clear: true });
 await ada.goto(`/applications/onboarding/${runId}`);
 await ada.getByRole('button', { name: 'Resume from Migrating' }).click();
 const ready = await waitRun(ada, runId, r => r.status === 'ready');
 expect(ready.jobs).toHaveLength(1); // resumed the same job: same request, same parameters
 await pilotCheck(ada, runId, appKey);

 // Change the email after validation: the reviewed revision is cleared, so activation cannot use the old evidence.
 const r = await ada.request.put(`/api/admin/onboarding/${runId}/steps/entry`, { headers: H, data: { version: ready.version, data: { emailAddress: `new-${appKey}@support.corp.internal`, emailOwner: 'Support', banner: false } } });
 expect(r.status()).toBe(200);
 expect((await r.json()).run.configRevision).toBeNull();
 const stale = await ada.request.post(`/api/admin/onboarding/${runId}/activate`, { headers: H, data: { configRevision: rev1, requestId: crypto.randomUUID(), validationJobId: ready.jobs[0].id } });
 expect((await stale.json()).error.code).toBe('NOT_REVIEWED');
 // Re-review and provision again (reconfigures the same instance); the old pilot evidence does not count.
 const rev2 = await reviewAndProvision(ada, runId);
 expect(rev2).not.toBe(rev1);
 await waitRun(ada, runId, x => x.status === 'ready');
 expect((await runOf(ada, runId)).blockers.join(' ')).toContain('pilot');
 await pilotCheck(ada, runId, appKey);
 expect((await activate(ada, runId)).lifecycle).toBe('active');
 await ada.context().close();
});

test('adoption shows its impact first and leaves existing data, sign-in and unmanaged people untouched', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const instance = key('legacy');
 await fleet('/dev/worker/unbound', { appKey: instance, displayName: `Legacy ${instance}` });
 const appKey = key('adopt');
 const runId = await draft(ada, appKey, { adopt: instance, mappings: [{ bundle: 'fleet-admin', role: 'admin', teams: [] }] });
 await ada.goto(`/applications/onboarding/${runId}`);
 await ada.getByRole('button', { name: /Review and provision/ }).click();
 await ada.getByRole('button', { name: 'Review configuration' }).click();
 const settings = ada.getByRole('table', { name: 'Settings' });
 await expect(settings.getByRole('row', { name: /Anonymous actions/ })).toContainText('differs');
 await expect(settings.getByRole('row', { name: /Anonymous actions/ })).not.toContainText('changes');
 const people = ada.getByRole('table', { name: 'People' });
 await expect(people.getByRole('row', { name: /Ada Admin/ })).toContainText('Managed by Resolve');
 await expect(people.getByRole('row', { name: /Sam Agent/ })).toContainText('Unchanged');
 expect((await new AxeBuilder({ page: ada }).withTags(tags).analyze()).violations).toEqual([]);
 await ada.getByRole('button', { name: 'Adopt and provision…' }).click();
 await ada.getByRole('button', { name: 'Dispatch' }).click();
 await waitRun(ada, runId, r => r.status === 'ready');
 // The instance kept serving its own users; Resolve keeps it closed to agents until activation.
 const state = ((await fleet('/dev/fleet')) as { appKey: string; state: string; adopted: boolean }[]).find(t => t.appKey === instance)!;
 expect(state).toMatchObject({ state: 'active', adopted: true });
 const apps = (await (await ada.request.get('/api/apps')).json()).apps;
 expect(apps.find((a: { appKey: string }) => a.appKey === instance)).toMatchObject({ servable: false });
 const port = await tenantPort(instance);
 const entitlements = await (await fetch(`http://127.0.0.1:${port}/dev/entitlements`)).json();
 expect(Object.keys(entitlements)).toContain('mock|ada');
 expect(Object.keys(entitlements)).not.toContain('mock|sam');
 expect((await ada.request.post(`/api/admin/onboarding/${runId}/cancel`, { headers: H, data: {} })).status()).toBe(200);
 await ada.context().close();
});

test('role changes reach the tenant as versioned entitlements, and a blocked person is denied by the tenant too', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const { appKey } = await onboarded(ada, 'ent', [{ bundle: 'fleet-admin', role: 'admin', teams: [] }, { bundle: 'fleet-agent', role: 'agent', teams: ['support'] }]);
 const port = await tenantPort(appKey);
 const ent = async (sub: string) => (await (await fetch(`http://127.0.0.1:${port}/dev/entitlements`)).json())[sub];
 await expect.poll(() => ent('mock|bo').then(e => e?.role)).toBe('agent');
 const v1 = (await ent('mock|bo')).version;

 // Mapping change: agents become observers here; Bo's tenant role follows with a newer version.
 await ada.goto(`/applications/${appKey}`);
 await ada.getByLabel('Role for fleet-agent').selectOption('observer');
 await ada.getByRole('button', { name: 'Save mappings' }).click();
 await expect(ada.getByText('Mappings saved')).toBeVisible();
 await expect.poll(() => ent('mock|bo').then(e => e?.role)).toBe('observer');
 expect((await ent('mock|bo')).version).toBeGreaterThan(v1);
 expect((await new AxeBuilder({ page: ada }).withTags(tags).analyze()).violations).toEqual([]);

 // An emergency block in Resolve becomes a tenant denial; lifting it restores access with a still newer version.
 const users = (await (await ada.request.get('/api/admin/users?q=Bo')).json()).users;
 const bo = users.find((u: { displayName: string }) => u.displayName === 'Bo Blockable');
 expect((await ada.request.post(`/api/admin/users/${bo.id}/access`, { headers: H, data: { enabled: false, reason: 'Onboarding entitlement test' } })).status()).toBe(200);
 await expect.poll(() => ent('mock|bo').then(e => e?.status)).toBe('denied');
 const denied = (await ent('mock|bo')).version;
 expect((await ada.request.post(`/api/admin/users/${bo.id}/access`, { headers: H, data: { enabled: true, reason: 'Onboarding entitlement test done' } })).status()).toBe(200);
 await expect.poll(() => ent('mock|bo').then(e => e?.status)).toBe('active');
 expect((await ent('mock|bo')).version).toBeGreaterThan(denied);
 await ada.context().close();
});

test('suspending an instance closes it to agents; resuming restores access without reconnecting', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const sam = await signedIn(browser, 'Sam Agent');
 const { appKey } = await onboarded(ada, 'susp');
 await sam.goto(`/api/connect/${appKey}/start`);
 await connected(sam);
 expect((await sam.request.get(`/api/apps/${appKey}/conversations?status=open`)).status()).toBe(200);

 await ada.goto(`/applications/${appKey}`);
 await ada.getByRole('button', { name: 'Suspend…' }).click();
 await ada.getByRole('button', { name: 'Suspend', exact: true }).click();
 await expect(ada.getByText('Fleet: suspended')).toBeVisible({ timeout: 15_000 });
 expect((await sam.request.get(`/api/apps/${appKey}/conversations?status=open`)).status()).toBe(503);

 await ada.getByRole('button', { name: 'Resume…' }).click();
 await ada.getByRole('button', { name: 'Resume', exact: true }).click();
 await expect(ada.getByText('Fleet: active')).toBeVisible({ timeout: 15_000 });
 await expect.poll(async () => (await sam.request.get(`/api/apps/${appKey}/conversations?status=open`)).status()).toBe(200);
 const audit = (await (await ada.request.get('/api/audit?category=app&limit=50')).json()).events
  .filter((e: { operation: string; summary: { app?: string } }) => e.summary.app === appKey && ['app.job.suspend', 'app.job.resume'].includes(e.operation));
 expect(audit.filter((e: { outcome: string }) => e.outcome === 'succeeded').map((e: { operation: string }) => e.operation).sort()).toEqual(['app.job.resume', 'app.job.suspend']);
 await ada.context().close(); await sam.context().close();
});

test('people and roles: a granted bundle is audited and changes what the person can do', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 await ada.goto('/people');
 await expect(ada.getByRole('heading', { level: 3, name: 'fleet-observer' })).toBeVisible();
 await ada.getByLabel('Name or email').fill('Nina');
 await ada.getByRole('button', { name: 'Search' }).click();
 await ada.getByRole('button', { name: 'Manage Nina No Groups' }).click();
 await ada.getByRole('button', { name: 'Grant' }).click();
 await expect(ada.getByLabel('Reason (recorded in the audit)')).toBeFocused();
 await ada.getByLabel('Reason (recorded in the audit)').fill('Temporary read access for review');
 await ada.getByLabel('Grant bundle').selectOption('fleet-observer');
 await ada.getByRole('button', { name: 'Grant' }).click();
 await expect(ada.getByText('Granted fleet-observer for Nina No Groups')).toBeVisible();
 expect((await new AxeBuilder({ page: ada }).withTags(tags).analyze()).violations).toEqual([]);

 const nina = await signedIn(browser, 'Nina No Groups');
 expect((await (await nina.request.get('/api/session')).json()).capabilities).toContain('chat.read');
 await ada.getByRole('button', { name: 'Manage Nina No Groups' }).click();
 await ada.getByRole('button', { name: 'Manage Nina No Groups' }).click();
 await ada.getByLabel('Reason (recorded in the audit)').fill('Review finished');
 await ada.getByRole('button', { name: 'Remove granted fleet-observer' }).click();
 await expect(ada.getByText('Removed fleet-observer for Nina No Groups')).toBeVisible();
 expect((await (await nina.request.get('/api/session')).json()).capabilities ?? []).not.toContain('chat.read');
 const audit = (await (await ada.request.get('/api/audit?category=user&limit=50')).json()).events.filter((e: { operation: string }) => e.operation.startsWith('user.bundle_'));
 expect(audit.slice(0, 2).map((e: { operation: string; summary: { reason: string } }) => [e.operation, e.summary.reason])).toEqual([
  ['user.bundle_revoke', 'Review finished'], ['user.bundle_grant', 'Temporary read access for review'],
 ]);
 await ada.context().close(); await nina.context().close();
});
