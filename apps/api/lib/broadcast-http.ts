import { json, jsonMutation } from './http';
import { apiError, currentPrincipal, type Principal } from './auth/session';
import { auditDenied } from './audit';
import { BroadcastError } from './broadcasts';
import { fieldProblem } from './fleet-admin/http';

/**
 * Broadcast routes: `broadcast.publish`, or `broadcast.app` for Tier 1+ authors whose banners are limited to their
 * applications (checked in lib/broadcasts). Refusals are audited; rule violations become 4xx.
 */
export async function withPublisher(request: Request, handler: (p: Principal) => Promise<Response>) {
 const principal = await currentPrincipal(request);
 if (!principal) { await auditDenied(request, null, 'unauthenticated', { capability: 'broadcast.publish' }); return apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'); }
 if (!principal.capabilities.includes('broadcast.publish') && !principal.capabilities.includes('broadcast.app')) {
  await auditDenied(request, principal.userId, 'missing_capability', { capability: 'broadcast.publish' });
  return apiError(403, 'FORBIDDEN', 'You do not have access to this.');
 }
 try { return await handler(principal); }
 catch (e) { if (e instanceof BroadcastError) return fieldProblem(e.status, e.code, e.message, e.details); throw e; }
}
export async function publisherMutation(request: Request, handler: (p: Principal, body: unknown) => Promise<Response>) {
 const body = await jsonMutation(request);
 if (body instanceof Response) return body;
 return withPublisher(request, p => handler(p, body));
}
export { json };
