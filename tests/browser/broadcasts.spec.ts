import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { H, onboarded, signedIn, tags } from './fleet-helpers';

/*
 * Phase 5 exit criteria (plan 00, plan 08) against the mock fleet: duplicate requests produce one tenant mutation and
 * audit; observers cannot publish; an unknown completion is reconciled safely. Plus: reviewed recipients, partial
 * delivery only with confirmation, per-app outcomes, embed-installation distinguished from publication, scheduled
 * "All apps" following the registry, edit/archive version-checked against local edits, and author attribution.
 */
test.describe.configure({ timeout: 120_000 });
const TENANT: Record<string, string> = { payroll: 'http://127.0.0.1:3301', hr: 'http://127.0.0.1:3302' };
const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 7)}`;
const tenantPost = (app: string, path: string, body: unknown) => fetch(TENANT[app] + path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const announcements = async (app: string) => (await (await fetch(TENANT[app] + '/dev/announcements')).json()) as { id: string; keys: string[]; title: string; version: number; archived: boolean; author: string; mutations: number }[];
const content = (title: string, over: Record<string, unknown> = {}) => ({ kind: 'maintenance', title, body: 'Expect a short outage.', link: null, surfaces: ['portal', 'embed'], audience: 'everyone', publishAt: null, expiresAt: null, ...over });

async function bea(browser: Parameters<typeof signedIn>[0], apps = ['payroll', 'hr']) {
 const page = await signedIn(browser, 'Bea Broadcaster');
 for (const app of apps) {
  await page.goto(`/api/connect/${app}/start`);
  await expect(page.getByText(/^Connected to /)).toBeVisible();
 }
 return page;
}
/** Draft → review → publish through the API; returns the broadcast view. */
async function publishVia(page: Page, draft: unknown, opts: { confirmPartial?: boolean; requestId?: string } = {}) {
 const { id } = await (await page.request.post('/api/broadcasts', { headers: H, data: draft })).json();
 const { review } = await (await page.request.post(`/api/broadcasts/${id}/review`, { headers: H, data: {} })).json();
 const r = await page.request.post(`/api/broadcasts/${id}/publish`, { headers: H, data: { reviewHash: review.reviewHash, requestId: opts.requestId ?? crypto.randomUUID(), confirmPartial: opts.confirmPartial ?? false } });
 expect(r.status(), await r.text()).toBe(202);
 return { id: id as string, review, broadcast: (await r.json()).broadcast };
}
const viewOf = async (page: Page, id: string) => (await (await page.request.get(`/api/broadcasts/${id}`)).json()).broadcast;

test('an author publishes to all registered apps after reviewing them; blocked apps need confirmation and stay visible', async ({ browser }) => {
 const page = await bea(browser);
 const title = unique('Payroll maintenance tonight');
 await page.goto('/');
 await page.getByRole('link', { name: 'Announcements' }).click();
 await page.getByRole('link', { name: 'New banner' }).click();
 await page.getByLabel('Type of notice').selectOption('maintenance');
 await page.getByLabel('Title').fill(title);
 await page.getByLabel('Message (optional, plain text)').fill('Expect a short outage.');
 await expect(page.getByRole('group', { name: 'Banner preview' })).toContainText(title);
 expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
 await page.getByRole('button', { name: 'Save and review' }).click();

 // Review: every registered app is listed; Facilities (suspended) is not ready and says why.
 const recipients = page.getByRole('table', { name: 'Recipients and readiness' });
 await expect(recipients.getByRole('row', { name: /Payroll/ })).toContainText('Ready');
 await expect(recipients.getByRole('row', { name: /Facilities/ })).toContainText('Suspended');
 await expect(page.getByRole('button', { name: 'Publish…' })).toBeDisabled();
 expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
 await page.getByLabel(/Publish to the \d+ ready application/).check();
 await page.getByRole('button', { name: 'Publish…' }).click();
 await page.getByRole('button', { name: 'Publish', exact: true }).click();

 // Per-app results: published as Bea; HR's in-app banner awaits its script; Facilities is recorded as not delivered.
 const results = page.getByRole('table', { name: 'Publication result in each application' });
 await expect(results.getByRole('row', { name: /Payroll/ })).toContainText('Published', { timeout: 15_000 });
 await expect(results.getByRole('row', { name: /HR Platform/ })).toContainText('script not installed');
 await expect(results.getByRole('row', { name: /Facilities/ })).toContainText('Not delivered');
 await expect(page.getByText(/Partly delivered/).first()).toBeVisible();
 expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
 const mine = (await announcements('payroll')).filter(a => a.title === title);
 expect(mine).toEqual([expect.objectContaining({ author: 'Bea Broadcaster', mutations: 1, archived: false })]);

 // Everyone sees it on the portal, and can dismiss it.
 const portal = await page.context().newPage();
 await portal.goto(TENANT.payroll + '/portal');
 const banner = portal.getByRole('region', { name: 'maintenance announcement' }).filter({ hasText: title });
 await expect(banner).toBeVisible();
 expect((await new AxeBuilder({ page: portal }).withTags(tags).analyze()).violations).toEqual([]);
 await banner.getByRole('button', { name: `Dismiss ${title}` }).click();
 await expect(banner).toHaveCount(0);

 // The audit names the author and keeps the banner text.
 const ada = await signedIn(browser, 'Ada Admin');
 const events = (await (await ada.request.get('/api/audit?limit=100')).json()).events.filter((e: { operation: string; content: string | null }) => e.operation === 'broadcast.publish' && e.content?.includes(title));
 expect(events).toEqual([expect.objectContaining({ actor: 'Bea Broadcaster', outcome: 'succeeded' })]);
 await page.context().close(); await ada.context().close();
});

test('repeated publishes and a lost response produce one tenant announcement; the unknown result is reconciled by key', async ({ browser }) => {
 const page = await bea(browser);
 const title = unique('Lost response');
 await tenantPost('payroll', '/dev/fail', { mode: 'drop', sub: 'mock|bea' });
 const requestId = crypto.randomUUID();
 let id: string;
 try {
  ({ id } = await publishVia(page, { content: content(title), targeting: { mode: 'selected', apps: ['payroll'] } }, { requestId }));
  await expect.poll(async () => (await viewOf(page, id)).deliveries[0].state).toBe('uncertain');
 } finally { await tenantPost('payroll', '/dev/fail', { mode: 'off', sub: 'mock|bea' }); }
 // Same request again: the same publication, nothing new sent.
 const again = await page.request.post(`/api/broadcasts/${id}/publish`, { headers: H, data: { reviewHash: 'a'.repeat(64), requestId, confirmPartial: false } });
 expect(again.status()).toBe(202);
 // Unknown is never resent blindly.
 expect((await page.request.post(`/api/broadcasts/${id}/deliveries/payroll/retry`, { headers: H, data: {} })).status()).toBe(409);
 await page.goto(`/announcements/${id}`);
 await page.getByRole('button', { name: 'Check result for Payroll' }).click();
 await expect(page.getByRole('table', { name: 'Publication result in each application' }).getByRole('row', { name: /Payroll/ })).toContainText('Published');
 const mine = (await announcements('payroll')).filter(a => a.title === title);
 expect(mine).toHaveLength(1);
 expect(mine[0].mutations).toBe(1);
 await page.context().close();
});

test('observers cannot publish, and the API refuses them', async ({ browser }) => {
 const page = await signedIn(browser, 'Olive Observer');
 await expect(page.getByRole('link', { name: 'Announcements' })).toHaveCount(0);
 expect((await page.request.post('/api/broadcasts', { headers: H, data: { content: content('Nope'), targeting: { mode: 'all' } } })).status()).toBe(403);
 expect((await page.request.get('/api/broadcasts')).status()).toBe(403);
 await page.context().close();
});

test('an agent with Tier 1 or higher in an application can banner that application only (owner decision)', async ({ browser }) => {
 // Sam holds T2 in Payroll and T1 in HR (as each application reports); suspended Facilities reports no tier.
 const sam = await signedIn(browser, 'Sam Agent');
 for (const app of ['payroll', 'hr']) {
  await sam.goto(`/api/connect/${app}/start`);
  await expect(sam.getByText(/^Connected to /)).toBeVisible();
 }
 const post = (targeting: unknown) => sam.request.post('/api/broadcasts', { headers: H, data: { content: content(unique('Tier banner')), targeting } });
 const all = await post({ mode: 'all' });
 expect(all.status()).toBe(403);
 expect((await all.json()).error.code).toBe('TIER_SCOPE');
 const outside = await post({ mode: 'selected', apps: ['payroll', 'facilities'] });
 expect(outside.status()).toBe(403);
 expect((await outside.json()).error.message).toContain('Facilities');

 // The application's workspace offers "Create banner": a modal for that application only, without leaving the workspace.
 await sam.goto('/apps/payroll');
 await sam.getByRole('complementary', { name: /tools$/ }).getByRole('button', { name: 'Create banner' }).click();
 const dialog = sam.getByRole('dialog', { name: 'New banner for Payroll' });
 await expect(dialog.getByLabel('Title')).toBeFocused();
 const title = unique('Payroll payslips delayed');
 await dialog.getByLabel('Title').fill(title);
 await dialog.getByLabel('Message').fill('Payslips arrive by noon.');
 await dialog.getByRole('button', { name: 'Review' }).click();
 await expect(dialog).toContainText('Ready to receive it');
 expect((await new AxeBuilder({ page: sam }).withTags(tags).include('[role=dialog]').analyze()).violations).toEqual([]);
 await dialog.getByRole('button', { name: 'Publish banner' }).click();
 // Once published, the dialog is titled with the banner.
 const done = sam.getByRole('dialog', { name: title });
 await expect(done.getByRole('status')).toContainText('Published', { timeout: 20_000 });
 await expect(done.getByRole('status')).toContainText(/Payroll\s*succeeded/);
 await expect(sam).toHaveURL(/\/apps\/payroll$/);
 expect((await announcements('payroll')).find(a => a.title === title)).toMatchObject({ author: 'Sam Agent' });
 await done.getByRole('button', { name: 'Done' }).click();
 await expect(done).toBeHidden();
 await expect(sam.getByRole('complementary', { name: /tools$/ }).getByRole('button', { name: 'Create banner' })).toBeFocused();
 // Published as Sam, to Payroll only; Sam's list shows only Sam's banners.
 const list = (await (await sam.request.get('/api/broadcasts')).json()).broadcasts as { author: string }[];
 expect(list.length).toBeGreaterThan(0);
 expect(list.every(b => b.author === 'Sam Agent')).toBe(true);
 await sam.context().close();
});

test('a scheduled All-apps banner includes an app registered before its publish time', async ({ browser }) => {
 const page = await bea(browser);
 const title = unique('Scheduled');
 const publishAt = new Date(Date.now() + 12_000).toISOString();
 const { id, review } = await publishVia(page, { content: content(title, { publishAt }), targeting: { mode: 'all' } }, { confirmPartial: true });
 expect(review.followsRegistry).toBe(true);
 expect((await viewOf(page, id)).status).toBe('scheduled');
 // Registered after review, before the publish time.
 const ada = await signedIn(browser, 'Ada Admin');
 const { appKey } = await onboarded(ada, 'late');
 expect(review.recipients.map((r: { appKey: string }) => r.appKey)).not.toContain(appKey);
 await expect.poll(async () => (await viewOf(page, id)).status, { timeout: 30_000 }).not.toBe('scheduled');
 const v = await viewOf(page, id);
 // Included and visible: Bea is not connected to the new app, so it is recorded as not delivered (never skipped).
 expect(v.deliveries.find((d: { appKey: string }) => d.appKey === appKey)).toMatchObject({ state: 'blocked', reason: 'not_connected' });
 expect(v.deliveries.find((d: { appKey: string }) => d.appKey === 'payroll')).toMatchObject({ state: 'succeeded' });
 await page.context().close(); await ada.context().close();
});

test('an edit updates each app version-checked; a local edit is reported, not overwritten; archive removes it', async ({ browser }) => {
 const page = await bea(browser);
 const title = unique('Edit me');
 const { id } = await publishVia(page, { content: content(title), targeting: { mode: 'selected', apps: ['payroll', 'hr'] } });
 await expect.poll(async () => (await viewOf(page, id)).status).toBe('published');
 // Someone edits the banner inside HR.
 const hrAnn = (await announcements('hr')).find(a => a.title === title)!;
 await fetch(`${TENANT.hr}/dev/announcements/${hrAnn.id}/edit`, { method: 'POST' });

 await page.goto(`/announcements/${id}`);
 await page.getByRole('button', { name: 'Edit…' }).click();
 await page.getByLabel('Title').fill(`${title} (moved to 22:00)`);
 await page.getByRole('button', { name: 'Publish changes' }).click();
 const results = page.getByRole('table', { name: 'Publication result in each application' });
 await expect(results.getByRole('row', { name: /Payroll/ })).toContainText('Published', { timeout: 15_000 });
 await expect(results.getByRole('row', { name: /HR Platform/ })).toContainText('LOCAL_EDIT_CONFLICT');
 expect((await announcements('payroll')).find(a => a.id && a.title === `${title} (moved to 22:00)`)?.version).toBe(2);
 expect((await announcements('hr')).find(a => a.id === hrAnn.id)?.title).toContain('(edited here)');

 await page.getByRole('button', { name: 'Archive everywhere…' }).click();
 await page.getByRole('button', { name: 'Archive', exact: true }).click();
 await expect(page.getByText('Archived', { exact: true }).first()).toBeVisible();
 await expect(results.getByRole('row', { name: /Payroll/ })).toContainText('Archive: succeeded');
 expect((await announcements('payroll')).find(a => a.title === `${title} (moved to 22:00)`)?.archived).toBe(true);
 await page.context().close();
});

test('an expired banner leaves the portal; a change after review needs a new review', async ({ browser }) => {
 const page = await bea(browser, ['payroll']);
 const title = unique('Short lived');
 const expiresAt = new Date(Date.now() + 6_000).toISOString();
 const { id } = await (await page.request.post('/api/broadcasts', { headers: H, data: { content: content(title, { expiresAt, surfaces: ['portal'] }), targeting: { mode: 'selected', apps: ['payroll'] } } })).json();
 const { review } = await (await page.request.post(`/api/broadcasts/${id}/review`, { headers: H, data: {} })).json();
 const v = await viewOf(page, id);
 await page.request.put(`/api/broadcasts/${id}`, { headers: H, data: { draft: { content: content(title + '!', { expiresAt, surfaces: ['portal'] }), targeting: { mode: 'selected', apps: ['payroll'] } }, version: v.version } });
 const stale = await page.request.post(`/api/broadcasts/${id}/publish`, { headers: H, data: { reviewHash: review.reviewHash, requestId: crypto.randomUUID(), confirmPartial: false } });
 expect((await stale.json()).error.code).toBe('STALE_REVIEW');
 const fresh = await (await page.request.post(`/api/broadcasts/${id}/review`, { headers: H, data: {} })).json();
 expect((await page.request.post(`/api/broadcasts/${id}/publish`, { headers: H, data: { reviewHash: fresh.review.reviewHash, requestId: crypto.randomUUID(), confirmPartial: false } })).status()).toBe(202);
 const portal = await page.context().newPage();
 await portal.goto(TENANT.payroll + '/portal');
 await expect(portal.getByRole('region').filter({ hasText: title + '!' })).toBeVisible();
 await page.waitForTimeout(6_500);
 await portal.reload();
 await expect(portal.getByRole('region').filter({ hasText: title + '!' })).toHaveCount(0);
 await page.context().close();
});
