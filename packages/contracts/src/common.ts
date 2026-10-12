import { z } from 'zod';

/** Resolve wire-contract major version. Additive changes keep it; breaking changes need overlap (plan 03). */
export const CONTRACT_VERSION = 1;

/** Stable application key. Lowercase, DNS-label safe; never renamed when an application is renamed (plan 07). */
export const appKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'App keys are lowercase letters, digits and hyphens');
export const uuidSchema = z.uuid();
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** Internal hostname: labels only, no scheme, port, path or credentials. */
export const hostnameSchema = z.string().max(253).regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/);
/** Redacted machine-readable failure code. Never free text that could carry tenant data or secrets. */
export const failureCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

export const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), requestId: uuidSchema }) });
export type ErrorResponse = z.infer<typeof errorSchema>;

/** Deterministic JSON (sorted object keys) for hashing payloads across processes. */
export function canonicalJson(value: unknown): string {
 if (value === null || typeof value !== 'object') return JSON.stringify(value);
 if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
 return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
  .map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
}

/** SHA-256 of canonical JSON, via WebCrypto so the same code runs in Node and the browser. */
export async function payloadHash(value: unknown): Promise<string> {
 const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
 return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
