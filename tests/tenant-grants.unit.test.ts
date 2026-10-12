import { describe, expect, test } from 'vitest';
import { ResponseBodyError } from 'openid-client';
import { capabilitiesFor } from '../packages/contracts/src';
import { aad, localSealer } from '../apps/api/lib/crypto';
import { classifyRefreshError, tenantScopes } from '../apps/api/lib/tenants/oauth';

const sealer = localSealer(Buffer.alloc(32, 7).toString('base64'));

describe('sealing tokens', () => {
 test('round-trips and never contains the plaintext', () => {
  const sealed = sealer.seal('secret-token', aad.accessToken('u1', 'payroll'));
  expect(sealed).not.toContain('secret-token');
  expect(sealer.open(sealed, aad.accessToken('u1', 'payroll'))).toBe('secret-token');
 });
 test('a ciphertext cannot be moved to another user, app or purpose', () => {
  const sealed = sealer.seal('t', aad.accessToken('u1', 'payroll'));
  for (const other of [aad.accessToken('u2', 'payroll'), aad.accessToken('u1', 'hr'), aad.refreshToken('u1', 'payroll')])
   expect(() => sealer.open(sealed, other)).toThrow();
 });
 test('tampering and a different key are detected', () => {
  const sealed = sealer.seal('t', 'x');
  const parts = sealed.split(':'); parts[3] = Buffer.from('tampered').toString('base64url');
  expect(() => sealer.open(parts.join(':'), 'x')).toThrow();
  expect(() => localSealer(Buffer.alloc(32, 8).toString('base64')).open(sealed, 'x')).toThrow();
  expect(() => localSealer(Buffer.alloc(16).toString('base64'))).toThrow();
 });
});

describe('tenant scopes follow capabilities', () => {
 test('observer requests read scopes only', () => {
  expect(tenantScopes(capabilitiesFor(['fleet-observer']))).toEqual(['openid', 'offline_access', 'read:chat']);
 });
 test('agent gets chat read and write; proposed announcement scopes are never requested from the fork', () => {
  expect(tenantScopes(capabilitiesFor(['fleet-agent']))).toEqual(['openid', 'offline_access', 'read:chat', 'write:chat']);
  expect(tenantScopes(capabilitiesFor(['announcement-author']))).toEqual(['openid', 'offline_access']);
 });
});

describe('refresh failures', () => {
 const net = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
 test('definite refusal, never-sent and unknown outcomes are distinguished', () => {
  const refusal = new ResponseBodyError('invalid_grant', { cause: { error: 'invalid_grant' }, response: new Response() } as never);
  expect(classifyRefreshError(refusal).kind).toBe('invalid_grant');
  expect(classifyRefreshError(net('ECONNREFUSED')).kind).toBe('not_sent');
  expect(classifyRefreshError(net('ECONNRESET')).kind).toBe('unknown');
  expect(classifyRefreshError(new DOMException('timeout', 'TimeoutError')).kind).toBe('unknown');
 });
});
