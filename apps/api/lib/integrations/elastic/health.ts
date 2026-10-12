import type { AlertResult, AppHealth, Completeness, ElasticFamily, HealthComponent, HealthState, SloResult, SyntheticResult } from '@resolve/contracts';

/*
 * Health aggregation (plan 12 §5, plan 14 E1). Pure: the poller feeds it what each family returned and it decides
 * the state. Rules:
 * - An SLO is healthy, degrading (degraded) or violated (critical) as Elastic reports it; no data is unknown.
 * - Active alerts on the mapped rules make the app degraded. A failing synthetic location is degraded.
 * - A configured SLO Elastic does not know, or a monitor with no executed result in the window, is unknown.
 * - The app takes the worst known state. If nothing is known, it is unknown; absence of data is never healthy.
 * - A family that failed or was refused makes the result partial and is listed as missing; if every configured
 *   family failed, the result is unavailable.
 */

export interface FamilyOutcome<T> { ok: true; items: T[]; missingIds?: string[] }
export interface FamilyFailure { ok: false; code: string }
export type Outcome<T> = FamilyOutcome<T> | FamilyFailure;

export interface HealthInput {
 slos?: Outcome<SloResult>;
 alerts?: Outcome<AlertResult>;
 synthetics?: Outcome<SyntheticResult> & { configured?: string[]; recent?: SyntheticResult[] };
 /** Families that are configured but did not feed health directly (cases): counted for completeness only. */
 others?: Partial<Record<ElasticFamily, Outcome<unknown>>>;
}

export interface HealthResult {
 state: HealthState;
 completeness: Completeness;
 missing: ElasticFamily[];
 components: HealthComponent[];
 summary: AppHealth['summary'];
}

const RANK: Record<HealthState, number> = { unknown: 0, stale: 0, healthy: 1, degraded: 2, critical: 3 };
const pct = (v: number) => `${+(v * 100).toFixed(2)}%`;

export function sloComponent(s: SloResult): HealthComponent {
 const state: HealthState = s.status === 'healthy' ? 'healthy' : s.status === 'degrading' ? 'degraded' : s.status === 'violated' ? 'critical' : 'unknown';
 const window = `${s.window.duration} ${s.window.type === 'rolling' ? 'rolling' : 'calendar'}`;
 const detail = s.status === 'no_data' || s.sliValue === null
  ? `No data in the ${window} window`
  : `${pct(s.sliValue)} against ${pct(s.target)} (${window})${s.errorBudgetRemaining !== null ? `, ${pct(Math.max(0, s.errorBudgetRemaining))} of budget left` : ''}${s.burnRate ? `, burning ${s.burnRate.value.toFixed(1)}x over ${s.burnRate.window}` : ''}`;
 return { family: 'slo', key: s.sloId, label: s.name, state, detail };
}

export function aggregate(input: HealthInput): HealthResult {
 const components: HealthComponent[] = [];
 const missing: ElasticFamily[] = [];
 let configured = 0, failed = 0;
 const summary: AppHealth['summary'] = {
  slos: { total: 0, healthy: 0, degrading: 0, violated: 0, noData: 0, worstBurn: null },
  activeAlerts: 0,
  synthetics: { passing: 0, total: 0, failing: [], configured: 0, recent: [] },
 };

 if (input.slos) {
  configured++;
  if (!input.slos.ok) { failed++; missing.push('slo'); }
  else {
   for (const s of input.slos.items) {
    components.push(sloComponent(s));
    summary.slos.total++;
    if (s.status === 'healthy') summary.slos.healthy++;
    else if (s.status === 'degrading') summary.slos.degrading++;
    else if (s.status === 'violated') summary.slos.violated++;
    else summary.slos.noData++;
    if (s.burnRate && (!summary.slos.worstBurn || s.burnRate.value > summary.slos.worstBurn.value))
     summary.slos.worstBurn = { sloId: s.sloId, name: s.name, target: s.target, window: s.burnRate.window, value: s.burnRate.value };
   }
   for (const id of input.slos.missingIds ?? []) {
    components.push({ family: 'slo', key: id, label: id, state: 'unknown', detail: 'This SLO was not found in Elastic' });
    summary.slos.total++; summary.slos.noData++;
   }
  }
 }

 if (input.alerts) {
  configured++;
  if (!input.alerts.ok) { failed++; missing.push('alerts'); }
  else {
   const active = input.alerts.items.filter(a => a.status === 'active');
   summary.activeAlerts = active.length;
   components.push({
    family: 'alerts', key: 'alerts', label: 'Alerts', state: active.length ? 'degraded' : 'healthy',
    detail: active.length ? `${active.length} active: ${[...new Set(active.map(a => a.ruleName))].join(', ')}`.slice(0, 300) : 'No active alerts on the mapped rules',
   });
  }
 }

 if (input.synthetics) {
  configured++;
  summary.synthetics.configured = input.synthetics.configured?.length ?? 0;
  if (!input.synthetics.ok) { failed++; missing.push('synthetics'); }
  else {
   summary.synthetics.recent = [...(input.synthetics.recent ?? [])].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt)).slice(-12)
    .map(r => ({ status: r.status, label: `${r.name} · ${r.location}`, checkedAt: r.checkedAt }));
   const seen = new Set<string>();
   for (const r of [...input.synthetics.items].sort((a, b) => `${a.name}${a.location}`.localeCompare(`${b.name}${b.location}`))) {
    seen.add(r.monitorId);
    summary.synthetics.total++;
    if (r.status === 'up') summary.synthetics.passing++; else summary.synthetics.failing.push(`${r.name} (${r.location})`);
    components.push({
     family: 'synthetics', key: `${r.monitorId}@${r.location}`, label: `${r.name} · ${r.location}`, state: r.status === 'up' ? 'healthy' : 'degraded',
     detail: r.status === 'up' ? `Passing${r.durationMs !== null ? ` in ${r.durationMs} ms` : ''}` : 'Failing on its latest run',
    });
   }
   for (const id of input.synthetics.configured ?? []) if (!seen.has(id))
    components.push({ family: 'synthetics', key: `${id}@-`, label: id, state: 'unknown', detail: 'No executed result in the last 15 minutes' });
  }
 }

 for (const [family, o] of Object.entries(input.others ?? {}) as [ElasticFamily, Outcome<unknown>][]) {
  configured++;
  if (!o.ok) { failed++; missing.push(family); }
 }

 const known = components.filter(c => c.state !== 'unknown');
 const state: HealthState = known.length === 0 ? 'unknown' : known.reduce<HealthState>((w, c) => (RANK[c.state] > RANK[w] ? c.state : w), 'healthy');
 const completeness: Completeness = configured > 0 && failed === configured ? 'unavailable' : failed > 0 ? 'partial' : 'complete';
 return { state: completeness === 'unavailable' ? 'unknown' : state, completeness, missing, components, summary };
}

/** Read-time staleness: a snapshot older than two missed polls is stale, whatever it said. */
export function withStaleness<T extends { state: HealthState; fetchedAt: Date }>(s: T, pollSeconds: number, now = Date.now()): T {
 return now - s.fetchedAt.getTime() > 2 * pollSeconds * 1000 + 5000 ? { ...s, state: 'stale' } : s;
}
