import { BUNDLES, CAPABILITIES } from '@resolve/contracts';
import { pool } from '../../../../lib/db';
import { config } from '../../../../lib/config';
import { json } from '../../../../lib/http';
import { admin } from '../../../../lib/fleet-admin/http';
import { auditRead } from '../../../../lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Role bundles: their capabilities, which IdP groups grant them, and how many people hold them (by source). */
export async function GET(request: Request) {
 return admin(request, 'roles.manage', async principal => {
  const counts = (await pool().query('SELECT bundle, source, count(DISTINCT user_id)::int AS n FROM role_members GROUP BY bundle, source')).rows;
  const groups = config().RESOLVE_GROUP_BUNDLES;
  const bundles = Object.entries(BUNDLES).map(([id, caps]) => ({
   id, capabilities: caps.map(c => ({ id: c, summary: CAPABILITIES[c].summary, kind: CAPABILITIES[c].kind })),
   groups: Object.entries(groups).filter(([, b]) => (b as string[]).includes(id)).map(([g]) => g),
   claimHolders: counts.find(c => c.bundle === id && c.source === 'claim')?.n ?? 0,
   manualHolders: counts.find(c => c.bundle === id && c.source === 'manual')?.n ?? 0,
  }));
  await auditRead(principal, 'bundles');
  return json({ bundles });
 });
}
