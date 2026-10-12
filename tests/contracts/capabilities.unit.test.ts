import { describe, expect, test } from 'vitest';
import {
 BUNDLES, CAPABILITIES, GAPS, JOB_COMMANDS, TENANT_TOOLS, capabilitiesFor, capabilityReadiness, scopesFor,
 toolArgs, toolResults, type CapabilityId, type TenantToolName,
} from '../../packages/contracts/src';

describe('capability catalogue', () => {
 test('every capability tool and job exists in the inventory', () => {
  for (const [id, cap] of Object.entries(CAPABILITIES)) {
   for (const t of cap.tools) expect(TENANT_TOOLS, id).toHaveProperty(t);
   for (const j of cap.jobs) expect(JOB_COMMANDS, id).toContain(j);
  }
 });

 test('tenant-facing capabilities name tenant tools; administration uses jobs, never tenant tokens', () => {
  for (const [id, cap] of Object.entries(CAPABILITIES)) {
   if (cap.kind === 'administration') expect(cap.tools, id).toEqual([]);
   if (cap.kind === 'mutation' && !['connection.manage'].includes(id)) expect(cap.tools.length, id).toBeGreaterThan(0);
  }
 });

 test('observer requests read scopes only and gets no mutation', () => {
  const caps = capabilitiesFor(['fleet-observer']);
  expect(scopesFor(caps)).toEqual(['read:chat']);
  expect([...caps].filter(c => CAPABILITIES[c].kind !== 'read' && c !== 'connection.manage')).toEqual([]);
 });

 test('agent scopes are bounded to chat; broadcast authors need the proposed announcement scopes', () => {
  expect(scopesFor(capabilitiesFor(['fleet-agent']))).toEqual(['read:chat', 'write:chat']);
  expect(scopesFor(capabilitiesFor(['announcement-author']))).toEqual(['read:announcement', 'write:announcement']);
 });

 test('only admins hold administration capabilities', () => {
  for (const [bundle, caps] of Object.entries(BUNDLES)) {
   const admin = caps.filter(c => CAPABILITIES[c].kind === 'administration');
   expect(admin.length > 0, bundle).toBe(bundle === 'fleet-admin');
  }
 });

 test('dashboard aggregates require analytics.view', () => {
  expect(TENANT_TOOLS.get_support_dashboard.permissions).toContain('analytics.view');
 });

 test('out-of-scope domains are not requested by any bundle', () => {
  const all = scopesFor(capabilitiesFor(Object.keys(BUNDLES) as (keyof typeof BUNDLES)[]));
  for (const forbidden of ['read:feedback', 'write:feedback', 'write:changelog', 'read:article', 'write:article', 'write:settings']) expect(all).not.toContain(forbidden);
 });

 test('every gap referenced by a tool is documented, and every documented gap is referenced', () => {
  const used = new Set(Object.values(TENANT_TOOLS).flatMap(t => t.gaps));
  for (const g of used) expect(GAPS).toHaveProperty(g);
  // QB-ID-1, QB-REG-1 and QB-PROTO-1 block contracts 2, 1 and 6, not a single tool.
  expect(Object.keys(GAPS).filter(g => !used.has(g as never)).sort()).toEqual(['QB-ID-1', 'QB-PROTO-1', 'QB-REG-1']);
 });

 test('available tools have wire schemas; mutations declare idempotency', () => {
  for (const [name, t] of Object.entries(TENANT_TOOLS) as [TenantToolName, (typeof TENANT_TOOLS)[TenantToolName]][]) {
   if (t.status !== 'missing') { expect(toolArgs, name).toHaveProperty(name); expect(toolResults, name).toHaveProperty(name); }
   if (t.status === 'available') expect(t.gaps, name).toEqual([]);
   else expect(t.gaps.length, name).toBeGreaterThan(0);
  }
 });

 // Snapshot of phase 0 readiness: changing the inventory must be a reviewed decision.
 test('readiness against the pinned fork', () => {
  const blocked = Object.fromEntries(capabilityReadiness().filter(r => !r.ready).map(r => [r.capability, r.gaps]));
  expect(blocked).toEqual({
   'dashboard.view': ['QB-DASH-1', 'QB-DASH-2'],
   'chat.read': ['QB-CHAT-2', 'QB-CHAT-3', 'QB-CHAT-4', 'QB-CHAT-5', 'QB-CHAT-8', 'QB-FILE-1'],
   'chat.reply': ['QB-CHAT-4', 'QB-CHAT-6', 'QB-CHAT-8', 'QB-FILE-2'],
   'chat.note': ['QB-CHAT-1', 'QB-CHAT-6', 'QB-CHAT-8', 'QB-FILE-2'],
   'chat.assign': ['QB-CHAT-1'],
   'chat.availability': ['QB-CHAT-3'],
   'chat.mark_read': ['QB-CHAT-1'],
   'ticket.read': ['QB-TICKET-1'],
   'ticket.reply': ['QB-CHAT-6', 'QB-FILE-2'],
   'ticket.note': ['QB-CHAT-6', 'QB-FILE-2'],
   'ticket.assign': ['QB-TICKET-2'],
   'ticket.status': ['QB-TICKET-2'],
   'broadcast.publish': ['QB-ANN-1', 'QB-ANN-2'],
  } satisfies Partial<Record<CapabilityId, string[]>>);
 });
});

describe('tool wire schemas', () => {
 test('reject unknown arguments and enforce handler limits', () => {
  expect(toolArgs.reply_to_conversation.safeParse({ conversationId: 'c', content: 'x'.repeat(4001) }).success).toBe(false);
  expect(toolArgs.reply_to_conversation.safeParse({ conversationId: 'c', content: 'hi', actorId: 'p' }).success).toBe(false);
  expect(toolArgs.list_tickets.safeParse({ limit: 101 }).success).toBe(false);
 });

 test('results tolerate additive fields but not missing or retyped ones', () => {
  const ok = { id: 'm', conversationId: 'c', status: 'open', createdAt: '2026-10-12T10:00:00.000Z' };
  expect(toolResults.reply_to_conversation.safeParse({ ...ok, extra: 1 }).success).toBe(true);
  expect(toolResults.reply_to_conversation.safeParse({ ...ok, status: 'resolved' }).success).toBe(false);
  expect(toolResults.reply_to_conversation.safeParse({ id: 'm' }).success).toBe(false);
 });
});
