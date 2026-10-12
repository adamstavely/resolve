/*
 * Deterministic support data for one mock tenant, plus the gap-fixed read tools Resolve targets
 * (packages/contracts/src/fleet-read.ts). Timestamps are relative to process start; some items share
 * timestamps on purpose so keyset pagination ties are exercised.
 */
import { createHash } from 'node:crypto';

export interface Viewer { principalId: string; role: 'admin' | 'agent' | 'observer' | 'portal'; teams: string[]; analytics: boolean; tier?: 1 | 2 | 3 | null }
export interface Message { id: string; senderType: 'visitor' | 'agent' | 'system'; isInternal: boolean; authorName: string | null; content: string; createdAt: string; attachments: { id: string; name: string; contentType: string; size: number }[] }
interface Staff { principalId: string; name: string }
export interface Ticket {
 id: string; number: number; reference: string; type: 'customer' | 'back_office' | 'tracker'; title: string; status: string; statusCategory: 'open' | 'pending' | 'closed';
 stage: string; priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'; requesterPrincipalId: string | null; assigneePrincipalId: string | null; assigneeName: string | null;
 assigneeTeamId: string | null; teamName: string | null; createdAt: string; updatedAt: string; dueAt: string | null; slaDueAt: string | null; slaBreachedAt: string | null; messages: Message[]; version: number;
}
export interface Conversation {
 id: string; status: 'open' | 'snoozed' | 'closed'; priority: Ticket['priority']; channel: string; subject: string | null; visitorPrincipalId: string; visitorName: string;
 visitorEmail: string | null; assignedAgentPrincipalId: string | null; assigneeName: string | null; teamId: string | null; teamName: string | null; waitingSince: string | null;
 linkedTicketId: string | null; lastMessageAt: string; resolvedAt: string | null; createdAt: string; messages: Message[];
 /** Shared support-team read watermark. */
 lastReadAt: string | null; version: number;
}

const TEAMS = [{ id: 'team_support', key: 'support', name: 'Support' }, { id: 'team_billing', key: 'billing', name: 'Billing' }];
const TITLES = ['Cannot download payslip', 'Login loop after password reset', 'Wrong tax code applied', 'Expense claim stuck in review', 'Bank details not saving',
 'Leave balance looks incorrect', 'Two-factor code not arriving', 'Export to CSV times out', 'Duplicate invoice received', 'Access request for new starter',
 'Report shows last month', 'Notification emails missing'];
const CUSTOMERS = ['Jordan Lee', 'Amara Okafor', 'Chen Wei', 'Lucía Romero', 'Noah Fischer', 'Priya Nair', 'Sam Taylor', 'Elif Demir'];
const STATUS = { open: ['Open', 'in_progress'], pending: ['Waiting on customer', 'awaiting_requester'], closed: ['Resolved', 'resolved'] } as const;

const SEEDED_TYPES: Record<string, string> = { png: 'image/png', pdf: 'application/pdf', csv: 'text/csv' };
const seededFile = (id: string, name: string, size: number) => ({ id, name, contentType: SEEDED_TYPES[name.split('.').pop()!] ?? 'application/octet-stream', size });

/** Bytes for a seeded attachment: the type's signature, then deterministic filler up to the listed size. */
export function seededContent(a: { id: string; contentType: string; size: number }): Buffer {
 const head = a.contentType === 'image/png' ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  : a.contentType === 'application/pdf' ? Buffer.from('%PDF-1.4\n') : Buffer.from('employee,period,amount\n');
 const fill = a.contentType === 'text/csv' ? Buffer.from(`E${a.id.length},2026-09,1000.00\n`) : createHash('sha256').update(a.id).digest();
 const out = Buffer.alloc(a.size);
 head.copy(out, 0);
 for (let i = head.length; i < a.size; i += fill.length) fill.copy(out, i, 0, Math.min(fill.length, a.size - i));
 return out;
}

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

export function buildTenant(appKey: string, seed: number, counts: { tickets: number; conversations: number }, staff: Staff[], now = Date.now()) {
 const r = rng(seed); const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
 // Round to whole minutes so several items share timestamps (pagination ties).
 const ago = (maxMinutes: number) => new Date(Math.floor((now - r() * maxMinutes * 60_000) / 60_000) * 60_000).toISOString();
 const team = () => pick(TEAMS);
 const msg = (id: string, at: string, sender: Message['senderType'], author: string | null, content: string, internal = false): Message => ({
  id, senderType: sender, isInternal: internal, authorName: author, content, createdAt: at,
  attachments: r() < 0.15 ? [seededFile(`file_${id}`, pick(['screenshot.png', 'payslip.pdf', 'export.csv']), 1000 + Math.floor(r() * 90_000))] : [],
 });

 const tickets: Ticket[] = Array.from({ length: counts.tickets }, (_, i) => {
  const n = i + 1; const category = r() < 0.5 ? 'open' : r() < 0.4 ? 'pending' : 'closed';
  const t = team(); const assignRoll = r();
  const assignee = assignRoll < 0.45 ? pick(staff) : null;
  const created = ago(60 * 24 * 30); const updated = new Date(Math.max(Date.parse(created), Date.parse(ago(60 * 24 * 3)))).toISOString();
  // SLA: some open tickets breached, some approaching (within 30 minutes), the rest comfortably ahead.
  const slaRoll = r();
  const slaDueAt = category === 'closed' ? null : new Date(now + (slaRoll < 0.2 ? -r() * 6 * 3600_000 : slaRoll < 0.35 ? r() * 25 * 60_000 : (2 + r() * 40) * 3600_000)).toISOString();
  const customer = pick(CUSTOMERS);
  const messages = [msg(`tmsg_${appKey}_${n}_0`, created, 'visitor', customer, `${pick(TITLES)}. Can someone help?`)];
  for (let k = 1; k < 1 + Math.floor(r() * 4); k++) {
   const internal = r() < 0.3;
   messages.push(msg(`tmsg_${appKey}_${n}_${k}`, new Date(Date.parse(created) + k * 37 * 60_000).toISOString(), internal || r() < 0.6 ? 'agent' : 'visitor',
    internal || r() < 0.6 ? (assignee?.name ?? pick(staff).name) : customer, internal ? 'Checked the account; waiting on the payroll run.' : 'Thanks, looking into this now.', internal));
  }
  return {
   id: `ticket_${appKey}_${n}`, number: n, reference: `${appKey.toUpperCase().slice(0, 3)}-${1000 + n}`, type: r() < 0.8 ? 'customer' : r() < 0.6 ? 'back_office' : 'tracker',
   title: pick(TITLES), status: STATUS[category][0], statusCategory: category, stage: STATUS[category][1], priority: pick(['none', 'low', 'medium', 'high', 'urgent'] as const),
   requesterPrincipalId: `principal_customer_${(n % CUSTOMERS.length) + 1}`, assigneePrincipalId: assignee?.principalId ?? null, assigneeName: assignee?.name ?? null,
   assigneeTeamId: assignRoll < 0.8 ? t.id : null, teamName: assignRoll < 0.8 ? t.name : null, createdAt: created, updatedAt: updated, dueAt: null, slaDueAt,
   slaBreachedAt: slaDueAt && Date.parse(slaDueAt) < now ? slaDueAt : null, messages, version: 1,
  };
 });

 const conversations: Conversation[] = Array.from({ length: counts.conversations }, (_, i) => {
  const n = i + 1; const status = r() < 0.55 ? 'open' : r() < 0.3 ? 'snoozed' : 'closed';
  const t = team(); const assignee = r() < 0.5 ? pick(staff) : null; const customer = pick(CUSTOMERS);
  const created = ago(60 * 24 * 10); const last = new Date(Math.max(Date.parse(created), Date.parse(ago(60 * 24)))).toISOString();
  const waiting = status !== 'closed' && r() < 0.6;
  return {
   id: `conversation_${appKey}_${n}`, status, priority: pick(['none', 'low', 'medium', 'high'] as const), channel: 'messenger', subject: pick(TITLES),
   visitorPrincipalId: `principal_customer_${(n % CUSTOMERS.length) + 1}`, visitorName: customer, visitorEmail: `${customer.split(' ')[0].toLowerCase()}@example.test`,
   assignedAgentPrincipalId: assignee?.principalId ?? null, assigneeName: assignee?.name ?? null, teamId: t.id, teamName: t.name,
   waitingSince: waiting ? last : null, linkedTicketId: r() < 0.2 ? `ticket_${appKey}_${1 + Math.floor(r() * counts.tickets)}` : null,
   lastMessageAt: last, resolvedAt: status === 'closed' ? last : null, createdAt: created, lastReadAt: waiting ? null : last, version: 1,
   messages: [msg(`cmsg_${appKey}_${n}_0`, created, 'visitor', customer, 'Hi, I need help with my account.'),
    msg(`cmsg_${appKey}_${n}_1`, last, waiting ? 'visitor' : 'agent', waiting ? customer : (assignee?.name ?? 'Support'), waiting ? 'Any update on this?' : 'This is sorted now.')],
  };
 });
 return { tickets, conversations };
}

export type TenantData = ReturnType<typeof buildTenant>;

const teamKey = (teamId: string | null) => TEAMS.find(t => t.id === teamId)?.key;
/** One object policy for lists, detail and aggregates (QB-CHAT-4 fixed): admin, own assignment, or own team. */
export const teamKeyOf = (teamId: string | null) => TEAMS.find(t => t.id === teamId)?.key;
export const TEAM_LIST = TEAMS;
export const canSeeTicket = (v: Viewer, t: Ticket) => v.role === 'admin' || t.assigneePrincipalId === v.principalId || v.teams.includes(teamKey(t.assigneeTeamId) ?? '');
export const canSeeConversation = (v: Viewer, c: Conversation) => v.role === 'admin' || c.assignedAgentPrincipalId === v.principalId || v.teams.includes(teamKey(c.teamId) ?? '');

const enc = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString('base64url');
const dec = (c?: string) => { try { return c ? JSON.parse(Buffer.from(c, 'base64url').toString()) as [string, string] : undefined; } catch { return undefined; } };

/** Keyset pagination over (at desc, id desc), stable across ties. */
function page<T>(items: T[], key: (x: T) => [string, string], cursor: string | undefined, limit: number) {
 const sorted = [...items].sort((a, b) => { const [ta, ia] = key(a), [tb, ib] = key(b); return tb.localeCompare(ta) || ib.localeCompare(ia); });
 const after = dec(cursor);
 const rest = after ? sorted.filter(x => { const [t, i] = key(x); return t < after[0] || (t === after[0] && i < after[1]); }) : sorted;
 const slice = rest.slice(0, limit);
 const last = slice.at(-1);
 return { slice, hasMore: rest.length > limit, nextCursor: rest.length > limit && last ? enc(...key(last)) : null };
}

const ticketSummary = ({ messages: _m, slaDueAt: _s, slaBreachedAt: _b, createdAt: _c, dueAt: _d, ...t }: Ticket) => t;
/** Unread for the support team: a customer message newer than the shared read watermark. */
export const isUnread = (c: Conversation) => c.messages.some(m => m.senderType === 'visitor' && (!c.lastReadAt || m.createdAt > c.lastReadAt));
const conversationSummary = (c: Conversation) => ({ id: c.id, status: c.status, priority: c.priority, channel: c.channel, subject: c.subject, lastMessageAt: c.lastMessageAt,
 visitorPrincipalId: c.visitorPrincipalId, assignedAgentPrincipalId: c.assignedAgentPrincipalId, assigneeName: c.assigneeName, teamName: c.teamName, waitingSince: c.waitingSince,
 visitorName: c.visitorName, unread: isUnread(c), version: c.version });

/** Mock identity rule: principal_customer_1..6 signed in through the host app's signed identify; 7 and 8 did not. */
export function customerIdentity(principalId: string | null) {
 const n = Number(principalId?.match(/^principal_customer_(\d+)$/)?.[1]);
 return n >= 1 && n <= 6 ? { verified: true as const, externalId: `cust-${n}` } : { verified: false as const, externalId: null };
}

export class ToolError extends Error { constructor(readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_ARGUMENT' | 'CONFLICT' | 'OPERATION_CONFLICT' | 'FILE_NOT_AVAILABLE' | 'FILE_TYPE_NOT_ALLOWED' | 'FILE_TOO_LARGE' | 'FILE_REJECTED', message: string) { super(message); } }

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown, d: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, max) : d);

/** Gap-fixed read tools. Callers have already checked the scope and that the viewer is staff. */
export function callTool(data: TenantData, v: Viewer, name: string, a: Args, now = Date.now()) {
 const tickets = data.tickets.filter(t => canSeeTicket(v, t));
 const conversations = data.conversations.filter(c => canSeeConversation(v, c));
 switch (name) {
  case 'list_tickets': {
   let list = tickets;
   if (a.statusCategory) list = list.filter(t => t.statusCategory === a.statusCategory);
   if (a.assignee === 'me') list = list.filter(t => t.assigneePrincipalId === v.principalId);
   if (a.assignee === 'unassigned') list = list.filter(t => !t.assigneePrincipalId);
   const p = page(list, t => [t.updatedAt, t.id], str(a.cursor), num(a.limit, 20, 100));
   return { tickets: p.slice.map(ticketSummary), nextCursor: p.nextCursor, hasMore: p.hasMore };
  }
  case 'get_ticket': {
   // Hidden and nonexistent are indistinguishable (existence is not disclosed).
   const t = tickets.find(x => x.id === a.ticketId);
   if (!t) throw new ToolError('NOT_FOUND', 'Ticket not found');
   const { messages, status, statusCategory: category, ...rest } = t;
   return { ticket: { ...rest, status: { name: status, category } }, messages, hasMore: false, nextCursor: null };
  }
  case 'list_conversations': {
   let list = conversations;
   if (a.status) list = list.filter(c => c.status === a.status);
   const p = page(list, c => [c.lastMessageAt, c.id], str(a.cursor), num(a.limit, 20, 100));
   return { conversations: p.slice.map(conversationSummary), nextCursor: p.nextCursor, hasMore: p.hasMore };
  }
  case 'get_conversation': {
   const c = conversations.find(x => x.id === a.conversationId);
   if (!c) throw new ToolError('NOT_FOUND', 'Conversation not found');
   const { messages, teamId: _t, lastReadAt: _r, ...rest } = c;
   return { conversation: { ...rest, unread: isUnread(c) }, messages, hasMore: false, nextCursor: null };
  }
  case 'get_support_dashboard': {
   const horizon = num(a.warningHorizonMinutes, 30, 1440);
   const open = tickets.filter(t => t.statusCategory === 'open');
   const activity = activityFor(tickets, conversations).filter(e => Date.parse(e.at) > now - 24 * 3600_000);
   const metric = (value: number) => v.analytics ? { status: 'available', value } : { status: 'unavailable', reason: 'not_permitted' };
   return {
    schemaVersion: 1, asOf: new Date(now).toISOString(), warningHorizonMinutes: horizon,
    metrics: {
     openTickets: metric(open.length),
     unassignedTickets: metric(open.filter(t => !t.assigneePrincipalId).length),
     awaitingResponse: metric(conversations.filter(c => c.waitingSince && c.status !== 'closed').length),
     slaBreached: metric(open.filter(t => t.slaDueAt && Date.parse(t.slaDueAt) <= now).length),
     slaApproaching: metric(open.filter(t => t.slaDueAt && Date.parse(t.slaDueAt) > now && Date.parse(t.slaDueAt) <= now + horizon * 60_000).length),
     recentActivity: metric(activity.length),
    },
   };
  }
  case 'list_support_activity': {
   const entries = activityFor(tickets, conversations);
   const p = page(entries, e => [e.at, e.id], str(a.cursor), num(a.limit, 20, 50));
   return { entries: p.slice, nextCursor: p.nextCursor, coverageSince: new Date(now - 30 * 24 * 3600_000).toISOString() };
  }
  // QB-TIER-1 (target): the caller's effective tier; observers and untiered staff have none.
  case 'get_my_tier': return { tier: v.tier ?? null };
  case 'get_customer_identity': {
   // QB-OBS-1 (target): the customer's verified external id, under the same visibility as detail. Customers 7 and 8
   // were identified without a signed token, so they are unverified and no id is returned.
   const principal = typeof a.conversationId === 'string' ? conversations.find(x => x.id === a.conversationId)?.visitorPrincipalId
    : typeof a.ticketId === 'string' ? tickets.find(x => x.id === a.ticketId)?.requesterPrincipalId : undefined;
   if (principal === undefined) throw new ToolError(typeof a.conversationId === 'string' || typeof a.ticketId === 'string' ? 'NOT_FOUND' : 'INVALID_ARGUMENT', 'Not found');
   return customerIdentity(principal);
  }
  default: throw new ToolError('INVALID_ARGUMENT', `Unknown tool ${name}`);
 }
}

function activityFor(tickets: Ticket[], conversations: Conversation[]) {
 const out: { id: string; at: string; kind: string; itemType: 'ticket' | 'conversation'; itemId: string; title: string; actorName: string | null }[] = [];
 for (const t of tickets) {
  out.push({ id: `act_${t.id}_created`, at: t.createdAt, kind: 'ticket_created', itemType: 'ticket', itemId: t.id, title: t.title, actorName: null });
  for (const m of t.messages.slice(1)) out.push({ id: `act_${m.id}`, at: m.createdAt, kind: m.isInternal ? 'internal_note' : m.senderType === 'agent' ? 'agent_reply' : 'customer_message', itemType: 'ticket', itemId: t.id, title: t.title, actorName: m.authorName });
 }
 for (const c of conversations) for (const m of c.messages)
  out.push({ id: `act_${m.id}`, at: m.createdAt, kind: m.senderType === 'agent' ? 'agent_reply' : 'customer_message', itemType: 'conversation', itemId: c.id, title: c.subject ?? 'Conversation', actorName: m.authorName });
 return out;
}

export const hashId = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);
