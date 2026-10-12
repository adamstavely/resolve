/*
 * Runs the inbox stream route handler in a bare Node HTTP server (no Next.js), so the load test can measure the
 * handler's own memory and CPU without the development server's request tracking. Development only.
 *
 *   node --env-file=.env --import tsx tools/load/stream-harness.mts [--port 3199]
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { GET } from '../../apps/api/app/api/inbox/stream/route';

if (process.env.NODE_ENV === 'production') throw new Error('Development only');
const at = process.argv.indexOf('--port');
const port = at > 0 ? Number(process.argv[at + 1]) : 3199;

createServer(async (req, res) => {
 if (!req.url?.startsWith('/api/inbox/stream')) { res.writeHead(404).end(); return; }
 const abort = new AbortController();
 let readable: Readable | null = null;
 // Like a real server: when the client goes away, abort the request and cancel the response body.
 res.on('close', () => { abort.abort(); readable?.destroy(); });
 const headers = new Headers();
 for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
 const response = await GET(new NextRequest(`http://127.0.0.1:${port}${req.url}`, { headers, signal: abort.signal }));
 res.writeHead(response.status, Object.fromEntries(response.headers));
 if (!response.body) { res.end(); return; }
 if (res.destroyed) { void response.body.cancel().catch(() => {}); return; }
 readable = Readable.fromWeb(response.body as never);
 readable.on('error', () => res.destroy()).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Stream harness at http://127.0.0.1:${port}`));
