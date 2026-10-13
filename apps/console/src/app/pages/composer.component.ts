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
 <ul class="pending" aria-label="Messages awaiting confirmation" style="margin:0 0 10px;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">
  @for (p of pending(); track p.operationId) {
   <li class="msgbox" [attr.data-state]="p.state" style="padding:9px 12px">
    <div class="tags" style="gap:8px"><b style="font-size:var(--fs-sm)">You</b>
     <span [class]="p.state === 'sending' ? 'meta' : 'waiting'">{{ label(p) }}</span>
     <span class="meta">{{ p.kind === 'note' ? 'Work note' : 'Reply' }}</span></div>
    @if (p.content) { <div style="white-space:pre-wrap;margin-top:4px">{{ p.content }}</div> }
    @if (p.files.length) { <div class="meta" style="margin-top:4px"><rs-icon name="paperclip" [size]="12" /> {{ fileNames(p.files) }}</div> }
    @if (p.state !== 'sending') {
     <p class="small" role="alert" style="margin:6px 0">{{ p.message }}</p>
     <div class="comp-row">
      @if (p.state === 'uncertain') { <button class="btn btn-sm" type="button" (click)="check.emit(p)">Check result</button> }
      <button class="btn btn-sm" type="button" (click)="retry.emit(p)">Retry<span class="sr-only"> sending this {{ p.kind === 'note' ? 'note' : 'reply' }}</span></button>
      <button class="btn btn-sm btn-ghost" type="button" (click)="discard.emit(p)">Discard</button>
     </div>
    }
   </li>
  }
 </ul>
}
<form class="composer-form" (submit)="submit($event)" [attr.aria-label]="'Write a ' + (kind() === 'note' ? 'work note' : 'reply')" style="margin:0">
 <div class="comp-row" style="margin-bottom:8px">
  <div class="seg" role="group" aria-label="Message type">
   <button type="button" [attr.data-on]="kind() === 'reply'" [attr.aria-pressed]="kind() === 'reply'" [disabled]="!canReply()" (click)="setKind('reply')">Reply to {{ firstName() }}</button>
   <button type="button" [attr.data-on]="kind() === 'note'" [attr.aria-pressed]="kind() === 'note'" [disabled]="!canNote()" (click)="setKind('note')">Work note</button>
  </div>
  <span style="flex:1"></span>
  @if (uploadPath()) {
   <input #fileInput type="file" multiple hidden [attr.accept]="accept" (change)="picked($any($event.target))">
   <button class="chipbtn" type="button" (click)="fileInput.click()" [disabled]="attachments().length >= max"><rs-icon name="paperclip" [size]="12" /> Attach files</button>
  }
 </div>
 <label class="sr-only" [attr.for]="fieldId()">{{ kind() === 'note' ? 'Work note, visible to support only' : 'Reply, visible to the customer' }}</label>
 <textarea [id]="fieldId()" maxlength="4000" [value]="draft()" (input)="onInput($any($event.target).value)" (keydown)="onKeydown($event)"
  [attr.aria-describedby]="fieldId() + '-hint'" [placeholder]="kind() === 'note' ? 'Internal note, visible to support only…' : 'Write to ' + firstName() + '…'"></textarea>
 @if (attachments().length) {
  <ul class="attach-list" [attr.aria-label]="'Files to attach (' + attachments().length + ')'" style="list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px">
   @for (a of attachments(); track a.localId) {
    <li class="tags" [attr.data-state]="a.state" style="gap:8px;font-size:var(--fs-xs)">
     <rs-icon name="paperclip" [size]="12" /><span class="mono">{{ a.name }}</span><span class="meta">{{ fileSize(a.size) }}</span>
     <span [attr.role]="a.state === 'failed' ? 'alert' : null">{{ a.state === 'uploading' ? 'Uploading…' : a.state === 'ready' ? 'Ready' : a.message }}</span>
     @if (a.state === 'failed' && retryable(a)) { <button class="chipbtn" type="button" (click)="upload(a)">Retry<span class="sr-only"> uploading {{ a.name }}</span></button> }
     <button class="chipbtn" type="button" (click)="remove(a)" [disabled]="a.state === 'uploading'">Remove<span class="sr-only"> {{ a.name }}</span></button>
    </li>
   }
  </ul>
 }
 @if (pickError()) { <p class="small" role="alert" style="margin:6px 0 0">{{ pickError() }}</p> }
 <div class="comp-row" style="margin-top:8px">
  <span class="audit-note" [id]="fieldId() + '-hint'"><rs-icon name="shield" [size]="12" /> {{ kind() === 'reply' ? 'Sends via ' + channel() + ' · logged to ' + refLabel() : 'Not visible to the customer · logged to ' + refLabel() }}{{ blockReason() ? ' · ' + blockReason() : '' }}</span>
  <span style="flex:1"></span>
  <button class="btn btn-primary btn-sm" type="submit" [disabled]="!canSend()"><rs-icon name="send" [size]="14" />{{ kind() === 'note' ? 'Add note' : 'Send' }}</button>
 </div>
</form>`,
})
export class ComposerComponent {
 readonly canReply = input(true);
 readonly canNote = input(true);
 readonly fieldId = input('composer');
 /** Prototype labels: "Reply to {first name}", "Sends via chat · logged to {ref}". */
 readonly customerName = input<string | null>(null);
 readonly channel = input<'chat' | 'email'>('chat');
 readonly refLabel = input('this item');
 firstName() { return this.customerName()?.split(/\s+/)[0] || 'customer'; }
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

 /** ⌘/Ctrl+Enter sends (prototype). */
 onKeydown(e: KeyboardEvent) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.submit(e); }
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
