import { isServable, whoamiResponseSchema } from '@resolve/contracts';
import { pool } from '../../../../../lib/db';
import { apiError, requireCapability } from '../../../../../lib/auth/session';
import { registryApp } from '../../../../../lib/registry';
import { sealer } from '../../../../../lib/sealer';
import { accessToken, setGrantState } from '../../../../../lib/tenants/grants';
import { refresher } from '../../../../../lib/tenants/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const unavailable = (code: string, message: string, status = 409) =>
 Response.json({ error: { code, message, requestId: crypto.randomUUID() } }, { status, headers: { 'Cache-Control': 'no-store' } });

/** Ask the tenant who the caller is, using the caller's own grant: proves per-human attribution end to end. */
export async function GET(request: Request, ctx: { params: Promise<{ appKey: string }> }) {
 const principal = await requireCapability(request, 'connection.manage');
 if (principal instanceof Response) return principal;
 const { appKey } = await ctx.params;
 const app = await registryApp(appKey).catch(() => undefined);
 if (!app) return apiError(400, 'UNKNOWN_APP', 'This application is not registered.');
 if (!isServable(app)) return unavailable('APP_UNAVAILABLE', 'This application is not available right now.', 503);
 const token = await accessToken(pool(), sealer(), principal.userId, appKey, refresher(app));
 if (token.status !== 'ok') return token.status === 'reconnect_required' ? unavailable('RECONNECT_REQUIRED', 'Reconnect to this application to continue.')
  : token.status === 'not_connected' ? unavailable('NOT_CONNECTED', 'Connect to this application first.')
  : unavailable('APP_UNAVAILABLE', 'This application could not be reached.', 503);
 let r: Response;
 try {
  r = await fetch(`${app.supportOrigin}/api/mcp/whoami`, { headers: { Authorization: `Bearer ${token.accessToken}` }, signal: AbortSignal.timeout(4000) });
 } catch { return unavailable('APP_UNAVAILABLE', 'This application could not be reached.', 503); }
 if (r.status === 401) {
  await setGrantState(pool(), principal.userId, appKey, 'reconnect_required', 'tenant_rejected_token');
  return unavailable('RECONNECT_REQUIRED', 'Reconnect to this application to continue.');
 }
 const body = whoamiResponseSchema.safeParse(await r.json().catch(() => null));
 if (!r.ok || !body.success || body.data.app !== appKey) return unavailable('TENANT_ERROR', 'The application returned an unexpected response.', 502);
 return Response.json(body.data, { headers: { 'Cache-Control': 'no-store' } });
}
