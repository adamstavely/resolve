/*
 * Egress check (plan 14, E5). Lists every endpoint the Resolve server is configured to call, resolves each host, and
 * fails if any resolves to a public address. Sources: environment (IdP, registry, directory, worker, summary model),
 * the registry's tenant origins, and stored Elastic connections. Kibana deep links are reported separately: browsers
 * follow them, Resolve does not. Run in each environment (and in staging during qualification):
 *
 *   npm run qualify:egress
 */
import { lookup } from 'node:dns/promises';
import { Pool } from 'pg';
import { classify, verdict } from './egress.mjs';

interface Target { source: string; url: string }
const targets: Target[] = [];
const add = (source: string, url: string | undefined | null) => { if (url) targets.push({ source, url }); };
for (const k of ['OIDC_ISSUER', 'REGISTRY_URL', 'DIRECTORY_URL', 'WORKER_URL', 'SUMMARY_MODEL_URL', 'DATABASE_URL']) add(`env ${k}`, process.env[k]);

try {
 const r = await fetch(process.env.REGISTRY_URL!, { headers: { Authorization: `Bearer ${process.env.REGISTRY_TOKEN}` } });
 const reg = await r.json() as { apps: { appKey: string; supportOrigin: string }[] };
 for (const a of reg.apps) add(`registry ${a.appKey}`, a.supportOrigin);
} catch { targets.push({ source: 'registry', url: 'unreachable://registry' }); }

const links: Target[] = [];
if (process.env.DATABASE_URL) {
 const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
 try {
  for (const c of (await db.query(`SELECT name, settings FROM integration_connections WHERE NOT kill_switch`)).rows)
   { add(`elastic ${c.name} (Elasticsearch)`, c.settings.elasticsearchUrl); add(`elastic ${c.name} (Kibana)`, c.settings.kibanaUrl); }
  for (const m of (await db.query(`SELECT app_key, mapping->>'deepLinkBase' AS base FROM elastic_app_mappings WHERE mapping->>'deepLinkBase' IS NOT NULL`)).rows)
   links.push({ source: `deep link ${m.app_key} (browser only)`, url: m.base });
 } finally { await db.end(); }
}

const seen = new Map<string, Awaited<ReturnType<typeof check>>>();
async function check(host: string) {
 try { const addrs = await lookup(host, { all: true, verbatim: true }); return { addresses: addrs.map(a => a.address), v: verdict(addrs.map(a => classify(a.address))) }; }
 catch { return { addresses: [] as string[], v: 'unresolved' as const }; }
}
let failed = 0;
const rows: string[] = [];
for (const t of [...targets, ...links]) {
 let host: string;
 try { host = new URL(t.url).hostname.replace(/^\[|\]$/g, ''); } catch { rows.push(`| ${t.source} | (invalid URL) | - | unresolved |`); failed++; continue; }
 if (!seen.has(host)) seen.set(host, await check(host));
 const r = seen.get(host)!;
 const browserOnly = t.source.includes('browser only');
 if (r.v !== 'ok' && !browserOnly) failed++;
 rows.push(`| ${t.source} | ${host} | ${r.addresses.join(', ') || '-'} | ${r.v}${browserOnly ? ' (not called by Resolve)' : ''} |`);
}
console.log('| Endpoint | Host | Resolves to | Result |\n|---|---|---|---|\n' + rows.join('\n'));
console.log(failed ? `\n${failed} server endpoint(s) are public or unresolved.` : '\nEvery server endpoint resolves to loopback or private addresses.');
process.exit(failed ? 1 : 0);
