import { describe, expect, test } from 'vitest';
import {
 auditOperationSchema, broadcastRevisionSchema, broadcastSummary, canTransition, canTransitionDelivery, canonicalJson,
 checkCallbackBinding, checkIdentityMapping, classify, contentHash, deliveryKey, evaluateCompatibility, isServable,
 jobRequestSchema, payloadHash, redactParameters, registryAppSchema, replayDecision, retryDecision, sumMetric,
 type ConnectAttempt,
} from '../../packages/contracts/src';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hex = (c: string) => c.repeat(64);

describe('registry read (contract 1)', () => {
 const app = { appKey: 'payroll', displayName: 'Payroll', supportOrigin: 'https://payroll.support.corp.internal', routable: true, dormant: false, state: 'active', deploymentVersion: 'qb-0.14.1', protocolVersions: [1], lastActivityAt: null };
 test('accepts the projection', () => expect(isServable(registryAppSchema.parse(app))).toBe(true));
 test.each(['dsn', 'secretRef', 'rootKey', 'credentials'])('rejects secret-bearing field %s', field => {
  expect(registryAppSchema.safeParse({ ...app, [field]: 'x' }).success).toBe(false);
 });
 test('unknown state is unavailable, not active', () => {
  const parsed = registryAppSchema.parse({ ...app, state: 'warming' });
  expect(parsed.state).toBe('unknown');
  expect(isServable(parsed)).toBe(false);
 });
 test.each(['https://payroll.support.corp.internal/', 'https://payroll.support.corp.internal/admin', 'ftp://payroll.corp.internal'])('rejects non-origin %s', o => {
  expect(registryAppSchema.safeParse({ ...app, supportOrigin: o }).success).toBe(false);
 });
 test('routable flag is required for service, independent of state', () => expect(isServable(registryAppSchema.parse({ ...app, routable: false }))).toBe(false));
});

describe('OAuth connect (contract 2)', () => {
 const attempt: ConnectAttempt = { attemptId: uuid(1), userId: uuid(2), appKey: 'payroll', sessionHash: hex('a'), stateHash: hex('b'), codeChallengeMethod: 'S256', redirectUri: 'https://resolve.corp.internal/api/connect/callback', expiresAt: '2026-10-12T10:10:00Z', consumedAt: null };
 const cb = { sessionHash: hex('a'), userId: uuid(2), appKey: 'payroll', now: new Date('2026-10-12T10:05:00Z') };
 test('valid binding', () => expect(checkCallbackBinding(attempt, cb)).toEqual({ ok: true }));
 test.each([
  ['unknown_state', undefined, cb],
  ['consumed', { ...attempt, consumedAt: '2026-10-12T10:01:00Z' }, cb],
  ['expired', attempt, { ...cb, now: new Date('2026-10-12T10:10:00Z') }],
  ['wrong_session', attempt, { ...cb, sessionHash: hex('c') }],
  ['wrong_user', attempt, { ...cb, userId: uuid(3) }],
  ['wrong_app', attempt, { ...cb, appKey: 'hr' }],
 ] as const)('rejects %s', (reason, a, c) => expect(checkCallbackBinding(a, c)).toEqual({ ok: false, reason }));

 test('identity must match the persisted issuer/subject mapping; email plays no part', () => {
  const link = { appKey: 'payroll', issuer: 'https://payroll.support.corp.internal/api/auth', subject: 's1', tenantUserId: 'u1', tenantPrincipalId: 'p1' };
  const claims = { issuer: link.issuer, audience: 'resolve', subject: 's1', tenantUserId: 'u1', tenantPrincipalId: 'p1' };
  expect(checkIdentityMapping(link, claims)).toEqual([]);
  expect(checkIdentityMapping(link, { ...claims, subject: 's2' })).toEqual(['subject']);
  expect(checkIdentityMapping(undefined, claims)).toBe('unmapped');
 });
});

describe('privileged jobs (contract 4)', () => {
 const base = { appKey: 'payroll', requestId: uuid(1), desiredStateVersion: 3, initiator: { userId: uuid(2), operationId: uuid(3) } };
 test('accepts an allowlisted command', () => {
  expect(jobRequestSchema.safeParse({ ...base, command: 'validate', parameters: { configRevision: hex('d') } }).success).toBe(true);
 });
 test.each([
  ['unknown command', { ...base, command: 'shell', parameters: { cmd: 'id' } }],
  ['image override', { ...base, command: 'resume', parameters: { image: 'evil:latest' } }],
  ['environment override', { ...base, command: 'validate', parameters: { configRevision: hex('d'), env: { A: '1' } } }],
  ['DSN in envelope', { ...base, dsn: 'postgres://x', command: 'resume', parameters: {} }],
  ['mutable tag instead of digest', { ...base, command: 'activate', parameters: { configRevision: hex('d'), testedImage: 'quackback:latest', validationJobId: uuid(4) } }],
 ])('rejects %s', (_label, request) => expect(jobRequestSchema.safeParse(request).success).toBe(false));

 test('stages cannot skip validation or leave terminal states', () => {
  expect(canTransition('migrating', 'ready_to_activate')).toBe(false);
  expect(canTransition('validating', 'ready_to_activate')).toBe(true);
  expect(canTransition('ready_to_activate', 'validating')).toBe(true);
  expect(canTransition('succeeded', 'activating')).toBe(false);
  expect(canTransition('cancelled', 'preparing')).toBe(false);
 });
});

describe('audit (contract 5)', () => {
 test('redaction keeps only allowlisted non-secret shape', () => {
  const out = redactParameters({ conversationId: 'c1', accessToken: 't', content: 'customer text', fileIds: ['a', 'b'], note: 'x'.repeat(300), nested: { a: 1 } },
   ['conversationId', 'accessToken', 'fileIds', 'note', 'nested', 'absent']);
  expect(out).toEqual({ conversationId: 'c1', fileIds: '[2 items]', note: 'x'.repeat(199) + '…', nested: '[omitted]' });
 });
 test('system actors record their source event instead of a human', () => {
  const op = { operationId: uuid(1), appKey: 'payroll', operation: 'entitlement.apply', parameterSummary: {}, outcome: 'succeeded', tenantCorrelation: null, authorizedAt: '2026-10-12T10:00:00Z', dispatchedAt: null };
  expect(auditOperationSchema.safeParse({ ...op, actor: { type: 'system', executor: 'directory-sync', sourceEvent: 'scim:123', sourceVersion: '42' } }).success).toBe(true);
  expect(auditOperationSchema.safeParse({ ...op, actor: { type: 'system', executor: 'directory-sync', userId: uuid(2), sourceEvent: 'x', sourceVersion: '1' } }).success).toBe(false);
 });
});

describe('compatibility (contract 6)', () => {
 const need = { protocol: 1, tools: { reply_to_conversation: 2 } } as const;
 test('unknown tenant protocol disables mutations', () => expect(evaluateCompatibility(undefined, need)).toEqual({ compatible: false, reasons: [{ code: 'TENANT_PROTOCOL_UNKNOWN' }] }));
 test('reports actionable reasons', () => {
  expect(evaluateCompatibility({ protocolVersions: [2], tools: { reply_to_conversation: 1 } }, need).reasons).toEqual([
   { code: 'PROTOCOL_UNSUPPORTED', required: 1 }, { code: 'TOOL_TOO_OLD', tool: 'reply_to_conversation', required: 2, actual: 1 }]);
  expect(evaluateCompatibility({ protocolVersions: [1], tools: {} }, need).reasons).toEqual([{ code: 'TOOL_MISSING', tool: 'reply_to_conversation', required: 2 }]);
 });
 test('compatible tenant', () => expect(evaluateCompatibility({ protocolVersions: [1, 2], tools: { reply_to_conversation: 3 } }, need).compatible).toBe(true));
});

describe('outcomes', () => {
 test('timeout after dispatch is uncertain, not failed', () => {
  expect(classify('timeout_after_send')).toBe('uncertain');
  expect(classify('server_error')).toBe('uncertain');
  expect(classify('not_sent')).toBe('failed');
 });
 test('non-idempotent actions are never retried automatically once sent', () => {
  expect(retryDecision('not_idempotent', 'timeout_after_send')).toBe('never');
  expect(retryDecision('not_idempotent', 'not_sent')).toBe('retry');
  expect(retryDecision('keyed', 'timeout_after_send')).toBe('reconcile_then_retry');
  expect(retryDecision('idempotent', 'rejected')).toBe('never');
 });
});

describe('fleet aggregation', () => {
 test('unavailable metrics are never counted as zero', () => {
  const r = sumMetric([
   { appKey: 'payroll', metric: { status: 'available', value: 4, asOf: '2026-10-12T10:00:00Z' } },
   { appKey: 'hr', metric: { status: 'unavailable', reason: 'not_permitted' } },
  ]);
  expect(r).toEqual({ value: 4, included: ['payroll'], missing: [{ appKey: 'hr', reason: 'not_permitted' }], complete: false });
  expect(sumMetric([{ appKey: 'hr', metric: { status: 'unavailable', reason: 'app_unavailable' } }]).value).toBeNull();
 });
});

describe('broadcasts', () => {
 const content = { kind: 'maintenance', title: 'Payroll closes early', body: null, link: null, surfaces: ['portal', 'embed'], audience: 'everyone', publishAt: null, expiresAt: null } as const;
 const revision = { broadcastId: uuid(1), revision: 1, content, targeting: { mode: 'selected', registryRevision: 'r9' }, recipients: ['payroll', 'hr'] };
 test('Everyone audience only, explicit unique recipients', () => {
  expect(broadcastRevisionSchema.safeParse(revision).success).toBe(true);
  expect(broadcastRevisionSchema.safeParse({ ...revision, content: { ...content, audience: 'segments' } }).success).toBe(false);
  expect(broadcastRevisionSchema.safeParse({ ...revision, recipients: [] }).success).toBe(false);
  expect(broadcastRevisionSchema.safeParse({ ...revision, recipients: ['hr', 'hr'] }).success).toBe(false);
  expect(broadcastRevisionSchema.safeParse({ ...revision, content: { ...content, publishAt: '2026-10-13T00:00:00Z', expiresAt: '2026-10-12T00:00:00Z' } }).success).toBe(false);
 });
 test('per-app key is stable; changed content under the same key is a conflict', async () => {
  expect(deliveryKey(uuid(1), 1, 'hr')).toBe(deliveryKey(uuid(1), 1, 'hr'));
  expect(deliveryKey(uuid(1), 2, 'hr')).not.toBe(deliveryKey(uuid(1), 1, 'hr'));
  const key = deliveryKey(uuid(1), 1, 'hr');
  const a = await contentHash(content);
  expect(await contentHash({ ...content, surfaces: ['portal', 'embed'] })).toBe(a);
  const b = await contentHash({ ...content, title: 'Payroll closes late' });
  expect(replayDecision(undefined, { key, payloadHash: a })).toBe('new');
  expect(replayDecision({ key, payloadHash: a }, { key, payloadHash: a })).toBe('replay');
  expect(replayDecision({ key, payloadHash: a }, { key, payloadHash: b })).toBe('conflict');
 });
 test('canonical hashing ignores key order', async () => {
  expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  expect(await payloadHash({ a: 1, b: 2 })).toBe(await payloadHash({ b: 2, a: 1 }));
 });
 test('uncertain deliveries resolve only by reconciliation and block "published"', () => {
  expect(canTransitionDelivery('uncertain', 'pending')).toBe(false);
  expect(canTransitionDelivery('succeeded', 'pending')).toBe(false);
  expect(broadcastSummary(['succeeded', 'uncertain'])).toBe('needs_attention');
  expect(broadcastSummary(['succeeded', 'blocked'])).toBe('partial');
  expect(broadcastSummary(['succeeded', 'succeeded'])).toBe('published');
 });
});
