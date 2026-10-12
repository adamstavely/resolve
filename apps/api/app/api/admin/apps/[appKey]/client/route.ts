import { appKeySchema, tenantClientRegistrationSchema } from '@resolve/contracts';
import { pool } from '../../../../../../lib/db';
import { json, jsonMutation, problem } from '../../../../../../lib/http';
import { audit } from '../../../../../../lib/auth/repository';
import { requireCapability } from '../../../../../../lib/auth/session';
import { registryApp } from '../../../../../../lib/registry';
import { sealer } from '../../../../../../lib/sealer';
import { saveTenantClient } from '../../../../../../lib/tenants/grants';
import { forgetTenantOidc } from '../../../../../../lib/tenants/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Register (or rotate) Resolve's confidential OAuth client for a registered app. The secret is sealed on receipt
 * and never returned or logged. Onboarding (plan 07) replaces this with worker-generated credentials.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ appKey: string }> }) {
 const body = await jsonMutation(request);
 if (body instanceof Response) return body;
 const principal = await requireCapability(request, 'app.register');
 if (principal instanceof Response) return principal;
 const { appKey } = await ctx.params;
 if (!appKeySchema.safeParse(appKey).success || !(await registryApp(appKey).catch(() => undefined)))
  return problem(404, 'UNKNOWN_APP', 'This application is not in the registry.');
 const reg = tenantClientRegistrationSchema.safeParse(body);
 if (!reg.success) return problem(400, 'INVALID_REQUEST', reg.error.issues[0]?.message ?? 'Invalid request.');
 await saveTenantClient(pool(), sealer(), appKey, reg.data);
 forgetTenantOidc(appKey);
 await audit(pool(), { actorUserId: principal.userId, operation: 'app.client_register', outcome: 'succeeded', summary: { app: appKey, clientId: reg.data.clientId } });
 return json({ appKey, clientId: reg.data.clientId });
}
