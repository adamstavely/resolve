import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/*
 * Phase 2 exit criteria (plan 00) against the mock fleet (npm run dev + npm run dev:seed):
 * direct-ID authorization, partial failures, no passive wake of dormant apps, per-app pagination.
 */
const ORIGIN = 'http://127.0.0.1:4200';
const TENANT = { payroll: 'http://127.0.0.1:3301', hr: 'http://127.0.0.1:3302', legal: 'http://127.0.0.1:3304' };
const tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

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
const getJson = async (page: Page, path: string) => (await page.request.get(path)).json();
const tenant = (app: keyof typeof TENANT, path: string, body?: unknown) =>
 fetch(TENANT[app] + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());

/** All ticket IDs one user can page through in one app, via the per-app cursor. */
async function allTickets(page: Page, app: string) {
 const ids: string[] = []; let cursor: string | null = null;
 do {
  const p = await getJson(page, `/api/apps/${app}/tickets` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
  ids.push(...p.tickets.map((t: { id: string }) => t.id)); cursor = p.nextCursor;
 } while (cursor);
 return ids;
}

test('KPI totals cover reporting apps only and name the missing ones', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll', 'hr']);
 const d = await getJson(sam, '/api/dashboard');
 expect(d.apps.map((a: { appKey: string; status: string; reason?: string }) => `${a.appKey}:${a.reason ?? a.status}`)).toEqual(['payroll:ok', 'hr:ok', 'facilities:suspended', 'legal:dormant']);
 expect(d.totals.openTickets.included).toEqual(['payroll', 'hr']);
 expect(d.totals.openTickets.missing).toEqual([{ appKey: 'facilities', reason: 'suspended' }, { appKey: 'legal', reason: 'dormant' }]);
 const tile = sam.getByRole('listitem').filter({ hasText: 'Open tickets' });
 await expect(tile).toContainText(String(d.totals.openTickets.value));
 await expect(tile).toContainText('2 of 4 applications · Facilities suspended, Legal Ops idle');
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 await sam.context().close();
});

test('a dormant app is never woken by the passive dashboard, only by an explicit load', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin', ['payroll', 'legal']);
 await tenant('legal', '/dev/reset-stats', {});
 await ada.goto('/');
 await expect(ada.getByRole('listitem').filter({ hasText: 'Open tickets' })).toContainText('Legal Ops idle');
 await ada.getByRole('button', { name: 'Refresh' }).click();
 await expect(ada.getByRole('listitem').filter({ hasText: 'Open tickets' })).toContainText('Legal Ops idle');
 expect(await tenant('legal', '/dev/stats')).toEqual({ toolCalls: 0, protocolCalls: 0 });

 await ada.getByRole('button', { name: 'Load Legal Ops' }).click();
 await expect(ada.getByRole('listitem').filter({ hasText: 'Open tickets' })).not.toContainText('Legal Ops idle');
 expect((await tenant('legal', '/dev/stats')).toolCalls).toBeGreaterThan(0);
 await ada.context().close();
});

test('per-app pagination neither loses nor repeats tickets', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin', ['payroll']);
 const ids = await allTickets(ada, 'payroll');
 expect(ids).toHaveLength(130);
 expect(new Set(ids).size).toBe(130);

 await ada.goto('/tickets');
 await ada.getByLabel('Status').selectOption('');
 const section = ada.getByRole('region', { name: 'Payroll' });
 await expect(section.getByRole('row')).toHaveCount(26); // header + first page of 25
 for (let i = 0; i < 5; i++) await section.getByRole('button', { name: 'Load more from Payroll' }).click().catch(() => {});
 await expect(section.getByRole('button', { name: 'Load more from Payroll' })).toHaveCount(0);
 const refs = await section.locator('tbody tr .ref').allTextContents();
 expect(refs).toHaveLength(130);
 expect(new Set(refs).size).toBe(130);
 await ada.context().close();
});

test('direct IDs outside the caller’s access are not found, for tickets and conversations', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin', ['payroll']);
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const visibleToSam = new Set(await allTickets(sam, 'payroll'));
 const hidden = (await allTickets(ada, 'payroll')).find(id => !visibleToSam.has(id))!;
 expect(hidden).toBeTruthy();
 const r = await sam.request.get(`/api/apps/payroll/tickets/${hidden}`);
 expect(r.status()).toBe(404);
 expect((await ada.request.get(`/api/apps/payroll/tickets/${hidden}`)).status()).toBe(200);
 await sam.goto(`/tickets/payroll/${hidden}`);
 await expect(sam.getByRole('heading', { name: 'Ticket unavailable' })).toBeVisible();
 await expect(sam.getByRole('alert')).toHaveText('Not found, or you do not have access to it.');

 const samConvs = new Set((await getJson(sam, '/api/apps/payroll/conversations')).conversations.map((c: { id: string }) => c.id));
 const hiddenConv = (await getJson(ada, '/api/apps/payroll/conversations')).conversations.map((c: { id: string }) => c.id).find((id: string) => !samConvs.has(id));
 expect((await sam.request.get(`/api/apps/payroll/conversations/${hiddenConv}`)).status()).toBe(404);
 await ada.context().close(); await sam.context().close();
});

test('one failing app does not hide the others', async ({ browser }) => {
 // Faults are injected for this user only, so parallel tests are unaffected.
 const sam = await signedIn(browser, 'Sam Duplicate', ['payroll', 'hr']);
 await tenant('hr', '/dev/fail', { mode: 'error', sub: 'mock|sam-imposter' });
 try {
  const res = await getJson(sam, '/api/tickets?statusCategory=open');
  expect(res.apps.find((a: { appKey: string }) => a.appKey === 'hr')).toMatchObject({ status: 'unavailable', reason: 'tenant_error', retryable: true });
  expect(res.apps.find((a: { appKey: string }) => a.appKey === 'payroll').status).toBe('ok');
  await sam.goto('/tickets');
  await expect(sam.getByRole('region', { name: 'HR Platform' })).toContainText('The application did not respond as expected.');
  await expect(sam.getByRole('region', { name: 'Payroll' }).getByRole('row').nth(1)).toBeVisible();
  expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);

  await tenant('hr', '/dev/fail', { mode: 'timeout', sub: 'mock|sam-imposter' });
  const slow = await getJson(sam, '/api/dashboard');
  expect(slow.apps.find((a: { appKey: string }) => a.appKey === 'hr')).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  expect(slow.totals.openTickets.included).toEqual(['payroll']);
 } finally {
  await tenant('hr', '/dev/fail', { mode: null, sub: 'mock|sam-imposter' });
 }
 await sam.context().close();
});

test('missing analytics permission is reported, never counted as zero', async ({ browser }) => {
 const olive = await signedIn(browser, 'Olive Observer', ['payroll', 'hr']);
 const d = await getJson(olive, '/api/dashboard');
 expect(d.totals.openTickets.missing).toContainEqual({ appKey: 'hr', reason: 'not_permitted' });
 expect(d.totals.openTickets.included).toEqual(['payroll']);
 await expect(olive.getByRole('listitem').filter({ hasText: 'Open tickets' })).toContainText('HR Platform no analytics access');
 await olive.context().close();
});

test('detail pages show the thread and pass axe', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 await sam.goto('/tickets');
 const first = sam.getByRole('region', { name: 'Payroll' }).getByRole('link').first();
 const title = (await first.textContent())!.replace(/^\S+\s/, '').trim();
 await first.click();
 await expect(sam.getByRole('heading', { level: 1, name: title })).toBeFocused();
 await expect(sam.getByRole('list', { name: 'Messages' }).getByRole('listitem').first()).toBeVisible();
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 await sam.getByRole('link', { name: 'All tickets' }).click();
 await expect(sam.getByRole('heading', { level: 1, name: 'Tickets' })).toBeFocused();
 await sam.context().close();
});

test('capabilities gate the read API', async ({ browser }) => {
 const bea = await signedIn(browser, 'Bea Broadcaster');
 for (const path of ['/api/tickets', '/api/conversations', '/api/dashboard', '/api/apps/payroll/tickets']) expect((await bea.request.get(path)).status(), path).toBe(403);
 await expect(bea.getByRole('link', { name: 'Tickets' })).toHaveCount(0);
 await bea.context().close();
});
