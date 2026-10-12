/*
 * Gap-fixed action tools and change feed for a mock tenant (packages/contracts/src/operations.ts):
 * keyed replies and notes (QB-CHAT-6), version-checked assignment and status (QB-CHAT-1, QB-TICKET-2),
 * the shared read watermark, and a content-free, resumable change log filtered per viewer (QB-CHAT-2/3).
 * The tenant enforces its own permissions and object policy, independent of Resolve.
 */
import { createHash } from 'node:crypto';
import { canSeeConversation, canSeeTicket, ToolError, type Conversation, type Message, type TenantData, type Ticket, type Viewer } from './fixtures.mjs';

export interface ChangeEvent { seq: number; itemType: 'conversation' | 'ticket'; itemId: string; kind: 'message' | 'assignment' | 'status' | 'read' | 'created'; at: string }
interface StoredOp { author: string; payloadHash: string; messageId: string; createdAt: string }

const RETAIN = 200;
const STATUS_NAMES = { open: ['Open', 'in_progress'], pending: ['Waiting on customer', 'awaiting_requester'], closed: ['Resolved', 'resolved'] } as const;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class TenantStore {
 private seq = 0;
 private events: ChangeEvent[] = [];
 private ops = new Map<string, StoredOp>();
 private waiters = new Set<() => void>();

 constructor(readonly appKey: string, readonly data: TenantData, private readonly names: (principalId: string) => string) {}

 private emit(itemType: ChangeEvent['itemType'], itemId: string, kind: ChangeEvent['kind']) {
  this.events.push({ seq: ++this.seq, itemType, itemId, kind, at: new Date().toISOString() });
  if (this.events.length > RETAIN) this.events.splice(0, this.events.length - RETAIN);
  for (const w of this.waiters) w();
  this.waiters.clear();
 }

 private actor(v: Viewer) {
  if (v.role !== 'agent' && v.role !== 'admin') throw new ToolError('FORBIDDEN', 'Your role in this application cannot change support items');
 }
 private conversation(v: Viewer, id: unknown) {
  const c = this.data.conversations.find(x => x.id === id);
  if (!c || !canSeeConversation(v, c)) throw new ToolError('NOT_FOUND', 'Conversation not found');
  return c;
 }
 private ticket(v: Viewer, id: unknown) {
  const t = this.data.tickets.find(x => x.id === id);
  if (!t || !canSeeTicket(v, t)) throw new ToolError('NOT_FOUND', 'Ticket not found');
  return t;
 }
 private checkVersion(item: { version: number }, expected: unknown) {
  if (item.version !== expected) throw new ToolError('CONFLICT', `Item changed (version ${item.version}); refresh and try again`);
 }

 /** Keyed message write: the same key and payload replays the original result; a changed payload is refused. */
 private keyed(v: Viewer, key: unknown, payload: unknown, write: () => Message) {
  if (typeof key !== 'string') throw new ToolError('INVALID_ARGUMENT', 'operationKey is required');
  const payloadHash = hash(payload);
  const prior = this.ops.get(key);
  if (prior) {
   if (prior.author !== v.principalId || prior.payloadHash !== payloadHash) throw new ToolError('OPERATION_CONFLICT', 'This operation key was used for different content');
   return { messageId: prior.messageId, createdAt: prior.createdAt, operationKey: key, replayed: true };
  }
  const m = write();
  this.ops.set(key, { author: v.principalId, payloadHash, messageId: m.id, createdAt: m.createdAt });
  return { messageId: m.id, createdAt: m.createdAt, operationKey: key, replayed: false };
 }

 private message(v: Viewer, sender: Message['senderType'], content: string, internal: boolean, author?: string): Message {
  return { id: `msg_${this.appKey}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, senderType: sender, isInternal: internal,
   authorName: author ?? this.names(v.principalId), content, createdAt: new Date().toISOString(), attachments: [] };
 }

 private assignTo(item: { assigneeName: string | null }, v: Viewer, assignee: unknown, set: (id: string | null) => void) {
  const me = assignee === 'me';
  set(me ? v.principalId : null);
  item.assigneeName = me ? this.names(v.principalId) : null;
 }

 call(v: Viewer, name: string, a: Record<string, unknown>) {
  switch (name) {
   case 'reply_to_conversation':
   case 'add_conversation_note': {
    const c = this.conversation(v, a.conversationId); this.actor(v);
    const internal = name === 'add_conversation_note';
    return this.keyed(v, a.operationKey, { t: name, id: c.id, content: a.content }, () => {
     const m = this.message(v, 'agent', String(a.content), internal);
     c.messages.push(m); c.lastMessageAt = m.createdAt;
     if (!internal) {
      c.waitingSince = null;
      if (c.status === 'closed') { c.status = 'open'; c.resolvedAt = null; }
      // As upstream does: a reply auto-assigns an unassigned conversation to the replying agent.
      if (!c.assignedAgentPrincipalId) this.assignTo(c, v, 'me', id => { c.assignedAgentPrincipalId = id; });
     }
     c.version++; this.emit('conversation', c.id, 'message');
     return m;
    });
   }
   case 'assign_conversation': {
    const c = this.conversation(v, a.conversationId); this.actor(v); this.checkVersion(c, a.expectedVersion);
    this.assignTo(c, v, a.assignee, id => { c.assignedAgentPrincipalId = id; });
    c.version++; this.emit('conversation', c.id, 'assignment');
    return { id: c.id, version: c.version, status: c.status, assigneeName: c.assigneeName };
   }
   case 'set_conversation_status': {
    const c = this.conversation(v, a.conversationId); this.actor(v); this.checkVersion(c, a.expectedVersion);
    c.status = a.status as Conversation['status'];
    c.resolvedAt = c.status === 'closed' ? new Date().toISOString() : null;
    if (c.status === 'closed') c.waitingSince = null;
    c.version++; this.emit('conversation', c.id, 'status');
    return { id: c.id, version: c.version, status: c.status, assigneeName: c.assigneeName };
   }
   case 'mark_conversation_read': {
    const c = this.conversation(v, a.conversationId);
    if (v.role === 'portal') throw new ToolError('FORBIDDEN', 'Only support staff can mark conversations read');
    c.lastReadAt = new Date().toISOString(); this.emit('conversation', c.id, 'read');
    return { id: c.id, readAt: c.lastReadAt };
   }
   case 'reply_to_ticket':
   case 'add_ticket_note': {
    const t = this.ticket(v, a.ticketId); this.actor(v);
    return this.keyed(v, a.operationKey, { t: name, id: t.id, content: a.content }, () => {
     const m = this.message(v, 'agent', String(a.content), name === 'add_ticket_note');
     t.messages.push(m); t.updatedAt = m.createdAt; t.version++;
     this.emit('ticket', t.id, 'message');
     return m;
    });
   }
   case 'assign_ticket': {
    const t = this.ticket(v, a.ticketId); this.actor(v); this.checkVersion(t, a.expectedVersion);
    this.assignTo(t, v, a.assignee, id => { t.assigneePrincipalId = id; });
    t.updatedAt = new Date().toISOString(); t.version++; this.emit('ticket', t.id, 'assignment');
    return { id: t.id, version: t.version, status: t.status, assigneeName: t.assigneeName };
   }
   case 'set_ticket_status': {
    const t = this.ticket(v, a.ticketId); this.actor(v); this.checkVersion(t, a.expectedVersion);
    const cat = a.statusCategory as Ticket['statusCategory'];
    t.statusCategory = cat; t.status = STATUS_NAMES[cat][0]; t.stage = STATUS_NAMES[cat][1];
    t.updatedAt = new Date().toISOString(); t.version++; this.emit('ticket', t.id, 'status');
    return { id: t.id, version: t.version, status: t.status, assigneeName: t.assigneeName };
   }
   case 'get_operation_result': {
    const op = this.ops.get(String(a.operationKey));
    if (!op || op.author !== v.principalId) return { state: 'unknown', operationKey: a.operationKey };
    return { state: 'committed', operationKey: a.operationKey, payloadHash: op.payloadHash, messageId: op.messageId, createdAt: op.createdAt };
   }
   default: return undefined;
  }
 }

 /** Content-free changes after `after`, filtered to what this viewer may see now. */
 changes(v: Viewer, after: string | undefined) {
  const from = after === undefined ? this.seq : Number(after);
  const oldest = this.events[0]?.seq ?? this.seq + 1;
  const resync = after !== undefined && (!Number.isInteger(from) || from < oldest - 1 || from > this.seq);
  const visible = (e: ChangeEvent) => e.itemType === 'conversation'
   ? canSeeConversation(v, this.data.conversations.find(c => c.id === e.itemId)!)
   : canSeeTicket(v, this.data.tickets.find(t => t.id === e.itemId)!);
  const events = resync ? [] : this.events.filter(e => e.seq > from && visible(e));
  return { events: events.map(e => ({ cursor: String(e.seq), itemType: e.itemType, itemId: e.itemId, kind: e.kind, at: e.at })), cursor: String(this.seq), resync };
 }

 /** Long-poll helper: resolves when any change is emitted, or after `ms`. */
 waitForChange(ms: number) {
  return new Promise<void>(resolve => { const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); }; const t = setTimeout(done, ms); this.waiters.add(done); });
 }

 /** Development: a customer writes in (new or existing conversation). */
 customerMessage(conversationId: string | undefined, text: string, team = 'team_support') {
  let c = conversationId ? this.data.conversations.find(x => x.id === conversationId) : undefined;
  const now = new Date().toISOString();
  if (!c) {
   const n = this.data.conversations.length + 1;
   c = { id: `conversation_${this.appKey}_live_${n}`, status: 'open', priority: 'none', channel: 'messenger', subject: text.slice(0, 60), visitorPrincipalId: 'principal_customer_live',
    visitorName: 'Morgan Ellis', visitorEmail: 'morgan@example.test', assignedAgentPrincipalId: null, assigneeName: null, teamId: team,
    teamName: team === 'team_billing' ? 'Billing' : 'Support', waitingSince: now, linkedTicketId: null, lastMessageAt: now, resolvedAt: null, createdAt: now,
    messages: [], lastReadAt: null, version: 1 };
   this.data.conversations.push(c);
   this.emit('conversation', c.id, 'created');
  }
  const m: Message = { id: `msg_${this.appKey}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, senderType: 'visitor', isInternal: false,
   authorName: c.visitorName, content: text, createdAt: now, attachments: [] };
  c.messages.push(m); c.lastMessageAt = now; c.waitingSince ??= now;
  if (c.status !== 'open') { c.status = 'open'; c.resolvedAt = null; }
  c.version++; this.emit('conversation', c.id, 'message');
  return { conversationId: c.id, messageId: m.id };
 }
}
