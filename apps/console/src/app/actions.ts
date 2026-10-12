import { signal } from '@angular/core';
import { operationSchema, type Operation, type UploadedFile } from '../../../../packages/contracts/src/index';

/** Result of a Resolve action request: the recorded operation (when one exists) and a user-facing message. */
export interface ActionResult { ok: boolean; operation?: Operation; message: string; status: number }

export async function postAction(path: string, body: unknown): Promise<ActionResult> {
 let r: Response;
 try {
  r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
 } catch {
  // The request may or may not have reached Resolve; a retry with the same operation id is safe for messages.
  return { ok: false, status: 0, message: 'Resolve could not be reached. Your message may not have been sent; retry to make sure.' };
 }
 const json = await r.json().catch(() => null);
 const op = operationSchema.safeParse(json?.operation);
 return { ok: r.status === 200, status: r.status, operation: op.success ? op.data : undefined, message: json?.message ?? json?.error?.message ?? 'The action failed.' };
}

/** A message the user sent from this browser, shown until the tenant confirms it. */
export interface PendingMessage { operationId: string; kind: 'reply' | 'note'; content: string; files: UploadedFile[]; state: 'sending' | 'failed' | 'uncertain'; message: string }
const body = (p: { kind: 'reply' | 'note'; content: string; operationId: string; files: UploadedFile[] }) => ({ kind: p.kind, content: p.content, operationId: p.operationId, fileIds: p.files.map(f => f.fileId) });

/**
 * Message sending for one thread. Successful sends are confirmed by re-reading the thread from the tenant;
 * nothing is shown as sent until then. Unknown outcomes stay visible with Check result / Retry, both of which
 * reuse the original operation id.
 */
export class MessageSender {
 readonly pending = signal<PendingMessage[]>([]);
 constructor(private readonly path: () => string, private readonly confirmed: () => void, private readonly announce: (text: string) => void) {}

 async send(req: { kind: 'reply' | 'note'; content: string; operationId: string; files: UploadedFile[] }) {
  this.upsert({ ...req, state: 'sending', message: '' });
  this.settle(req.operationId, await postAction(this.path(), body(req)));
 }
 async retry(p: PendingMessage) {
  this.upsert({ ...p, state: 'sending', message: '' });
  this.settle(p.operationId, await postAction(this.path(), body(p)));
 }
 async check(p: PendingMessage) {
  this.upsert({ ...p, state: 'sending', message: '' });
  const r = await postAction(`/api/operations/${p.operationId}/reconcile`, {});
  if (r.ok) return this.done(p.operationId, 'Confirmed: the application had received it.');
  this.upsert({ ...p, state: 'uncertain', message: r.operation?.failureCode === 'NOT_COMMITTED_YET'
   ? 'The application has no record of it yet. You can retry safely; it will not be sent twice.' : r.message });
 }
 discard(p: PendingMessage) { this.pending.update(list => list.filter(x => x.operationId !== p.operationId)); }

 private settle(id: string, r: ActionResult) {
  const p = this.pending().find(x => x.operationId === id)!;
  if (r.ok) return this.done(id, p.kind === 'note' ? 'Note added.' : 'Reply sent.');
  const uncertain = r.status === 202 || r.status === 0;
  this.upsert({ ...p, state: uncertain ? 'uncertain' : 'failed', message: r.message });
  this.announce(uncertain ? 'Your message was not confirmed.' : 'Your message was not sent.');
 }
 private done(id: string, text: string) {
  this.pending.update(list => list.filter(x => x.operationId !== id));
  this.announce(text);
  this.confirmed();
 }
 private upsert(p: PendingMessage) {
  this.pending.update(list => list.some(x => x.operationId === p.operationId) ? list.map(x => x.operationId === p.operationId ? p : x) : [...list, p]);
 }
}
