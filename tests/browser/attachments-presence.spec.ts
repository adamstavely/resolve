import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/*
 * Plan 09 attachments, typing and presence against the mock fleet (target tools upload_file v2, get_attachment v1,
 * signal_activity / get_conversation_activity v1, get/set_availability v1). Each test creates its own conversation.
 */
const ORIGIN = 'http://127.0.0.1:4200';
const PAYROLL = 'http://127.0.0.1:3301';
const tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 7)}`;
const tenantPost = (path: string, body: unknown) => fetch(PAYROLL + path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const tenantGet = (path: string) => fetch(PAYROLL + path).then(r => r.json());
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('mock image body')]);

async function signedIn(browser: Browser, name: string) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByRole('button', { name: `${name}, account and availability` })).toBeVisible();
 await page.goto('/api/connect/payroll/start');
 await expect(page.locator('p.notice')).toContainText('Connected to');
 return page;
}
async function openConversation(page: Page, conversationId: string) {
 await page.goto(`/inbox/payroll/${conversationId}`);
 await expect(page.getByRole('list', { name: 'Messages', exact: true })).toBeVisible();
}
async function newConversation(label: string) {
 const subject = unique(label);
 const { conversationId } = await tenantPost('/dev/customer-message', { text: subject });
 return { conversationId: conversationId as string, subject };
}
const presence = (page: Page) => page.locator('.presence-line');

test('a reply carries an attachment uploaded through Resolve, and it downloads through Resolve', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 const { conversationId } = await newConversation('Screenshot of the error');
 await openConversation(sam, conversationId);

 await sam.locator('input[type=file]').setInputFiles({ name: 'error.png', mimeType: 'image/png', buffer: PNG });
 const files = sam.getByRole('list', { name: /Files to attach/ });
 await expect(files).toContainText('error.png');
 await expect(files).toContainText('Ready');
 await sam.getByRole('button', { name: 'Send', exact: true }).click();

 const sent = sam.getByRole('list', { name: 'Messages', exact: true }).getByRole('listitem').filter({ hasText: 'Sam Agent' }).last();
 const link = sent.getByRole('link', { name: /error\.png/ });
 await expect(link).toBeVisible();
 const download = await Promise.all([sam.waitForEvent('download'), link.click()]).then(([d]) => d);
 expect(download.suggestedFilename()).toBe('error.png');
 expect(Buffer.from(await (await download.createReadStream()).toArray().then(c => Buffer.concat(c)))).toEqual(PNG);

 // Downloads are never inline and never cached.
 const href = await link.getAttribute('href');
 const r = await sam.request.get(href!);
 expect(r.headers()['content-disposition']).toMatch(/^attachment;/);
 expect(r.headers()['x-content-type-options']).toBe('nosniff');
 expect(r.headers()['cache-control']).toContain('no-store');

 // Audit: the upload (name, size, file id) and the download are recorded against Sam.
 const ada = await signedIn(browser, 'Ada Admin');
 const uploads = (await (await ada.request.get('/api/audit?category=conversation&limit=100')).json()).events
  .filter((e: { operation: string; summary: { target?: string } }) => e.operation === 'conversation.upload' && e.summary.target === conversationId);
 expect(uploads).toHaveLength(1);
 expect(uploads[0]).toMatchObject({ actor: 'Sam Agent', outcome: 'succeeded', summary: { name: 'error.png', size: PNG.length, contentType: 'image/png' } });
 const reads = (await (await ada.request.get('/api/audit?category=read&limit=100')).json()).events
  .filter((e: { operation: string; summary: { target?: string } }) => e.operation === 'read.attachment' && e.summary.target === conversationId);
 expect(reads.length).toBeGreaterThanOrEqual(1);
 await sam.context().close(); await ada.context().close();
});

test('a file that fails the policy or the scan blocks Send until it is removed', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 const { conversationId } = await newConversation('Log attached');
 await openConversation(sam, conversationId);

 // Refused in the browser before upload: type not allowed.
 await sam.locator('input[type=file]').setInputFiles({ name: 'run.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
 await expect(sam.getByRole('alert').filter({ hasText: 'run.exe: this type of file cannot be attached' })).toBeVisible();

 // Refused by the tenant's malware scan.
 const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
 await sam.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(eicar) });
 await expect(sam.getByRole('alert').filter({ hasText: 'malware scan' })).toBeVisible();
 await sam.getByLabel('Reply, visible to the customer').fill('Here is the log');
 await expect(sam.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
 await expect(sam.getByText('remove or retry the files that did not upload')).toBeVisible();
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 await sam.getByRole('button', { name: 'Remove notes.txt' }).click();
 await expect(sam.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
 await sam.context().close();
});

test('an attachment cannot be fetched through a conversation that does not contain it', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 const a = await newConversation('Has file');
 const b = await newConversation('Other');
 const form = { file: { name: 'proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\nproof') }, targetType: 'conversation', targetId: a.conversationId, uploadKey: crypto.randomUUID() };
 const up = await sam.request.post('/api/apps/payroll/uploads', { multipart: form, headers: { Origin: ORIGIN } });
 expect(up.status()).toBe(201);
 const { file } = await up.json();
 // Retrying the same upload key returns the same file, not a second copy.
 expect((await (await sam.request.post('/api/apps/payroll/uploads', { multipart: form, headers: { Origin: ORIGIN } })).json()).file.fileId).toBe(file.fileId);
 // Uploads from another site are refused.
 expect((await sam.request.post('/api/apps/payroll/uploads', { multipart: { ...form, uploadKey: crypto.randomUUID() }, headers: { Origin: 'https://evil.example' } })).status()).toBe(403);
 const sent = await sam.request.post(`/api/apps/payroll/conversations/${a.conversationId}/messages`, {
  data: { kind: 'note', content: 'Proof attached', fileIds: [file.fileId], operationId: crypto.randomUUID() }, headers: { Origin: ORIGIN },
 });
 expect(sent.status()).toBe(200);
 expect((await sam.request.get(`/api/apps/payroll/conversations/${a.conversationId}/attachments/${file.fileId}`)).status()).toBe(200);
 expect((await sam.request.get(`/api/apps/payroll/conversations/${b.conversationId}/attachments/${file.fileId}`)).status()).toBe(404);
 await sam.context().close();
});

test('agents see who else is viewing or writing, and when the customer is typing; notes never signal typing', async ({ browser }) => {
 const { conversationId } = await newConversation('Both looking');
 const sam = await signedIn(browser, 'Sam Agent');
 const ada = await signedIn(browser, 'Ada Admin');
 await openConversation(sam, conversationId);
 await openConversation(ada, conversationId);
 await expect(presence(sam)).toContainText('Ada Admin is viewing');
 await expect(presence(ada)).toContainText('Sam Agent is viewing');

 await sam.getByLabel('Reply, visible to the customer').pressSequentially('Looking into it');
 await expect(presence(ada)).toContainText('Sam Agent is writing a reply');

 // Switching to an internal note ends the typing signal, and typing a note never starts one.
 await sam.getByRole('button', { name: 'Work note' }).click();
 await sam.getByLabel('Work note, visible to support only').pressSequentially('Customer is on the old plan');
 await expect(presence(ada)).toContainText('Sam Agent is viewing');
 expect((await tenantGet(`/dev/activity?conversationId=${conversationId}`)).agents).toEqual([
  { name: 'Ada Admin', activity: 'viewing' }, { name: 'Sam Agent', activity: 'viewing' },
 ]);

 await tenantPost('/dev/visitor-activity', { conversationId, online: true, typing: true });
 await expect(presence(sam)).toContainText('Morgan Ellis is typing…');
 await tenantPost('/dev/visitor-activity', { conversationId, typing: false });
 await expect(presence(sam)).toContainText('Morgan Ellis is online');
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);

 // Leaving the conversation ends the viewing signal straight away.
 await ada.goto('/tickets');
 await expect(presence(sam)).not.toContainText('Ada Admin');
 await sam.context().close(); await ada.context().close();
});

test('availability is explicit: monitoring the inbox does not make an agent available, and signing out ends it', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent');
 // A clean starting point: away everywhere.
 const reset = await sam.request.post('/api/availability', { data: { status: 'away' }, headers: { Origin: ORIGIN } });
 expect(reset.status()).toBe(200);
 await sam.goto('/inbox');
 await expect(sam.getByRole('group', { name: 'Monitored applications' })).toContainText('Payroll · Live');
 await sam.getByRole('button', { name: /account and availability/ }).click();
 const toggle = sam.getByRole('button', { name: /Available for chats/ });
 await expect(toggle).toHaveAttribute('aria-pressed', 'false');
 expect((await tenantGet('/dev/availability'))['Sam Agent']).toBe('away');

 await toggle.click();
 await expect(toggle).toHaveAttribute('aria-pressed', 'true');
 await expect(sam.locator('[aria-live=polite]').first()).toContainText('Available in Payroll');
 expect((await tenantGet('/dev/availability'))['Sam Agent']).toBe('available');
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);

 await sam.getByRole('button', { name: 'Sign out' }).click();
 await expect(sam.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible();
 expect((await tenantGet('/dev/availability'))['Sam Agent']).toBe('away');

 const ada = await signedIn(browser, 'Ada Admin');
 const events = (await (await ada.request.get('/api/audit?category=presence&limit=100')).json()).events
  .filter((e: { operation: string; actor: string; summary: { app?: string } }) => e.operation === 'presence.availability' && e.actor === 'Sam Agent' && e.summary.app === 'payroll');
 expect(events.slice(0, 3).map((e: { summary: { status: string } }) => e.summary.status)).toEqual(['away', 'available', 'away']);
 await sam.context().close(); await ada.context().close();
});

test('observers get no composer signals and no availability control', async ({ browser }) => {
 const olive = await signedIn(browser, 'Olive Observer');
 const { conversationId } = await newConversation('Observer view');
 await openConversation(olive, conversationId);
 await olive.getByRole('button', { name: /account and availability/ }).click();
 await expect(olive.getByRole('button', { name: 'Sign out' })).toBeVisible();
 await expect(olive.getByRole('button', { name: /Available for chats/ })).toHaveCount(0);
 await olive.keyboard.press('Escape');
 expect((await olive.request.post(`/api/apps/payroll/conversations/${conversationId}/activity`, { data: { activity: 'viewing' }, headers: { Origin: ORIGIN } })).status()).toBe(403);
 expect((await olive.request.post('/api/availability', { data: { status: 'available' }, headers: { Origin: ORIGIN } })).status()).toBe(403);
 expect((await tenantGet(`/dev/activity?conversationId=${conversationId}`)).agents).toEqual([]);
 await olive.context().close();
});
