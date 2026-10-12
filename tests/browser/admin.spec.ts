import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/* Requires npm run dev. Uses "Bo Blockable", whom no other test signs in as. */
const ORIGIN = 'http://127.0.0.1:4200';
const json = { Origin: ORIGIN, 'Content-Type': 'application/json' };

async function signedIn(browser: Browser, name: string) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
 return page;
}
const findUser = async (page: Page, q: string) => (await (await page.request.get('/api/admin/users?q=' + encodeURIComponent(q))).json()).users;
const setAccess = (page: Page, userId: string, data: unknown, headers: Record<string, string> = json) =>
 page.request.post(`/api/admin/users/${userId}/access`, { headers, data: JSON.stringify(data) });

test('non-admins cannot use the admin API', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 expect((await sam.request.get('/api/admin/users')).status()).toBe(403);
 expect((await setAccess(sam, crypto.randomUUID(), { enabled: false, reason: 'testing' })).status()).toBe(403);
 expect((await sam.request.put('/api/admin/apps/payroll/client', { headers: json, data: JSON.stringify({ clientId: 'x', clientSecret: 'y'.repeat(20) }) })).status()).toBe(403);
 await expect(sam.getByRole('heading', { name: 'Audit' })).toHaveCount(0);
 await sam.context().close();
});

test('an admin blocks a person immediately and lifts the block; both are audited with the reason', async ({ browser }) => {
 const bo = await signedIn(browser, 'Bo Blockable');
 const ada = await signedIn(browser, 'Ada Admin');
 const [target] = await findUser(ada, 'Bo Blockable');
 expect(target).toMatchObject({ displayName: 'Bo Blockable', enabled: true, bundles: ['fleet-agent'] });
 try {
  const r = await setAccess(ada, target.id, { enabled: false, reason: 'Lost laptop reported' });
  expect(await r.json()).toEqual({ result: 'changed', enabled: false });
  expect(await (await bo.request.get('/api/session')).json()).toEqual({ authenticated: false });
  // A new sign-in is refused while blocked, even with a valid IdP session.
  await bo.context().clearCookies();
  await signInAs(bo, 'Bo Blockable');
  await expect(bo.getByRole('alert')).toHaveText(/account is disabled/);
 } finally {
  expect((await setAccess(ada, target.id, { enabled: true, reason: 'Laptop recovered' })).ok()).toBe(true);
 }
 await signInAs(bo, 'Bo Blockable');
 await expect(bo.getByText('Signed in as Bo Blockable')).toBeVisible();

 await ada.goto('/audit');
 await ada.getByLabel('Activity').selectOption('user');
 const row = ada.getByRole('row').filter({ hasText: 'Blocked access' }).first();
 await expect(row).toContainText('Ada Admin');
 await expect(row).toContainText('reason: Lost laptop reported');
 await expect(ada.getByRole('row').filter({ hasText: 'Lifted an access block' }).first()).toContainText('Laptop recovered');
 expect((await new AxeBuilder({ page: ada }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
 await bo.context().close(); await ada.context().close();
});

test('access changes require a reason, JSON, the same origin, and cannot target yourself', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const [self] = await findUser(ada, 'Ada Admin');
 const [bo] = await findUser(ada, 'Bo Blockable');
 expect((await setAccess(ada, self.id, { enabled: false, reason: 'Testing self' })).status()).toBe(409);
 expect((await setAccess(ada, bo.id, { enabled: false, reason: '' })).status()).toBe(400);
 expect((await setAccess(ada, bo.id, { enabled: false, reason: 'Cross-site' }, { ...json, Origin: 'https://evil.example' })).status()).toBe(403);
 expect((await setAccess(ada, bo.id, { enabled: false, reason: 'Form post' }, { Origin: ORIGIN, 'Content-Type': 'text/plain' })).status()).toBe(400);
 expect((await setAccess(ada, 'not-a-uuid', { enabled: false, reason: 'Bad id' })).status()).toBe(404);
 expect((await findUser(ada, 'Bo Blockable'))[0].enabled).toBe(true);
 await ada.context().close();
});

test('an admin registers a tenant client; the secret is never returned or audited', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const fleet = JSON.parse(readFileSync('tools/mock-tenant/tenants.json', 'utf8'));
 const hr = fleet.tenants.find((t: { appKey: string }) => t.appKey === 'hr').resolveClient;
 const r = await ada.request.put('/api/admin/apps/hr/client', { headers: json, data: JSON.stringify({ clientId: hr.id, clientSecret: hr.secret }) });
 expect(await r.json()).toEqual({ appKey: 'hr', clientId: hr.id });
 expect((await ada.request.put('/api/admin/apps/unknown-app/client', { headers: json, data: JSON.stringify({ clientId: 'x', clientSecret: 'y'.repeat(20) }) })).status()).toBe(404);
 const audit = await (await ada.request.get('/api/audit?category=app')).text();
 expect((await ada.request.get('/api/audit?category=nonsense')).status()).toBe(400); // only known categories
 const all = await (await ada.request.get('/api/audit?category=app&limit=100')).text();
 expect(all).toContain('app.client_register');
 expect(all + audit).not.toContain(hr.secret);
 // The re-registered client still works: connecting to HR succeeds.
 await ada.goto('/api/connect/hr/start');
 await expect(ada.locator('p.notice')).toHaveText('Connected to HR Platform.');
 await ada.context().close();
});
