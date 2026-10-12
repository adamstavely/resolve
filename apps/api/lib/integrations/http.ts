import type { CapabilityId } from '@resolve/contracts';
import { admin, adminMutation, fieldProblem } from '../fleet-admin/http';
import type { Principal } from '../auth/session';
import { ConnectionError } from './connections';

const mapped = async (work: () => Promise<Response>) => {
 try { return await work(); }
 catch (e) { if (e instanceof ConnectionError) return fieldProblem(e.status, e.code, e.message, e.details); throw e; }
};

/** Integration admin route: capability first (audited when refused); connection rule violations become 4xx. */
export const integrationAdmin = (request: Request, capability: CapabilityId, handler: (p: Principal) => Promise<Response>) =>
 admin(request, capability, p => mapped(() => handler(p)));

export const integrationMutation = (request: Request, capability: CapabilityId, handler: (p: Principal, body: unknown) => Promise<Response>) =>
 adminMutation(request, capability, (p, body) => mapped(() => handler(p, body)));
