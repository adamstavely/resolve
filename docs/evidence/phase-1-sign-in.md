# Phase 1 evidence — sign-in, sessions and capability enforcement

Status: 2026-10-12. Runs against the development mock IdP only. Plan 06 and plan 00's phase 1 exit criteria
require the real IdP for conformance and identity validation, so this is not yet phase 1 sign-off.

## Decisions

- The organization IdP will support OAuth 2.0/OIDC and SAML 2.0 (product not chosen). Resolve signs in with
  **OIDC authorization code + PKCE (S256)** through `openid-client` 6.8.8 (OpenID-certified).
- Until the IdP is chosen, `tools/mock-idp` provides discovery, JWKS, code + PKCE and RS256 ID tokens with a
  `groups` claim. It refuses to start in production, and Resolve refuses a plain-HTTP issuer unless it is loopback outside production.
- IdP groups map to bundles through `RESOLVE_GROUP_BUNDLES`; unmapped groups grant nothing. Admins
  (`fleet-admin`) hold registration, provisioning and activation.

## Flow

1. `GET /api/auth/login`: random state, nonce and PKCE verifier. Only hashes of state and of a browser-binding
   cookie (`resolve_login`, HttpOnly, path `/api/auth`, 10 minutes) are stored, in `login_attempts`.
2. `GET /api/auth/callback`: the attempt is deleted atomically (single use, bound to the browser, unexpired)
   *before* the code exchange. Then `openid-client` checks state, PKCE, nonce, issuer, audience and signature.
3. The user is found by **issuer + subject** under an advisory lock; email is display data only. Disabled users are denied.
   Claim-sourced bundles are replaced on each sign-in; manual grants are kept.
4. A new random session id is issued (only its SHA-256 is stored). The browser's previous session is revoked.
   Cookie `resolve_session`: HttpOnly, SameSite=Lax, Secure outside local development; 12 h absolute, 60 min idle.
5. Every request re-reads the session, checking revoked, absolute and idle limits and that the user is enabled. Capabilities are computed server-side.
6. `POST /api/auth/logout`: exact-Origin check, then revokes the server session. All sign-in, sign-out and denial outcomes are written to `audit_events`.

## Evidence

| Requirement | Test |
|---|---|
| Same issuer/subject → same user; same email, different subject → different user; other issuer → different user | `tests/database/auth.db.test.ts`, `tests/browser/auth.spec.ts` |
| Concurrent first sign-in creates one user | `auth.db.test.ts` |
| Login attempt single use, browser-bound, expiring; replayed or stolen callback fails | `auth.db.test.ts`, `auth.spec.ts` |
| Session revoked on sign-out (copied cookie fails), on re-sign-in, and on disable; idle/absolute limits | both |
| Observer/agent cannot read audit (403); unauthenticated gets 401; admin can | `auth.spec.ts` |
| No-group user gets no capabilities; unknown bundle names grant nothing | `auth.spec.ts`, `tests/auth-policy.unit.test.ts` |
| Open redirect, CRLF and protocol-relative return paths rejected | `auth-policy.unit.test.ts`, `auth.spec.ts` |
| Config fails closed (unknown bundle, bad JSON, non-loopback HTTP issuer, short secret) | `auth-policy.unit.test.ts` |
| Cross-origin sign-out refused | `auth.spec.ts` |
| Signed-in console passes axe (WCAG 2.2 A/AA tags) | `auth.spec.ts` |

## Not yet done (phase 1 scope)

- The real IdP: claim names, group format, issuer/subject stability, and the accessible sign-in process (plan 06).
- Directory ingestion and revocation within the 15-minute target (plan 02). Today a disabled flag is the only revocation path.
- Per-tenant OAuth grants and connection UI (contract 2: `checkCallbackBinding`/`checkIdentityMapping` exist, not wired).
- Admin UI for users, manual grants and group mapping. CSRF beyond the Origin check for future JSON mutations.
- Encrypting secrets at rest (KMS envelope) applies to tenant grants; login attempts now delete their verifier on use.
