import type { CapabilityId } from '@resolve/contracts';
import { config } from '../config';
import { pool } from '../db';
import { capabilityList, readCookie, SESSION_COOKIE, sha256 } from './policy';
import { findSession, type SessionUser } from './repository';
import { auditDenied } from '../audit';

export interface Principal extends SessionUser { capabilities: CapabilityId[]; sessionHash: string }

export async function currentPrincipal(request: Request): Promise<Principal | undefined> {
 const raw = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
 if (!raw) return undefined;
 const sessionHash = sha256(raw);
 const user = await findSession(pool(), sessionHash, config().SESSION_IDLE_MINUTES);
 return user && { ...user, capabilities: capabilityList(user.bundles), sessionHash };
}

export function apiError(status: 401 | 403 | 400, code: string, message: string) {
 return Response.json({ error: { code, message, requestId: crypto.randomUUID() } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Server-side capability check (plan 02). The UI hiding a control is never the enforcement. */
/** Every refusal is audited (owner decision: the audit covers every user event, including denied ones). */
export async function requireCapability(request: Request, capability: CapabilityId): Promise<Principal | Response> {
 const principal = await currentPrincipal(request);
 if (!principal) { await auditDenied(request, null, 'unauthenticated', { capability }); return apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'); }
 if (!principal.capabilities.includes(capability)) { await auditDenied(request, principal.userId, 'missing_capability', { capability }); return apiError(403, 'FORBIDDEN', 'You do not have access to this.'); }
 return principal;
}
