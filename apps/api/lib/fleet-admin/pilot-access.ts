import { isServable, type RegistryApp } from '@resolve/contracts';
import { pool } from '../db';
import { rawRegistryApp, registryApp } from '../registry';
import { pilotRun } from './onboarding';

/**
 * The app a person may connect to: any servable app, or, for a named pilot of its current onboarding run, the
 * instance under validation (plan 07 step 6). The tenant admits only pilot identities while it is not active.
 */
export async function connectableApp(userId: string, appKey: string): Promise<{ app: RegistryApp; pilot: boolean } | undefined> {
 const app = await registryApp(appKey).catch(() => undefined);
 if (app && isServable(app)) return { app, pilot: false };
 if (!app || app.state === 'suspended' || !(await pilotRun(pool(), userId, appKey))) return undefined;
 const raw = await rawRegistryApp(appKey).catch(() => undefined);
 return raw && (raw.state === 'maintenance' || raw.state === 'active') ? { app: raw, pilot: true } : undefined;
}
