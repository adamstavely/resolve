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
 await expect(page.getByRole('button', { name: `${name}, account and availability` })).toBeVisible();
 for (const app of connect) {
  await page.goto(`/api/connect/${app}/start`);
  await expect(page.locator('p.notice')).toContainText('Connected to');
 }
 // Connecting returns to the application's page; these tests start from Home.
 if (connect.length) await page.goto('/');
 return page;
}
const getJson = async (page: Page, path: string) => (await page.request.get(path)).json();
const tenant = (app: keyof typeof TENANT, path: string, body?: unknown) =>
 fetch(TENANT[app] + path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());

/** All ticket IDs one user can page through in one app, via the per-app cursor. */
async function allTickets(page: Page, app: string, status?: string) {
 const ids: string[] = []; let cursor: string | null = null;
 do {
  const q = new URLSearchParams({ ...(status ? { statusCategory: status } : {}), ...(cursor ? { cursor } : {}) });
  const p = await getJson(page, `/api/apps/${app}/tickets?` + q);
  ids.push(...p.tickets.map((t: { id: string }) => t.id)); cursor = p.nextCursor;
 } while (cursor);
 return ids;
}

test('KPI totals cover reporting apps only and name the missing ones', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll', 'hr']);
 const d = await getJson(sam, '/api/dashboard');
 // Other specs onboard more apps into the same mock fleet; check the fixture apps and derive the totals.
 const FIXTURE = ['payroll', 'hr', 'facilities', 'legal'];
 expect(d.apps.filter((a: { appKey: string }) => FIXTURE.includes(a.appKey)).map((a: { appKey: string; status: string; reason?: string }) => `${a.appKey}:${a.reason ?? a.status}`))
  .toEqual(['payroll:ok', 'hr:ok', 'facilities:suspended', 'legal:dormant']);
 expect(d.totals.openTickets.included.filter((k: string) => FIXTURE.includes(k))).toEqual(['payroll', 'hr']);
 expect(d.totals.openTickets.missing.filter((m: { appKey: string }) => FIXTURE.includes(m.appKey))).toEqual([{ appKey: 'facilities', reason: 'suspended' }, { appKey: 'legal', reason: 'dormant' }]);
 // Prototype v2 has no KPI tiles: each application card carries its own open-ticket figure, and none when the
 // application did not report one (never a zero).
 const card = (name: string) => sam.getByRole('article', { name });
 const payrollOpen = d.apps.find((a: { appKey: string }) => a.appKey === 'payroll').data.metrics.openTickets.value;
 await expect(card('Payroll')).toContainText(`${payrollOpen} open tickets`);
 await expect(card('Legal Ops')).not.toContainText('open tickets');
 await expect(card('Facilities')).toContainText('Unavailable');
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 await sam.context().close();
});

test('a dormant app is never woken by the passive dashboard, only by an explicit load', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin', ['payroll', 'legal']);
 await tenant('legal', '/dev/reset-stats', {});
 await ada.goto('/');
 await expect(ada.getByRole('article', { name: 'Legal Ops' })).not.toContainText('open tickets');
 await ada.goto('/tickets');
 await ada.getByRole('button', { name: 'All open' }).click();
 await expect(ada.getByRole('button', { name: 'Load Legal Ops tickets' })).toBeVisible();
 expect(await tenant('legal', '/dev/stats')).toEqual({ toolCalls: 0, protocolCalls: 0 });

 await ada.getByRole('button', { name: 'Load Legal Ops tickets' }).click();
 await expect(ada.getByRole('button', { name: 'Load Legal Ops tickets' })).toHaveCount(0);
 expect((await tenant('legal', '/dev/stats')).toolCalls).toBeGreaterThan(0);
 await ada.context().close();
});

test('per-app pagination neither loses nor repeats tickets', async ({ browser }) => {
 test.setTimeout(90_000);
 const ada = await signedIn(browser, 'Ada Admin', ['payroll']);
 const ids = await allTickets(ada, 'payroll');
 expect(ids).toHaveLength(130);
 expect(new Set(ids).size).toBe(130);

 // My tickets lists open and waiting tickets, a page per application and status, with "Load more" per application.
 const expected = [...await allTickets(ada, 'payroll', 'open'), ...await allTickets(ada, 'payroll', 'pending')];
 await ada.goto('/tickets');
 await ada.getByRole('button', { name: 'All open' }).click();
 const rows = ada.locator('a.case-row[href^="/tickets/payroll/"]');
 const more = ada.getByRole('button', { name: 'Load more from Payroll' });
 // Payroll has more than one page of open tickets, so the first page offers more.
 await expect(more).toBeVisible();
 for (let i = 0; i < 12 && await more.count(); i++) {
  // The button is relabelled while a page loads and removed after the last one, so a click may find it gone.
  await more.click({ timeout: 5_000 }).catch(() => undefined);
  await expect(ada.getByRole('button', { name: /Loading…/ })).toHaveCount(0);
 }
 await expect(ada.getByRole('button', { name: 'Load more from Payroll' })).toHaveCount(0);
 const hrefs = await rows.evaluateAll(els => els.map(e => e.getAttribute('href')));
 expect(hrefs).toHaveLength(expected.length);
 expect(new Set(hrefs).size).toBe(expected.length);
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
  await sam.getByRole('button', { name: 'All open' }).click();
  await expect(sam.getByRole('main')).toContainText('HR Platform: The application did not respond as expected.');
  await expect(sam.locator('a.case-row[href^="/tickets/payroll/"]').first()).toBeVisible();
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
 await expect(olive.getByRole('article', { name: 'HR Platform' })).not.toContainText('open tickets');
 await expect(olive.getByRole('article', { name: 'Payroll' })).toContainText('open tickets');
 await olive.context().close();
});

test('detail pages show the thread and pass axe', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 await sam.goto('/tickets');
 await sam.getByRole('button', { name: 'All open' }).click();
 const first = sam.locator('a.case-row[href^="/tickets/payroll/"]').first();
 const title = (await first.locator('.subj').textContent())!.trim();
 await first.click();
 await expect(sam.getByRole('heading', { level: 1, name: title })).toBeFocused();
 await expect(sam.getByRole('list', { name: 'Messages' }).getByRole('listitem').first()).toBeVisible();
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 await sam.getByRole('main').getByRole('link', { name: 'My tickets' }).click();
 await expect(sam.getByRole('heading', { level: 1, name: 'My tickets' })).toBeFocused();
 await sam.context().close();
});

test('capabilities gate the read API', async ({ browser }) => {
 const bea = await signedIn(browser, 'Bea Broadcaster');
 for (const path of ['/api/tickets', '/api/conversations', '/api/dashboard', '/api/apps/payroll/tickets']) expect((await bea.request.get(path)).status(), path).toBe(403);
 await expect(bea.getByRole('link', { name: /My tickets/ })).toHaveCount(0);
 await bea.context().close();
});
