import { Component, input } from '@angular/core';
import type { ThreadMessage } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { fileSize, fullTime, relativeTime } from '../state';

/**
 * Read-only message thread. Internal notes are labelled in text, not only by colour. Attachments download through
 * Resolve (`attachmentBase` + id), which asks the application with the person's own access; there are no direct links.
 */
@Component({
 selector: 'rs-thread',
 imports: [IconComponent],
 template: `
<ol class="thread" aria-label="Messages">
 @for (m of messages(); track m.id) {
  <li class="msg" [attr.data-sender]="m.senderType" [attr.data-internal]="m.isInternal || null">
   <div class="msg-head">
    <span class="msg-author">{{ m.authorName ?? (m.senderType === 'visitor' ? 'Customer' : 'System') }}</span>
    <span class="tag" [attr.data-tone]="m.isInternal ? 'sensitive' : m.senderType === 'visitor' ? 'neutral' : 'accent'">{{ m.isInternal ? 'Internal note' : m.senderType === 'visitor' ? 'Customer' : m.senderType === 'agent' ? 'Agent' : 'System' }}</span>
    <time class="muted small" [attr.datetime]="m.createdAt" [attr.title]="fullTime(m.createdAt)">{{ relativeTime(m.createdAt) }}</time>
   </div>
   @if (m.content) { <p class="msg-body">{{ m.content }}</p> }
   @if (m.attachments.length) {
    <ul class="attachments" aria-label="Attachments">
     @for (a of m.attachments; track a.id) {
      <li><rs-icon name="paperclip" [size]="14" />
       @if (attachmentBase(); as base) {
        <a class="mono" [href]="base + encode(a.id)" download>{{ a.name }}<span class="sr-only">, download</span></a>
       } @else { <span class="mono">{{ a.name }}</span> }
       <span class="muted small">{{ fileSize(a.size) }}</span></li>
     }
    </ul>
   }
  </li>
 } @empty { <li class="muted small">No messages.</li> }
</ol>`,
})
export class ThreadComponent {
 readonly messages = input.required<ThreadMessage[]>();
 /** e.g. `/api/apps/payroll/conversations/c1/attachments/`; without it, names are shown without links. */
 readonly attachmentBase = input<string | null>(null);
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly fileSize = fileSize;
 readonly encode = encodeURIComponent;
}
