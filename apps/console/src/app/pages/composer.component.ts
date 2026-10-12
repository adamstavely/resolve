import { Component, input, output, signal } from '@angular/core';
import type { PendingMessage } from '../actions';
import { IconComponent } from '../icon.component';

export interface SendRequest { kind: 'reply' | 'note'; content: string; operationId: string }

/**
 * Reply / internal-note composer with explicit Send (plan 09). Shows this browser's unconfirmed messages with their
 * state; a retry or result check reuses the original operation id, so it can never send twice.
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
    <p class="msg-body">{{ p.content }}</p>
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
  <label [class.on]="kind() === 'reply'"><input type="radio" name="kind" value="reply" [checked]="kind() === 'reply'" [disabled]="!canReply()" (change)="kind.set('reply')">Reply to customer</label>
  <label [class.on]="kind() === 'note'"><input type="radio" name="kind" value="note" [checked]="kind() === 'note'" [disabled]="!canNote()" (change)="kind.set('note')">Internal note</label>
 </fieldset>
 <label class="sr-only" [attr.for]="fieldId()">{{ kind() === 'note' ? 'Internal note, visible to the support team only' : 'Reply, visible to the customer' }}</label>
 <textarea [id]="fieldId()" rows="3" maxlength="4000" [value]="draft()" (input)="draft.set($any($event.target).value); draftChange.emit(draft())"
  [attr.aria-describedby]="fieldId() + '-hint'" [placeholder]="kind() === 'note' ? 'Only your support team sees notes' : 'The customer sees this reply'"></textarea>
 <div class="composer-foot">
  <span class="muted small" [id]="fieldId() + '-hint'">{{ kind() === 'note' ? 'Internal note · not sent to the customer' : 'Reply · sent to the customer' }} · {{ draft().length }}/4000</span>
  <button class="btn btn-primary btn-sm" type="submit" [disabled]="!draft().trim() || (!canReply() && !canNote())"><rs-icon name="send" [size]="14" />{{ kind() === 'note' ? 'Add note' : 'Send reply' }}</button>
 </div>
</form>`,
})
export class ComposerComponent {
 readonly canReply = input(true);
 readonly canNote = input(true);
 readonly fieldId = input('composer');
 readonly pending = input<PendingMessage[]>([]);
 readonly initialDraft = input('');
 readonly send = output<SendRequest>();
 readonly check = output<PendingMessage>();
 readonly retry = output<PendingMessage>();
 readonly discard = output<PendingMessage>();
 readonly draftChange = output<string>();
 readonly kind = signal<'reply' | 'note'>('reply');
 readonly draft = signal('');
 readonly label = (p: PendingMessage) => p.state === 'sending' ? 'Sending…' : p.state === 'uncertain' ? 'Not confirmed' : 'Not sent';

 ngOnInit() { this.draft.set(this.initialDraft()); if (!this.canReply() && this.canNote()) this.kind.set('note'); }

 submit(event: Event) {
  event.preventDefault();
  const content = this.draft().trim();
  if (!content) return;
  this.send.emit({ kind: this.kind(), content, operationId: crypto.randomUUID() });
  this.draft.set(''); this.draftChange.emit('');
 }
}
