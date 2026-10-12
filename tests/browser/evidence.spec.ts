import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/*
 * Requires npm run dev (mock Elastic, mock tenants with QB-OBS-1, the integration worker). Plan 14, E2: customer context
 * beside a ticket (prototype board 1) and evidence snapshots (board 4). Payroll customers 1–6 are verified (cust-n);
 * 7 and 8 are not. cust-1 has payroll errors inside the active issue, RUM sessions from Lisbon and a log line.
 */
const ORIGIN = 'http://127.0.0.1:4200';
const ES = 'http://127.0.0.1:3400', KIBANA = 'http://127.0.0.1:3401';
const json = { Origin: ORIGIN, 'Content-Type': 'application/json' };
const keys: { id: string; secret: string }[] = JSON.parse(readFileSync('tools/mock-elastic/keys.json', 'utf8')).keys;
const apiKey = (id: string) => { const k = keys.find(x => x.id === id)!; return Buffer.from(`${k.id}:${k.secret}`).toString('base64'); };
const RUN = Date.now().toString(36);
const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
test.describe.configure({ mode: 'serial' });

async function signedIn(browser: Browser, name: string, connect: string[] = []) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
 for (const app of connect) {
  await page.goto(`/api/connect/${app}/start`);
  await expect(page.locator('p.notice')).toContainText('Connected to');
 }
 return page;
}
const post = (p: Page, path: string, data: unknown) => p.request.post(path, { headers: json, data: JSON.stringify(data) });
/** A payroll ticket whose requester is the given mock customer, visible to this person. */
async function ticketFor(p: Page, customer: number) {
 let cursor: string | null = null;
 for (let i = 0; i < 10; i++) {
  const r = await (await p.request.get('/api/apps/payroll/tickets' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''))).json();
  const t = r.tickets.find((x: { requesterPrincipalId: string }) => x.requesterPrincipalId === `principal_customer_${customer}`);
  if (t) return t as { id: string; reference: string };
  cursor = r.nextCursor; if (!cursor) break;
 }
 throw new Error(`no ticket for customer ${customer}`);
}

test.beforeAll(async ({ browser }) => {
 await fetch(`${ES}/dev/reset`, { method: 'POST', body: '{}' });
 const ada = await signedIn(browser, 'Ada Admin');
 const conn = await (await post(ada, '/api/admin/integrations/connections', { name: `Evidence ${RUN}`, elasticsearchUrl: ES, kibanaUrl: KIBANA, spaceId: 'support-ops', apiKey: apiKey('resolve-reader') })).json();
 const existing = ((await (await ada.request.get('/api/admin/integrations/mappings')).json()).mappings as { appKey: string; version: number }[]).find(m => m.appKey === 'payroll');
 let v = await (await ada.request.put('/api/admin/integrations/mappings', { headers: json, data: JSON.stringify({ version: existing?.version ?? null, mapping: {
  appKey: 'payroll', environment: 'production', connectionId: conn.id,
  indices: { apm: ['traces-apm-*', 'logs-apm.error-*'], rum: ['traces-apm.rum-*'], logs: ['logs-payroll-*'], synthetics: ['synthetics-*'] },
  services: [{ name: 'payroll-api', environment: 'production', discriminator: null }, { name: 'payroll-web', environment: 'production', discriminator: null },
   { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'payroll' } }],
  sloIds: ['payroll-payslip-availability', 'payroll-login-latency'], monitorIds: ['payroll-login', 'payroll-payslip'], alertRuleIds: ['payroll-api-5xx-eu-west'], caseTags: ['app:payroll'],
  deepLinkBase: 'https://kibana.corp.internal', subjectPolicy: 'verified_external_id' } }) })).json();
 await post(ada, '/api/admin/integrations/mappings/payroll/production/preview', {});
 v = await (await post(ada, '/api/admin/integrations/mappings/payroll/production/isolation', {})).json();
 expect((await post(ada, '/api/admin/integrations/mappings/payroll/production/state', { state: 'active', version: v.version })).status()).toBe(200);
 // Wait for the worker's first poll so known issues exist.
 await expect.poll(async () => (await (await ada.request.get('/api/observability/issues')).json()).issues.filter((i: { appKey: string }) => i.appKey === 'payroll').length, { timeout: 20_000 }).toBeGreaterThan(0);
 await ada.context().close();
});

test("an agent sees the customer's system context beside the ticket, as on the prototype, without restricted detail", async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const t = await ticketFor(sam, 1);
 await sam.goto(`/tickets/payroll/${t.id}`);
 const ctx = sam.getByRole('region', { name: 'System context' });
 await expect(ctx).toContainText('matched on user.id cust-1');
 const incident = ctx.getByRole('region', { name: 'Active incident' });
 await expect(incident).toContainText('Known issue affecting this customer');
 await expect(incident).toContainText(/2 of this customer's errors fall inside this issue's window/);
 await expect(incident).toContainText('About 18 customers affected so far (approximate)');
 const saw = ctx.getByRole('region', { name: 'What the systems saw' });
 await expect(saw).toContainText('upstream connect error or disconnect/reset before headers');
 await expect(saw).toContainText('Page load /payslips');
 await expect(saw).not.toContainText('trace.id');
 const us = ctx.getByRole('region', { name: 'Is it us?' });
 await expect(us).toContainText('Download payslip');
 await expect(us).toContainText("customer's last session Lisbon");
 await expect(us).toContainText('failing for everyone. That points to the service, not this account.');
 await expect(ctx).toContainText('Trace IDs, log patterns, log lines and Kibana links appear for investigators');
 // The timeline toggle hides system events.
 const activity = ctx.getByRole('region', { name: 'Recent activity' });
 await expect(activity.getByText('APM', { exact: true }).first()).toBeVisible();
 await activity.getByRole('button', { name: 'Customer only' }).click();
 await expect(activity.getByText('APM', { exact: true })).toHaveCount(0);
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 await sam.context().close();
});

test('an unidentified customer gets service-level context only, with the reason', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const t = await ticketFor(sam, 7);
 await sam.goto(`/tickets/payroll/${t.id}`);
 const ctx = sam.getByRole('region', { name: 'System context' });
 await expect(ctx).toContainText('Payroll did not identify this customer, so only service-level context is shown.');
 await expect(ctx).toContainText('Customer events need a verified customer id.');
 await expect(ctx).not.toContainText('matched on user.id');
 await sam.context().close();
});

test('capturing a snapshot records what the agent saw and posts an internal note that links to it', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const t = await ticketFor(sam, 1);
 await sam.goto(`/tickets/payroll/${t.id}`);
 const ctx = sam.getByRole('region', { name: 'System context' });
 await ctx.getByRole('button', { name: 'Capture evidence snapshot' }).click();
 await expect(ctx.getByRole('status').filter({ hasText: 'Snapshot captured, and an internal note links to it.' })).toBeVisible();
 await ctx.getByRole('link', { name: 'View the snapshot' }).click();
 await expect(sam).toHaveURL(/\/evidence\//);
 await expect(sam.getByText('Unchanged since capture')).toBeVisible();
 const ev = sam.getByRole('region', { name: 'Evidence snapshot' });
 await expect(ev).toContainText('Service health at time of capture');
 await expect(ev).toContainText('Degraded');
 await expect(ev.getByRole('table', { name: 'Customer events' })).toContainText('inside');
 await expect(ev).toContainText('Last session');
 await expect(ev).toContainText('Already tried');
 await expect(sam.getByRole('region', { name: 'Snapshot record' })).toContainText('Internal note added');
 await expect(sam.getByRole('region', { name: 'Snapshot record' })).toContainText('Customer level');
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 const snapshotUrl = sam.url();
 // The note is in the ticket thread, posted as Sam, carrying the link and not the evidence.
 await sam.goto(`/tickets/payroll/${t.id}`);
 await expect(sam.getByText(/Evidence snapshot captured by Sam Agent/).first()).toBeVisible();
 // An agent cannot export.
 const id = snapshotUrl.split('/evidence/')[1];
 expect((await sam.request.get(`/api/evidence/${id}?download=1`)).status()).toBe(403);
 await sam.context().close();
});

test('an investigator sees trace ids, Kibana links and redacted log lines; their snapshot hides those from agents', async ({ browser }) => {
 const ivy = await signedIn(browser, 'Ivy Investigator', ['payroll']);
 const t = await ticketFor(ivy, 1);
 await ivy.goto(`/tickets/payroll/${t.id}`);
 const ctx = ivy.getByRole('region', { name: 'System context' });
 await expect(ctx.getByRole('region', { name: 'What the systems saw' })).toContainText('trace.id');
 await expect(ctx.getByRole('link', { name: /Open trace in Kibana/ }).first()).toHaveAttribute('href', /^https:\/\/kibana\.corp\.internal\/app\/apm\/link-to\/trace\//);
 const logs = ctx.getByRole('region', { name: /Log lines/ });
 await expect(logs).toContainText('upstream reset');
 await expect(logs).toContainText('[credential]');
 await expect(logs).not.toContainText('eyJhbGci');
 await expect(logs).not.toContainText('4111');
 await ctx.getByRole('button', { name: 'Capture evidence snapshot' }).click();
 await ctx.getByRole('link', { name: 'View the snapshot' }).click();
 await expect(ivy.getByRole('region', { name: 'Snapshot record' })).toContainText('Restricted');
 const id = ivy.url().split('/evidence/')[1];
 const exported = await ivy.request.get(`/api/evidence/${id}?download=1`);
 expect(exported.status()).toBe(200);
 expect(exported.headers()['content-disposition']).toContain('attachment');
 await ivy.context().close();

 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 await sam.goto(`/evidence/${id}`);
 await expect(sam.getByText(/trace ids, log lines and log patterns are in this snapshot\. They are shown to investigators\./)).toBeVisible();
 const asSam = await (await sam.request.get(`/api/evidence/${id}`)).json();
 expect(asSam.facts.restricted).toEqual({ logs: [], traces: [] });
 expect(asSam.hiddenRestricted).toBeGreaterThan(0);
 await sam.context().close();
});

test('observers get no customer context; a person who cannot see the ticket cannot see its context or snapshots', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const t = await ticketFor(sam, 1);
 const snapshotId = (await (await sam.request.get(`/api/apps/payroll/tickets/${t.id}/evidence`)).json()).snapshots[0].id;
 await sam.context().close();

 const olive = await signedIn(browser, 'Olive Observer', ['payroll']);
 expect((await olive.request.get(`/api/apps/payroll/tickets/${t.id}/observability`)).status()).toBe(403);
 await olive.goto(`/tickets/payroll/${t.id}`);
 await expect(olive.getByRole('heading', { level: 1 })).toBeVisible();
 await expect(olive.getByRole('region', { name: 'System context' })).toHaveCount(0);
 await olive.context().close();

 // Bo works the billing team: Sam's support-team ticket is not visible to Bo in Payroll.
 const bo = await signedIn(browser, 'Bo Blockable', ['payroll']);
 const seen = await bo.request.get(`/api/apps/payroll/tickets/${t.id}`);
 if (seen.status() === 404) {
  expect((await bo.request.get(`/api/apps/payroll/tickets/${t.id}/observability`)).status()).toBe(404);
  expect((await bo.request.get(`/api/evidence/${snapshotId}`)).status()).toBe(404);
 }
 await bo.context().close();
});
