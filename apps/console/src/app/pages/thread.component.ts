import { Component, input } from '@angular/core';
import type { ThreadMessage } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { fileSize, fullTime, relativeTime } from '../state';
import { hm, initialsOf } from '../ui';

/**
 * Case conversation thread (prototype v2 `.thread`): customer bubbles left with an avatar, agent replies right, work
 * notes full width and labelled "internal", system events inline. Read-only. Internal notes are labelled in text, not only by colour. Attachments download through
 * Resolve (`attachmentBase` + id), which asks the application with the person's own access; there are no direct links.
 */
@Component({
 selector: 'rs-thread',
 host: { style: 'display:contents' },
 imports: [IconComponent],
 template: `
<ol class="thread-list" aria-label="Messages" style="list-style:none;margin:0;padding:0;display:contents">
 @for (m of messages(); track m.id) {
  @if (m.senderType === 'system') {
   <li class="sysev"><span class="ic" aria-hidden="true"><rs-icon name="activity" [size]="12" /></span><span class="tx"><span class="sr-only">System: </span>{{ m.content }}</span>
    <time class="meta" [attr.datetime]="m.createdAt" [attr.title]="fullTime(m.createdAt)">{{ hm(m.createdAt) }}</time></li>
  } @else {
   <li class="msg" [attr.data-k]="m.isInternal ? 'note' : m.senderType === 'visitor' ? 'customer' : 'agent'">
    @if (m.senderType === 'visitor' && !m.isInternal) { <span class="avatar" aria-hidden="true" [style.width.px]="28" [style.height.px]="28" [style.font-size.px]="10.6" [style.--ah]="hue()">{{ initials(m.authorName) }}</span> }
    <div [style.min-width]="0" [style.flex]="m.isInternal ? 1 : null">
     <div class="who">
      <span>{{ m.authorName ?? (m.senderType === 'visitor' ? 'Customer' : 'Agent') }}</span><span aria-hidden="true">·</span>
      <time [attr.datetime]="m.createdAt" [attr.title]="fullTime(m.createdAt)">{{ hm(m.createdAt) }}</time>
      @if (m.isInternal) { <span class="waiting" style="font-weight:500">work note · internal</span> }
      @else if (m.senderType === 'visitor') { <span class="sr-only">, customer</span> } @else { <span class="sr-only">, agent reply</span> }
     </div>
     <div class="bub">@if (m.content) {<span>{{ m.content }}</span>}
      @if (m.attachments.length) {
       <ul class="attachments" aria-label="Attachments" style="list-style:none;margin:6px 0 0;padding:0">
        @for (a of m.attachments; track a.id) {
         <li class="tags" style="gap:6px"><rs-icon name="paperclip" [size]="13" />
          @if (attachmentBase(); as base) { <a class="mono" [href]="base + encode(a.id)" download style="color:inherit;text-decoration:underline">{{ a.name }}<span class="sr-only">, download</span></a> } @else { <span class="mono">{{ a.name }}</span> }
          <span style="opacity:.75;font-size:11px">{{ fileSize(a.size) }}</span></li>
        }
       </ul>
      }
     </div>
    </div>
   </li>
  }
 } @empty { <li class="sysev"><span class="tx">No messages yet.</span></li> }
</ol>`,
})
export class ThreadComponent {
 readonly messages = input.required<ThreadMessage[]>();
 /** e.g. `/api/apps/payroll/conversations/c1/attachments/`; without it, names are shown without links. */
 readonly attachmentBase = input<string | null>(null);
 /** Avatar hue for the customer (prototype `--ah`). */
 readonly hue = input(256);
 readonly hm = hm;
 initials(n: string | null) { return initialsOf(n ?? 'Customer'); }
 readonly relativeTime = relativeTime;
 readonly fullTime = fullTime;
 readonly fileSize = fileSize;
 readonly encode = encodeURIComponent;
}
