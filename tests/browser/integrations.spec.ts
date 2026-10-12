import { readFileSync } from 'node:fs';
import { test, expect, type Browser } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signInAs } from './helpers';

/* Requires npm run dev (including the mock Elastic on 3400/3401). Plan 14, E0: Elastic connection administration. */
const ORIGIN = 'http://127.0.0.1:4200';
const ES = 'http://127.0.0.1:3400', KIBANA = 'http://127.0.0.1:3401';
const json = { Origin: ORIGIN, 'Content-Type': 'application/json' };
const keys: { id: string; secret: string }[] = JSON.parse(readFileSync('tools/mock-elastic/keys.json', 'utf8')).keys;
const apiKey = (id: string) => { const k = keys.find(x => x.id === id)!; return Buffer.from(`${k.id}:${k.secret}`).toString('base64'); };
const RUN = Date.now().toString(36);

async function signedIn(browser: Browser, name: string) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
 return page;
}

test('only integration administrators see or use Elastic connections', async ({ browser }) => {
 for (const name of ['Sam Agent', 'Olive Observer']) {
  const p = await signedIn(browser, name);
  await expect(p.getByRole('link', { name: 'Integrations' })).toHaveCount(0);
  expect((await p.request.get('/api/admin/integrations/connections')).status()).toBe(403);
  expect((await p.request.post('/api/admin/integrations/connections', { headers: json, data: JSON.stringify({ name: 'x', elasticsearchUrl: ES, kibanaUrl: KIBANA, spaceId: 'support-ops', apiKey: apiKey('resolve-reader') }) })).status()).toBe(403);
  await p.context().close();
 }
});

test('an admin adds a connection, tests it, and sees exactly what the key can read; the key is never shown again', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 await ada.getByRole('link', { name: 'Integrations' }).click();
 await expect(ada.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();

 const form = ada.getByRole('region', { name: 'Add an Elastic connection' });
 await form.getByLabel('Connection name').fill(`Mock cloud ${RUN}`);
 await form.getByLabel('Elasticsearch endpoint').fill('https://es.not-approved.example');
 await form.getByLabel('Kibana endpoint').fill(KIBANA);
 await form.getByLabel('Kibana space ID').fill('support-ops');
 await form.getByLabel('Read-only API key').fill(apiKey('resolve-reader'));
 await expect(form.getByLabel('Read-only API key')).toHaveAttribute('type', 'password');
 await form.getByRole('button', { name: 'Add connection' }).click();
 await expect(ada.getByRole('alert')).toContainText('not on the approved Elastic host list');
 await expect(form.getByLabel('Elasticsearch endpoint')).toBeFocused();

 await form.getByLabel('Elasticsearch endpoint').fill(ES);
 await form.getByRole('button', { name: 'Add connection' }).click();
 await expect(ada.getByRole('status').filter({ hasText: `Added Mock cloud ${RUN}` })).toBeVisible();
 const row = ada.getByRole('row', { name: new RegExp(`Mock cloud ${RUN}`) });
 await expect(row).toContainText('Not tested');

 await ada.getByRole('button', { name: 'Test connection' }).click();
 await expect(row).toContainText('Reachable · 7 of 7 available');
 await expect(row).toContainText('9.1.0');
 const results = ada.getByRole('table', { name: /What this key can read/ });
 for (const family of ['SLOs', 'Alerts', 'Synthetics', 'APM traces and errors', 'Real user monitoring', 'Logs', 'Cases'])
  await expect(results.getByRole('row', { name: new RegExp(family) })).toContainText('Available');

 // Write-only: no API response carries the key.
 const listed = await (await ada.request.get('/api/admin/integrations/connections')).text();
 expect(listed).not.toContain(apiKey('resolve-reader'));
 expect(listed).not.toContain('dev-only-mock-elastic');

 const axe = await new AxeBuilder({ page: ada }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
 expect(axe.violations).toEqual([]);
 await ada.context().close();
});

test('a narrow key is reported family by family; replacing the key and the kill switch are audited', async ({ browser }) => {
 const ada = await signedIn(browser, 'Ada Admin');
 const created = await ada.request.post('/api/admin/integrations/connections', { headers: json, data: JSON.stringify({ name: `Narrow ${RUN}`, elasticsearchUrl: ES, kibanaUrl: KIBANA, spaceId: 'support-ops', apiKey: apiKey('resolve-narrow') }) });
 expect(created.status()).toBe(201);
 await ada.goto('/integrations');
 const row = ada.getByRole('row', { name: new RegExp(`Narrow ${RUN}`) });
 await row.getByRole('button', { name: /Manage/ }).click();
 await ada.getByRole('button', { name: 'Test connection' }).click();
 const results = ada.getByRole('table', { name: /What this key can read/ });
 await expect(results.getByRole('row', { name: /^SLOs/ })).toContainText('Not permitted for this key');
 await expect(results.getByRole('row', { name: /^Alerts/ })).toContainText('Not found for this key');
 await expect(results.getByRole('row', { name: /APM traces/ })).toContainText('Available');
 await expect(row).toContainText('Reachable · 1 of 7 available');

 // Replace the key: discovery is cleared until tested again.
 await ada.getByRole('button', { name: 'Replace API key' }).click();
 await ada.getByLabel('New read-only API key').fill(apiKey('resolve-reader'));
 await ada.getByRole('button', { name: 'Save new key' }).click();
 await expect(row).toContainText('Not tested');
 await ada.getByRole('button', { name: 'Test connection' }).click();
 await expect(row).toContainText('Reachable · 7 of 7 available');

 // Kill switch: needs a reason and a confirmation; testing is then refused.
 await ada.getByRole('button', { name: 'Turn kill switch on…' }).click();
 await expect(ada.getByRole('alert')).toContainText('Give a reason first');
 await ada.getByLabel('Reason (recorded in the audit)').fill('Rotating keys after an incident');
 await ada.getByRole('button', { name: 'Turn kill switch on…' }).click();
 const dialog = ada.getByRole('alertdialog', { name: 'Turn the kill switch on?' });
 await dialog.getByRole('button', { name: 'Turn it on' }).click();
 await expect(row).toContainText('Kill switch on');
 await expect(ada.getByRole('button', { name: 'Test connection' })).toBeDisabled();
 const id = (await (await ada.request.get('/api/admin/integrations/connections')).json()).connections.find((c: { name: string }) => c.name === `Narrow ${RUN}`).id;
 expect((await ada.request.post(`/api/admin/integrations/connections/${id}/test`, { headers: json, data: '{}' })).status()).toBe(409);

 const audit = await (await ada.request.get('/api/audit?category=observability&limit=50')).json();
 const ops = audit.events.filter((e: { summary: { connectionId?: string } }) => e.summary.connectionId === id).map((e: { operation: string }) => e.operation);
 expect(ops).toEqual(expect.arrayContaining(['observability.connection_create', 'observability.connection_test', 'observability.credential_rotate', 'observability.kill_switch']));
 await ada.context().close();
});
