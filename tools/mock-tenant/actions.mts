/*
 * Gap-fixed action tools and change feed for a mock tenant (packages/contracts/src/operations.ts):
 * keyed replies and notes (QB-CHAT-6), version-checked assignment and status (QB-CHAT-1, QB-TICKET-2),
 * the shared read watermark, and a content-free, resumable change log filtered per viewer (QB-CHAT-2/3).
 * The tenant enforces its own permissions and object policy, independent of Resolve.
 */
import { createHash } from 'node:crypto';
import { canSeeConversation, canSeeTicket, seededContent, ToolError, type Conversation, type Message, type TenantData, type Ticket, type Viewer } from './fixtures.mjs';

export interface ChangeEvent { seq: number; itemType: 'conversation' | 'ticket'; itemId: string; kind: 'message' | 'assignment' | 'status' | 'read' | 'created' | 'activity'; at: string }
interface StoredOp { author: string; payloadHash: string; messageId: string; createdAt: string }
interface Upload { id: string; key: string; owner: string; targetType: 'conversation' | 'ticket'; targetId: string; name: string; contentType: string; bytes: Buffer; payloadHash: string; expiresAt: number; attached: boolean }
interface Presence { name: string; viewingUntil: number; typingUntil: number }

const RETAIN = 1000;
const RUN = Date.now().toString(36).slice(-5);
/** The tenant's own attachment policy (it does not trust Resolve's check). */
const FILE_TYPES: Record<string, string[]> = {
 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'], 'application/pdf': ['pdf'],
 'text/plain': ['txt', 'log'], 'text/csv': ['csv'], 'application/json': ['json'], 'application/zip': ['zip'],
};
const MAX_FILE = 5 * 1024 * 1024;
const UPLOAD_TTL = 60 * 60_000;
const VIEWING_TTL = 30_000;
const TYPING_TTL = 8_000;
/** The standard antivirus test string stands in for the tenant's malware scanner. */
const EICAR = 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE';
const STATUS_NAMES = { open: ['Open', 'in_progress'], pending: ['Waiting on customer', 'awaiting_requester'], closed: ['Resolved', 'resolved'] } as const;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class TenantStore {
 private seq = 0;
 private events: ChangeEvent[] = [];
 private ops = new Map<string, StoredOp>();
 private waiters = new Set<() => void>();
 private uploads = new Map<string, Upload>();
 private presence = new Map<string, Map<string, Presence>>();
 private visitors = new Map<string, { online: boolean; typing: boolean }>();
 private activitySignature = new Map<string, string>();
 private activityTimers = new Map<string, NodeJS.Timeout>();
 private availability = new Map<string, { status: 'available' | 'away'; changedAt: string }>();

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

 private message(v: Viewer, sender: Message['senderType'], content: string, internal: boolean, author?: string, files: Upload[] = []): Message {
  for (const f of files) { f.attached = true; f.expiresAt = Infinity; }
  return { id: `msg_${this.appKey}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, senderType: sender, isInternal: internal,
   authorName: author ?? this.names(v.principalId), content, createdAt: new Date().toISOString(),
   attachments: files.map(f => ({ id: f.id, name: f.name, contentType: f.contentType, size: f.bytes.length })) };
 }

 /** Files named in a message: uploaded by this caller, for this target, unexpired and not yet attached. */
 private filesFor(v: Viewer, targetType: Upload['targetType'], targetId: string, ids: unknown): Upload[] {
  const list = Array.isArray(ids) ? ids.map(String) : [];
  if (list.length > 10) throw new ToolError('INVALID_ARGUMENT', 'At most 10 files per message');
  return list.map(id => {
   const f = this.uploads.get(id);
   if (!f || f.owner !== v.principalId || f.targetType !== targetType || f.targetId !== targetId || f.attached || f.expiresAt < Date.now())
    throw new ToolError('FILE_NOT_AVAILABLE', 'An attached file is missing, expired or belongs elsewhere; upload it again');
   return f;
  });
 }

 private upload(v: Viewer, a: Record<string, unknown>) {
  const targetType = a.targetType === 'ticket' ? 'ticket' : 'conversation';
  const target = targetType === 'ticket' ? this.ticket(v, a.targetId) : this.conversation(v, a.targetId);
  this.actor(v);
  const key = String(a.uploadKey ?? '');
  if (!key) throw new ToolError('INVALID_ARGUMENT', 'uploadKey is required');
  const name = String(a.name ?? '').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 255);
  const contentType = String(a.contentType ?? '');
  const payloadHash = hash({ targetType, target: target.id, name, contentType, content: a.contentBase64 });
  const prior = [...this.uploads.values()].find(u => u.key === key);
  if (prior) {
   if (prior.owner !== v.principalId || prior.payloadHash !== payloadHash) throw new ToolError('OPERATION_CONFLICT', 'This upload key was used for a different file');
   return this.fileResult(prior);
  }
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!FILE_TYPES[contentType]?.includes(ext)) throw new ToolError('FILE_TYPE_NOT_ALLOWED', 'This type of file cannot be attached');
  const bytes = Buffer.from(String(a.contentBase64 ?? ''), 'base64');
  if (!bytes.length) throw new ToolError('INVALID_ARGUMENT', 'The file is empty');
  if (bytes.length > MAX_FILE) throw new ToolError('FILE_TOO_LARGE', 'Files can be at most 5 MB');
  if (bytes.includes(EICAR)) throw new ToolError('FILE_REJECTED', 'The file failed the malware scan');
  const f: Upload = { id: `file_${this.appKey}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, key, owner: v.principalId, targetType, targetId: target.id,
   name, contentType, bytes, payloadHash, expiresAt: Date.now() + UPLOAD_TTL, attached: false };
  this.uploads.set(f.id, f);
  return this.fileResult(f);
 }
 private fileResult(f: Upload) {
  return { fileId: f.id, name: f.name, contentType: f.contentType, size: f.bytes.length, expiresAt: new Date(Number.isFinite(f.expiresAt) ? f.expiresAt : Date.now() + UPLOAD_TTL).toISOString() };
 }

 /** Download through the named parent: it must be visible and contain the file. */
 private attachment(v: Viewer, a: Record<string, unknown>) {
  const target = a.targetType === 'ticket' ? this.ticket(v, a.targetId) : this.conversation(v, a.targetId);
  const att = target.messages.flatMap(m => m.attachments).find(x => x.id === a.attachmentId);
  if (!att) throw new ToolError('NOT_FOUND', 'Attachment not found');
  const bytes = this.uploads.get(att.id)?.bytes ?? seededContent(att);
  return { id: att.id, name: att.name, contentType: att.contentType, size: bytes.length, contentBase64: bytes.toString('base64') };
 }

 // ── Activity: explicit viewing/typing signals with short leases; never implied by a stream connection ──

 private activityOf(conversationId: string, except?: string) {
  const now = Date.now();
  const agents = [...(this.presence.get(conversationId) ?? new Map()).entries()]
   .filter(([id, p]) => id !== except && (p.typingUntil > now || p.viewingUntil > now))
   .map(([, p]) => ({ name: p.name, activity: p.typingUntil > now ? 'typing' as const : 'viewing' as const }))
   .sort((x, y) => x.name.localeCompare(y.name));
  return { visitor: this.visitors.get(conversationId) ?? { online: false, typing: false }, agents, asOf: new Date(now).toISOString() };
 }

 /** Emit an `activity` change when what others would see changes, and re-check when the next lease expires. */
 private touchActivity(conversationId: string) {
  const { visitor, agents } = this.activityOf(conversationId);
  const sig = JSON.stringify({ visitor, agents });
  if (this.activitySignature.get(conversationId) !== sig) { this.activitySignature.set(conversationId, sig); this.emit('conversation', conversationId, 'activity'); }
  clearTimeout(this.activityTimers.get(conversationId));
  const now = Date.now();
  const next = Math.min(...[...(this.presence.get(conversationId)?.values() ?? [])].flatMap(p => [p.typingUntil, p.viewingUntil]).filter(t => t > now));
  if (Number.isFinite(next)) this.activityTimers.set(conversationId, setTimeout(() => this.touchActivity(conversationId), next - now + 5).unref());
 }

 private signal(v: Viewer, a: Record<string, unknown>) {
  const c = this.conversation(v, a.conversationId);
  if (a.activity === 'typing') this.actor(v);
  const map = this.presence.get(c.id) ?? new Map<string, Presence>();
  this.presence.set(c.id, map);
  const now = Date.now();
  const p = map.get(v.principalId) ?? { name: this.names(v.principalId), viewingUntil: 0, typingUntil: 0 };
  let expiresAt: number | null = null;
  if (a.activity === 'stopped') map.delete(v.principalId);
  else {
   if (a.activity === 'typing') { p.typingUntil = now + TYPING_TTL; expiresAt = p.typingUntil; } else { p.typingUntil = 0; }
   p.viewingUntil = Math.max(p.viewingUntil, now + VIEWING_TTL);
   expiresAt = expiresAt ?? p.viewingUntil;
   map.set(v.principalId, p);
  }
  this.touchActivity(c.id);
  return { expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() };
 }

 /** Development: what the tenant holds for a conversation (tests check note typing never reaches it). */
 rawActivity(conversationId: string) { return this.activityOf(conversationId); }
 /** Development: the customer's widget connects, disconnects or types. */
 visitorActivity(conversationId: string, state: { online?: boolean; typing?: boolean }) {
  const prev = this.visitors.get(conversationId) ?? { online: false, typing: false };
  const next = { online: state.online ?? prev.online, typing: state.typing ?? prev.typing };
  if (!next.online) next.typing = false;
  this.visitors.set(conversationId, next);
  this.touchActivity(conversationId);
  return next;
 }
 /** Development: everyone's explicit availability. */
 availabilityByName() { return Object.fromEntries([...this.availability.entries()].map(([id, a]) => [this.names(id), a.status])); }

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
    return this.keyed(v, a.operationKey, { t: name, id: c.id, content: a.content, files: a.fileIds ?? [] }, () => {
     const m = this.message(v, 'agent', String(a.content ?? ''), internal, undefined, this.filesFor(v, 'conversation', c.id, a.fileIds));
     // Sending ends this agent's typing indicator.
     const p = this.presence.get(c.id)?.get(v.principalId);
     if (p) p.typingUntil = 0;
     c.messages.push(m); c.lastMessageAt = m.createdAt;
     if (!internal) {
      c.waitingSince = null;
      if (c.status === 'closed') { c.status = 'open'; c.resolvedAt = null; }
      // As upstream does: a reply auto-assigns an unassigned conversation to the replying agent.
      if (!c.assignedAgentPrincipalId) this.assignTo(c, v, 'me', id => { c.assignedAgentPrincipalId = id; });
     }
     c.version++; this.emit('conversation', c.id, 'message');
     if (p) this.touchActivity(c.id);
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
    return this.keyed(v, a.operationKey, { t: name, id: t.id, content: a.content, files: a.fileIds ?? [] }, () => {
     const m = this.message(v, 'agent', String(a.content ?? ''), name === 'add_ticket_note', undefined, this.filesFor(v, 'ticket', t.id, a.fileIds));
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
   case 'upload_file': return this.upload(v, a);
   case 'get_attachment': return this.attachment(v, a);
   case 'signal_activity': return this.signal(v, a);
   case 'get_conversation_activity': return this.activityOf(this.conversation(v, a.conversationId).id, v.principalId);
   case 'get_availability': {
    const cur = this.availability.get(v.principalId);
    return { status: cur?.status ?? 'away', changedAt: cur?.changedAt ?? null };
   }
   case 'set_availability': {
    this.actor(v);
    const status = a.status === 'available' ? 'available' : 'away';
    const cur = this.availability.get(v.principalId);
    if (cur?.status !== status) this.availability.set(v.principalId, { status, changedAt: new Date().toISOString() });
    return { status, changedAt: this.availability.get(v.principalId)!.changedAt };
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

 /** Ends every open long poll now (suspension or an access change: callers re-check before polling again). */
 wakeAll() { for (const w of this.waiters) w(); this.waiters.clear(); }

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
   // Unique across restarts, so ids from an earlier run (e.g. in Resolve's audit) are never reused.
   c = { id: `conversation_${this.appKey}_live_${RUN}${n}`, status: 'open', priority: 'none', channel: 'messenger', subject: text.slice(0, 60), visitorPrincipalId: 'principal_customer_live',
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
