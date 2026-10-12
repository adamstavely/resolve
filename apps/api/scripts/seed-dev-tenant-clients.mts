/*
 * Development only: register Resolve's OAuth client for each mock tenant (tools/mock-tenant/tenants.json),
 * sealing the secrets. In real environments client registration is part of onboarding (plan 07).
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { config } from '../lib/config';
import { localSealer } from '../lib/crypto';
import { saveTenantClient } from '../lib/tenants/grants';

if (process.env.NODE_ENV === 'production') throw new Error('Development seed only');
const c = config();
const fleet = JSON.parse(readFileSync(new URL('../../../tools/mock-tenant/tenants.json', import.meta.url), 'utf8')) as { tenants: { appKey: string; resolveClient: { id: string; secret: string } }[] };
const db = new Pool({ connectionString: c.DATABASE_URL, max: 1 });
for (const t of fleet.tenants) await saveTenantClient(db, localSealer(c.RESOLVE_ENCRYPTION_KEY), t.appKey, { clientId: t.resolveClient.id, clientSecret: t.resolveClient.secret });
await db.end();
console.log(`Registered Resolve OAuth clients for ${fleet.tenants.map(t => t.appKey).join(', ')}`);
