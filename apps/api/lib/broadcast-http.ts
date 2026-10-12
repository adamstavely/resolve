import { json, jsonMutation } from './http';
import { requireCapability, type Principal } from './auth/session';
import { BroadcastError } from './broadcasts';
import { fieldProblem } from './fleet-admin/http';

/** Broadcast routes: `broadcast.publish` (refusals audited), then the handler; rule violations become 4xx. */
export async function withPublisher(request: Request, handler: (p: Principal) => Promise<Response>) {
 const principal = await requireCapability(request, 'broadcast.publish');
 if (principal instanceof Response) return principal;
 try { return await handler(principal); }
 catch (e) { if (e instanceof BroadcastError) return fieldProblem(e.status, e.code, e.message, e.details); throw e; }
}
export async function publisherMutation(request: Request, handler: (p: Principal, body: unknown) => Promise<Response>) {
 const body = await jsonMutation(request);
 if (body instanceof Response) return body;
 return withPublisher(request, p => handler(p, body));
}
export { json };
