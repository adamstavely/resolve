import { describe, expect, test } from 'vitest';
import { targetToolResults } from '../packages/contracts/src';
import { buildTenant, callTool, canSeeTicket, ToolError, type Viewer } from '../tools/mock-tenant/fixtures.mts';

const staff = [{ principalId: 'principal_sam', name: 'Sam Agent' }, { principalId: 'principal_priya', name: 'Priya Shah' }];
const data = buildTenant('payroll', 11, { tickets: 130, conversations: 48 }, staff, Date.parse('2026-10-12T12:00:00Z'));
const admin: Viewer = { principalId: 'principal_ada', role: 'admin', teams: [], analytics: true };
const agent: Viewer = { principalId: 'principal_sam', role: 'agent', teams: ['support'], analytics: true };
const observer: Viewer = { principalId: 'principal_olive', role: 'observer', teams: ['support'], analytics: false };

describe('mock tenant serves the target contracts', () => {
 test.each(['list_tickets', 'list_conversations', 'get_support_dashboard', 'list_support_activity'] as const)('%s matches its schema', tool => {
  expect(targetToolResults[tool].safeParse(callTool(data, agent, tool, {})).success).toBe(true);
 });
 test('detail tools match their schemas', () => {
  expect(targetToolResults.get_ticket.safeParse(callTool(data, admin, 'get_ticket', { ticketId: data.tickets[0].id })).success).toBe(true);
  expect(targetToolResults.get_conversation.safeParse(callTool(data, admin, 'get_conversation', { conversationId: data.conversations[0].id })).success).toBe(true);
 });
});

describe('mock tenant semantics', () => {
 test('keyset paging over more than 100 tickets neither loses nor repeats items, despite timestamp ties', () => {
  const seen: string[] = []; let cursor: string | undefined;
  do {
   const p = targetToolResults.list_tickets.parse(callTool(data, admin, 'list_tickets', { limit: 17, cursor }));
   seen.push(...p.tickets.map(t => t.id)); cursor = p.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toHaveLength(130);
  expect(new Set(seen).size).toBe(130);
  const times = data.tickets.map(t => t.updatedAt);
  expect(new Set(times).size).toBeLessThan(times.length); // ties exist
 });
 test('detail visibility matches list visibility; hidden items are not found', () => {
  const hidden = data.tickets.find(t => !canSeeTicket(agent, t))!;
  expect(() => callTool(data, agent, 'get_ticket', { ticketId: hidden.id })).toThrow(ToolError);
  const listed = targetToolResults.list_tickets.parse(callTool(data, agent, 'list_tickets', { limit: 100 })).tickets.map(t => t.id);
  expect(listed).not.toContain(hidden.id);
 });
 test('without analytics permission every KPI is unavailable, never zero', () => {
  const d = targetToolResults.get_support_dashboard.parse(callTool(data, observer, 'get_support_dashboard', {}));
  expect(Object.values(d.metrics).every(m => m.status === 'unavailable' && m.reason === 'not_permitted')).toBe(true);
 });
 test('dashboard counts use the same visibility as lists', () => {
  const d = targetToolResults.get_support_dashboard.parse(callTool(data, agent, 'get_support_dashboard', {}));
  const open = data.tickets.filter(t => canSeeTicket(agent, t) && t.statusCategory === 'open').length;
  expect(d.metrics.openTickets).toEqual({ status: 'available', value: open });
 });
});
