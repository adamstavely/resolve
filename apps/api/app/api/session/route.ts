import { BUNDLES } from '@resolve/contracts';
import { currentPrincipal } from '../../../lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Who is signed in and what they may do. Capabilities are informational; every endpoint re-checks them. */
export async function GET(request: Request) {
 const p = await currentPrincipal(request);
 const body = p
  ? { authenticated: true, user: { id: p.userId, displayName: p.displayName, email: p.email }, bundles: p.bundles.filter(b => Object.hasOwn(BUNDLES, b)), capabilities: p.capabilities }
  : { authenticated: false };
 return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
