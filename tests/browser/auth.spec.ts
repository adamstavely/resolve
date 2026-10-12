import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/* Requires the mock IdP, API, console and a migrated database (npm run dev). */

async function signInAs(page: Page, name: string, start = '/api/auth/login?returnTo=/') {
 await page.goto(start);
 await expect(page).toHaveTitle(/Mock identity provider/);
 await page.getByLabel(name).check();
 await page.getByRole('button', { name: 'Continue' }).click();
}
const session = async (page: Page) => (await page.request.get('/api/session')).json();

test('agent signs in through the IdP and gets agent capabilities only', async ({ page }) => {
 await page.goto('/');
 await page.getByRole('link', { name: 'Sign in' }).click();
 await page.getByLabel('Sam Agent').check();
 await page.getByRole('button', { name: 'Continue' }).click();
 await expect(page.getByText('Signed in as Sam Agent (sam@example.test). Roles: Fleet agent')).toBeVisible();
 const s = await session(page);
 expect(s.capabilities).toContain('chat.reply');
 expect(s.capabilities).not.toContain('app.register');
 expect((await page.request.get('/api/audit')).status()).toBe(403);
 expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
});

test('admin can read the audit log, which records the sign-in', async ({ page }) => {
 await signInAs(page, 'Ada Admin');
 await expect(page.getByText('Roles: Fleet admin')).toBeVisible();
 const r = await page.request.get('/api/audit');
 expect(r.status()).toBe(200);
 expect((await r.json()).events.some((e: { operation: string; actor: string; outcome: string }) =>
  e.operation === 'session.login' && e.actor === 'Ada Admin' && e.outcome === 'succeeded')).toBe(true);
});

test('unauthenticated API calls are refused', async ({ request }) => {
 expect(await (await request.get('/api/session')).json()).toEqual({ authenticated: false });
 expect((await request.get('/api/audit')).status()).toBe(401);
});

test('a replayed or forged callback does not sign in', async ({ page, browser }) => {
 const callback = page.waitForRequest(r => r.url().includes('/api/auth/callback'));
 await signInAs(page, 'Sam Agent');
 const callbackUrl = (await callback).url();
 await expect(page.getByText('Roles: Fleet agent')).toBeVisible();

 // Same browser replays the callback: the attempt was consumed.
 await page.goto(callbackUrl);
 await expect(page.getByRole('alert')).toHaveText(/Sign-in did not complete/);

 // A different browser presenting the stolen callback URL has no binding cookie.
 const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4200' });
 const otherPage = await other.newPage();
 await otherPage.goto(callbackUrl);
 await expect(otherPage.getByRole('alert')).toHaveText(/Sign-in did not complete/);
 expect(await (await otherPage.request.get('/api/session')).json()).toEqual({ authenticated: false });

 await otherPage.goto('/api/auth/callback?code=forged&state=forged-state-value-000');
 await expect(otherPage.getByRole('alert')).toHaveText(/Sign-in did not complete/);
 await other.close();
});

test('sign-out revokes the server session, and a copied cookie stops working', async ({ page, context }) => {
 await signInAs(page, 'Olive Observer');
 await expect(page.getByText('Roles: Fleet observer')).toBeVisible();
 const cookie = (await context.cookies()).find(c => c.name === 'resolve_session')!;
 expect(cookie.httpOnly).toBe(true);
 expect(cookie.sameSite).toBe('Lax');
 await page.getByRole('button', { name: 'Sign out' }).click();
 await expect(page.getByRole('status').filter({ hasText: 'You have signed out.' })).toBeVisible();
 await context.addCookies([cookie]);
 expect(await session(page)).toEqual({ authenticated: false });
});

test('signing in again replaces the previous session', async ({ page, context }) => {
 await signInAs(page, 'Sam Agent');
 await expect(page.getByText('Roles: Fleet agent')).toBeVisible();
 const first = (await context.cookies()).find(c => c.name === 'resolve_session')!;
 await signInAs(page, 'Sam Agent');
 await expect(page.getByText('Roles: Fleet agent')).toBeVisible();
 await context.addCookies([first]);
 expect(await session(page)).toEqual({ authenticated: false });
});

test('sign-out rejects cross-origin and origin-less requests', async ({ page }) => {
 await signInAs(page, 'Olive Observer');
 await expect(page.getByText('Roles: Fleet observer')).toBeVisible();
 expect((await page.request.post('/api/auth/logout', { headers: { Origin: 'https://evil.example' }, maxRedirects: 0 })).status()).toBe(403);
 expect((await session(page)).authenticated).toBe(true);
});

test('return paths are preserved, and off-site return paths are ignored', async ({ page }) => {
 await signInAs(page, 'Sam Agent', '/api/auth/login?returnTo=' + encodeURIComponent('/?view=inbox'));
 await expect(page).toHaveURL('http://127.0.0.1:4200/?view=inbox');
 await page.context().clearCookies();
 await signInAs(page, 'Sam Agent', '/api/auth/login?returnTo=' + encodeURIComponent('//evil.example/phish'));
 await expect(page).toHaveURL('http://127.0.0.1:4200/');
});

test('a user without mapped groups signs in with no capabilities', async ({ page }) => {
 await signInAs(page, 'Nina No Groups');
 await expect(page.getByText('Roles: none. Ask an administrator for access.')).toBeVisible();
 expect((await session(page)).capabilities).toEqual([]);
});

test('a different subject with the same email is a different Resolve user', async ({ browser }) => {
 const ids: string[] = [];
 for (const name of ['Sam Agent', 'Sam Duplicate']) {
  const ctx = await browser.newContext({ baseURL: 'http://127.0.0.1:4200' });
  const page = await ctx.newPage();
  await signInAs(page, name);
  await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
  ids.push((await session(page)).user.id);
  await ctx.close();
 }
 expect(ids[0]).not.toBe(ids[1]);
});
