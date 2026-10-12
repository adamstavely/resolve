import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { canonicalJson, canTransition, COMMAND_PATHS, jobRequestSchema, JOB_COMMANDS, type JobStatus } from '../packages/contracts/src';
import { desiredEntitlement } from '../apps/api/lib/fleet-admin/entitlements';
import { checkFile } from '../apps/api/lib/fleet/files';
import type { Tenant } from '../tools/mock-tenant/tenant.mts';

process.env.MOCK_WORKER_STEP_MS = '2';
const { FleetWorker } = await import('../tools/mock-tenant/worker.mts');
const { startTenant, sha } = await import('../tools/mock-tenant/tenant.mts');

const hex = (c: string) => c.repeat(64);
const uuid = () => crypto.randomUUID();
const IMAGE = 'sha256:' + hex('a');
const ctx = { idp: 'http://127.0.0.1:9', resolveRedirect: 'http://127.0.0.1:4200/api/connect/callback', people: { 'mock|sam': { role: 'agent' as const, teams: ['support'] } }, names: {} };
let tenant: Tenant;
const fleet = new Map<string, Tenant>();
const worker = () => new FleetWorker(fleet, ctx, 'x'.repeat(32), IMAGE);

beforeAll(async () => {
 tenant = await startTenant({ appKey: 'unit', displayName: 'Unit', port: 3390 + Math.floor(Math.random() * 9), state: 'active', routable: true, dormant: false, seed: 3, tickets: 2, conversations: 2,
  analyticsRoles: [], idpClient: { id: 'qb-unit', secret: 's'.repeat(20) } }, ctx, IMAGE);
 fleet.set('unit', tenant);
});
afterAll(() => tenant.close());

const envelope = (over: Record<string, unknown> = {}) => ({ appKey: 'unit', requestId: uuid(), desiredStateVersion: 1, initiator: { userId: uuid(), operationId: uuid() }, ...over });
async function settle(w: InstanceType<typeof FleetWorker>, jobId: string): Promise<JobStatus> {
 for (let i = 0; i < 200; i++) {
  const s = w.get(jobId)!;
  if (['succeeded', 'cancelled', 'needs_operator', 'retryable_failure', 'ready_to_activate'].includes(s.stage)) return s;
  await new Promise(r => setTimeout(r, 5));
 }
 throw new Error('job did not settle');
}
const apply = (w: InstanceType<typeof FleetWorker>, version: number, role: string, status = 'active', hashOverride?: string) => {
 const entitlement = { status, role, teams: ['support'] };
 return w.submit({ ...envelope({ desiredStateVersion: version }), command: 'apply_entitlements', parameters: {
  userId: uuid(), entitlementVersion: version, payloadHash: hashOverride ?? sha(canonicalJson(entitlement)), identity: { issuer: ctx.idp, subject: 'mock|sam' }, entitlement } });
};

describe('job contract (contract 4)', () => {
 test('every happy path is a legal sequence of stages', () => {
  for (const c of JOB_COMMANDS) {
   const p = COMMAND_PATHS[c];
   for (let i = 1; i < p.length; i++) expect(canTransition(p[i - 1], p[i]), `${c}: ${p[i - 1]} → ${p[i]}`).toBe(true);
  }
 });
 test('provisioning carries no secrets: unknown fields anywhere are refused, the client secret travels only as a hash', () => {
  const configuration = { displayName: 'X', environment: 'production', teamMappings: [], channels: { chat: true, email: { address: 'a@b.test', owner: 'o' }, banner: false }, pilots: [{ issuer: 'https://idp.test', subject: 's' }] };
  const parameters = { strategy: 'create', supportHostname: 'x.support.corp.internal', mailSlug: 'xx', configRevision: hex('b'), configuration, oauthClient: { clientId: 'resolve-x', secretSha256: hex('c'), redirectUri: 'https://r.test/cb' } };
  expect(jobRequestSchema.safeParse({ ...envelope(), command: 'provision', parameters }).success).toBe(true);
  expect(jobRequestSchema.safeParse({ ...envelope(), command: 'provision', parameters: { ...parameters, oauthClient: { ...parameters.oauthClient, secret: 'plain' } } }).success).toBe(false);
  expect(jobRequestSchema.safeParse({ ...envelope(), command: 'provision', parameters: { ...parameters, configuration: { ...configuration, databaseUrl: 'postgres://x' } } }).success).toBe(false);
  expect(jobRequestSchema.safeParse({ ...envelope(), command: 'provision', parameters: { ...parameters, supportHostname: 'evil.example/../x' } }).success).toBe(false);
 });
});

describe('mock fleet worker', () => {
 test('the worker validates again and is idempotent per request id', async () => {
  const w = worker();
  expect(w.submit({ ...envelope(), command: 'resume', parameters: { image: 'evil:latest' } }).status).toBe(400);
  const req = { ...envelope(), command: 'suspend', parameters: { reason: 'operator' } };
  const a = w.submit(req), b = w.submit(req);
  expect((b.body as JobStatus).jobId).toBe((a.body as JobStatus).jobId);
  expect(w.submit({ ...req, parameters: { reason: 'security' } }).status).toBe(409);
  await settle(w, (a.body as JobStatus).jobId);
  // Resume the instance for the other tests.
  const r = w.submit({ ...envelope({ desiredStateVersion: 2 }), command: 'resume', parameters: {} });
  expect((await settle(w, (r.body as JobStatus).jobId)).stage).toBe('succeeded');
 });

 test('one lifecycle job at a time per app, and an older desired-state version is refused', async () => {
  const w = worker();
  const first = w.submit({ ...envelope({ desiredStateVersion: 5 }), command: 'suspend', parameters: { reason: 'operator' } });
  expect(w.submit({ ...envelope({ desiredStateVersion: 6 }), command: 'resume', parameters: {} })).toMatchObject({ status: 409, body: { error: 'APP_BUSY' } });
  await settle(w, (first.body as JobStatus).jobId);
  expect(w.submit({ ...envelope({ desiredStateVersion: 4 }), command: 'resume', parameters: {} })).toMatchObject({ status: 409, body: { error: 'STALE_VERSION' } });
  const r = w.submit({ ...envelope({ desiredStateVersion: 7 }), command: 'resume', parameters: {} });
  expect((await settle(w, (r.body as JobStatus).jobId)).stage).toBe('succeeded');
  expect(tenant.state).toBe('active');
 });

 test('entitlements are version-fenced: older never replaces newer; one version cannot carry two payloads', async () => {
  const w = worker();
  const v3 = apply(w, 3, 'agent'); await settle(w, (v3.body as JobStatus).jobId);
  const v2 = apply(w, 2, 'admin'); expect((await settle(w, (v2.body as JobStatus).jobId)).stage).toBe('succeeded');
  expect(tenant.entitlements.get(`${ctx.idp}|mock|sam`)).toMatchObject({ version: 3, role: 'agent' });
  const clash = apply(w, 3, 'observer');
  expect(await settle(w, (clash.body as JobStatus).jobId)).toMatchObject({ stage: 'needs_operator', failureCode: 'VERSION_PAYLOAD_MISMATCH' });
  const forged = apply(w, 4, 'admin', 'active', hex('d'));
  expect(await settle(w, (forged.body as JobStatus).jobId)).toMatchObject({ stage: 'needs_operator', failureCode: 'PAYLOAD_HASH_MISMATCH' });
  // A denial is enforced by the tenant itself.
  const deny = apply(w, 5, 'portal', 'denied'); await settle(w, (deny.body as JobStatus).jobId);
  expect(tenant.viewer(tenant.userFor(ctx.idp, 'mock|sam', '').id)).toMatchObject({ denied: true, role: 'portal' });
 });

 test('activation is fenced to the validated revision and image', async () => {
  const w = worker();
  tenant.configRevision = hex('e');
  const v = w.submit({ ...envelope({ desiredStateVersion: 10 }), command: 'validate', parameters: { configRevision: hex('e') } });
  const validated = await settle(w, (v.body as JobStatus).jobId);
  let version = 10;
  const act = (image: string, rev = hex('e')) => w.submit({ ...envelope({ desiredStateVersion: ++version }), command: 'activate', parameters: { configRevision: rev, testedImage: image, validationJobId: validated.jobId } });
  // Whatever validation concluded, activating a different image or revision is refused.
  w.setImage('sha256:' + hex('f'));
  const stale = act(IMAGE);
  expect(await settle(w, (stale.body as JobStatus).jobId)).toMatchObject({ stage: 'needs_operator', failureCode: 'STALE_VALIDATION' });
  const wrongRev = act(IMAGE, hex('9'));
  expect(await settle(w, (wrongRev.body as JobStatus).jobId)).toMatchObject({ failureCode: 'STALE_VALIDATION' });
 });
});

describe('entitlement computation', () => {
 const mappings = [{ bundle: 'fleet-agent', role: 'agent' as const, teams: ['support'] }, { bundle: 'fleet-observer', role: 'observer' as const, teams: ['billing'] }, { bundle: 'fleet-admin', role: 'admin' as const, teams: [] }];
 test('the highest mapped role wins and teams are combined', () => {
  expect(desiredEntitlement(['fleet-agent', 'fleet-observer'], true, mappings)).toEqual({ status: 'active', role: 'agent', teams: ['billing', 'support'] });
  expect(desiredEntitlement(['fleet-admin'], true, mappings)).toEqual({ status: 'active', role: 'admin', teams: [] });
 });
 test('no mapped bundle is a portal user (never a staff role); disabled is a denial', () => {
  expect(desiredEntitlement(['announcement-author'], true, mappings)).toEqual({ status: 'active', role: 'portal', teams: [] });
  expect(desiredEntitlement(['fleet-admin'], false, mappings)).toEqual({ status: 'denied', role: 'portal', teams: [] });
 });
});

// Keeps the attachment helpers' import graph exercised alongside the worker (shared config loading).
test('file policy is importable without a database', () => expect(checkFile('a.txt', Buffer.from('a'))).toEqual({ contentType: 'text/plain' }));
