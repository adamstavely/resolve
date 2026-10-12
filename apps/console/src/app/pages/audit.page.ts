import { Component, effect, inject, signal, untracked } from '@angular/core';
import { auditPageSchema, type AuditEvent } from '../../../../../packages/contracts/src/index';
import { api, AppState, fullTime } from '../state';

const ACTION_LABELS: Record<string, string> = {
 'conversation.reply': 'Replied to a conversation', 'conversation.note': 'Added a conversation note', 'conversation.assign': 'Assigned a conversation',
 'conversation.status': 'Changed conversation status', 'conversation.mark_read': 'Marked a conversation read', 'ticket.reply': 'Replied on a ticket',
 'ticket.note': 'Added a ticket note', 'ticket.assign': 'Assigned a ticket', 'ticket.status': 'Changed ticket status', 'grant.connect_start': 'Started connecting an app',
 'access.denied': 'Request refused', 'read.session': 'Loaded the console', 'read.apps': 'Viewed applications', 'read.dashboard': 'Viewed the dashboard',
 'read.tickets': 'Listed tickets', 'read.ticket': 'Opened a ticket', 'read.conversations': 'Listed conversations', 'read.conversation': 'Opened a conversation',
 'read.connection_check': 'Checked an app connection', 'read.audit': 'Viewed the audit log', 'read.users': 'Searched people', 'read.operation': 'Checked an action',
 'read.inbox_stream': 'Started live inbox updates', 'read.inbox_stream_end': 'Live inbox updates ended',
 'session.login': 'Signed in', 'session.logout': 'Signed out', 'grant.connect': 'Connected an app', 'grant.disconnect': 'Disconnected an app',
 'user.manual_disable': 'Blocked access', 'user.manual_enable': 'Lifted an access block', 'user.directory_disable': 'Disabled by directory',
 'user.directory_enable': 'Re-enabled by directory', 'app.client_register': 'Registered an app client',
 'conversation.upload': 'Uploaded a file', 'ticket.upload': 'Uploaded a file', 'read.attachment': 'Downloaded a file', 'presence.activity': 'Signalled viewing or typing',
 'read.conversation_activity': 'Checked who is in a conversation', 'presence.availability': 'Changed chat availability', 'read.availability': 'Checked chat availability',
 'app.onboarding.start': 'Started onboarding', 'app.onboarding.step': 'Saved an onboarding step', 'app.onboarding.review': 'Reviewed an onboarding configuration',
 'app.onboarding.cancel': 'Cancelled onboarding', 'app.onboarding.pilot': 'Ran a pilot check', 'app.job.provision': 'Provisioning job', 'app.job.validate': 'Validation job',
 'app.job.activate': 'Activation job', 'app.job.suspend': 'Suspension job', 'app.job.resume': 'Resume job', 'app.mappings': 'Changed team mappings',
 'app.entitlements_retry': 'Retried entitlement applies', 'user.bundle_grant': 'Granted a bundle', 'user.bundle_revoke': 'Removed a granted bundle',
 'entitlement.desired': 'Entitlement changed', 'entitlement.applied': 'Entitlement applied in the app',
 'observability.connection_create': 'Added an Elastic connection', 'observability.connection_test': 'Tested an Elastic connection',
 'observability.credential_rotate': 'Rotated an Elastic credential', 'observability.kill_switch': 'Changed the Elastic kill switch',
 'observability.mapping_save': 'Saved an Elastic mapping', 'observability.mapping_preview': 'Previewed an Elastic mapping', 'observability.mapping_isolation': 'Ran an isolation check',
 'observability.mapping_state': 'Activated or disabled an Elastic mapping', 'observability.issue_link': 'Linked tickets to a known issue',
 'read.observability_health': 'Viewed service health', 'read.observability_issues': 'Viewed known issues', 'read.observability_stream': 'Started live service health',
 'read.issue_candidates': 'Reviewed tickets for a known issue',
 'read.observability_subject': 'Viewed customer context', 'observability.restricted_read': 'Read trace ids or log lines', 'observability.snapshot_capture': 'Captured an evidence snapshot',
 'read.snapshot': 'Viewed an evidence snapshot', 'read.snapshot_export': 'Exported an evidence snapshot', 'read.clearance': 'Checked support tiers',
};

@Component({
 selector: 'rs-audit-page',
 template: `
<div class="page">
 <header class="page-head">
  <h1 class="page-title" tabindex="-1">Audit</h1>
  <p class="lp-lede small-lede">Everything people do in Resolve, newest first: sign-ins, reads, actions with the messages they sent, and refused requests. Read-only.</p>
 </header>
 @if (!state.can('audit.read') && state.session()) {
  <p class="notice" data-tone="destructive" role="alert">You do not have access to the audit log.</p>
 } @else {
  <section class="card" aria-labelledby="audit-title">
   <div class="card-head"><h2 class="card-title" id="audit-title">Events</h2><span class="card-meta">Read-only</span></div>
   <div class="pad">
    <div class="filters" role="group" aria-label="Filter audit events">
     <label for="audit-category">Activity
      <select id="audit-category" [value]="category()" (change)="setFilter('category', $any($event.target).value)">
       <option value="">All</option><option value="conversation">Conversation actions</option><option value="ticket">Ticket actions</option>
       <option value="read">Reads and views</option><option value="access">Refused requests</option><option value="session">Sign-in</option>
       <option value="grant">App connections</option><option value="user">Access changes</option><option value="app">App administration</option>
       <option value="presence">Availability, viewing and typing</option>
       <option value="entitlement">Entitlement sync</option>
       <option value="broadcast">Announcements</option>
       <option value="observability">Elastic integration</option>
      </select>
     </label>
     <label for="audit-outcome">Outcome
      <select id="audit-outcome" [value]="outcome()" (change)="setFilter('outcome', $any($event.target).value)">
       <option value="">All</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="denied">Denied</option>
      </select>
     </label>
    </div>
    <div class="table-wrap"><table class="data">
     <caption class="sr-only">Audit events</caption>
     <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Outcome</th><th scope="col">Details</th></tr></thead>
     <tbody>
      @for (e of events(); track e.id) {
       <tr>
        <td class="mono nowrap"><time [attr.datetime]="e.at">{{ fullTime(e.at) }}</time></td>
        <td>{{ e.actor }}@if (e.actorType === 'system') { <span class="muted"> (system)</span> }</td>
        <td>{{ actionLabel(e.operation) }}</td>
        <td><span class="tag" [attr.data-tone]="tone(e.outcome)">{{ e.outcome }}</span></td>
        <td class="small">
         <span class="mono">{{ details(e) }}</span>
         @if (e.content !== null) { <blockquote class="audit-content"><span class="sr-only">Message text: </span>{{ e.content }}</blockquote> }
        </td>
       </tr>
      } @empty {
       <tr><td colspan="5" class="muted">{{ loading() ? 'Loading…' : 'No matching events.' }}</td></tr>
      }
     </tbody>
    </table></div>
    @if (cursor()) { <button class="btn btn-sm" type="button" (click)="load(true)" [disabled]="loading()">Load older events</button> }
    <p role="status" class="sr-only">{{ status() }}</p>
   </div>
  </section>
 }
</div>`,
})
export class AuditPage {
 readonly state = inject(AppState);
 readonly events = signal<AuditEvent[]>([]);
 readonly cursor = signal<string | null>(null);
 readonly loading = signal(false);
 readonly status = signal('');
 readonly category = signal('');
 readonly outcome = signal('');
 readonly fullTime = fullTime;

 constructor() {
  let started = false;
  effect(() => { if (!started && this.state.can('audit.read')) { started = true; untracked(() => this.load(false)); } });
 }

 setFilter(which: 'category' | 'outcome', value: string) { (which === 'category' ? this.category : this.outcome).set(value); this.load(false); }

 load(older: boolean) {
  const q = new URLSearchParams({ limit: '25' });
  if (this.category()) q.set('category', this.category());
  if (this.outcome()) q.set('outcome', this.outcome());
  if (older && this.cursor()) q.set('before', this.cursor()!);
  this.loading.set(true);
  api('/api/audit?' + q, auditPageSchema)
   .then(page => {
    this.events.update(prev => older ? [...prev, ...page.events] : page.events);
    this.cursor.set(page.nextCursor);
    this.status.set(`${this.events().length} audit events shown.`);
   })
   .catch(() => this.status.set('Audit events could not be loaded.'))
   .finally(() => this.loading.set(false));
 }

 actionLabel(op: string) { return ACTION_LABELS[op] ?? op; }
 tone(outcome: string) { return outcome === 'succeeded' ? 'safe' : outcome === 'pending' ? 'neutral' : outcome === 'uncertain' ? 'sensitive' : 'destructive'; }
 details(e: AuditEvent) {
  return Object.entries(e.summary).filter(([k]) => !['executor', 'userId', 'targetUserId'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · ');
 }
}
