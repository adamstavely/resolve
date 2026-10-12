import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RegistryApp } from '../packages/contracts/src';
import { fanOut } from '../apps/api/lib/fleet/fanout';
import { resetHealthCache } from '../apps/api/lib/tenants/protocol';

const app = (appKey: string, o: Partial<RegistryApp> = {}): RegistryApp => ({ appKey, displayName: appKey, supportOrigin: `https://${appKey}.test`, routable: true,
 dormant: false, state: 'active', deploymentVersion: 'v', protocolVersions: [1], lastActivityAt: null, ...o });
const compatible = { protocolVersions: [1], tools: { list_tickets: 2, get_ticket: 1, list_conversations: 1, get_conversation: 2, get_support_dashboard: 1, list_support_activity: 1 } };
let probed: string[];

beforeEach(() => {
 resetHealthCache(); probed = [];
 vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  probed.push(new URL(url).hostname);
  if (url.startsWith('https://old.test')) return Response.json({ protocolVersions: [1], tools: { list_tickets: 1 } });
  return Response.json(compatible);
 }));
});
afterEach(() => vi.unstubAllGlobals());

describe('fleet fan-out', () => {
 test('dormant and unavailable apps are never contacted; include wakes a dormant app on request', async () => {
  const calls: string[] = [];
  const apps = [app('a'), app('idle', { dormant: true }), app('down', { state: 'suspended', routable: false })];
  const call = async (a: RegistryApp) => { calls.push(a.appKey); return { ok: true as const, data: a.appKey }; };
  const r = await fanOut(apps, call);
  expect(r.map(x => x.status === 'ok' ? x.appKey + ':ok' : `${x.appKey}:${x.reason}`)).toEqual(['a:ok', 'idle:dormant', 'down:suspended']);
  expect(calls).toEqual(['a']);
  expect(probed).toEqual(['a.test']);
  await fanOut(apps, call, { include: new Set(['idle']) });
  expect(calls).toEqual(['a', 'a', 'idle']);
 });

 test('incompatible tenants are reported and not called', async () => {
  const calls: string[] = [];
  const r = await fanOut([app('old'), app('new')], async a => { calls.push(a.appKey); return { ok: true as const, data: 1 }; });
  expect(r[0]).toMatchObject({ status: 'unavailable', reason: 'incompatible', retryable: false });
  expect(calls).toEqual(['new']);
 });

 test('concurrency is bounded and results keep app order', async () => {
  let inFlight = 0, peak = 0;
  const apps = Array.from({ length: 14 }, (_, i) => app('app' + i));
  const r = await fanOut(apps, async a => {
   inFlight++; peak = Math.max(peak, inFlight);
   await new Promise(res => setTimeout(res, 5 + Number(a.appKey.slice(3)) % 3));
   inFlight--; return { ok: true as const, data: a.appKey };
  }, { concurrency: 6 });
  expect(peak).toBeLessThanOrEqual(6);
  expect(r.map(x => x.appKey)).toEqual(apps.map(a => a.appKey));
 });

 test('a slow or failing app becomes its own unavailable result', async () => {
  const r = await fanOut([app('slow'), app('broken'), app('fine'), app('denied')], async a => {
   if (a.appKey === 'slow') await new Promise(res => setTimeout(res, 200));
   if (a.appKey === 'broken') throw new Error('boom');
   if (a.appKey === 'denied') return { ok: false as const, reason: 'denied' as const };
   return { ok: true as const, data: 'x' };
  }, { timeoutMs: 50 });
  expect(r.map(x => x.status === 'ok' ? 'ok' : x.reason)).toEqual(['timeout', 'tenant_error', 'ok', 'denied']);
  expect(r[0]).toMatchObject({ retryable: true });
  expect(r[3]).toMatchObject({ retryable: false });
 });
});
