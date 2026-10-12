import { signal } from '@angular/core';
import type { z } from 'zod';
import { api, ApiError, UNAVAILABLE_TEXT } from '../state';

/** One app's section in a fleet list: rows so far, the tenant's cursor, or why it is unavailable. */
export interface AppSection<T> { appKey: string; rows: T[]; nextCursor: string | null; unavailable?: string; dormant?: boolean; loadingMore?: boolean; error?: string }

type FleetResult<T> = { status: 'ok'; appKey: string; data: { nextCursor: string | null } & Record<string, unknown> } | { status: 'unavailable'; appKey: string; reason: string };

/**
 * Per-app pagination (plan 01: the first release paginates per app; a global sorted page needs a k-way merge
 * that is not claimed here). Each section loads more from its own tenant cursor.
 */
export class FleetList<T> {
 readonly sections = signal<AppSection<T>[]>([]);
 readonly loading = signal(false);
 readonly error = signal('');
 readonly include = new Set<string>();

 constructor(private readonly rowsKey: string, private readonly fleetPath: (q: URLSearchParams) => string,
  private readonly appPath: (appKey: string, q: URLSearchParams) => string, private readonly fleetSchema: z.ZodType, private readonly pageSchema: z.ZodType) {}

 load(filters: Record<string, string>) {
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  if (this.include.size) q.set('include', [...this.include].join(','));
  this.loading.set(true);
  api(this.fleetPath(q), this.fleetSchema)
   .then(raw => {
    const res = raw as { apps: FleetResult<T>[] };
    this.sections.set(res.apps.map(r => r.status === 'ok'
     ? { appKey: r.appKey, rows: r.data[this.rowsKey] as T[], nextCursor: r.data.nextCursor }
     : { appKey: r.appKey, rows: [], nextCursor: null, unavailable: UNAVAILABLE_TEXT[r.reason] ?? 'Unavailable.', dormant: r.reason === 'dormant' }));
    this.error.set('');
   })
   .catch((e: Error) => this.error.set(e.message))
   .finally(() => this.loading.set(false));
 }

 /** Explicit user request to include an idle application (this starts it). */
 wake(appKey: string, filters: Record<string, string>) { this.include.add(appKey); this.load(filters); }

 more(appKey: string, filters: Record<string, string>) {
  const section = this.sections().find(s => s.appKey === appKey);
  if (!section?.nextCursor) return;
  const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  q.set('cursor', section.nextCursor);
  this.patch(appKey, { loadingMore: true, error: undefined });
  api(this.appPath(appKey, q), this.pageSchema)
   .then(raw => { const page = raw as Record<string, unknown> & { nextCursor: string | null }; this.patch(appKey, s => ({ rows: [...s.rows, ...(page[this.rowsKey] as T[])], nextCursor: page.nextCursor, loadingMore: false })); })
   .catch((e: unknown) => this.patch(appKey, { loadingMore: false, error: e instanceof ApiError ? e.message : 'Could not load more.' }));
 }

 private patch(appKey: string, change: Partial<AppSection<T>> | ((s: AppSection<T>) => Partial<AppSection<T>>)) {
  this.sections.update(list => list.map(s => s.appKey === appKey ? { ...s, ...(typeof change === 'function' ? change(s) : change) } : s));
 }
}
