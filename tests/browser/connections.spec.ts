import { execFileSync } from 'node:child_process';
import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/* Requires npm run dev (mock IdP, mock tenants, API, console) and npm run dev:seed. */
try { process.loadEnvFile('.env'); } catch { /* variables may come from the environment */ }
const IDP = 'http://127.0.0.1:3200';

async function signedIn(browser: Browser, name: string) {
 const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:4200' });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
 return page;
}
const whoami = async (page: Page, app: string) => (await page.request.get(`/api/apps/${app}/whoami`)).json();
const notice = (page: Page) => page.locator('p.notice');

/**
 * Follow the connect redirects (Resolve -> tenant -> IdP SSO -> tenant) with this browser's cookies, stopping
 * before the tenant's callback to Resolve is delivered. Routing cannot intercept mid-chain redirects.
 */
async function captureCallback(page: Page, app: string) {
 let next = `http://127.0.0.1:4200/api/connect/${app}/start`;
 for (let hop = 0; hop < 6; hop++) {
  if (next.startsWith('http://127.0.0.1:4200/api/connect/callback')) return next;
  const r = await page.request.get(next, { maxRedirects: 0 });
  expect(r.status(), next).toBe(302);
  next = new URL(r.headers()['location'], next).href;
 }
 throw new Error('No callback reached');
}

/** Tests share fixed mock users, so start each connection test from a clean state. */
async function disconnect(page: Page, ...apps: string[]) {
 for (const app of apps) await page.request.post(`/api/connect/${app}/disconnect`, { headers: { Origin: 'http://127.0.0.1:4200' }, maxRedirects: 0 });
 await page.reload();
}

test('one human connects two apps through SSO; each tenant knows them under its own account', async ({ browser }) => {
 const page = await signedIn(browser, 'Sam Agent');
 await disconnect(page, 'payroll', 'hr');
 await page.goto('/apps/payroll');
 await page.getByRole('link', { name: 'Connect to Payroll' }).click();
 await expect(notice(page)).toHaveText('Connected to Payroll.');
 await page.goto('/apps/hr');
 await page.getByRole('link', { name: 'Connect to HR Platform' }).click();
 await expect(notice(page)).toHaveText('Connected to HR Platform.');
 const [payroll, hr] = [await whoami(page, 'payroll'), await whoami(page, 'hr')];
 expect(payroll.scopes).toEqual(['openid', 'offline_access', 'read:chat', 'write:chat']);
 expect(hr.app).toBe('hr');
 expect(payroll.tenantUserId).not.toBe(hr.tenantUserId);
 await page.goto('/apps/payroll');
 await page.getByRole('button', { name: 'Check connection to Payroll' }).click();
 await expect(page.getByRole('status').filter({ hasText: 'Payroll recognises you as' })).toContainText(payroll.tenantUserId);
 expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
 // Suspended apps cannot be connected or called.
 await page.goto('/apps/facilities');
 await expect(page.getByRole('heading', { name: 'Facilities', level: 1 })).toBeVisible();
 await expect(page.getByRole('link', { name: 'Connect to Facilities' })).toHaveCount(0);
 expect((await page.request.get('/api/apps/facilities/whoami')).status()).toBe(503);
 await page.context().close();
});

test('an observer is granted read scope only', async ({ browser }) => {
 const page = await signedIn(browser, 'Olive Observer');
 await disconnect(page, 'payroll');
 await page.goto('/apps/payroll');
 await page.getByRole('link', { name: 'Connect to Payroll' }).click();
 await expect(notice(page)).toHaveText('Connected to Payroll.');
 expect((await whoami(page, 'payroll')).scopes).toEqual(['openid', 'offline_access', 'read:chat']);
 await page.context().close();
});

test('a callback delivered to another signed-in user fails, and cannot be reused', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 const callback = await captureCallback(sam, 'hr');
 const olive = await signedIn(browser, 'Olive Observer');
 await disconnect(olive, 'hr');
 await olive.goto(callback);
 await expect(notice(olive)).toContainText('did not complete');
 expect((await whoami(olive, 'hr')).error.code).toBe('NOT_CONNECTED');
 await sam.goto(callback);
 await expect(notice(sam)).toContainText('did not complete');
 await sam.context().close(); await olive.context().close();
});

test("a callback carrying another app's issuer fails (mix-up defence)", async ({ browser }) => {
 const page = await signedIn(browser, 'Sam Agent');
 const callback = new URL(await captureCallback(page, 'payroll'));
 callback.searchParams.set('iss', 'http://127.0.0.1:3302/api/auth');
 await page.goto(callback.href);
 await expect(notice(page)).toContainText('did not complete');
 await page.context().close();
});

test('a tenant account belonging to a different IdP identity is refused', async ({ browser }) => {
 const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:4200' });
 const page = await ctx.newPage();
 await signInAs(page, 'Olive Observer');
 await expect(page.getByText('Signed in as Olive Observer')).toBeVisible();
 const oliveIdp = (await ctx.cookies(IDP)).find(c => c.name === 'mock_idp_session')!;
 await ctx.clearCookies();
 await signInAs(page, 'Sam Duplicate');
 await expect(page.getByText('Signed in as Sam Duplicate')).toBeVisible();
 await disconnect(page, 'payroll');
 // The browser's IdP session is now Olive's while Resolve's session is Sam Duplicate's.
 await ctx.addCookies([oliveIdp]);
 await page.goto('/api/connect/payroll/start');
 await expect(notice(page)).toContainText('does not belong to you in Resolve');
 expect((await whoami(page, 'payroll')).error.code).toBe('NOT_CONNECTED');
 await ctx.close();
});

test('directory disable revokes the session and grants; re-enabling restores neither', async ({ browser }) => {
 const setActive = async (active: boolean) => {
  const r = await fetch(`${IDP}/dev/users/${encodeURIComponent('mock|bea')}/active`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.DIRECTORY_TOKEN}` }, body: JSON.stringify({ active }) });
  expect(r.ok).toBe(true);
  execFileSync(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'apps/api/scripts/directory-sync.mts', '--once'], { stdio: 'pipe' });
 };
 const page = await signedIn(browser, 'Bea Broadcaster');
 await disconnect(page, 'payroll');
 await page.goto('/apps/payroll');
 await page.getByRole('link', { name: 'Connect to Payroll' }).click();
 await expect(notice(page)).toHaveText('Connected to Payroll.');
 try {
  await setActive(false);
  expect(await (await page.request.get('/api/session')).json()).toEqual({ authenticated: false });
 } finally {
  await setActive(true);
 }
 await page.context().clearCookies();
 await signInAs(page, 'Bea Broadcaster');
 await page.goto('/apps/payroll');
 await expect(page.getByRole('region', { name: 'Your connection' })).toContainText('Access revoked');
 await expect(page.getByRole('link', { name: 'Reconnect to Payroll' })).toBeVisible();
 await page.context().close();
});
