import { Component, input } from '@angular/core';
import type { ThreadMessage } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { fullTime, relativeTime } from '../state';

/** Read-only message thread. Internal notes are labelled in text, not only by colour. */
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
   <p class="msg-body">{{ m.content }}</p>
   @if (m.attachments.length) {
    <ul class="attachments">
     @for (a of m.attachments; track a.id) {
      <li><rs-icon name="paperclip" [size]="14" /><span class="mono">{{ a.name }}</span><span class="muted small">{{ size(a.size) }} · download not available yet</span></li>
     }
    </ul>
   }
  </li>
 } @empty { <li class="muted small">No messages.</li> }
</ol>`,
})
export class ThreadComponent {
 readonly messages = input.required<ThreadMessage[]>();
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 size(n: number) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
}
