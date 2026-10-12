import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ES, FLEET, payrollMapped, post, signedIn, tags, ticketFor } from './elastic-helpers';

/*
 * Requires npm run dev. Plan 14, E3 (prototype board 3, and board 2's live activity): pre-flight checks before closing,
 * verified receipts after acting, and being told when a known issue clears. cust-1's errors fall inside Payroll's
 * open case, so closing their ticket warns; customer 7 is not identified.
 */
const RUN = Date.now().toString(36);
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => { const ada = await payrollMapped(browser, `Receipts ${RUN}`); await ada.context().close(); });

test("resolving an affected customer's ticket warns before acting, and linking to the case instead keeps it open", async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const t = await ticketFor(sam, 1);
 await sam.goto(`/tickets/payroll/${t.id}`);
 await sam.getByLabel('Change status').selectOption('closed');
 const dialog = sam.getByRole('alertdialog', { name: 'Resolve this ticket?' });
 await expect(dialog).toContainText('Pre-flight check');
 await expect(dialog).toContainText('The application is degraded');
 await expect(dialog).toContainText('Matches known issue case-payroll-1182');
 await expect(dialog).toContainText("of this customer's errors fall inside its window");
 await expect(dialog).toContainText('Download payslip (eu-west) failing');
 await expect(dialog).toContainText('Resolving now will most likely not fix this for the customer.');
 await expect(dialog).toContainText('Pre-flight result is saved with the action log');
 const link = dialog.getByRole('button', { name: 'Link to case-payroll-1182 and notify me' });
 await expect(link).toBeFocused();
 expect((await new AxeBuilder({ page: sam }).withTags(tags).include('dialog').analyze()).violations).toEqual([]);
 await link.click();
 await expect(sam.getByText(/Linked to case-payroll-1182\. You'll be told when it clears; the ticket stays open\./)).toBeVisible();
 await expect(sam.getByLabel('Change status')).toHaveValue('open');
 const subs = (await (await sam.request.get('/api/observability/subscriptions')).json()).subscriptions;
 expect(subs.some((s: { objectId: string }) => s.objectId === t.id)).toBe(true);
 await sam.context().close();
});

test('a warning can be overridden only with a reason, which is audited and shown on the receipt; the API refuses blind overrides', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const t = await ticketFor(sam, 1);
 const ver = (await (await sam.request.get(`/api/apps/payroll/tickets/${t.id}`)).json()).detail.ticket.version;
 // Without a pre-flight the server evaluates one and refuses: the person has not seen the warning.
 const blind = await post(sam, `/api/apps/payroll/tickets/${t.id}/status`, { statusCategory: 'closed', expectedVersion: ver, override: { reason: 'Customer asked to close' } });
 expect(blind.status()).toBe(409);
 const body = await blind.json();
 expect(body.error.code).toBe('PREFLIGHT_WARNING');
 expect(body.preflight.outcome).toBe('warn');

 await sam.goto(`/tickets/payroll/${t.id}`);
 await sam.getByLabel('Change status').selectOption('closed');
 const dialog = sam.getByRole('alertdialog', { name: 'Resolve this ticket?' });
 await dialog.getByRole('button', { name: 'Run anyway' }).click();
 await expect(dialog.getByRole('button', { name: 'Run anyway' })).toBeDisabled();
 await dialog.getByLabel('Why go ahead anyway? (recorded in the audit)').fill('Customer confirmed by phone it is fixed for them');
 await dialog.getByRole('button', { name: 'Run anyway' }).click();
 await expect(sam.getByText('Status updated.')).toBeVisible();
 await sam.getByRole('link', { name: 'View receipt' }).click();
 const receipt = sam.getByRole('region', { name: /Resolved a ticket/ });
 await expect(receipt).toContainText('Accepted and confirmed by the application.');
 await expect(receipt).toContainText('No downstream signal is defined for this action.');
 await expect(receipt).toContainText('warn · overridden: Customer confirmed by phone it is fixed for them');
 expect((await new AxeBuilder({ page: sam }).withTags(tags).analyze()).violations).toEqual([]);
 // Leave the fixture as found: reopen the ticket (opening is not gated).
 const now = (await (await sam.request.get(`/api/apps/payroll/tickets/${t.id}`)).json()).detail.ticket.version;
 expect((await post(sam, `/api/apps/payroll/tickets/${t.id}/status`, { statusCategory: 'open', expectedVersion: now })).ok()).toBe(true);
 await sam.context().close();
 const ada = await signedIn(browser, 'Ada Admin');
 const audit = await (await ada.request.get('/api/audit?category=observability&limit=50')).json();
 expect(audit.events.some((e: { operation: string; summary: { target?: string } }) => e.operation === 'observability.preflight_override' && e.summary.target === t.id)).toBe(true);
 await ada.context().close();
});

test("an unidentified customer's ticket gets 'not known' checks and may be resolved", async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const t = await ticketFor(sam, 7);
 await sam.goto(`/tickets/payroll/${t.id}`);
 await sam.getByLabel('Change status').selectOption('closed');
 const dialog = sam.getByRole('alertdialog', { name: 'Resolve this ticket?' });
 await expect(dialog).toContainText('The application did not identify this customer');
 await expect(dialog.getByRole('button', { name: 'Keep open' })).toBeFocused();
 await dialog.getByRole('button', { name: 'Resolve ticket' }).click();
 await expect(sam.getByText('Status updated.')).toBeVisible();
 await sam.context().close();
});

test('a reply gets a verified receipt once the notification service is seen handling it; a relay failure shows as failed', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const t = await ticketFor(sam, 2);
 await sam.goto(`/tickets/payroll/${t.id}`);
 await sam.getByLabel('Reply, visible to the customer').fill(`We are on it ${RUN}`);
 await sam.getByRole('button', { name: 'Send reply' }).click();
 await sam.getByRole('link', { name: 'View the receipt for your reply' }).click();
 const receipt = sam.getByRole('region', { name: /Reply/ });
 await expect(receipt).toContainText("Recorded in Resolve's audit");
 await expect(receipt).toContainText('Accepted by the application');
 // The worker sees the relay's event (matched on the operation id) within seconds; the page re-reads by itself.
 await expect(receipt.getByRole('heading', { level: 1 })).toHaveText('Reply handed to the mail relay', { timeout: 30_000 });
 await expect(receipt).toContainText('notification-service');
 await expect(receipt).toContainText('does not prove it reached the inbox');

 await fetch(`${FLEET}/dev/relay`, { method: 'POST', body: JSON.stringify({ appKey: 'payroll', failing: true }) });
 try {
  await sam.goto(`/tickets/payroll/${t.id}`);
  await sam.getByLabel('Reply, visible to the customer').fill(`Second update ${RUN}`);
  await sam.getByRole('button', { name: 'Send reply' }).click();
  await sam.getByRole('link', { name: 'View the receipt for your reply' }).click();
  await expect(sam.getByRole('heading', { level: 1 })).toHaveText('Reply did not go through', { timeout: 30_000 });
  await expect(sam.getByRole('main')).toContainText('The relay reported a failure (HTTP 550)');
 } finally {
  await fetch(`${FLEET}/dev/relay`, { method: 'POST', body: JSON.stringify({ appKey: 'payroll', failing: false }) });
 }
 // Live activity: Sam's own actions link to receipts; verification is shown.
 await sam.goto('/');
 const live = sam.getByRole('region', { name: 'Live activity' });
 await expect(live).toContainText('✓ verified in logs');
 await expect(live.getByRole('link', { name: 'Reply' }).first()).toBeVisible();
 await sam.context().close();

 // Another agent sees Sam's actions without their targets.
 const ivy = await signedIn(browser, 'Ivy Investigator');
 const entries = (await (await ivy.request.get('/api/observability/activity')).json()).entries as { actor: string; target: string | null; operationId: string | null }[];
 const samsEntries = entries.filter(e => e.actor === 'Sam Agent');
 expect(samsEntries.length).toBeGreaterThan(0);
 expect(samsEntries.every(e => e.target === null && e.operationId === null)).toBe(true);
 await ivy.context().close();
});

test('when the case clears, the person who asked is told and nothing is re-run', async ({ browser }) => {
 const sam = await signedIn(browser, 'Sam Agent', ['payroll']);
 const ada = await signedIn(browser, 'Ada Admin');
 await fetch(`${ES}/dev/case`, { method: 'POST', body: JSON.stringify({ id: 'case-payroll-1182', status: 'closed' }) });
 try {
  await post(ada, '/api/admin/integrations/mappings/payroll/production/refresh', {});
  await sam.goto('/');
  const issues = sam.getByRole('region', { name: 'Known issues' });
  await expect(issues).toContainText('Cleared: Payslip downloads failing in EU-West.', { timeout: 20_000 });
  await expect(issues).toContainText('Nothing was re-run');
  await issues.getByRole('link', { name: 'come back to the ticket' }).first().click();
  await expect(sam).toHaveURL(/\/tickets\/payroll\//);
  await sam.goto('/');
  for (const b of await issues.getByRole('button', { name: /Dismiss/ }).all()) await b.click();
  await expect(issues).not.toContainText('Cleared:');
 } finally {
  await fetch(`${ES}/dev/case`, { method: 'POST', body: JSON.stringify({ id: 'case-payroll-1182', status: 'open' }) });
  await post(ada, '/api/admin/integrations/mappings/payroll/production/refresh', {});
 }
 await sam.context().close(); await ada.context().close();
});
