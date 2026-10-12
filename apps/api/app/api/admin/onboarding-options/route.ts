import { BUNDLES, CAPABILITIES } from '@resolve/contracts';
import { config } from '../../../../lib/config';
import { json } from '../../../../lib/http';
import { admin } from '../../../../lib/fleet-admin/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What the wizard offers: approved support domains and the role bundles that can be mapped. */
export async function GET(request: Request) {
 return admin(request, 'app.register', async () => json({
  supportDomains: config().SUPPORT_DOMAINS,
  bundles: Object.entries(BUNDLES).map(([id, caps]) => ({ id, summary: caps.filter(c => CAPABILITIES[c].kind !== 'read').map(c => CAPABILITIES[c].summary).slice(0, 3).join('; ') || 'Read-only access' })),
 }));
}
