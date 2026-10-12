import * as client from 'openid-client';
import { config, isLoopback } from '../config';

let discovered: Promise<client.Configuration> | undefined;

/** Discover the IdP once per process; a failed discovery is retried on the next request. */
export function oidc(): Promise<client.Configuration> {
 const c = config();
 discovered ??= client.discovery(new URL(c.OIDC_ISSUER), c.OIDC_CLIENT_ID, c.OIDC_CLIENT_SECRET, undefined,
  // Plain HTTP only for a loopback mock outside production (enforced again in config()).
  isLoopback(c.OIDC_ISSUER) && process.env.NODE_ENV !== 'production' ? { execute: [client.allowInsecureRequests] } : undefined,
 ).catch(e => { discovered = undefined; throw e; });
 return discovered;
}

export const redirectUri = () => `${config().RESOLVE_ORIGIN}/api/auth/callback`;
export const SCOPES = 'openid profile email';
