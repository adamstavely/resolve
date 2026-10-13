import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { z } from 'zod';
import { liveActivitySchema } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { ObservabilityService } from '../observability.service';
import { api, AppState, relativeTime } from '../state';
import { hm } from '../ui';

/**
 * Live activity (plan 14, E3; prototype board 2): recent actions across the console and whether each was verified
 * downstream. Other people's targets are not shown; your own link to their receipts.
 */
@Component({
 selector: 'rs-live-activity',
 imports: [IconComponent, RouterLink],
 template: `
<section class="panel" aria-labelledby="la-title">
 <div class="panel-head"><h2 class="t" id="la-title" style="margin:0"><rs-icon name="activity" [size]="15" /> Live activity</h2><span class="section-label">console-wide</span></div>
 <div class="panel-body">
  @for (e of entries(); track $index) {
   <div class="feed-row">
    <div class="feed-rail"><span class="d" [style.background]="e.verification === 'verified' ? 'var(--safe)' : e.verification === 'awaiting' ? 'var(--sensitive)' : 'var(--ink-faint)'"></span></div>
    <div class="feed-body">
     <div class="feed-action">@if (e.operationId) { <a [routerLink]="['/receipts', e.operationId]">{{ e.action }}</a> } @else { {{ e.action }} }</div>
     <div class="feed-line2">
      <span class="feed-agent">{{ e.own ? 'you' : e.actor }}</span><span>·</span><span>{{ name(e.appKey) }}</span>@if (e.target) { <span>·</span><span>{{ e.target }}</span> }<span>·</span><time [attr.datetime]="e.at" [attr.title]="relativeTime(e.at)">{{ hm(e.at) }}</time>
      @if (e.verification === 'verified') { <span class="verif" data-s="ok">✓ verified in logs</span> }
      @else if (e.verification === 'awaiting') { <span class="verif" data-s="wait">awaiting confirmation</span> }
      @else if (e.verification === 'unverified') { <span class="verif" data-s="wait">not seen downstream</span> }
     </div>
    </div>
   </div>
  } @empty { <p class="feed-line2" style="padding:10px">No actions in the last 24 hours.</p> }
 </div>
</section>`,
})
export class LiveActivityComponent {
 readonly obs = inject(ObservabilityService);
 readonly state = inject(AppState);
 readonly entries = signal<z.infer<typeof liveActivitySchema>['entries']>([]);
 readonly relativeTime = relativeTime;
 readonly hm = hm;
 name(appKey: string) { return this.state.appName(appKey); }
 constructor() {
  // Re-read with each health refresh (the stream's cadence); there is no separate poll.
  effect(() => { void this.obs.health(); untracked(() => api('/api/observability/activity', liveActivitySchema).then(r => this.entries.set(r.entries.slice(0, 8))).catch(() => {})); });
 }
}
