import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { actionToolArgs, actionToolResults, messageActionSchema } from '../packages/contracts/src';
import { buildTenant, type Viewer } from '../tools/mock-tenant/fixtures.mts';
import { TenantStore } from '../tools/mock-tenant/actions.mts';
import { checkFile, safeName } from '../apps/api/lib/fleet/files';

const staff = [{ principalId: 'principal_sam', name: 'Sam Agent' }, { principalId: 'principal_ada', name: 'Ada Admin' }];
const names: Record<string, string> = { principal_sam: 'Sam Agent', principal_ada: 'Ada Admin', principal_olive: 'Olive Observer' };
const sam: Viewer = { principalId: 'principal_sam', role: 'agent', teams: ['support', 'billing'], analytics: true };
const ada: Viewer = { principalId: 'principal_ada', role: 'admin', teams: [], analytics: true };
const olive: Viewer = { principalId: 'principal_olive', role: 'observer', teams: ['support', 'billing'], analytics: false };
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
let store: TenantStore;
let convo: string;

const errorCode = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'no error'; };
const upload = (v: Viewer, over: Record<string, unknown> = {}) => store.call(v, 'upload_file', {
 targetType: 'conversation', targetId: convo, name: 'screen.png', contentType: 'image/png', contentBase64: png.toString('base64'), uploadKey: crypto.randomUUID(), ...over,
}) as { fileId: string; size: number };

beforeEach(() => {
 store = new TenantStore('payroll', buildTenant('payroll', 11, { tickets: 10, conversations: 10 }, staff), id => names[id] ?? 'Agent');
 convo = store.data.conversations[0].id;
});
afterEach(() => vi.useRealTimers());

describe('attachments (mock tenant, target upload_file v2 / get_attachment v1)', () => {
 test('upload results and downloads match the contract', () => {
  const f = upload(sam);
  expect(actionToolResults.upload_file.safeParse(f).success).toBe(true);
  store.call(sam, 'reply_to_conversation', { conversationId: convo, content: '', fileIds: [f.fileId], operationKey: crypto.randomUUID() });
  const d = store.call(ada, 'get_attachment', { targetType: 'conversation', targetId: convo, attachmentId: f.fileId });
  expect(actionToolResults.get_attachment.parse(d).contentBase64).toBe(png.toString('base64'));
 });

 test('a retried upload with the same key returns the same file; the key cannot be reused for another file', () => {
  const key = crypto.randomUUID();
  expect(upload(sam, { uploadKey: key }).fileId).toBe(upload(sam, { uploadKey: key }).fileId);
  expect(errorCode(() => upload(sam, { uploadKey: key, name: 'other.png' }))).toBe('OPERATION_CONFLICT');
 });

 test('the tenant enforces its own policy and malware scan', () => {
  expect(errorCode(() => upload(sam, { name: 'run.exe', contentType: 'application/x-msdownload' }))).toBe('FILE_TYPE_NOT_ALLOWED');
  expect(errorCode(() => upload(sam, { name: 'big.png', contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }))).toBe('FILE_TOO_LARGE');
  const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*').toString('base64');
  expect(errorCode(() => upload(sam, { name: 'notes.txt', contentType: 'text/plain', contentBase64: eicar }))).toBe('FILE_REJECTED');
  expect(errorCode(() => upload(olive))).toBe('FORBIDDEN');
 });

 test('a file can only be attached by its uploader, to its target, once', () => {
  const f = upload(sam);
  const other = store.data.conversations.find(c => c.id !== convo)!.id;
  expect(errorCode(() => store.call(ada, 'reply_to_conversation', { conversationId: convo, content: 'x', fileIds: [f.fileId], operationKey: crypto.randomUUID() }))).toBe('FILE_NOT_AVAILABLE');
  expect(errorCode(() => store.call(sam, 'reply_to_conversation', { conversationId: other, content: 'x', fileIds: [f.fileId], operationKey: crypto.randomUUID() }))).toBe('FILE_NOT_AVAILABLE');
  store.call(sam, 'add_conversation_note', { conversationId: convo, content: 'see file', fileIds: [f.fileId], operationKey: crypto.randomUUID() });
  expect(errorCode(() => store.call(sam, 'reply_to_conversation', { conversationId: convo, content: 'again', fileIds: [f.fileId], operationKey: crypto.randomUUID() }))).toBe('FILE_NOT_AVAILABLE');
 });

 test('an unattached upload expires', () => {
  vi.useFakeTimers({ now: Date.now() });
  const f = upload(sam);
  vi.advanceTimersByTime(61 * 60_000);
  expect(errorCode(() => store.call(sam, 'reply_to_conversation', { conversationId: convo, content: 'late', fileIds: [f.fileId], operationKey: crypto.randomUUID() }))).toBe('FILE_NOT_AVAILABLE');
 });

 test('downloads name their parent: a guessed id under another conversation is not found', () => {
  const seeded = store.data.conversations.flatMap(c => c.messages.flatMap(m => m.attachments.map(a => ({ c: c.id, a })))).at(0)!;
  const other = store.data.conversations.find(c => c.id !== seeded.c)!.id;
  expect(errorCode(() => store.call(ada, 'get_attachment', { targetType: 'conversation', targetId: other, attachmentId: seeded.a.id }))).toBe('NOT_FOUND');
  const d = actionToolResults.get_attachment.parse(store.call(ada, 'get_attachment', { targetType: 'conversation', targetId: seeded.c, attachmentId: seeded.a.id }));
  expect(Buffer.from(d.contentBase64, 'base64').length).toBe(seeded.a.size);
 });
});

describe('typing, viewing and availability (mock tenant, QB-CHAT-3/8 targets)', () => {
 const activity = (v: Viewer) => actionToolResults.get_conversation_activity.parse(store.call(v, 'get_conversation_activity', { conversationId: convo }));

 test('others see who is viewing or typing; nobody sees themselves', () => {
  store.call(sam, 'signal_activity', { conversationId: convo, activity: 'typing' });
  store.call(ada, 'signal_activity', { conversationId: convo, activity: 'viewing' });
  expect(activity(ada).agents).toEqual([{ name: 'Sam Agent', activity: 'typing' }]);
  expect(activity(sam).agents).toEqual([{ name: 'Ada Admin', activity: 'viewing' }]);
 });

 test('signals are leases: typing lapses to viewing, then viewing ends', () => {
  vi.useFakeTimers({ now: Date.now() });
  store.call(sam, 'signal_activity', { conversationId: convo, activity: 'typing' });
  vi.advanceTimersByTime(9_000);
  expect(activity(ada).agents).toEqual([{ name: 'Sam Agent', activity: 'viewing' }]);
  vi.advanceTimersByTime(25_000);
  expect(activity(ada).agents).toEqual([]);
 });

 test('activity changes are content-free change events, emitted only when what others see changes', () => {
  const start = store.changes(ada, undefined).cursor;
  store.call(sam, 'signal_activity', { conversationId: convo, activity: 'viewing' });
  store.call(sam, 'signal_activity', { conversationId: convo, activity: 'viewing' }); // a refresh is not a change
  store.call(sam, 'signal_activity', { conversationId: convo, activity: 'stopped' });
  const events = store.changes(ada, start).events;
  expect(events.map(e => e.kind)).toEqual(['activity', 'activity']);
  expect(Object.keys(events[0]).sort()).toEqual(['at', 'cursor', 'itemId', 'itemType', 'kind']);
 });

 test('sending a reply ends the typing indicator', () => {
  store.call(sam, 'signal_activity', { conversationId: convo, activity: 'typing' });
  store.call(sam, 'reply_to_conversation', { conversationId: convo, content: 'Done', operationKey: crypto.randomUUID() });
  expect(activity(ada).agents).toEqual([{ name: 'Sam Agent', activity: 'viewing' }]);
 });

 test('observers may not signal typing', () => {
  expect(errorCode(() => store.call(olive, 'signal_activity', { conversationId: convo, activity: 'typing' }))).toBe('FORBIDDEN');
 });

 test('availability is explicit, per person, and away until set', () => {
  expect(store.call(sam, 'get_availability', {})).toMatchObject({ status: 'away', changedAt: null });
  store.call(sam, 'set_availability', { status: 'available' });
  expect(store.call(sam, 'get_availability', {})).toMatchObject({ status: 'available' });
  expect(store.call(ada, 'get_availability', {})).toMatchObject({ status: 'away' });
  expect(errorCode(() => store.call(olive, 'set_availability', { status: 'available' }))).toBe('FORBIDDEN');
 });
});

describe('contracts', () => {
 test('a message needs text or a file', () => {
  const id = crypto.randomUUID();
  expect(messageActionSchema.safeParse({ kind: 'reply', content: '  ', operationId: id }).success).toBe(false);
  expect(messageActionSchema.parse({ kind: 'reply', content: '', fileIds: ['f1'], operationId: id }).fileIds).toEqual(['f1']);
  expect(messageActionSchema.safeParse({ kind: 'reply', content: 'x', fileIds: Array(11).fill('f'), operationId: id }).success).toBe(false);
  expect(actionToolArgs.reply_to_conversation.safeParse({ conversationId: 'c', content: '', operationKey: id }).success).toBe(false);
 });
});

describe('Resolve file policy (checked before the tenant sees the file)', () => {
 test('type comes from the extension and must match the file signature', () => {
  expect(checkFile('screen.png', png)).toEqual({ contentType: 'image/png' });
  expect(checkFile('screen.PNG', png)).toEqual({ contentType: 'image/png' });
  expect(checkFile('fake.png', Buffer.from('<script>alert(1)</script>'))).toMatchObject({ code: 'FILE_CONTENT_MISMATCH' });
  expect(checkFile('page.html', Buffer.from('<html>'))).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
  expect(checkFile('image.svg', Buffer.from('<svg/>'))).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
  expect(checkFile('noext', png)).toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
 });
 test('text files must be text; size and emptiness are enforced', () => {
  expect(checkFile('log.txt', Buffer.from('line 1\nline 2\n'))).toEqual({ contentType: 'text/plain' });
  expect(checkFile('log.txt', Buffer.from([0x41, 0x00, 0x42]))).toMatchObject({ code: 'FILE_CONTENT_MISMATCH' });
  expect(checkFile('log.txt', Buffer.from([0xff, 0xfe, 0xfd]))).toMatchObject({ code: 'FILE_CONTENT_MISMATCH' });
  expect(checkFile('empty.csv', Buffer.alloc(0))).toMatchObject({ code: 'FILE_EMPTY' });
  expect(checkFile('big.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5 * 1024 * 1024)]))).toMatchObject({ code: 'FILE_TOO_LARGE' });
 });
 test('names lose path parts and control characters', () => {
  expect(safeName('../../etc/passwd.txt')).toBe('passwd.txt');
  expect(safeName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
  expect(safeName('bad\u0000name\r\n.png')).toBe('badname.png');
 });
});
