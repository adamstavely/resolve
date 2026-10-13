import { Component, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { z } from 'zod';
import { broadcastListSchema } from '../../../../../packages/contracts/src/index';
import { IconComponent } from '../icon.component';
import { api, AppState, fullTime } from '../state';

export const STATUS_LABEL: Record<string, string> = {
 draft: 'Draft', scheduled: 'Scheduled', publishing: 'Publishing', published: 'Published', partial: 'Partly delivered', needs_attention: 'Needs attention', failed: 'Not delivered', archived: 'Archived',
};
export const STATUS_TONE: Record<string, string> = {
 draft: 'neutral', scheduled: 'neutral', publishing: 'neutral', published: 'safe', partial: 'sensitive', needs_attention: 'sensitive', failed: 'destructive', archived: 'neutral',
};

/** Fleet banner broadcasts (plan 08): every draft and publication, newest first. */
@Component({
 selector: 'rs-broadcasts-page',
 imports: [RouterLink, IconComponent],
 template: `
<div class="page">
 <header class="page-head head-row">
  <div class="grow">
   <h1 class="page-title" tabindex="-1">Announcements</h1>
   <p class="lp-lede small-lede">Banners for everyone, published to all registered applications or the ones you choose, as you.</p>
  </div>
  <a class="btn btn-primary" routerLink="/announcements/new"><rs-icon name="plus" [size]="15" />New banner</a>
 </header>
 @if (error()) { <p class="notice" data-tone="destructive" role="alert">{{ error() }}</p> }
 <section class="card" aria-labelledby="list-title">
  <div class="card-head"><h2 class="card-title" id="list-title">Banners</h2></div>
  <div class="table-wrap pad-sm"><table class="data">
   <caption class="sr-only">Banners, newest first</caption>
   <thead><tr><th scope="col">Banner</th><th scope="col">Status</th><th scope="col">Delivered</th><th scope="col">By</th><th scope="col">Updated</th></tr></thead>
   <tbody>
    @for (b of list(); track b.id) {
     <tr>
      <td><a class="row-link" [routerLink]="['/announcements', b.id]">{{ b.title }}</a><div class="muted small">{{ b.kind }}</div></td>
      <td><span class="tag" [attr.data-tone]="tone(b.status)">{{ label(b.status) }}</span></td>
      <td>{{ b.status === 'draft' || b.status === 'scheduled' ? '—' : b.succeeded + ' of ' + b.recipients }}</td>
      <td>{{ b.author }}</td>
      <td class="nowrap"><time [attr.datetime]="b.updatedAt">{{ fullTime(b.updatedAt) }}</time></td>
     </tr>
    } @empty { <tr><td colspan="5" class="muted">{{ loading() ? 'Loading…' : 'No banners yet.' }}</td></tr> }
   </tbody>
  </table></div>
 </section>
</div>`,
})
export class BroadcastsPage {
 readonly state = inject(AppState);
 readonly list = signal<z.infer<typeof broadcastListSchema>['broadcasts']>([]);
 readonly loading = signal(true);
 readonly error = signal('');
 readonly fullTime = fullTime;
 readonly label = (s: string) => STATUS_LABEL[s] ?? s;
 readonly tone = (s: string) => STATUS_TONE[s] ?? 'neutral';
 constructor() {
  let started = false;
  effect(() => {
   if (started || !(this.state.can('broadcast.publish') || this.state.can('broadcast.app'))) return;
   started = true;
   untracked(() => api('/api/broadcasts', broadcastListSchema).then(r => this.list.set(r.broadcasts)).catch(e => this.error.set(e.message)).finally(() => this.loading.set(false)));
  });
 }
}
