import { computed, Injectable, signal } from '@angular/core';
import { fleetHealthSchema, knownIssueListSchema, type AppHealth, type HealthState, type KnownIssue } from '../../../../packages/contracts/src/index';
import type { IconName } from './icon.component';
import { api } from './state';

export const HEALTH_LABEL: Record<HealthState, string> = { healthy: 'Operational', degraded: 'Degraded', critical: 'Critical', unknown: 'Unknown', stale: 'Out of date' };
export const HEALTH_TONE: Record<HealthState, string> = { healthy: 'safe', degraded: 'sensitive', critical: 'destructive', unknown: 'neutral', stale: 'neutral' };
export const HEALTH_ICON: Record<HealthState, IconName> = { healthy: 'check', degraded: 'alert', critical: 'alert', unknown: 'help', stale: 'clock' };
export const REASON_TEXT: Record<string, string> = {
 not_configured: 'Not connected to Elastic', kill_switch: 'Elastic reads switched off by an administrator',
 connection_unavailable: 'Elastic refused Resolve’s credential', not_polled_yet: 'Waiting for the first health check',
};

/**
 * App-wide service health (plan 14, E1). One event stream per signed-in person with observability.health; each
 * event triggers a re-read of committed snapshots (never Elastic). Changes are announced politely and only when an
 * app's state actually changes, never on every refresh.
 */
@Injectable({ providedIn: 'root' })
export class ObservabilityService {
 readonly health = signal<AppHealth[]>([]);
 readonly issues = signal<KnownIssue[]>([]);
 readonly pollSeconds = signal(30);
 readonly loaded = signal(false);
 readonly error = signal('');
 readonly announcement = signal('');
 readonly live = signal(false);
 readonly byApp = computed(() => {
  const m = new Map<string, AppHealth>();
  for (const h of this.health()) { const cur = m.get(h.appKey); if (!cur || rank(h.state) > rank(cur.state)) m.set(h.appKey, h); }
  return m;
 });
 private source?: EventSource;
 private timer?: ReturnType<typeof setTimeout>;
 private started = false;
 appName: (appKey: string) => string = k => k;

 start() {
  if (this.started) return;
  this.started = true;
  this.connect();
 }
 stop() { this.source?.close(); this.started = false; this.live.set(false); }

 private connect() {
  this.source = new EventSource('/api/observability/stream', { withCredentials: true });
  const reread = () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.reload(), 250); };
  for (const type of ['ready', 'health', 'issues']) this.source.addEventListener(type, reread);
  this.source.onopen = () => this.live.set(true);
  // EventSource reconnects by itself; `ready` on reconnect triggers a re-read.
  this.source.onerror = () => this.live.set(false);
 }

 reload() {
  return Promise.all([api('/api/observability/health', fleetHealthSchema), api('/api/observability/issues', knownIssueListSchema)]).then(([h, i]) => {
   const before = this.byApp();
   this.health.set(h.apps); this.pollSeconds.set(h.pollSeconds); this.issues.set(i.issues);
   if (this.loaded()) {
    const changes = [...this.byApp().values()].filter(a => before.get(a.appKey) && before.get(a.appKey)!.state !== a.state);
    if (changes.length) this.announcement.set(changes.map(a => `${this.appName(a.appKey)} is now ${HEALTH_LABEL[a.state].toLowerCase()}.`).join(' '));
   }
   this.loaded.set(true); this.error.set('');
  }).catch(e => this.error.set(e.message ?? 'Service health could not be loaded.'));
 }
}

const rank = (s: HealthState) => ({ unknown: 0, stale: 0, healthy: 1, degraded: 2, critical: 3 })[s];
