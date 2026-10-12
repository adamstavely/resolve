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
 /** 32-byte base64 key for local sealing; production uses a KMS-backed sealer instead. */
 RESOLVE_ENCRYPTION_KEY: z.string().refine(k => Buffer.from(k, 'base64').length === 32, 'RESOLVE_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
 /** Fleet registry projection (contract 1) and its service credential. */
 REGISTRY_URL: z.url(),
 REGISTRY_TOKEN: z.string().min(16),
 /** Directory API for authoritative user state (plan 02). */
 DIRECTORY_URL: z.url(),
 DIRECTORY_TOKEN: z.string().min(16),
 DIRECTORY_POLL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
 /** Privileged fleet worker (contract 4): allowlisted commands only, with a service credential; never a tenant DSN. */
 WORKER_URL: z.url(),
 WORKER_TOKEN: z.string().min(16),
 /** Approved support domains; onboarding accepts support hostnames only under these (owner decision 2026-10-12). */
 SUPPORT_DOMAINS: z.string().default('support.corp.internal').transform(v => v.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)),
 /** Approved Elastic hosts (plan 12 §4); `*.example.internal` allows subdomains. Empty: no Elastic connection can be saved. */
 ELASTIC_ALLOWED_HOSTS: z.string().default('').transform(v => v.split(',').map(h => h.trim().toLowerCase()).filter(Boolean)),
 /** Health poll interval per active app mapping (plan 12 §6, proposed 30 s); stale after two missed polls. */
 OBSERVABILITY_POLL_SECONDS: z.coerce.number().int().min(2).max(3600).default(30),
 /** E4 draft summaries: an internally hosted model endpoint. Unset means summaries are off (plan 12 §9). */
 SUMMARY_MODEL_URL: z.url().optional(),
 SUMMARY_MODEL_NAME: z.string().min(1).max(100).default('internal-summary'),
 RESOLVE_COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
 SESSION_ABSOLUTE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(12 * 60),
 SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),
}).superRefine((c, ctx) => {
 // Plain-HTTP identity providers are allowed only for the local mock, never in production.
 if (new URL(c.OIDC_ISSUER).protocol !== 'https:' && (process.env.NODE_ENV === 'production' || !isLoopback(c.OIDC_ISSUER)))
  ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER must use https outside local development' });
 for (const key of ['REGISTRY_URL', 'DIRECTORY_URL', 'WORKER_URL'] as const)
  if (new URL(c[key]).protocol !== 'https:' && (process.env.NODE_ENV === 'production' || !isLoopback(c[key])))
   ctx.addIssue({ code: 'custom', path: [key], message: `${key} must use https outside local development` });
 // The summary model must be internal: https, or a loopback mock outside production.
 if (c.SUMMARY_MODEL_URL && new URL(c.SUMMARY_MODEL_URL).protocol !== 'https:' && (process.env.NODE_ENV === 'production' || !isLoopback(c.SUMMARY_MODEL_URL)))
  ctx.addIssue({ code: 'custom', path: ['SUMMARY_MODEL_URL'], message: 'SUMMARY_MODEL_URL must use https outside local development' });
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
