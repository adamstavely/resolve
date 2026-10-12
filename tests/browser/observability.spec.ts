import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/*
 * Requires npm run dev (mock Elastic and the integration worker). Plan 14, E1: mappings, service health and known
 * issues. Tests run in order: the first maps Payroll through the UI, the second maps HR through the API.
 */
const ORIGIN = 'http://127.0.0.1:4200';
const ES = 'http://127.0.0.1:3400', KIBANA = 'http://127.0.0.1:3401';
const json = { Origin: ORIGIN, 'Content-Type': 'application/json' };
const keys: { id: string; secret: string }[] = JSON.parse(readFileSync('tools/mock-elastic/keys.json', 'utf8')).keys;
const apiKey = (id: string) => { const k = keys.find(x => x.id === id)!; return Buffer.from(`${k.id}:${k.secret}`).toString('base64'); };
const RUN = Date.now().toString(36);
const CONN_NAME = `Health ${RUN}`;
test.describe.configure({ mode: 'serial' });

async function signedIn(browser: Browser, name: string) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
 return page;
}
const post = (p: Page, path: string, data: unknown) => p.request.post(path, { headers: json, data: JSON.stringify(data) });
async function connectionId(p: Page) {
 const list = (await (await p.request.get('/api/admin/integrations/connections')).json()).connections as { id: string; name: string; version: number; killSwitch: boolean }[];
 return list.find(c => c.name === CONN_NAME)!;
}

test.beforeAll(async ({ browser }) => {
 await fetch(`${ES}/dev/reset`, { method: 'POST', body: '{}' });
 const ada = await signedIn(browser, 'Ada Admin');
 expect((await post(ada, '/api/admin/integrations/connections', { name: CONN_NAME, elasticsearchUrl: ES, kibanaUrl: KIBANA, spaceId: 'support-ops', apiKey: apiKey('resolve-reader') })).status()).toBe(201);
 await ada.context().close();
});

test('an admin maps Payroll: saved as a draft, previewed, checked for isolation, then activated', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 await ada.goto('/integrations');
 await ada.getByRole('row', { name: /Payroll/ }).getByRole('link', { name: /(Map|Edit) Payroll/ }).click();
 await expect(ada.getByRole('heading', { name: 'Elastic mapping: Payroll', level: 1 })).toBeVisible();
 await ada.getByLabel('Elastic connection').selectOption({ label: CONN_NAME });
 const services = ada.getByLabel('Services (required)');
 await services.fill('payroll-api production\nnotification-service production labels.app');
 await ada.getByRole('button', { name: /Save (draft|changes)/ }).click();
 await expect(ada.getByText('third part must be labels.app=value').first()).toBeVisible();
 await expect(services).toBeFocused();
 await services.fill('payroll-api production\npayroll-web production\nnotification-service production labels.app=payroll');
 await ada.getByLabel('SLO ids').fill('payroll-payslip-availability, payroll-login-latency');
 await ada.getByLabel('Synthetic monitor ids').fill('payroll-login, payroll-payslip');
 await ada.getByLabel('Alerting rule ids').fill('payroll-api-5xx-eu-west');
 await ada.getByLabel('Case tags').fill('app:payroll');
 await ada.getByLabel('Log data streams').fill('logs-payroll-*');
 await ada.getByRole('button', { name: /Save (draft|changes)/ }).click();
 await expect(ada.getByRole('status').filter({ hasText: 'Saved as a draft' })).toBeVisible();
 await expect(ada.getByRole('button', { name: 'Activate' })).toBeDisabled();

 await ada.getByLabel('Known test customer id (optional)').fill('cust-1');
 await ada.getByRole('button', { name: 'Run preview' }).click();
 await expect(ada.getByRole('status').filter({ hasText: 'Preview passed.' })).toBeVisible();
 const preview = ada.getByRole('table', { name: /Preview passed/ });
 await expect(preview).toContainText('events for the test customer');
 await expect(preview.getByRole('row', { name: /^SLOs/ })).toContainText('Found');
 await ada.getByRole('button', { name: 'Run isolation check' }).click();
 await expect(ada.getByRole('status').filter({ hasText: 'Isolation check passed.' })).toBeVisible();
 await ada.getByRole('button', { name: 'Activate' }).click();
 await expect(ada.getByRole('status').filter({ hasText: 'Active.' })).toBeVisible();

 const axe = await new AxeBuilder({ page: ada }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
 expect(axe.violations).toEqual([]);
 await ada.context().close();
});

test('HR shares a service with Payroll: without its discriminator the isolation check fails and activation is refused', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const conn = await connectionId(ada);
 const existing = ((await (await ada.request.get('/api/admin/integrations/mappings')).json()).mappings as { appKey: string; version: number }[]).find(m => m.appKey === 'hr');
 const hr = (services: unknown[]) => ({
  appKey: 'hr', environment: 'production', connectionId: conn.id, indices: { apm: ['traces-apm-*', 'logs-apm.error-*'], rum: [], logs: [], synthetics: ['synthetics-*'] },
  services, sloIds: ['hr-availability'], monitorIds: ['hr-login'], alertRuleIds: ['hr-api-errors'], caseTags: ['app:hr'], deepLinkBase: null, subjectPolicy: 'verified_external_id',
 });
 let v = await (await ada.request.put('/api/admin/integrations/mappings', { headers: json, data: JSON.stringify({ mapping: hr([{ name: 'hr-api', environment: 'production', discriminator: null }, { name: 'notification-service', environment: 'production', discriminator: null }]), version: existing?.version ?? null }) })).json();
 v = await (await post(ada, '/api/admin/integrations/mappings/hr/production/preview', {})).json();
 v = await (await post(ada, '/api/admin/integrations/mappings/hr/production/isolation', {})).json();
 expect(v.isolation).toMatchObject({ passed: false, comparedWith: [{ appKey: 'payroll', overlappingEvents: expect.any(Number) }] });
 expect(v.isolation.comparedWith[0].overlappingEvents).toBeGreaterThan(0);
 const refused = await post(ada, '/api/admin/integrations/mappings/hr/production/state', { state: 'active', version: v.version });
 expect(refused.status()).toBe(409);
 expect((await refused.json()).error.code).toBe('CHECKS_REQUIRED');

 v = await (await ada.request.put('/api/admin/integrations/mappings', { headers: json, data: JSON.stringify({ mapping: hr([{ name: 'hr-api', environment: 'production', discriminator: null }, { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'hr' } }]), version: v.version }) })).json();
 await post(ada, '/api/admin/integrations/mappings/hr/production/preview', {});
 v = await (await post(ada, '/api/admin/integrations/mappings/hr/production/isolation', {})).json();
 expect(v.isolation.passed).toBe(true);
 expect((await post(ada, '/api/admin/integrations/mappings/hr/production/state', { state: 'active', version: v.version })).status()).toBe(200);
 await ada.context().close();
});

test('application cards show live health like the prototype: status, current issue, SLO, alerts and the synthetic run strip', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 // Tiers are reported by each application with Sam's own grant.
 for (const app of ['payroll', 'hr']) {
  await sam.goto(`/api/connect/${app}/start`);
  await expect(sam.locator('p.notice')).toContainText('Connected to');
 }
 await sam.goto('/');
 const apps = sam.getByRole('region', { name: 'Your applications · live health' });
 const payroll = apps.getByRole('article', { name: 'Payroll' });
 await expect(payroll).toContainText('Degraded', { timeout: 20_000 });
 await expect(payroll).toContainText('Payslip downloads failing in EU-West');
 await expect(payroll).toContainText('Payslip downloads available 99.5% · burning 4.2x');
 await expect(payroll).toContainText('Your clearance T2');
 await expect(payroll).not.toContainText('Your connection');
 await expect(apps.getByRole('article', { name: 'HR Platform' })).toContainText('Your clearance T1');
 await expect(payroll).not.toContainText('What was checked');
 await expect(payroll.locator('.hrow', { hasText: 'Active alerts' })).toHaveText(/Active alerts\s*1$/);
 await expect(payroll).toContainText(/\d+\/\d+/);
 await expect(payroll).toContainText(/runs passed; failing now: Download payslip \(eu-west\)/);
 await expect(apps.getByRole('article', { name: 'HR Platform' })).toContainText('Operational', { timeout: 20_000 });
 await expect(apps.getByRole('article', { name: 'HR Platform' })).toContainText('All within budget');
 await expect(apps.getByRole('article', { name: 'Legal Ops' })).toContainText('Not connected to Elastic');
 await expect(apps).toContainText('Health from Elastic SLOs, alerting rules and Synthetics · refreshed');
 await expect(sam.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /Payroll.*service degraded/ })).toBeVisible();
 await expect(sam.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /HR Platform/ })).not.toContainText('service');

 const issues = sam.getByRole('region', { name: 'Known issues' });
 await expect(issues).toContainText('Payslip downloads failing in EU-West');
 await expect(issues).toContainText('Failed transaction rate is 7.8%');
 await expect(issues).toContainText('About 18 affected customers');
 await expect(issues).not.toContainText('dev-secret');
 const axe = await new AxeBuilder({ page: sam }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
 expect(axe.violations).toEqual([]);

 // The card opens the application's page, where the detail behind it lives.
 await payroll.getByRole('link', { name: 'Payroll' }).click();
 await expect(sam).toHaveURL(/\/apps\/payroll$/);
 await expect(sam.getByRole('heading', { name: 'Payroll', level: 1 })).toBeVisible();
 const checked = sam.getByRole('region', { name: 'What was checked' });
 await expect(checked.getByRole('row', { name: /^Payslip downloads available/ })).toContainText('99.61% against 99.5% (30d rolling)');
 await expect(checked.getByRole('row', { name: /Download payslip · eu-west/ })).toContainText('Degraded');
 await expect(checked.getByRole('row', { name: /^Alerts/ })).toContainText('1 active');
 await expect(checked).toContainText('Recent synthetic runs');
 await expect(sam.getByRole('region', { name: 'Known issues' })).toContainText('Payslip downloads failing in EU-West');
 await expect(sam.getByRole('region', { name: 'Known issues' })).not.toContainText('HR');
 const axe2 = await new AxeBuilder({ page: sam }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
 expect(axe2.violations).toEqual([]);
 await sam.context().close();
});

test('an agent links a ticket to a known issue after choosing it; observers cannot link', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 // Act in Payroll as Sam (connects, or refreshes a connection the mock tenants forgot on restart).
 await sam.goto('/api/connect/payroll/start');
 await expect(sam.locator('p.notice')).toContainText('Connected to');
 // A ticket that changes during the issue becomes a candidate.
 const tickets = (await (await sam.request.get('/api/apps/payroll/tickets?statusCategory=open')).json());
 const ticket = tickets.tickets[0];
 expect((await post(sam, `/api/apps/payroll/tickets/${ticket.id}/messages`, { kind: 'note', content: 'Customer reports payslip download errors.', operationId: crypto.randomUUID() })).ok()).toBe(true);
 await sam.goto('/');
 const issue = sam.getByRole('region', { name: 'Known issues' }).getByRole('listitem').filter({ hasText: 'Failed transaction rate' });
 await issue.getByRole('button', { name: /Link tickets/ }).click();
 const review = sam.getByRole('group', { name: /Link tickets to/ });
 const box = review.getByRole('checkbox', { name: new RegExp(ticket.reference) });
 await expect(box).not.toBeChecked();
 await expect(review).toContainText('nothing is pre-selected');
 await expect(review.getByRole('button', { name: /Link 0 tickets/ })).toBeDisabled();
 await box.check();
 await review.getByRole('button', { name: 'Link 1 ticket' }).click();
 await expect(sam.getByText(/Linked 1 ticket to/).first()).toBeVisible();
 await expect(issue).toContainText(/[1-9]\d* linked ticket/);
 // Connected now, so the card footer carries the app's open-ticket count (the support figure, not Elastic).
 await sam.reload();
 await expect(sam.getByRole('article', { name: 'Payroll' })).toContainText(/\d+ open tickets/);
 // A hidden or invented ticket is refused by the tenant check.
 const issueId = (await (await sam.request.get('/api/observability/issues')).json()).issues.find((i: { title: string }) => i.title.includes('Failed transaction')).id;
 const r = await (await post(sam, `/api/apps/payroll/observability/issues/${issueId}/links`, { requestId: crypto.randomUUID(), ticketIds: ['ticket_payroll_999999'] })).json();
 expect(r).toMatchObject({ linked: [], refused: [{ ticketId: 'ticket_payroll_999999', reason: 'not_found' }] });
 await sam.context().close();

 const olive = await signedIn(browser, 'Olive Observer');
 await expect(olive.getByRole('region', { name: 'Your applications · live health' }).getByRole('article', { name: 'Payroll' })).toContainText('Degraded');
 await expect(olive.getByRole('region', { name: 'Known issues' })).toContainText('Payslip downloads failing');
 await expect(olive.getByRole('button', { name: /Link tickets/ })).toHaveCount(0);
 expect((await post(olive, `/api/apps/payroll/observability/issues/${issueId}/links`, { requestId: crypto.randomUUID(), ticketIds: [ticket.id] })).status()).toBe(403);
 await olive.context().close();
});

test('the kill switch empties health at once, live; chat keeps working while Elastic is down', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 const payroll = sam.getByRole('region', { name: 'Your applications · live health' }).getByRole('article', { name: 'Payroll' });
 await expect(payroll).toContainText('Degraded', { timeout: 20_000 });
 const ada = await signedIn(browser, 'Ada Admin');
 const conn = await connectionId(ada);
 const on = await (await post(ada, `/api/admin/integrations/connections/${conn.id}/kill-switch`, { killSwitch: true, reason: 'Drill', version: conn.version })).json();
 try {
  // No reload: the stream tells the page to re-read.
  await expect(payroll).toContainText('Elastic reads switched off by an administrator');
  await expect(sam.getByRole('region', { name: 'Known issues' })).toContainText('No known issues right now');
 } finally {
  await post(ada, `/api/admin/integrations/connections/${conn.id}/kill-switch`, { killSwitch: false, reason: 'Drill over', version: on.version });
 }
 await fetch(`${ES}/dev/fault`, { method: 'POST', body: JSON.stringify({ kind: 'unavailable' }) });
 try {
  await sam.goto('/inbox');
  await expect(sam.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  expect((await sam.request.get('/api/apps/payroll/conversations')).ok()).toBe(true);
  expect((await sam.request.get('/api/apps/payroll/tickets')).ok()).toBe(true);
 } finally {
  await fetch(`${ES}/dev/fault`, { method: 'POST', body: JSON.stringify({ kind: 'none' }) });
 }
 await ada.context().close();
 await sam.context().close();
});
