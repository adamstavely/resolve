import { z } from 'zod';
import { BUNDLES, type BundleId } from '@resolve/contracts';

const bundleIds = Object.keys(BUNDLES) as [BundleId, ...BundleId[]];

const schema = z.object({
 DATABASE_URL: z.string().min(1),
 /** Public origin of the console and API (one origin, plan 06). Used for redirects and Origin checks. */
 RESOLVE_ORIGIN: z.url().transform(u => new URL(u).origin),
 OIDC_ISSUER: z.url(),
 OIDC_CLIENT_ID: z.string().min(1),
 OIDC_CLIENT_SECRET: z.string().min(16),
 /** IdP group → Resolve bundles. Unlisted groups grant nothing (fail closed). */
 RESOLVE_GROUP_BUNDLES: z.string().transform((raw, ctx) => {
  try { return JSON.parse(raw) as unknown; } catch { ctx.addIssue({ code: 'custom', message: 'RESOLVE_GROUP_BUNDLES must be JSON' }); return z.NEVER; }
 }).pipe(z.record(z.string().min(1), z.array(z.enum(bundleIds)))),
 RESOLVE_COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
 SESSION_ABSOLUTE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(12 * 60),
 SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),
}).superRefine((c, ctx) => {
 // Plain-HTTP identity providers are allowed only for the local mock, never in production.
 if (new URL(c.OIDC_ISSUER).protocol !== 'https:' && (process.env.NODE_ENV === 'production' || !isLoopback(c.OIDC_ISSUER)))
  ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER must use https outside local development' });
 if (process.env.NODE_ENV === 'production' && !c.RESOLVE_COOKIE_SECURE)
  ctx.addIssue({ code: 'custom', path: ['RESOLVE_COOKIE_SECURE'], message: 'Secure cookies are required in production' });
});

export function isLoopback(url: string) {
 return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
}

export type Config = z.infer<typeof schema>;
let cached: Config | undefined;

/** Validated configuration. Throws (fails closed) when required settings are missing or unsafe. */
export function config(env: Record<string, string | undefined> = process.env): Config {
 if (env !== process.env) return schema.parse(env);
 return (cached ??= schema.parse(env));
}
