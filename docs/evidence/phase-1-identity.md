# Phase 1 evidence — sign-in, connections and revocation

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

## Per-app connections (contract 2)

Mocks: `tools/mock-tenant` runs Payroll (3301) and HR (3302) as Quackback-like OAuth servers whose sign-in
federates to the mock IdP, plus a suspended Facilities app and the registry projection (3300).

1. `GET /api/apps` (`fleet.view`) reads the registry through the adapter (`lib/registry.ts`): strict schema,
   service token, 4 s timeout, 30 s cache. Non-https origins are refused outside loopback development.
2. `GET /api/connect/:app/start` (`connection.manage`) works only for active, routable apps. It requests scopes derived
   from the user's capabilities (observer: `read:chat` only), with PKCE and nonce. The state is bound to the Resolve session, user and app.
3. `GET /api/connect/callback`:
   - Consumes the attempt, then runs `checkCallbackBinding` (session, user, expiry).
   - Exchanges the code: state, PKCE, nonce, RFC 9207 `iss` (mix-up defence), audience and signature are checked.
   - Requires the tenant ID token's `idp_iss`/`idp_sub` to equal the signed-in Resolve identity (new fork gap **QB-ID-1**).
   - Rejects scope escalation and runs `checkIdentityMapping` against any existing link.
   - A tenant account may link to only one Resolve user.
4. Tokens and tenant client secrets are AES-256-GCM sealed. Associated data binds each one to its user, app and purpose.
   A database constraint keeps tokens only while the grant is `connected`.
5. Tokens are refreshed under a row lock, so concurrent requests refresh once. A refused or lost refresh response
   becomes `reconnect_required`; a refresh that never reached the tenant leaves the grant unchanged.
6. `GET /api/apps/:app/whoami` calls the tenant as the human. It is a stand-in for real tool calls.

## Directory revocation (plan 02)

`npm run dev:directory` (`apps/api/scripts/directory-sync.mts`) polls the directory, which defaults to every 60 s against
the 15-minute target. Each run and each observation (applied, stale, unchanged, unknown user, absent) is recorded.
- **Disabling a user:** revokes their sessions and every per-app grant in one transaction, audited as a system action.
- **Versions only move forward:** a stale or replayed observation cannot re-enable a user.
- **Re-enabling:** restores neither sessions nor grants.
- **Complete snapshots:** absence from a complete snapshot disables the user; a partial snapshot proves nothing.
- **Manual denial:** a manual (emergency) denial is independent of the directory and is never lifted by it.

## Phase 1 exit criteria (plan 00)

| Criterion | State |
|---|---|
| Two apps connect as the same mapped human | Met against mocks (`connections.spec.ts`: two tenants, two tenant accounts, one IdP identity) |
| Wrong user/app callbacks fail | Met (other user's session, consumed state, foreign `iss`, foreign IdP identity) |
| Observer requests read scopes only | Met (unit and browser) |
| Session and directory revocation tests pass | Met against the mock directory (database and browser) |
| No runtime internet egress | Not yet evidenced: needs the deployment network policy. All runtime calls go to configured internal URLs |
| Real IdP, real Quackback | Open. Needs the IdP product (plan 05, Q1) and fork work QB-ID-1, QB-REG-1 and QB-PROTO-1 |

## Additional evidence

| Requirement | Test |
|---|---|
| Sealing round trip, cross-row/purpose swap refused, tamper and wrong key detected | `tests/tenant-grants.unit.test.ts` |
| Refresh outcomes classified (refused / never sent / unknown) | `tenant-grants.unit.test.ts`, `grants-directory.db.test.ts` |
| Sealed storage only; tokens only while connected; one tenant account per user | `tests/database/grants-directory.db.test.ts` |
| Concurrent refresh happens once | `grants-directory.db.test.ts` |
| Directory: disable, stale replay, re-enable without restore, manual denial, absence | `grants-directory.db.test.ts`, `connections.spec.ts` |
| Suspended app cannot be connected or called | `connections.spec.ts` |

## Not yet done

- The real IdP: claim names, group format, issuer/subject stability, and the accessible sign-in process (plan 06).
- Directory: delta/SCIM semantics, group changes (bundles refresh only at sign-in), the optional lease, and alarms on stale runs.
- Desired-state propagation of denials into tenants (plan 02 versioned jobs). Today revocation is Resolve-side only.
- Revoking tokens at the tenant on disconnect or disable (the mock has no revocation endpoint). KMS-backed sealer for shared environments.
- Admin UI for users, manual grants, group mapping and tenant client registration (onboarding, plan 07).
- Local development puts every mock on 127.0.0.1, and cookies are not isolated by port. Real deployments use separate hostnames.
