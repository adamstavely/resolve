import { Component, input, output, signal } from '@angular/core';
import { ATTACHMENT_POLICY, uploadResponseSchema, type UploadedFile } from '../../../../../packages/contracts/src/index';
import type { PendingMessage } from '../actions';
import { IconComponent } from '../icon.component';
import { fileSize } from '../state';

export interface SendRequest { kind: 'reply' | 'note'; content: string; operationId: string; files: UploadedFile[] }
interface Attachment { localId: string; name: string; size: number; state: 'uploading' | 'ready' | 'failed'; message: string; code?: string; uploadKey: string; blob: File; file?: UploadedFile }

const ACCEPT = Object.values(ATTACHMENT_POLICY.types).flat().map(e => '.' + e).join(',');
const TYPING_REFRESH_MS = 4000;
const TYPING_IDLE_MS = 5000;

/**
 * Reply / internal-note composer with explicit Send (plan 09). Shows this browser's unconfirmed messages with their
 * state; a retry or result check reuses the original operation id, so it can never send twice.
 *
 * Attachments upload as soon as they are chosen, through Resolve, with an upload key so a retry cannot store the file
 * twice. Send stays disabled while a file is uploading or has failed, so a failed upload never turns into a reply
 * that silently lacks its file. Typing is signalled only for customer replies, never for internal notes.
 */
@Component({
 selector: 'rs-composer',
 imports: [IconComponent],
 template: `
@if (pending().length) {
 <ul class="pending" aria-label="Messages awaiting confirmation">
  @for (p of pending(); track p.operationId) {
   <li class="pending-item" [attr.data-state]="p.state">
    <div class="msg-head"><span class="msg-author">You</span>
     <span class="tag" [attr.data-tone]="p.state === 'sending' ? 'neutral' : p.state === 'uncertain' ? 'sensitive' : 'destructive'">{{ label(p) }}</span>
     <span class="muted small">{{ p.kind === 'note' ? 'Internal note' : 'Reply' }}</span></div>
    @if (p.content) { <p class="msg-body">{{ p.content }}</p> }
    @if (p.files.length) { <p class="small muted"><rs-icon name="paperclip" [size]="13" /> {{ fileNames(p.files) }}</p> }
    @if (p.state !== 'sending') {
     <p class="small" role="alert">{{ p.message }}</p>
     <div class="row">
      @if (p.state === 'uncertain') { <button class="btn btn-sm" type="button" (click)="check.emit(p)">Check result</button> }
      <button class="btn btn-sm" type="button" (click)="retry.emit(p)">Retry<span class="sr-only"> sending this {{ p.kind === 'note' ? 'note' : 'reply' }}</span></button>
      <button class="btn btn-sm btn-ghost" type="button" (click)="discard.emit(p)">Discard</button>
     </div>
    }
   </li>
  }
 </ul>
}
<form class="composer" (submit)="submit($event)" [attr.aria-label]="'Write a ' + (kind() === 'note' ? 'note' : 'reply')">
 <fieldset class="segmented">
  <legend class="sr-only">Message type</legend>
  <label [class.on]="kind() === 'reply'"><input type="radio" name="kind" value="reply" [checked]="kind() === 'reply'" [disabled]="!canReply()" (change)="setKind('reply')">Reply to customer</label>
  <label [class.on]="kind() === 'note'"><input type="radio" name="kind" value="note" [checked]="kind() === 'note'" [disabled]="!canNote()" (change)="setKind('note')">Internal note</label>
 </fieldset>
 <label class="sr-only" [attr.for]="fieldId()">{{ kind() === 'note' ? 'Internal note, visible to the support team only' : 'Reply, visible to the customer' }}</label>
 <textarea [id]="fieldId()" rows="3" maxlength="4000" [value]="draft()" (input)="onInput($any($event.target).value)"
  [attr.aria-describedby]="fieldId() + '-hint'" [placeholder]="kind() === 'note' ? 'Only your support team sees notes' : 'The customer sees this reply'"></textarea>
 @if (attachments().length) {
  <ul class="attach-list" [attr.aria-label]="'Files to attach (' + attachments().length + ')'">
   @for (a of attachments(); track a.localId) {
    <li class="attach-item" [attr.data-state]="a.state">
     <rs-icon name="paperclip" [size]="14" /><span class="mono attach-name">{{ a.name }}</span><span class="muted small">{{ fileSize(a.size) }}</span>
     <span class="small" [attr.role]="a.state === 'failed' ? 'alert' : null">{{ a.state === 'uploading' ? 'Uploading…' : a.state === 'ready' ? 'Ready' : a.message }}</span>
     @if (a.state === 'failed' && retryable(a)) {
      <button class="btn btn-sm" type="button" (click)="upload(a)">Retry<span class="sr-only"> uploading {{ a.name }}</span></button>
     }
     <button class="btn btn-sm btn-ghost" type="button" (click)="remove(a)" [disabled]="a.state === 'uploading'">Remove<span class="sr-only"> {{ a.name }}</span></button>
    </li>
   }
  </ul>
 }
 @if (pickError()) { <p class="small" role="alert">{{ pickError() }}</p> }
 <div class="composer-foot">
  @if (uploadPath()) {
   <input #fileInput type="file" multiple hidden [attr.accept]="accept" (change)="picked($any($event.target))">
   <button class="btn btn-sm btn-ghost" type="button" (click)="fileInput.click()" [disabled]="attachments().length >= max">
    <rs-icon name="paperclip" [size]="14" />Attach files</button>
  }
  <span class="muted small grow" [id]="fieldId() + '-hint'">{{ kind() === 'note' ? 'Internal note · not sent to the customer' : 'Reply · sent to the customer' }} · {{ draft().length }}/4000{{ blockReason() ? ' · ' + blockReason() : '' }}</span>
  <button class="btn btn-primary btn-sm" type="submit" [disabled]="!canSend()"><rs-icon name="send" [size]="14" />{{ kind() === 'note' ? 'Add note' : 'Send reply' }}</button>
 </div>
</form>`,
})
export class ComposerComponent {
 readonly canReply = input(true);
 readonly canNote = input(true);
 readonly fieldId = input('composer');
 readonly pending = input<PendingMessage[]>([]);
 readonly initialDraft = input('');
 /** Upload endpoint and target; without them the composer offers no attachments. */
 readonly uploadPath = input<string | null>(null);
 readonly target = input<{ type: 'conversation' | 'ticket'; id: string } | null>(null);
 readonly send = output<SendRequest>();
 readonly check = output<PendingMessage>();
 readonly retry = output<PendingMessage>();
 readonly discard = output<PendingMessage>();
 readonly draftChange = output<string>();
 /** True while the person is writing a customer reply; false when they stop, send, clear or switch to a note. */
 readonly typing = output<boolean>();
 readonly kind = signal<'reply' | 'note'>('reply');
 readonly draft = signal('');
 readonly attachments = signal<Attachment[]>([]);
 readonly pickError = signal('');
 readonly accept = ACCEPT;
 readonly max = ATTACHMENT_POLICY.maxPerMessage;
 readonly fileSize = fileSize;
 readonly label = (p: PendingMessage) => p.state === 'sending' ? 'Sending…' : p.state === 'uncertain' ? 'Not confirmed' : 'Not sent';
 readonly fileNames = (files: UploadedFile[]) => files.map(f => f.name).join(', ');
 private typingSentAt = 0;
 private idleTimer?: ReturnType<typeof setTimeout>;

 ngOnInit() { this.draft.set(this.initialDraft()); if (!this.canReply() && this.canNote()) this.kind.set('note'); }
 ngOnDestroy() { this.stopTyping(); }

 blockReason() {
  const a = this.attachments();
  if (a.some(x => x.state === 'uploading')) return 'waiting for files to upload';
  if (a.some(x => x.state === 'failed')) return 'remove or retry the files that did not upload';
  return '';
 }
 canSend() {
  return (!!this.draft().trim() || this.attachments().length > 0) && !this.blockReason() && (this.canReply() || this.canNote());
 }

 onInput(value: string) {
  this.draft.set(value); this.draftChange.emit(value);
  if (this.kind() !== 'reply' || !value.trim()) return this.stopTyping();
  const now = Date.now();
  if (now - this.typingSentAt > TYPING_REFRESH_MS) { this.typingSentAt = now; this.typing.emit(true); }
  clearTimeout(this.idleTimer);
  this.idleTimer = setTimeout(() => this.stopTyping(), TYPING_IDLE_MS);
 }
 setKind(kind: 'reply' | 'note') { this.kind.set(kind); if (kind === 'note') this.stopTyping(); }
 private stopTyping() {
  clearTimeout(this.idleTimer);
  if (this.typingSentAt) { this.typingSentAt = 0; this.typing.emit(false); }
 }

 picked(inputEl: HTMLInputElement) {
  const files = [...(inputEl.files ?? [])];
  inputEl.value = '';
  this.pickError.set('');
  const room = this.max - this.attachments().length;
  if (files.length > room) this.pickError.set(`You can attach up to ${this.max} files to one message.`);
  for (const f of files.slice(0, Math.max(room, 0))) {
   const ext = f.name.includes('.') ? f.name.split('.').pop()!.toLowerCase() : '';
   const allowed = Object.values(ATTACHMENT_POLICY.types).some(exts => exts.includes(ext));
   const problem = !allowed ? `${f.name}: this type of file cannot be attached.` : f.size > ATTACHMENT_POLICY.maxBytes ? `${f.name} is larger than 5 MB.` : f.size === 0 ? `${f.name} is empty.` : '';
   if (problem) { this.pickError.set(problem); continue; }
   const a: Attachment = { localId: crypto.randomUUID(), name: f.name, size: f.size, state: 'uploading', message: '', uploadKey: crypto.randomUUID(), blob: f };
   this.attachments.update(list => [...list, a]);
   void this.upload(a);
  }
 }

 /** Upload (or retry with the same key, which the tenant answers with the same file). */
 async upload(a: Attachment) {
  const path = this.uploadPath(), target = this.target();
  if (!path || !target) return;
  this.patch(a.localId, { state: 'uploading', message: '', code: undefined });
  const form = new FormData();
  form.set('file', a.blob, a.name); form.set('targetType', target.type); form.set('targetId', target.id); form.set('uploadKey', a.uploadKey);
  try {
   const r = await fetch(path, { method: 'POST', credentials: 'same-origin', body: form });
   const json = await r.json().catch(() => null);
   const ok = r.ok ? uploadResponseSchema.safeParse(json) : undefined;
   if (ok?.success) this.patch(a.localId, { state: 'ready', file: ok.data.file });
   else this.patch(a.localId, { state: 'failed', message: json?.error?.message ?? 'The file was not uploaded.', code: json?.error?.code });
  } catch {
   this.patch(a.localId, { state: 'failed', message: 'Resolve could not be reached. Retry the upload.', code: 'NOT_SENT' });
  }
 }
 /** Policy refusals cannot succeed on retry; connection and confirmation problems can. */
 retryable(a: Attachment) { return !a.code || ['UPLOAD_UNCONFIRMED', 'NOT_SENT', 'TENANT_ERROR', 'RECONNECT_REQUIRED'].includes(a.code); }
 remove(a: Attachment) { this.attachments.update(list => list.filter(x => x.localId !== a.localId)); }
 private patch(localId: string, change: Partial<Attachment>) { this.attachments.update(list => list.map(x => x.localId === localId ? { ...x, ...change } : x)); }

 submit(event: Event) {
  event.preventDefault();
  if (!this.canSend()) return;
  const content = this.draft().trim();
  const files = this.attachments().map(a => a.file!).filter(Boolean);
  this.stopTyping();
  this.send.emit({ kind: this.kind(), content, operationId: crypto.randomUUID(), files });
  this.draft.set(''); this.draftChange.emit(''); this.attachments.set([]);
 }
}
