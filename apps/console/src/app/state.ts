import { computed, Injectable, signal } from '@angular/core';
import type { z } from 'zod';
import {
 appsResponseSchema, healthSchema, sessionResponseSchema, type AppsResponse, type CapabilityId, type SessionResponse,
} from '../../../../packages/contracts/src/index';

/** API error body (`{ error: { code, message } }`) surfaced to pages. */
export class ApiError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }

/** Fetch and validate a Resolve API response. Non-2xx responses become ApiError with the server's message. */
export async function api<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
 const r = await fetch(path, { credentials: 'same-origin' });
 const body = await r.json().catch(() => null);
 if (!r.ok) throw new ApiError(r.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? 'The request failed. Try again.');
 return schema.parse(body);
}

/** Session, applications and service health, shared by the shell and pages. */
@Injectable({ providedIn: 'root' })
export class AppState {
 readonly session = signal<SessionResponse | undefined>(undefined);
 readonly apps = signal<AppsResponse | undefined>(undefined);
 readonly appsError = signal('');
 readonly health = signal('Checking backend…');
 readonly healthy = signal(false);

 readonly signedIn = computed(() => this.session()?.authenticated === true);
 readonly user = computed(() => { const s = this.session(); return s?.authenticated ? s.user : undefined; });
 readonly initials = computed(() => this.user()?.displayName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() ?? '');

 can(capability: CapabilityId) { const s = this.session(); return !!s?.authenticated && s.capabilities.includes(capability); }
 appName(appKey: string) { return this.apps()?.apps.find(a => a.appKey === appKey)?.displayName ?? appKey; }

 constructor() {
  fetch('/api/health')
   .then(async r => { if (!r.ok) throw Error(); healthSchema.parse(await r.json()); this.health.set('Resolve API is reachable · contract v1'); this.healthy.set(true); })
   .catch(() => this.health.set('Backend unavailable. Start the API service and reload.'));
  fetch('/api/session', { credentials: 'same-origin' })
   .then(async r => {
    const s = sessionResponseSchema.parse(await r.json());
    this.session.set(s);
    if (s.authenticated && s.capabilities.includes('fleet.view')) this.loadApps();
   })
   .catch(() => this.session.set({ authenticated: false }));
 }

 loadApps() {
  api('/api/apps', appsResponseSchema).then(a => { this.apps.set(a); this.appsError.set(''); })
   .catch(() => this.appsError.set('Applications could not be loaded. Try again shortly.'));
 }
}

export const UNAVAILABLE_TEXT: Record<string, string> = {
 not_connected: 'Not connected. Connect to this application on Home to see its data.',
 reconnect_required: 'Reconnect to this application on Home to continue.',
 denied: 'You do not have access to this in the application.',
 timeout: 'The application took too long to respond.',
 tenant_error: 'The application did not respond as expected.',
 incompatible: 'This application runs a version Resolve cannot read yet.',
 suspended: 'This application is suspended.',
 dormant: 'This application is idle. Load it to see its data; loading starts it.',
};

export function relativeTime(iso: string, now = Date.now()) {
 const s = Math.round((now - Date.parse(iso)) / 1000);
 const abs = Math.abs(s);
 const [n, unit] = abs < 60 ? [s, 'second'] : abs < 3600 ? [Math.round(s / 60), 'minute'] : abs < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
 return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-n, unit as Intl.RelativeTimeFormatUnit);
}
export const fullTime = (iso: string) => new Date(iso).toLocaleString();
