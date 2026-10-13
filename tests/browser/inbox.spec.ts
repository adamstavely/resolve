import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/*
 * Phase 3 exit criteria (plan 00) against the mock fleet: audit correlation to the human and tenant record,
 * visible uncertain outcomes, no automatic retry of non-idempotent actions, tenant permissions rechecked
 * independently of Resolve's UI. Each test creates its own conversation.
 */
const ORIGIN = 'http://127.0.0.1:4200';
const TENANT = { payroll: 'http://127.0.0.1:3301', hr: 'http://127.0.0.1:3302' } as const;
const tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const tenant = (app: keyof typeof TENANT, path: string, body: unknown) =>
 fetch(TENANT[app] + path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 7)}`;

async function signedIn(browser: Browser, name: string, connect: string[] = []) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByRole('button', { name: `${name}, account and availability` })).toBeVisible();
 for (const app of connect) {
  await page.goto(`/api/connect/${app}/start`);
  await expect(page.locator('p.notice')).toContainText('Connected to');
 }
 return page;
}

/** A customer writes in; returns the new conversation's id and subject. */
async function customerWrites(app: keyof typeof TENANT, label: string, team = 'team_support') {
 const subject = unique(label);
 const { conversationId } = await tenant(app, '/dev/customer-message', { text: subject, team });
 return { conversationId: conversationId as string, subject };
}
/** A row in the Inbox (plan 16): chats open in the case workspace. */
const queueItem = (page: Page, subject: string) => page.getByRole('main').getByRole('link', { name: new RegExp(subject) });
/** Run a rail tool: the tool opens the drawer, whose primary button performs it. */
async function runTool(page: Page, tool: string, verb = tool) {
 await page.getByRole('complementary', { name: /tools$/ }).getByRole('button', { name: tool }).click();
 const drawer = page.getByRole('dialog', { name: tool });
 await drawer.getByRole('button', { name: verb, exact: true }).click();
 await drawer.getByRole('button', { name: 'Done' }).click();
}
async function openInbox(page: Page) {
 await page.goto('/inbox');
 await expect(page.getByRole('group', { name: 'Monitored applications' })).toContainText('Payroll · Live');
}

test('new customer chats arrive live, are announced, and do not move focus', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 await openInbox(sam);
 await sam.getByRole('button', { name: "Everyone's" }).focus();
 const { subject } = await customerWrites('payroll', 'Payslip missing');
 await expect(queueItem(sam, subject)).toBeVisible();
 await expect(sam.locator('p[aria-live=polite]')).toContainText(`in Payroll: ${subject}`);
 await expect(sam.getByRole('button', { name: "Everyone's" })).toBeFocused();
 await sam.context().close();
});

test('a reply is sent as the human, confirmed from the tenant, and correlated in the audit', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const { conversationId, subject } = await customerWrites('payroll', 'Cannot log in');
 await openInbox(sam);
 await queueItem(sam, subject).click();
 const text = unique('We have reset your session');
 await sam.getByLabel('Reply, visible to the customer').fill(text);
 await sam.getByRole('button', { name: 'Send', exact: true }).click();
 await expect(sam.getByRole('list', { name: 'Messages', exact: true }).getByRole('listitem').filter({ hasText: text })).toContainText('Sam Agent');
 await expect(sam.getByRole('list', { name: 'Messages awaiting confirmation' })).toHaveCount(0);

 // Tenant record names the human; Resolve's audit links the operation to that record.
 const detail = await (await sam.request.get(`/api/apps/payroll/conversations/${conversationId}`)).json();
 const sent = detail.detail.messages.find((m: { content: string }) => m.content === text);
 expect(sent).toMatchObject({ authorName: 'Sam Agent', senderType: 'agent', isInternal: false });
 const ada = await signedIn(browser, 'Ada Admin');
 const audit = await (await ada.request.get('/api/audit?category=conversation&limit=100')).json();
 const events = audit.events.filter((e: { operation: string; summary: { target?: string } }) => e.operation === 'conversation.reply' && e.summary.target === conversationId);
 expect(events.map((e: { outcome: string }) => e.outcome).sort()).toEqual(['pending', 'succeeded']);
 expect(events.find((e: { outcome: string }) => e.outcome === 'succeeded')).toMatchObject({ actor: 'Sam Agent', summary: { app: 'payroll', tenantRecord: sent.id } });
 // Owner decision: the audit records the text of messages sent (sealed at rest), on the operation's first transition.
 expect(events.find((e: { outcome: string }) => e.outcome === 'pending').content).toBe(text);
 expect(events.find((e: { outcome: string }) => e.outcome === 'succeeded').content).toBeNull();
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 await sam.context().close(); await ada.context().close();
});

test('a lost response is shown as not confirmed, never retried automatically, and settles once', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const { conversationId, subject } = await customerWrites('payroll', 'Expense stuck');
 await openInbox(sam);
 await queueItem(sam, subject).click();
 const text = unique('Approved on our side');
 await tenant('payroll', '/dev/fail', { mode: 'drop', sub: 'mock|sam' });
 try {
  await sam.getByLabel('Reply, visible to the customer').fill(text);
  await sam.getByRole('button', { name: 'Send', exact: true }).click();
  const pending = sam.getByRole('list', { name: 'Messages awaiting confirmation' });
  await expect(pending).toContainText('Not confirmed');
  await expect(pending).toContainText('It may have been applied');
 } finally {
  await tenant('payroll', '/dev/fail', { mode: null, sub: 'mock|sam' });
 }
 // The tenant committed exactly one copy; Resolve did not resend on its own.
 const count = async () => (await (await sam.request.get(`/api/apps/payroll/conversations/${conversationId}`)).json())
  .detail.messages.filter((m: { content: string }) => m.content === text).length;
 await sam.waitForTimeout(1000);
 expect(await count()).toBe(1);
 // The user's retry reuses the operation id: the tenant replays instead of sending twice.
 await sam.getByRole('button', { name: 'Retry sending this reply' }).click();
 await expect(sam.getByRole('list', { name: 'Messages awaiting confirmation' })).toHaveCount(0);
 expect(await count()).toBe(1);
 await sam.context().close();
});

test('check result reconciles an uncertain note without resending', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const { conversationId, subject } = await customerWrites('payroll', 'Duplicate invoice');
 await openInbox(sam);
 await queueItem(sam, subject).click();
 await sam.getByRole('button', { name: 'Work note' }).click();
 const text = unique('Checked billing ledger');
 await tenant('payroll', '/dev/fail', { mode: 'drop', sub: 'mock|sam' });
 try {
  await sam.getByLabel('Work note, visible to support only').fill(text);
  await sam.getByRole('button', { name: 'Add note' }).click();
  await expect(sam.getByRole('list', { name: 'Messages awaiting confirmation' })).toContainText('Not confirmed');
 } finally {
  await tenant('payroll', '/dev/fail', { mode: null, sub: 'mock|sam' });
 }
 await sam.getByRole('button', { name: 'Check result' }).click();
 await expect(sam.getByRole('list', { name: 'Messages awaiting confirmation' })).toHaveCount(0);
 const note = sam.getByRole('list', { name: 'Messages', exact: true }).getByRole('listitem').filter({ hasText: text });
 await expect(note).toContainText('work note · internal');
 const msgs = (await (await sam.request.get(`/api/apps/payroll/conversations/${conversationId}`)).json()).detail.messages;
 expect(msgs.filter((m: { content: string }) => m.content === text)).toHaveLength(1);
 await sam.context().close();
});

test('another agent’s assignment appears live, and a stale assignment is refused', async ({ browser }) => {
 const { conversationId, subject } = await customerWrites('payroll', 'Leave balance wrong');
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const ada = await signedIn(browser, 'Ada Admin', ['payroll']);
 await openInbox(sam); await openInbox(ada);
 await queueItem(sam, subject).click();
 const seen = (await (await sam.request.get(`/api/apps/payroll/conversations/${conversationId}`)).json()).detail.conversation.version;
 await queueItem(ada, subject).click();
 await runTool(ada, 'Assign to me');
 await expect(ada.locator('.toast').filter({ hasText: 'Assigned to you' })).toBeVisible();
 // Sam's open case reflects Ada's ownership without a reload.
 await expect(sam.locator('.conv-meta')).toContainText('Ada Admin');
 // A request carrying the version Sam saw before is refused instead of overwriting Ada.
 const r = await sam.request.post(`/api/apps/payroll/conversations/${conversationId}/assign`, {
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: JSON.stringify({ assignee: 'me', expectedVersion: seen }),
 });
 expect(r.status()).toBe(409);
 expect(await r.json()).toMatchObject({ operation: { state: 'failed', failureCode: 'CONFLICT', next: 'refresh_and_retry' }, message: 'This item changed since you opened it. Refresh and try again.' });
 await sam.context().close(); await ada.context().close();
});

test('the tenant rechecks permissions independently of Resolve', async ({ browser }) => {
 // Bo is an agent in Resolve but only an observer in HR.
 const bo = await signedIn(browser, 'Bo Blockable', ['hr']);
 const { conversationId } = await customerWrites('hr', 'Access request', 'team_billing');
 const r = await bo.request.post(`/api/apps/hr/conversations/${conversationId}/messages`, {
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
  data: JSON.stringify({ kind: 'reply', content: 'Hello', operationId: crypto.randomUUID() }),
 });
 expect(r.status()).toBe(403);
 const body = await r.json();
 expect(body.operation).toMatchObject({ state: 'denied', failureCode: 'FORBIDDEN', next: 'none' });
 expect(body.message).toBe('The application does not allow you to do this.');
 await bo.context().close();
});

test('observers get no action controls, and Resolve refuses their direct requests', async ({ browser }) => {
 const olive = await signedIn(browser, 'Olive Observer', ['payroll']);
 const { conversationId, subject } = await customerWrites('payroll', 'Report shows old data');
 await openInbox(olive);
 await queueItem(olive, subject).click();
 await expect(olive.getByRole('heading', { level: 1, name: subject })).toBeVisible();
 await expect(olive.getByRole('button', { name: 'Assign to me' })).toHaveCount(0);
 await expect(olive.getByRole('button', { name: 'Close chat' })).toHaveCount(0);
 await expect(olive.getByRole('button', { name: 'Send' })).toHaveCount(0);
 const r = await olive.request.post(`/api/apps/payroll/conversations/${conversationId}/messages`, {
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: JSON.stringify({ kind: 'reply', content: 'Hi', operationId: crypto.randomUUID() }),
 });
 expect(r.status()).toBe(403);
 const csrf = await olive.request.post(`/api/apps/payroll/conversations/${conversationId}/read`, { headers: { 'Content-Type': 'application/json' }, data: '{}' });
 expect(csrf.status()).toBe(403);
 await olive.context().close();
});

test('closing a conversation asks for confirmation', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const { subject } = await customerWrites('payroll', 'Thanks, all sorted');
 await openInbox(sam);
 await queueItem(sam, subject).click();
 const tools = sam.getByRole('complementary', { name: /tools$/ });
 await tools.getByRole('button', { name: 'Close chat' }).click();
 const dialog = sam.getByRole('dialog', { name: 'Close chat' });
 await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
 await dialog.getByRole('button', { name: 'Cancel' }).click();
 await expect(tools.getByRole('button', { name: 'Close chat' })).toBeFocused();
 await tools.getByRole('button', { name: 'Close chat' }).click();
 await dialog.getByRole('button', { name: 'Close chat', exact: true }).click();
 await expect(sam.locator('.toast').filter({ hasText: 'Conversation closed' })).toBeVisible();
 await dialog.getByRole('button', { name: 'Done' }).click();
 await expect(tools.getByRole('button', { name: 'Reopen chat' })).toBeVisible();
 await sam.context().close();
});

test('blocking a person closes their live stream', async ({ browser }) => {
 const bo = await signedIn(browser, 'Bo Blockable', ['payroll']);
 await bo.evaluate(() => { (window as unknown as { es: EventSource }).es = new EventSource('/api/inbox/stream'); });
 await expect.poll(() => bo.evaluate(() => (window as unknown as { es: EventSource }).es.readyState)).toBe(1);
 const ada = await signedIn(browser, 'Ada Admin');
 const [target] = (await (await ada.request.get('/api/admin/users?q=Bo Blockable')).json()).users;
 const post = (enabled: boolean, reason: string) => ada.request.post(`/api/admin/users/${target.id}/access`, { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: JSON.stringify({ enabled, reason }) });
 try {
  await post(false, 'Testing stream revocation');
  // The server closes the stream at its next session check; the browser's reconnect is refused (401).
  await expect.poll(() => bo.evaluate(() => (window as unknown as { es: EventSource }).es.readyState), { timeout: 30_000 }).toBe(2);
 } finally {
  await post(true, 'Test complete');
 }
 await bo.context().close(); await ada.context().close();
});

test('ticket reply, assignment and confirmed resolution', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin', ['payroll']);
 const list = await (await ada.request.get('/api/apps/payroll/tickets?statusCategory=open')).json();
 // An unidentified customer's ticket: closing it is allowed after the pre-flight check (an affected customer's warns; see receipts.spec).
 const ticket = list.tickets.find((t: { requesterPrincipalId: string }) => ['principal_customer_7', 'principal_customer_8'].includes(t.requesterPrincipalId)) ?? list.tickets[0];
 await ada.goto(`/tickets/payroll/${ticket.id}`);
 const text = unique('Fixed in the next payroll run');
 await ada.getByLabel('Reply, visible to the customer').fill(text);
 await ada.getByRole('button', { name: 'Send', exact: true }).click();
 await expect(ada.getByRole('list', { name: 'Messages', exact: true })).toContainText(text);
 const tools = ada.getByRole('complementary', { name: /tools$/ });
 if (await tools.getByRole('button', { name: 'Assign to me' }).count()) {
  await runTool(ada, 'Assign to me');
  await expect(ada.locator('.toast').filter({ hasText: 'Assigned to you' })).toBeVisible();
 }
 await tools.getByRole('button', { name: 'Resolve ticket' }).click();
 const dialog = ada.getByRole('dialog', { name: 'Resolve ticket' });
 await dialog.getByRole('button', { name: 'Cancel' }).click();
 await expect(dialog).toBeHidden();
 await expect(ada.locator('.conv-meta')).toContainText('Open');
 await tools.getByRole('button', { name: 'Resolve ticket' }).click();
 await dialog.getByRole('button', { name: 'Resolve ticket', exact: true }).click();
 await expect(ada.locator('.toast').filter({ hasText: 'Status updated' })).toBeVisible();
 await expect(dialog.getByText('Downstream confirmation', { exact: true })).toBeVisible();
 await dialog.getByRole('button', { name: 'Done' }).click();
 await expect(ada.locator('.conv-meta')).toContainText('Resolved');
 expect((await new AxeBuilder({ page: ada }).withTags(tags).analyze()).violations).toEqual([]);
 await ada.context().close();
});

test('the Inbox nav item counts unread conversations and updates live on any page', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const inboxLink = sam.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Inbox/ });
 await expect(inboxLink).toHaveAccessibleName(/unread/);
 const count = async () => Number((await inboxLink.locator('.nav-count').textContent())?.replace('+', ''));
 const before = await count();
 // Navigate within the app (no reload): the count keeps updating on other pages.
 await sam.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^My tickets/ }).click();
 await expect(sam.getByRole('heading', { level: 1, name: 'My tickets' })).toBeVisible();
 const { conversationId } = await customerWrites('payroll', 'Badge check');
 await expect.poll(count).toBe(before + 1);
 // Marking read for the team lowers it again.
 await sam.request.post(`/api/apps/payroll/conversations/${conversationId}/read`, { headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, data: '{}' });
 await expect.poll(count).toBe(before);
 await sam.context().close();
});

test('conversations are part of the inbox: old links redirect and deep links open the conversation', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const { conversationId, subject } = await customerWrites('payroll', 'Deep link');
 await sam.goto('/conversations');
 await expect(sam).toHaveURL(/\/inbox$/);
 await sam.goto(`/conversations/payroll/${conversationId}`);
 await expect(sam).toHaveURL(new RegExp(`/inbox/payroll/${conversationId}$`));
 await expect(sam.getByRole('heading', { level: 1, name: subject })).toBeVisible();
 await sam.getByRole('main').getByRole('link', { name: 'Inbox' }).click();
 await sam.getByRole('button', { name: 'All', exact: true }).click();
 await expect(queueItem(sam, subject)).toBeVisible();
 const nav = sam.getByRole('navigation', { name: 'Primary' });
 await expect(nav.getByRole('link', { name: 'Conversations' })).toHaveCount(0);
 await expect(nav.getByRole('link', { name: 'Component check' })).toHaveCount(0);
 await expect(nav.getByText('Development')).toHaveCount(0);
 await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
 await expect(sam.getByRole('link', { name: 'Resolve home' })).toHaveAttribute('href', '/');
 await sam.context().close();
});
