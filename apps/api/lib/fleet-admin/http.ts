import type { CapabilityId } from '@resolve/contracts';
import { json, jsonMutation } from '../http';
import { requireCapability, type Principal } from '../auth/session';
import { OnboardingError } from './onboarding';

/** Problem response that can name the form field at fault (for focus management in the wizard). */
export const fieldProblem = (status: number, code: string, message: string, details: Record<string, string> = {}) =>
 json({ error: { code, message, requestId: crypto.randomUUID(), ...details } }, status);

/** Admin route: capability first (audited when refused), then the handler; onboarding rule violations become 4xx. */
export async function admin(request: Request, capability: CapabilityId, handler: (principal: Principal) => Promise<Response>) {
 const principal = await requireCapability(request, capability);
 if (principal instanceof Response) return principal;
 try { return await handler(principal); }
 catch (e) { if (e instanceof OnboardingError) return fieldProblem(e.status, e.code, e.message, e.details); throw e; }
}

/** JSON mutation (same-origin) on an admin route. */
export async function adminMutation(request: Request, capability: CapabilityId, handler: (principal: Principal, body: unknown) => Promise<Response>) {
 const body = await jsonMutation(request);
 if (body instanceof Response) return body;
 return admin(request, capability, p => handler(p, body));
}
