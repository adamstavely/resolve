import { readFileSync } from 'node:fs';
import { expect, type Browser, type Page } from '@playwright/test';
import { signInAs } from './helpers';

/* Shared setup for the Elastic specs: a fresh connection to the mock and an active Payroll mapping. */
export const ORIGIN = 'http://127.0.0.1:4200';
export const ES = 'http://127.0.0.1:3400', KIBANA = 'http://127.0.0.1:3401';
export const FLEET = 'http://127.0.0.1:3300';
export const json = { Origin: ORIGIN, 'Content-Type': 'application/json' };
export const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const keys: { id: string; secret: string }[] = JSON.parse(readFileSync('tools/mock-elastic/keys.json', 'utf8')).keys;
export const apiKey = (id: string) => { const k = keys.find(x => x.id === id)!; return Buffer.from(`${k.id}:${k.secret}`).toString('base64'); };
export const post = (p: Page, path: string, data: unknown) => p.request.post(path, { headers: json, data: JSON.stringify(data) });

export async function signedIn(browser: Browser, name: string, connect: string[] = []) {
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

/** Reset the mock Elastic and activate a Payroll mapping on a new connection; waits for the first poll. */
export async function payrollMapped(browser: Browser, name: string) {
 await fetch(`${ES}/dev/reset`, { method: 'POST', body: '{}' });
 const ada = await signedIn(browser, 'Ada Admin');
 const conn = await (await post(ada, '/api/admin/integrations/connections', { name, elasticsearchUrl: ES, kibanaUrl: KIBANA, spaceId: 'support-ops', apiKey: apiKey('resolve-reader') })).json();
 const existing = ((await (await ada.request.get('/api/admin/integrations/mappings')).json()).mappings as { appKey: string; version: number }[]).find(m => m.appKey === 'payroll');
 await ada.request.put('/api/admin/integrations/mappings', { headers: json, data: JSON.stringify({ version: existing?.version ?? null, mapping: {
  appKey: 'payroll', environment: 'production', connectionId: conn.id,
  indices: { apm: ['traces-apm-*', 'logs-apm.error-*'], rum: ['traces-apm.rum-*'], logs: ['logs-payroll-*'], synthetics: ['synthetics-*'] },
  services: [{ name: 'payroll-api', environment: 'production', discriminator: null }, { name: 'payroll-web', environment: 'production', discriminator: null },
   { name: 'notification-service', environment: 'production', discriminator: { field: 'labels.app', value: 'payroll' } }],
  sloIds: ['payroll-payslip-availability', 'payroll-login-latency'], monitorIds: ['payroll-login', 'payroll-payslip'], alertRuleIds: ['payroll-api-5xx-eu-west'], caseTags: ['app:payroll'],
  deepLinkBase: 'https://kibana.corp.internal', subjectPolicy: 'verified_external_id', mlJobIds: ['payroll-log-categories'] } }) });
 await post(ada, '/api/admin/integrations/mappings/payroll/production/preview', {});
 const v = await (await post(ada, '/api/admin/integrations/mappings/payroll/production/isolation', {})).json();
 expect((await post(ada, '/api/admin/integrations/mappings/payroll/production/state', { state: 'active', version: v.version })).status()).toBe(200);
 await expect.poll(async () => (await (await ada.request.get('/api/observability/issues')).json()).issues.filter((i: { appKey: string }) => i.appKey === 'payroll').length, { timeout: 20_000 }).toBeGreaterThan(1);
 return ada;
}

/** An open payroll ticket for the given mock customer, visible to this person (reopening one if an earlier run resolved it). */
export async function ticketFor(p: Page, customer: number) {
 try { return await findTicket(p, customer, 'open'); } catch {
  const t = await findTicket(p, customer, 'closed');
  const v = (await (await p.request.get(`/api/apps/payroll/tickets/${t.id}`)).json()).detail.ticket.version;
  expect((await post(p, `/api/apps/payroll/tickets/${t.id}/status`, { statusCategory: 'open', expectedVersion: v })).ok()).toBe(true);
  return t;
 }
}
async function findTicket(p: Page, customer: number, status: string) {
 let cursor: string | null = null;
 for (let i = 0; i < 10; i++) {
  const r = await (await p.request.get('/api/apps/payroll/tickets?statusCategory=' + status + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''))).json();
  const t = r.tickets.find((x: { requesterPrincipalId: string }) => x.requesterPrincipalId === `principal_customer_${customer}`);
  if (t) return t as { id: string; reference: string };
  cursor = r.nextCursor; if (!cursor) break;
 }
 throw new Error(`no ${status} ticket for customer ${customer}`);
}
