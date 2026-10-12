import type { RegistryApp } from '@resolve/contracts';
import { pool } from '../db';
import { auditRead, writeAudit } from '../audit';
import type { Principal } from '../auth/session';
import { rpc, type ToolOutcome } from '../tenants/mcp';
import { actionSupported } from '../tenants/protocol';
import { fanOut, type AppResult } from './fanout';

/*
 * Agent availability for chat routing (plan 09, QB-CHAT-3). Availability is an explicit choice made in each
 * application, never a side effect of having Resolve open or the inbox stream connected. Results are per app:
 * Resolve never claims "available everywhere" when one application did not confirm it.
 */
type Status = 'available' | 'away';
type Problem = 'not_connected' | 'reconnect_required' | 'unsupported' | 'unavailable' | 'dormant' | 'failed';
export interface AppAvailability { appKey: string; status: Status | 'unknown'; problem: Problem | null }

const PROBLEM: Record<string, Problem> = {
 not_connected: 'not_connected', reconnect_required: 'reconnect_required', incompatible: 'unsupported', suspended: 'unavailable', denied: 'unavailable',
 dormant: 'dormant', timeout: 'failed', tenant_error: 'failed',
};

async function call(app: RegistryApp, userId: string, set: Status | undefined, unsupported: Set<string>): Promise<ToolOutcome<{ status: Status }>> {
 if (!(await actionSupported(app, set ? 'set_availability' : 'get_availability'))) { unsupported.add(app.appKey); return { ok: false, reason: 'tenant_error' }; }
 const o = set ? await rpc(app, userId, 'set_availability', { status: set }, 3000) : await rpc(app, userId, 'get_availability', {}, 3000);
 if (o.kind === 'ok') return { ok: true, data: { status: o.data.status } };
 if (o.kind === 'not_connected' || o.kind === 'reconnect_required' || o.kind === 'denied') return { ok: false, reason: o.kind };
 if (o.kind === 'tool_error') return { ok: false, reason: o.code === 'FORBIDDEN' ? 'denied' : 'tenant_error' };
 return { ok: false, reason: o.kind === 'unknown' && o.detail === 'timeout' ? 'timeout' : 'tenant_error' };
}

const toApi = (r: AppResult<{ status: Status }>, unsupported: Set<string>): AppAvailability => r.status === 'ok'
 ? { appKey: r.appKey, status: r.data.status, problem: null }
 : { appKey: r.appKey, status: 'unknown', problem: unsupported.has(r.appKey) ? 'unsupported' : PROBLEM[r.reason] ?? 'failed' };

/** Read (no `set`) or change availability in every connected, awake application. Dormant apps are not woken. */
export async function fleetAvailability(principal: Principal, apps: RegistryApp[], set?: Status, timeoutMs = 4000): Promise<AppAvailability[]> {
 const unsupported = new Set<string>();
 const results = (await fanOut(apps, app => call(app, principal.userId, set, unsupported), { timeoutMs })).map(r => toApi(r, unsupported));
 if (set) {
  for (const r of results.filter(x => x.problem !== 'dormant' && x.problem !== 'unavailable')) {
   await writeAudit(pool(), { actorUserId: principal.userId, operation: 'presence.availability', outcome: r.status === set ? 'succeeded' : 'failed',
    summary: { app: r.appKey, status: set, ...(r.problem ? { code: r.problem } : {}) } });
  }
 } else await auditRead(principal, 'availability', { apps: results.length });
 return results;
}
