import { ChangeDetectionStrategy, Component, computed, inject, Injectable, input, signal } from '@angular/core';
import { clearanceResponseSchema } from '../../../../packages/contracts/src/index';
import { api, AppState } from './state';

/** Tier clearance badge (prototype `TierBadge`): four pips, the filled ones up to the tier, and "T<n>". */
@Component({
 selector: 'rs-tier',
 changeDetection: ChangeDetectionStrategy.OnPush,
 host: { style: 'display:contents' },
 template: `
<span [class]="cls()" [attr.data-tier]="tier()" [attr.title]="tier() ? 'Tier ' + tier() + ' clearance' : 'Clearance not reported'">
 <span class="tier-pips" aria-hidden="true">@for (n of pips; track n) { <i [class.on]="!!tier() && n <= tier()!"></i> }</span>
 <span class="mono tier-num">{{ tier() ? 'T' + tier() : '—' }}</span>@if (!tier()) { <span class="sr-only">not reported</span> }
</span>`,
})
export class TierBadgeComponent {
 readonly tier = input<number | null>(null);
 readonly size = input<'sm' | 'md' | 'lg'>('md');
 readonly pips = [1, 2, 3, 4];
 readonly cls = computed(() => 'tier-badge' + (this.size() === 'sm' ? ' tier-sm' : this.size() === 'lg' ? ' tier-lg' : ''));
}

/** Source label (prototype `Src`): Elastic sources in accent, ServiceNow kinds in teal. */
const SN_KINDS = ['CASE', 'CHANGE', 'CMDB', 'ON-CALL', 'CSM', 'KB', 'MAJOR INCIDENT', 'APPROVAL', 'GROUPS', 'ASSIGNMENT GROUPS', 'COMMS PLAN', 'SERVICENOW'];
@Component({
 selector: 'rs-src',
 changeDetection: ChangeDetectionStrategy.OnPush,
 host: { style: 'display:contents' },
 template: `<span [class]="SN_KINDS.includes(k()) ? 'sn' : 'src'">{{ k() }}</span>`,
})
export class SrcComponent {
 readonly k = input.required<string>();
 readonly SN_KINDS = SN_KINDS;
}

/** Transient confirmations (prototype toasts), also announced politely; they never take focus. */
@Injectable({ providedIn: 'root' })
export class ToastService {
 readonly toasts = signal<{ id: number; msg: string }[]>([]);
 private n = 0;
 show(msg: string) {
  const id = ++this.n;
  this.toasts.update(x => [...x, { id, msg }]);
  setTimeout(() => this.toasts.update(x => x.filter(y => y.id !== id)), 3200);
 }
}

/** Your tier per application as each application reports it (QB-TIER-1); read once per session. */
@Injectable({ providedIn: 'root' })
export class ClearanceService {
 private readonly state = inject(AppState);
 readonly tiers = signal<Record<string, 1 | 2 | 3 | null>>({});
 private asked = false;
 load() {
  if (this.asked || !this.state.can('ticket.read')) return;
  this.asked = true;
  api('/api/clearance', clearanceResponseSchema).then(r => this.tiers.set(Object.fromEntries(r.apps.map(a => [a.appKey, a.tier])))).catch(() => { this.asked = false; });
 }
 tierOf(appKey: string) { return this.tiers()[appKey] ?? null; }
}

export const initialsOf = (name: string | null | undefined) => (name ?? '?').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
/** A stable hue per name, for avatar colour (prototype `--ah`). */
export const hueOf = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
/** Clock time as the prototype shows it ("22:14"). */
export const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
/** Today's items by clock time, older ones by date (prototype lists show "22:14"). */
export const when = (iso: string) => { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? hm(iso) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
