import { isServable, type CapabilityId, type RegistryApp } from '@resolve/contracts';
import { problem } from '../http';
import { requireCapability, type Principal } from '../auth/session';
import { registry, registryApp, RegistryUnavailable } from '../registry';
import { pool } from '../db';
import { tenantHealth } from '../tenants/protocol';
import type { ToolFailure } from '../tenants/mcp';
import { writeAudit } from '../audit';

export const registryUnavailable = () => problem(503, 'REGISTRY_UNAVAILABLE', 'The application registry is unavailable. Try again shortly.');

/** Apps the user explicitly asked to load (waking dormant apps is only allowed on request). */
export function includeParam(url: URL): Set<string> {
 return new Set((url.searchParams.get('include') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50));
}

export async function fleetRequest(request: Request, capability: CapabilityId): Promise<{ principal: Principal; apps: RegistryApp[] } | Response> {
 const principal = await requireCapability(request, capability);
 if (principal instanceof Response) return principal;
 try { return { principal, apps: (await registry()).apps }; } catch (e) { if (e instanceof RegistryUnavailable) return registryUnavailable(); throw e; }
}

/**
 * A single-app request is an explicit user action, so a dormant app may be contacted. `auditAs` names the
 * operation, so requests that stop here (unknown, unavailable or incompatible app) are audited too.
 */
export async function appRequest(request: Request, capability: CapabilityId, appKey: string, auditAs: string): Promise<{ principal: Principal; app: RegistryApp } | Response> {
 const principal = await requireCapability(request, capability);
 if (principal instanceof Response) return principal;
 const fail = async (status: number, code: string, message: string) => {
  await writeAudit(pool(), { actorUserId: principal.userId, operation: auditAs, outcome: 'failed', summary: { app: appKey, code } });
  return problem(status, code, message);
 };
 let app: RegistryApp | undefined;
 try { app = await registryApp(appKey); } catch (e) { if (e instanceof RegistryUnavailable) return fail(503, 'REGISTRY_UNAVAILABLE', 'The application registry is unavailable. Try again shortly.'); throw e; }
 if (!app) return fail(404, 'UNKNOWN_APP', 'This application is not registered.');
 if (!isServable(app)) return fail(503, 'APP_UNAVAILABLE', `${app.displayName} is not available right now.`);
 const health = await tenantHealth(app);
 if (health.status === 'incompatible') return fail(409, 'INCOMPATIBLE', `${app.displayName} runs a version Resolve cannot read yet.`);
 if (health.status === 'unreachable') return fail(502, 'TENANT_ERROR', `${app.displayName} did not respond. Try again shortly.`);
 return { principal, app };
}

/** Audit outcome for a read that reached the tenant. */
export const readOutcome = (o: { ok: boolean; reason?: string }) => o.ok ? 'succeeded' as const : o.reason === 'denied' || o.reason === 'not_found' ? 'denied' as const : 'failed' as const;

const FAILURES: Record<ToolFailure, [number, string]> = {
 not_connected: [409, 'Connect to this application first.'],
 reconnect_required: [409, 'Reconnect to this application to continue.'],
 denied: [403, 'You do not have access to this in the application.'],
 not_found: [404, 'Not found, or you do not have access to it.'],
 timeout: [504, 'The application took too long to respond. Try again.'],
 tenant_error: [502, 'The application returned an unexpected response. Try again shortly.'],
};
export const toolFailure = (reason: ToolFailure) => problem(FAILURES[reason][0], reason.toUpperCase(), FAILURES[reason][1]);
