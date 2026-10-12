/*
 * Live inbox stream load test (plan 09: "an explicit freshness target established by load testing").
 *
 * Signs in many Resolve sessions over HTTP against the mock IdP, opens one inbox stream (SSE) per session, then has
 * customers write in at a steady rate. For every stream it measures delivery latency (tenant commit -> event received)
 * and whether every message arrived, while sampling the API process, PostgreSQL and the mock tenants.
 *
 *   node --env-file=.env --import tsx tools/load/stream-load.mts --sessions 100 --rate 2 --seconds 60 [--stream-origin http://127.0.0.1:3100]
 *
 * Requires the development stack (mock IdP, mock tenants, API). Development only: it uses the mocks' /dev endpoints.
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') throw new Error('The load test drives development mocks only');

const { values: opt } = parseArgs({ options: {
 sessions: { type: 'string', default: '50' }, rate: { type: 'string', default: '2' }, seconds: { type: 'string', default: '60' },
 users: { type: 'string', default: 'mock|sam,mock|ada' }, apps: { type: 'string', default: 'payroll,hr' },
 origin: { type: 'string', default: process.env.RESOLVE_ORIGIN ?? 'http://127.0.0.1:4200' }, 'api-port': { type: 'string', default: '3100' },
 /** Open streams against the API directly (bypassing the console dev server's proxy). */
 'stream-origin': { type: 'string' },
 out: { type: 'string' },
} });
const SESSIONS = Number(opt.sessions), RATE = Number(opt.rate), SECONDS = Number(opt.seconds);
const ORIGIN = opt.origin!;
const STREAM_ORIGIN = opt['stream-origin'] ?? ORIGIN;
const USERS = opt.users!.split(',');
const APPS = opt.apps!.split(',');
const TENANTS: Record<string, string> = { payroll: 'http://127.0.0.1:3301', hr: 'http://127.0.0.1:3302' };

// ── HTTP sign-in with a cookie jar (all mocks share 127.0.0.1, as browsers treat cookies by host) ──

type Jar = Map<string, string>;
const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function store(jar: Jar, r: Response) {
 for (const c of r.headers.getSetCookie()) { const [pair] = c.split(';'); const i = pair.indexOf('='); const v = pair.slice(i + 1); if (v) jar.set(pair.slice(0, i), v); else jar.delete(pair.slice(0, i)); }
}
async function follow(jar: Jar, url: string, init: RequestInit = {}, sub?: string): Promise<Response> {
 for (let hop = 0; hop < 12; hop++) {
  const r = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), Cookie: cookieHeader(jar) } });
  store(jar, r);
  if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.get('location')!, url).href; init = {}; continue; }
  // The mock IdP's login page: choose the user and continue.
  if (r.status === 200 && new URL(url).port === '3200' && sub) {
   const html = await r.text();
   const form = new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1], m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"')]));
   form.set('sub', sub);
   init = { method: 'POST', body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
   url = new URL('/authorize', url).href; sub = undefined; continue;
  }
  return r;
 }
 throw new Error('Too many redirects');
}

/** One Resolve session for `sub`. The IdP session cookie is shared per user, so later sign-ins are SSO. */
async function signIn(idpJar: Jar, sub: string): Promise<string> {
 const jar: Jar = new Map(idpJar);
 await follow(jar, `${ORIGIN}/api/auth/login?returnTo=/`, {}, sub);
 for (const [k, v] of jar) if (k === 'mock_idp_session') idpJar.set(k, v);
 const session = jar.get('resolve_session');
 if (!session) throw new Error(`Sign-in failed for ${sub}`);
 return session;
}
async function connect(session: string, idpJar: Jar, app: string) {
 const jar: Jar = new Map([...idpJar, ['resolve_session', session]]);
 const r = await follow(jar, `${ORIGIN}/api/connect/${app}/start`);
 if (!r.ok) throw new Error(`Connecting ${app} failed: HTTP ${r.status}`);
}

// ── Streams ──

interface Stream { user: string; latencies: number[]; received: Map<string, number>; live: Set<string>; errors: number; reconnects: number; abort: AbortController }

async function openStream(session: string, user: string): Promise<Stream> {
 const s: Stream = { user, latencies: [], received: new Map(), live: new Set(), errors: 0, reconnects: 0, abort: new AbortController() };
 let lastId = '';
 const run = async () => {
  while (!s.abort.signal.aborted) {
   try {
    const r = await fetch(`${STREAM_ORIGIN}/api/inbox/stream`, { signal: s.abort.signal, headers: { Cookie: `resolve_session=${session}`, Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': lastId } : {}) } });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
     buf += decoder.decode(chunk, { stream: true });
     let i;
     while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const id = frame.match(/^id: (.*)$/m)?.[1]; if (id) lastId = id;
      const data = frame.match(/^data: (.*)$/m)?.[1]; if (!data) continue;
      const ev = JSON.parse(data);
      const now = Date.now();
      if (ev.type === 'monitor') for (const a of ev.apps) { if (a.state === 'live') s.live.add(a.appKey); else s.live.delete(a.appKey); }
      if (ev.type === 'change' && ev.kind === 'message') {
       const key = `${ev.appKey}/${ev.itemId}@${ev.at}`;
       if (!s.received.has(key)) { s.received.set(key, now); s.latencies.push(now - Date.parse(ev.at)); }
      }
     }
    }
   } catch (e) {
    if (s.abort.signal.aborted) return;
    s.errors++;
   }
   if (!s.abort.signal.aborted) { s.reconnects++; await new Promise(r => setTimeout(r, 500)); }
  }
 };
 void run();
 return s;
}

// ── Sampling ──

const pidOn = (port: string) => { try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).toString().trim().split('\n')[0]; } catch { return ''; } };
function proc(pid: string) {
 try { const [rss, cpu] = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', pid]).toString().trim().split(/\s+/).map(Number); return { rssMb: rss / 1024, cpu }; } catch { return { rssMb: NaN, cpu: NaN }; }
}
const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const tenantStats = async () => Object.fromEntries(await Promise.all(APPS.map(async a => [a, (await (await fetch(TENANTS[a] + '/dev/stats')).json()).toolCalls as number])));

async function main() {
 const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
 const apiPid = pidOn(opt['api-port']!);
 console.error(`Signing in ${SESSIONS} sessions for ${USERS.join(', ')}…`);
 const idpJars = new Map(USERS.map(u => [u, new Map() as Jar]));
 const sessions: { user: string; session: string }[] = [];
 for (let i = 0; i < SESSIONS; i++) { const user = USERS[i % USERS.length]; sessions.push({ user, session: await signIn(idpJars.get(user)!, user) }); }
 for (const user of USERS) for (const app of APPS) await connect(sessions.find(s => s.user === user)!.session, idpJars.get(user)!, app);

 const auditBefore = Number((await db.query('SELECT count(*) FROM audit_events')).rows[0].count);
 console.error('Opening streams…');
 const streams = await Promise.all(sessions.map(s => openStream(s.session, s.user)));
 const settle = Date.now();
 while (streams.some(s => APPS.some(a => !s.live.has(a)))) {
  if (Date.now() - settle > 60_000) throw new Error(`Streams not live after 60 s: ${streams.filter(s => APPS.some(a => !s.live.has(a))).length} pending`);
  await new Promise(r => setTimeout(r, 250));
 }
 const timeToLive = Date.now() - settle;
 console.error(`All ${streams.length} streams live after ${timeToLive} ms. Sending ${RATE}/s for ${SECONDS} s…`);

 const stats0 = await tenantStats();
 const dbStats = async () => (await db.query(`SELECT xact_commit + xact_rollback AS tx, tup_inserted + tup_updated + tup_deleted AS writes FROM pg_stat_database WHERE datname = current_database()`)).rows[0];
 const db0 = await dbStats();
 const samples: { rssMb: number; cpu: number; dbConnections: number }[] = [];
 const sampler = setInterval(async () => {
  const c = Number((await db.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()`)).rows[0].count);
  samples.push({ ...proc(apiPid), dbConnections: c });
 }, 1000);

 // Customers write in: each message is a new conversation on the support team (visible to every test user).
 const sent: { app: string; conversationId: string; at: number }[] = [];
 const start = Date.now();
 let n = 0;
 while (Date.now() - start < SECONDS * 1000) {
  const app = APPS[n % APPS.length];
  const t = Date.now();
  const r = await (await fetch(TENANTS[app] + '/dev/customer-message', { method: 'POST', body: JSON.stringify({ text: `Load ${n}`, team: 'team_support' }) })).json();
  sent.push({ app, conversationId: r.conversationId, at: t });
  n++;
  const next = start + (n * 1000) / RATE;
  await new Promise(res => setTimeout(res, Math.max(0, next - Date.now())));
 }
 await new Promise(r => setTimeout(r, 5000)); // drain
 clearInterval(sampler);
 const elapsed = (Date.now() - start) / 1000;
 const stats1 = await tenantStats();
 const db1 = await dbStats();
 for (const s of streams) s.abort.abort();
 // Closed streams must stop polling: after the longest long-poll (20 s) no tenant calls should remain.
 await new Promise(r => setTimeout(r, 2000));
 const closed0 = await tenantStats();
 await new Promise(r => setTimeout(r, 25_000));
 const closed1 = await tenantStats();
 const auditAfter = Number((await db.query('SELECT count(*) FROM audit_events')).rows[0].count);

 const all = streams.flatMap(s => s.latencies);
 const expectedPerStream = sent.length;
 const missing = streams.reduce((m, s) => m + Math.max(0, expectedPerStream - s.received.size), 0);
 const result = {
  at: new Date().toISOString(), apiMode: process.env.LOAD_API_MODE ?? 'unspecified', sessions: SESSIONS, users: USERS.length, apps: APPS, ratePerSecond: RATE, seconds: SECONDS,
  messagesSent: sent.length, deliveriesExpected: expectedPerStream * streams.length, deliveriesMissing: missing,
  timeToAllLiveMs: timeToLive,
  latencyMs: { p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), max: Math.max(...all) },
  within2s: all.filter(x => x <= 2000).length / (all.length || 1),
  streamErrors: streams.reduce((m, s) => m + s.errors, 0), reconnects: streams.reduce((m, s) => m + s.reconnects, 0),
  api: { peakRssMb: Math.max(...samples.map(s => s.rssMb)), meanCpu: samples.reduce((m, s) => m + s.cpu, 0) / (samples.length || 1), peakCpu: Math.max(...samples.map(s => s.cpu)) },
  db: { transactionsPerSecond: (Number(db1.tx) - Number(db0.tx)) / elapsed, rowWritesPerSecond: (Number(db1.writes) - Number(db0.writes)) / elapsed, peakConnections: Math.max(...samples.map(s => s.dbConnections)) },
  tenantToolCallsPerSecond: Object.fromEntries(APPS.map(a => [a, (stats1[a] - stats0[a]) / elapsed])),
  auditRowsWritten: auditAfter - auditBefore,
  /** Tenant calls 2-27 s after every stream closed; must be 0 (no orphaned polling with a person's grant). */
  tenantCallsAfterClose: APPS.reduce((m, a) => m + closed1[a] - closed0[a], 0),
 };
 console.log(JSON.stringify(result, null, 1));
 if (opt.out) await import('node:fs').then(fs => fs.writeFileSync(opt.out!, JSON.stringify(result, null, 1)));
 await db.end();
 process.exit(0);
}

await main();
