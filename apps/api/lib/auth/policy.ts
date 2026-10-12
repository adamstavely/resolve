import { createHash, randomBytes } from 'node:crypto';
import { BUNDLES, capabilitiesFor, type BundleId, type CapabilityId } from '@resolve/contracts';

/** Pure authentication policy: no I/O, unit-tested in tests/auth-policy.unit.test.ts. */

export const SESSION_COOKIE = 'resolve_session';
export const LOGIN_COOKIE = 'resolve_login';
export const LOGIN_ATTEMPT_SECONDS = 600;

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only same-origin relative paths; anything else (absolute, protocol-relative, backslash tricks) goes home. */
export function safeReturnTo(raw: string | null | undefined): string {
 if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return '/';
 return raw.length > 512 ? '/' : raw;
}

/** Map IdP groups to bundles. Unknown groups grant nothing; non-string claims are ignored. */
export function bundlesForGroups(groups: unknown, mapping: Record<string, readonly BundleId[]>): BundleId[] {
 if (!Array.isArray(groups)) return [];
 const out = new Set<BundleId>();
 for (const g of groups) if (typeof g === 'string' && Object.hasOwn(mapping, g)) for (const b of mapping[g]) out.add(b);
 return [...out].sort();
}

/** Capabilities for stored bundle names; a name that is not a known bundle grants nothing. */
export function capabilityList(bundles: readonly string[]): CapabilityId[] {
 return [...capabilitiesFor(bundles.filter((b): b is BundleId => Object.hasOwn(BUNDLES, b)))].sort();
}

export interface CookieOptions { secure: boolean; maxAgeSeconds?: number; path?: string }

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
 const parts = [`${name}=${value}`, `Path=${o.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax'];
 if (o.secure) parts.push('Secure');
 if (o.maxAgeSeconds !== undefined) parts.push(`Max-Age=${o.maxAgeSeconds}`);
 return parts.join('; ');
}

export const clearCookie = (name: string, o: CookieOptions) => serializeCookie(name, '', { ...o, maxAgeSeconds: 0 });

export function readCookie(header: string | null, name: string): string | undefined {
 for (const part of (header ?? '').split(';')) {
  const i = part.indexOf('=');
  if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || undefined;
 }
 return undefined;
}

/** CSRF defence for state-changing requests: browsers always send Origin on cross-origin POSTs. */
export function sameOrigin(originHeader: string | null, expected: string): boolean {
 return originHeader === expected;
}
