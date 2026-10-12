import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/*
 * Elastic HTTP client (plan 12 §4). Every request goes to an approved host over HTTPS (plain HTTP only for a loopback
 * mock outside production), to an address checked before connecting and pinned for the connection (no DNS
 * rebinding), with certificate verification always on, bounded time and size, no redirects followed, and Elastic's
 * 429 Retry-After honoured by the caller. Response bodies never appear in errors.
 */

export interface ElasticTarget {
 elasticsearchUrl: string;
 kibanaUrl: string;
 spaceId: string;
 /** Elastic API key credential (base64 `id:key`). */
 apiKey: string;
 caPem: string | null;
}

export interface ClientPolicy {
 /** Approved hostnames; `*.example.internal` allows subdomains. Empty allows nothing. */
 allowedHosts: readonly string[];
 /** Outside production a loopback mock over plain HTTP is allowed. */
 production: boolean;
 timeoutMs?: number;
 maxBytes?: number;
}

export type ElasticErrorCode =
 | 'HOST_NOT_ALLOWED' | 'INSECURE_URL' | 'ADDRESS_NOT_ALLOWED' | 'DNS_FAILED' | 'UNREACHABLE' | 'TIMEOUT' | 'TLS_FAILED'
 | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'REDIRECT_REFUSED' | 'RESPONSE_TOO_LARGE' | 'BAD_RESPONSE' | 'UPSTREAM_ERROR';

export class ElasticError extends Error {
 constructor(readonly code: ElasticErrorCode, readonly status: number | null = null, readonly retryAfterSeconds: number | null = null, readonly elasticType: string | null = null) {
  super(code);
 }
}

const BLOCKED_V4: [number, number][] = [
 [0x00000000, 8],  // 0.0.0.0/8
 [0xa9fe0000, 16], // 169.254.0.0/16 link-local, including cloud metadata
 [0xe0000000, 4],  // multicast
 [0xf0000000, 4],  // reserved, broadcast
];
const LOOPBACK_V4: [number, number] = [0x7f000000, 8];

function v4ToInt(ip: string) { return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0; }
const inRange = (ip: number, [base, bits]: [number, number]) => bits === 0 || (ip >>> (32 - bits)) === (base >>> (32 - bits));

/** Addresses Resolve may connect to: private-network targets, never link-local/metadata, multicast or unspecified. */
export function addressAllowed(address: string, allowLoopback: boolean): boolean {
 const family = isIP(address);
 if (family === 4) {
  const n = v4ToInt(address);
  if (inRange(n, LOOPBACK_V4)) return allowLoopback;
  return !BLOCKED_V4.some(r => inRange(n, r));
 }
 if (family === 6) {
  const a = address.toLowerCase();
  if (a === '::1') return allowLoopback;
  if (a === '::' || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') || a.startsWith('ff')) return false;
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? addressAllowed(mapped[1], allowLoopback) : true;
 }
 return false;
}

export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
 const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
 return allowed.some(a => {
  const rule = a.trim().toLowerCase();
  if (!rule) return false;
  if (rule.startsWith('*.')) return h.endsWith(rule.slice(1)) && h.length > rule.length - 1;
  return h === rule;
 });
}

const isLoopbackHost = (h: string) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(h.toLowerCase());

/** Validate a configured origin against policy (used when saving a connection, and on every request). */
export function checkOrigin(origin: string, policy: ClientPolicy): URL {
 let url: URL;
 try { url = new URL(origin); } catch { throw new ElasticError('INSECURE_URL'); }
 if (url.username || url.password) throw new ElasticError('INSECURE_URL');
 if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !policy.production && isLoopbackHost(url.hostname))) throw new ElasticError('INSECURE_URL');
 if (!hostAllowed(url.hostname, policy.allowedHosts)) throw new ElasticError('HOST_NOT_ALLOWED');
 return url;
}

export interface ElasticResponse<T = unknown> { status: number; body: T }

export class ElasticClient {
 constructor(private readonly target: ElasticTarget, private readonly policy: ClientPolicy, private readonly resolve = dnsLookup) {}

 get spaceId() { return this.target.spaceId; }

 es<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, query?: Record<string, string | string[]>) {
  return this.send<T>(this.target.elasticsearchUrl, method, path, body, query, false);
 }

 /** Kibana API in the connection's space. Reads only; Resolve does not write to Elastic (owner decision 2026-10-12). */
 kibana<T = unknown>(path: string, query?: Record<string, string | string[]>) {
  const spaced = this.target.spaceId === 'default' ? path : `/s/${encodeURIComponent(this.target.spaceId)}${path}`;
  return this.send<T>(this.target.kibanaUrl, 'GET', spaced, undefined, query, true);
 }

 /** Unspaced Kibana route (status/version). */
 kibanaRoot<T = unknown>(path: string) { return this.send<T>(this.target.kibanaUrl, 'GET', path, undefined, undefined, true); }

 private async send<T>(origin: string, method: string, path: string, body: unknown, query: Record<string, string | string[]> | undefined, kibana: boolean): Promise<ElasticResponse<T>> {
  const base = checkOrigin(origin, this.policy);
  if (!path.startsWith('/') || path.includes('..')) throw new ElasticError('BAD_RESPONSE');
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(query ?? {})) for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
  const allowLoopback = !this.policy.production;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let address: string; let family: number;
  if (isIP(host)) { address = host; family = isIP(host); }
  else {
   try { ({ address, family } = await this.resolve(host, { verbatim: true })); } catch { throw new ElasticError('DNS_FAILED'); }
  }
  if (!addressAllowed(address, allowLoopback)) throw new ElasticError('ADDRESS_NOT_ALLOWED');

  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `ApiKey ${this.target.apiKey}` };
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(payload.length); }
  if (kibana) headers['elastic-api-version'] = '2023-10-31';
  const timeoutMs = this.policy.timeoutMs ?? 10_000;
  const maxBytes = this.policy.maxBytes ?? 4 * 1024 * 1024;
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;

  const res = await new Promise<IncomingMessage>((resolve, reject) => {
   const req = requester(url, {
    method, headers, timeout: timeoutMs,
    // Connect to the checked address only; TLS still verifies the certificate against the hostname.
    // (Node asks for all addresses when autoSelectFamily is on.)
    lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => o?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
    ...(url.protocol === 'https:' ? { ca: this.target.caPem ?? undefined, rejectUnauthorized: true, servername: isIP(host) ? undefined : host } : {}),
   }, resolve);
   req.on('timeout', () => req.destroy(new ElasticError('TIMEOUT')));
   req.on('error', e => reject(e instanceof ElasticError ? e : tlsOrNetwork(e)));
   req.end(payload);
  });

  const chunks: Buffer[] = []; let size = 0;
  try {
   for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) { res.destroy(); throw new ElasticError('RESPONSE_TOO_LARGE', res.statusCode ?? null); }
    chunks.push(chunk as Buffer);
   }
  } catch (e) { throw e instanceof ElasticError ? e : new ElasticError('UNREACHABLE'); }
  const status = res.statusCode ?? 0;
  let parsed: unknown = null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text) { try { parsed = JSON.parse(text); } catch { if (status < 300) throw new ElasticError('BAD_RESPONSE', status); } }
  if (status >= 300 && status < 400) throw new ElasticError('REDIRECT_REFUSED', status);
  if (status === 401) throw new ElasticError('UNAUTHENTICATED', status);
  if (status === 403) throw new ElasticError('FORBIDDEN', status, null, errorType(parsed));
  if (status === 404) throw new ElasticError('NOT_FOUND', status, null, errorType(parsed));
  if (status === 429) {
   const retry = Number(res.headers['retry-after']);
   throw new ElasticError('RATE_LIMITED', status, Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : 30);
  }
  if (status >= 400) throw new ElasticError('UPSTREAM_ERROR', status, null, errorType(parsed));
  return { status, body: parsed as T };
 }
}

/** Elastic's error type (e.g. index_not_found_exception, security_exception); a code, never the message. */
function errorType(body: unknown): string | null {
 const t = (body as { error?: { type?: unknown } } | null)?.error?.type;
 return typeof t === 'string' && /^[a-z_]{1,80}$/.test(t) ? t : null;
}

function tlsOrNetwork(e: unknown): ElasticError {
 const code = (e as { code?: string }).code ?? '';
 if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(code)) return new ElasticError('TLS_FAILED');
 return new ElasticError('UNREACHABLE');
}
