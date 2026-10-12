import { expect, type Browser, type Page } from '@playwright/test';
import { signInAs } from './helpers';

/** Shared helpers for tests that onboard (mock) applications through Resolve and the fleet worker. */
export const ORIGIN = 'http://127.0.0.1:4200';
export const FLEET = 'http://127.0.0.1:3300';
export const tags = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
export const key = (p: string) => `${p}${Math.random().toString(36).slice(2, 7)}`;
export const H = { Origin: ORIGIN };
export const fleet = (path: string, body?: unknown) => fetch(FLEET + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
export const tenantPort = async (appKey: string) => ((await fleet('/dev/fleet')) as { appKey: string; port: number }[]).find(t => t.appKey === appKey)!.port;

export async function signedIn(browser: Browser, name: string) {
 const ctx = await browser.newContext({ baseURL: ORIGIN });
 const page = await ctx.newPage();
 await signInAs(page, name);
 await expect(page.getByText(`Signed in as ${name}`)).toBeVisible();
 return page;
}
export async function me(page: Page) { return (await (await page.request.get('/api/session')).json()).user as { id: string; displayName: string }; }
export async function runOf(page: Page, runId: string) { return (await (await page.request.get(`/api/admin/onboarding/${runId}`)).json()).run; }
export async function waitRun(page: Page, runId: string, until: (r: { status: string; jobs: { stage: string }[] }) => boolean) {
 let r;
 await expect.poll(async () => until(r = await runOf(page, runId)), { timeout: 20_000 }).toBe(true);
 return r!;
}

/** Steps 1–4 through the API (the wizard itself is exercised in the first test). */
export async function draft(admin: Page, appKey: string, opts: { adopt?: string; mappings?: unknown[]; pilots?: string[] } = {}) {
 const start = await admin.request.post('/api/admin/onboarding', { headers: H, data: { describe: {
  name: `App ${appKey}`, key: appKey, description: '', appUrl: `https://${appKey}.corp.internal`, environment: 'production', ownerName: 'Owner', ownerEmail: 'owner@example.test', supportTeam: 'Support', contact: '' } } });
 expect(start.status()).toBe(201);
 const { runId } = await start.json();
 const put = async (step: string, data: unknown) => {
  const r = await admin.request.put(`/api/admin/onboarding/${runId}/steps/${step}`, { headers: H, data: { data, version: (await runOf(admin, runId)).version } });
  expect(r.status(), await r.text()).toBe(200);
 };
 await put('instance', opts.adopt ? { strategy: 'adopt', workspaceKey: opts.adopt, mailSlug: appKey } : { strategy: 'create', supportHostname: `${appKey}.support.corp.internal`, mailSlug: appKey });
 await put('access', { teamMappings: opts.mappings ?? [{ bundle: 'fleet-admin', role: 'admin', teams: [] }, { bundle: 'fleet-agent', role: 'agent', teams: ['support'] }], pilotUserIds: opts.pilots ?? [(await me(admin)).id] });
 await put('entry', { emailAddress: `${appKey}@support.corp.internal`, emailOwner: 'Support', banner: false });
 return runId as string;
}
export async function reviewAndProvision(admin: Page, runId: string) {
 const review = await (await admin.request.post(`/api/admin/onboarding/${runId}/review`, { headers: H, data: {} })).json();
 const r = await admin.request.post(`/api/admin/onboarding/${runId}/provision`, { headers: H, data: { configRevision: review.configRevision, requestId: crypto.randomUUID() } });
 expect(r.status(), await r.text()).toBe(202);
 return review.configRevision as string;
}
export const connected = (page: Page) => expect(page.getByText(/^Connected to /)).toBeVisible();
export async function pilotCheck(pilot: Page, runId: string, workspaceKey: string) {
 await pilot.goto(`/api/connect/${workspaceKey}/start`);
 await connected(pilot);
 const r = await pilot.request.post(`/api/onboarding/${runId}/pilot`, { headers: H, data: {} });
 expect((await r.json()).passed).toBe(true);
}
export async function activate(admin: Page, runId: string) {
 const run = await runOf(admin, runId);
 const v = run.jobs.find((j: { command: string }) => j.command === 'provision' || j.command === 'validate');
 const r = await admin.request.post(`/api/admin/onboarding/${runId}/activate`, { headers: H, data: { configRevision: run.configRevision, requestId: crypto.randomUUID(), validationJobId: v.id } });
 expect(r.status(), await r.text()).toBe(202);
 return waitRun(admin, runId, x => x.status === 'active');
}
/** A fully onboarded, active application (create strategy), with Ada as admin and pilot. */
export async function onboarded(admin: Page, prefix: string, mappings?: unknown[]) {
 const appKey = key(prefix);
 const runId = await draft(admin, appKey, { mappings });
 await reviewAndProvision(admin, runId);
 await waitRun(admin, runId, r => r.status === 'ready');
 await pilotCheck(admin, runId, appKey);
 await activate(admin, runId);
 return { appKey, runId };
}

