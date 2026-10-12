import { test, expect, type Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/* Owner decision: the audit covers every user event: reads, refused requests, actions and the messages sent. */
const ORIGIN = 'http://127.0.0.1:4200';

async function signedIn(browser: Browser, name: string) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
 return page;
}
type Ev = { operation: string; actor: string; outcome: string; summary: Record<string, unknown>; content: string | null };
const events = async (page: Awaited<ReturnType<typeof signedIn>>, category: string) =>
 ((await (await page.request.get(`/api/audit?category=${category}&limit=100`)).json()).events as Ev[]);

test('reads, refusals and messages sent are all audited, with the message text', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 await sam.goto('/api/connect/payroll/start');
 await expect(sam.locator('p.notice')).toContainText('Connected to Payroll');
 const ticket = (await (await sam.request.get('/api/apps/payroll/tickets?statusCategory=open')).json()).tickets[0];
 await sam.goto(`/tickets/payroll/${ticket.id}`);
 await expect(sam.getByRole('heading', { level: 1 })).toBeVisible();
 expect((await sam.request.get('/api/admin/users')).status()).toBe(403);
 const text = `Audit me ${Math.random().toString(36).slice(2, 7)}`;
 await sam.getByLabel('Reply, visible to the customer').fill(text);
 await sam.getByRole('button', { name: 'Send reply' }).click();
 await expect(sam.getByRole('list', { name: 'Messages', exact: true })).toContainText(text);

 const ada = await signedIn(browser, 'Ada Admin');
 const reads = (await events(ada, 'read')).filter(e => e.actor === 'Sam Agent');
 expect(reads.map(e => e.operation)).toEqual(expect.arrayContaining(['read.session', 'read.apps', 'read.dashboard', 'read.ticket', 'read.tickets']));
 expect(reads.find(e => e.operation === 'read.ticket' && e.summary.target === ticket.id)).toMatchObject({ outcome: 'succeeded', summary: { app: 'payroll' } });
 const refused = (await events(ada, 'access')).find(e => e.actor === 'Sam Agent' && e.summary.path === '/api/admin/users');
 expect(refused).toMatchObject({ operation: 'access.denied', outcome: 'denied', summary: { reason: 'missing_capability', capability: 'users.manage' } });
 const sent = (await events(ada, 'ticket')).find(e => e.operation === 'ticket.reply' && e.content === text);
 expect(sent).toMatchObject({ actor: 'Sam Agent', outcome: 'pending', summary: { app: 'payroll', target: ticket.id } });

 // The audit page shows the message text to audit readers.
 await ada.goto('/audit');
 await ada.getByLabel('Activity').selectOption('ticket');
 await expect(ada.getByRole('row').filter({ hasText: text }).first()).toContainText('Replied on a ticket');
 expect((await new AxeBuilder({ page: ada }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([]);
 await sam.context().close(); await ada.context().close();
});

test('unauthenticated and cross-origin requests are audited as refused', async ({ browser, request }) => {
 expect((await request.get('/api/tickets')).status()).toBe(401);
 const bo = await signedIn(browser, 'Bo Blockable');
 expect((await bo.request.post('/api/auth/logout', { headers: { Origin: 'https://evil.example' }, maxRedirects: 0 })).status()).toBe(403);
 const ada = await signedIn(browser, 'Ada Admin');
 const refused = await events(ada, 'access');
 expect(refused.find(e => e.actor === 'system' && e.summary.path === '/api/tickets')).toMatchObject({ summary: { reason: 'unauthenticated' } });
 expect(refused.find(e => e.actor === 'Bo Blockable' && e.summary.path === '/api/auth/logout')).toMatchObject({ summary: { reason: 'cross_origin', origin: 'https://evil.example' } });
 await bo.context().close(); await ada.context().close();
});
