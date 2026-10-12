import { describe, expect, test } from 'vitest';
import { config } from '../apps/api/lib/config';
import { bundlesForGroups, capabilityList, readCookie, safeReturnTo, sameOrigin, serializeCookie } from '../apps/api/lib/auth/policy';

describe('returnTo', () => {
 test.each(['/', '/inbox?app=payroll', '/a/b#c'])('keeps same-origin path %s', p => expect(safeReturnTo(p)).toBe(p));
 test.each([null, '', 'https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/ok\nSet-Cookie: x=1', '/' + 'a'.repeat(600)])
  ('rejects %j', p => expect(safeReturnTo(p)).toBe('/'));
});

describe('group mapping fails closed', () => {
 const mapping = { 'resolve-agents': ['fleet-agent'], 'resolve-admins': ['fleet-admin'] } as const;
 test('maps known groups, ignores unknown and malformed claims', () => {
  expect(bundlesForGroups(['resolve-agents', 'everyone', 42, 'resolve-agents'], mapping)).toEqual(['fleet-agent']);
  expect(bundlesForGroups('resolve-admins', mapping)).toEqual([]);
  expect(bundlesForGroups(undefined, mapping)).toEqual([]);
  expect(bundlesForGroups(['__proto__', 'constructor'], mapping)).toEqual([]);
 });
 test('unknown stored bundle names grant nothing', () => {
  expect(capabilityList(['fleet-root', 'fleet-observer'])).toEqual(capabilityList(['fleet-observer']));
  expect(capabilityList([])).toEqual([]);
 });
});

describe('cookies and origin', () => {
 test('session cookie is HttpOnly and SameSite=Lax; Secure when configured', () => {
  expect(serializeCookie('s', 'v', { secure: true, maxAgeSeconds: 60 })).toBe('s=v; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60');
  expect(serializeCookie('s', 'v', { secure: false })).not.toContain('Secure');
 });
 test('reads a named cookie only', () => {
  expect(readCookie('a=1; resolve_session=abc; b=2', 'resolve_session')).toBe('abc');
  expect(readCookie('xresolve_session=abc', 'resolve_session')).toBeUndefined();
  expect(readCookie(null, 'resolve_session')).toBeUndefined();
 });
 test('state changes require the exact origin', () => {
  expect(sameOrigin('http://127.0.0.1:4200', 'http://127.0.0.1:4200')).toBe(true);
  expect(sameOrigin(null, 'http://127.0.0.1:4200')).toBe(false);
  expect(sameOrigin('http://127.0.0.1:4200.evil.example', 'http://127.0.0.1:4200')).toBe(false);
 });
});

describe('configuration fails closed', () => {
 const base = { DATABASE_URL: 'postgres://x', RESOLVE_ORIGIN: 'https://resolve.corp.internal/', OIDC_ISSUER: 'https://idp.corp.internal', OIDC_CLIENT_ID: 'resolve', OIDC_CLIENT_SECRET: 'x'.repeat(32), RESOLVE_GROUP_BUNDLES: '{"g":["fleet-agent"]}',
  RESOLVE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), REGISTRY_URL: 'https://fleet.corp.internal/registry', REGISTRY_TOKEN: 'r'.repeat(32),
  DIRECTORY_URL: 'https://idp.corp.internal/directory/users', DIRECTORY_TOKEN: 'd'.repeat(32),
  WORKER_URL: 'https://fleet.corp.internal/worker', WORKER_TOKEN: 'w'.repeat(32) };
 test('valid production-shaped config; cookies Secure by default', () => {
  const c = config(base);
  expect(c.RESOLVE_ORIGIN).toBe('https://resolve.corp.internal');
  expect(c.RESOLVE_COOKIE_SECURE).toBe(true);
 });
 test.each([
  ['unknown bundle', { RESOLVE_GROUP_BUNDLES: '{"g":["root"]}' }],
  ['malformed mapping', { RESOLVE_GROUP_BUNDLES: 'not json' }],
  ['plain-http non-loopback issuer', { OIDC_ISSUER: 'http://idp.corp.internal' }],
  ['short client secret', { OIDC_CLIENT_SECRET: 'short' }],
  ['short encryption key', { RESOLVE_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }],
  ['plain-http registry', { REGISTRY_URL: 'http://fleet.corp.internal/registry' }],
  ['plain-http worker', { WORKER_URL: 'http://fleet.corp.internal/worker' }],
  ['missing worker credential', { WORKER_TOKEN: undefined }],
 ])('rejects %s', (_l, patch) => expect(() => config({ ...base, ...patch })).toThrow());
 test('loopback http issuer is allowed for the local mock', () => expect(config({ ...base, OIDC_ISSUER: 'http://127.0.0.1:3200' }).OIDC_ISSUER).toBe('http://127.0.0.1:3200'));
});
