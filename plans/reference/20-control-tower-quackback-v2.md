# Fleet Control Tower (separate app) + Provisioner — Design Plan v2

> **Status:** v2 (round-2 + staff-review + intranet + second-pass + third-review revision) — supersedes `plans/v1/multi-tenant-control-tower-plan.md`. Planning only.
> **Depends on:** Foundations (F-1 fork migration lineage, F-3 fork MCP registration, F-7 catalogue fence,
> `fork_settings`, **F-12 SSRF allow-list — hard prerequisite for any app SSO against the intranet IdP**);
> `04-intranet-deployment.md` (baseline §3, blockers E-1…E-3); `10-rbac-persona-extensions.md` Phase 1a (D3: custom roles enforced on MCP, argument-aware
> MCP permission map), its persona templates and its grant-reconcile primitives (plan 10 §reconcile);
> `60-announcements-banner.md` (`list_announcements` gated by `announcement.view`, write tools gated by
> `announcement.manage`) for Phase 6; `50-prioritization-scoring.md` (batch MCP tool `list_post_prioritization`)
> for Phase 7; `30-tiered-support.md` (tier teams + tier-membership service) for Tier bundles.
> **Decisions applied:** D1, D2, D3, D4, **D-C1** (separate app), **D-C2** (human-attributed actions via app
> MCP + per-user OAuth), **D-C3** (one shared Aurora cluster, DB + role per app), **D-C4** (root key in AWS
> Secrets Manager, tower never holds it), 🟡 **D-C5** (seed role mapping), **D-C6** (wildcard subdomains —
> on the intranet: internal DNS + an internally trusted certificate, O-14), **D-C7** (OIDC or SAML IdP, on the
> intranet), **D-C8** (fleet-level backups), **D-C9** (configurable role bundles), **D-C10** (one S3 bucket,
> per-app prefix), **D-C11** (per-app inbound email), **D-C12** (no consent screens, silent "connect all"),
> **D-N8** (Fleet Agents publish announcements), **D-E1…D-E6** (intranet only, no internet egress, public +
> anonymous-off + SSO-only portals, all users employees; D-E3 supersedes D-N5), **D-C15** (tower owns the whole app role set of managed people), **D-C16** (SCIM/directory
> sync; disable = tenant-level denial on every auth path). Build position: last (README
> build order); Phase 8 (inbound email) may run in parallel once Phase 2 is done.

## Round-2 changes

| Change                                                                                                                                                                                                                  | Driven by   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Tower login supports **OIDC and SAML** (Better Auth SSO plugin in the tower). Apps get SAML through an OIDC broker, because upstream `apps/web` is OIDC-only (verified, §4.5.1). Group/claim → tower role is a table.     | D-C7        |
| Fixed `observer/agent/owner` enum replaced by **configurable role bundles**: `tower_roles` (capabilities + tenant `template_key`) + `tower_role_members` + `tower_claim_role_mappings`. `sync-admins` → `sync-members`, multi-role. | D-C9, D-R4  |
| **Consent screens removed:** the provisioner sets `skip_consent` on the tower's client; new "connect all apps" silent SSO chain (§4.5.3) with failure handling. Old O-5/O-6 removed.                                  | D-C12       |
| One shared Aurora cluster (control DB in it too); "or separate instance" option dropped.                                                                                                                                | D-C3        |
| Backups: fleet cluster only (snapshots + PITR). Per-app backup/restore removed.                                                                                                                                         | D-C8        |
| Storage: one fleet S3 bucket, per-app prefix `w/<settings.id>/` applied by upstream; no per-app bucket credentials.                                                                                                     | D-C10       |
| **New §4.11 + Phase 8: per-app inbound email** (fork seam IE-1 + an SES edge — the SES edge is replaced by the intranet IMAP router, see Intranet changes). Replaces the "inbound email off" caveat. Permanently fork-only. | D-C11, D1   |
| Announcements: Fleet Agent seed bundle may publish (was owner-only). Tool names aligned with 60 (`list_/upsert_/archive_announcement`).                                                                                 | D-N8        |
| MCP registration line is now shared seam F-3 (not counted here). Old S-2 renamed to C-1 (matches `SEAMS.md`).                                                                                                          | 02 §10      |
| Open items reduced to D-C5 plus two new items. V-1 (RDS Proxy pinning) and V-4 (token lifetimes) stay as Phase 0 validations. O-4 closed by 02 §3.3 / X-R1; O-7 closed by X-R6.                                          | 01 Still open |

## Staff-review changes

| Finding ID | Change | Where in plan |
| --- | --- | --- |
| F1 (1) | Production artifact defined: fork-owned `apps/web/Dockerfile.fork` layers `/app/drizzle-fork` + bundled `/app/fork-provision.mjs` + `FORK_MIGRATIONS_FOLDER=/app/drizzle-fork` onto the upstream-built image (no Dockerfile seam). Fork journal is statically imported (inlined by bundling) and the folder comes from the env var, mirroring `MIGRATIONS_FOLDER` (`packages/db/src/schema-version.ts:48`). The provisioner refuses to start if the folder's journal ≠ the inlined journal. CI image-content gate. | §4.4.1, §8 Phase 2/9 |
| F1 (2) (precondition superseded by **R2-1**, resume path by **R2-2**) | `fork-migrate` no longer applies only fork SQL: per workspace it runs `runMigrations(direct)` (upstream no-op, fork lineage via F-1, `seedSystemData` → fork keys, preset bundles incl. Manager exclusions) + plan 10 §reconcile template reconcile, but only when the upstream ledger is already at the fleet target (never bypasses fleet-migrator cohorts). Records `cp_fork_schema_state`. | §4.4.2 |
| F1 (3) | Fork schema **floor**: shared seam **F-11** in `fleet/schema-floor.ts` checks `drizzle.__fork_migrations` against `FORK_MIN_SCHEMA_VERSION` and `fork_settings.fork.catalogue_version` against `FORK_MIN_CATALOGUE_VERSION`; refusal reuses the upstream 503 path. Suspended tenants are caught up by `resume` before hostnames are republished (fail closed). Deploy steps + four mandatory rehearsals. | §4.4.3–4.4.5, §7, §9 |
| C1 (access profile superseded by D-E3 — see Intranet changes; fail-closed publish-last kept) | Provisioning writes an explicit **private access profile** (portal `visibility:'private'`, `allowAnonymous:false`, portal + team `openSignup:false`, configured domain/widget/segment rules) instead of `DEFAULT_PORTAL_CONFIG` (public, `settings.types.ts:370-381`). The previous "`authConfig` without `openSignup`" was wrong: absent means `true` (`settings.types.ts:172-196`). Hostnames are published **last**, after in-scope checks; HTTP negative probes then run and a failure unpublishes. Resume re-verifies. | §4.3 steps 4–8, §4.3.1 |
| C2 (ownership model superseded by **R2-3**/D-C15: whole role set, one writer, `fork_tower_assignments` dropped) | Tower-owned grant **provenance** in the tenant DB (`fork_tower_principals`, `fork_tower_assignments`), tower rows written with the app's tower-sync service principal as grantor; removals driven by provenance, not by "template currently named by a tower role". Per-app team mappings (`tower_role_app_teams`). Atomic per-principal reconcile (legacy role, preset rows, workspace-wide + team grants, provenance) via plan 10 §reconcile; zero-role ⇒ legacy `user` (never a `member` with zero workspace-wide rows, which falls back to Manager: `policy/permissions.ts:58-75`, `principal.factory.ts:357-398`). Deletion/retarget/demotion and local-vs-tower ownership defined. | §4.3.2, §5.2, §5.3, §9 |
| C3 (revocation superseded by **R2-4**/D-C16) | Explicit identity chain (tower user ↔ IdP/broker subject ↔ tenant `user.id` (= MCP token `sub`, `mcp/handler.ts:98-99,122`) ↔ tenant principal), stored in `tower_user_idp_links` + `tower_user_app_identities`; connect-chain check compares `sub`/`principalId`, not email; stray email-linked accounts removed by sync. Portfolio uses `list_post_prioritization`; Observer uses `list_announcements` (`announcement.view`, `read:feedback`) — `announcements.view` no longer maps to `write:feedback`; broadcast outcomes are `succeeded`/`failed`/`uncertain`, uncertain reconciled by `broadcastId`. Sync authority split (provisioner vs human MCP) and a shared capability → tool/args → permission → scope contract. IdP revocation bound ≤ 15 min (🟡). | §4.5.1, §4.5.3, §4.5.4, §4.6, §4.8, §4.9, §6, §6.1 |
| X-6 / X-7 | Coordination requests to other plans removed (dependencies stated as consumed contracts). Phases 6–7 labelled as not delivering R10/R11 until they ship. | §2, §8, §11 |

## Intranet changes (D-E1…D-E6)

| Change | Decision | Where |
| --- | --- | --- |
| Provisioning writes the **04 §3 sign-in baseline** instead of a private portal: `access.visibility:'public'`, `allowAnonymous:false`, portal + team `openSignup:false`, `oauth` = password/magic link/every social provider `false`, OIDC to the intranet IdP with JIT (`autoCreateUsers:true`, `autoProvisionRole:'user'`), company domain verified + enforced, `widgetConfig.hmacRequired:true`. Fail-closed publish-last kept. Probes now assert, at Quackback level, that **writes** are refused without a session, that every non-SSO sign-in/sign-up door is closed and that SSO starts; read protection is the edge SSO's job (D-E3) and is checked by a separate edge probe. `tower_app_access_profiles` (domains/segments/widget sign-in per app) **removed** — every app gets the same baseline. | D-E1, D-E3, D-E4 | §2 R12, §4.3 steps 4–8, §4.3.1, §5.1–5.2, §8 Phase 2, §9 |
| **F-12 (SSRF allow-list) is a hard prerequisite** for app SSO: saving the provider, the SSO test, enforcement **and** every runtime sign-in (discovery + userinfo are fetched through `safeFetch`, `auth/index.ts:222-239`, `auth/hooks.ts:815-816,832-833`) reject intranet addresses without it. | D-E1, D-E2 | header, §4.5.1, §7, §8 Phase 0/3 |
| SSO-only is reached **without faking upstream attestations**: the provisioner mints break-glass recovery codes first (upstream refuses SSO-only without them, `sign-in-method-availability.ts:84-93,203-209`), verifies the domain through the real `_quackback-verify` TXT lookup on internal DNS, and turns `enforced` on only once upstream's own unlock rule holds (`sso-gates.ts:77-87`). Until then the app is already SSO-only because every other method is off. | D-E3 | §4.3 step 6, §4.3.1, O-12 |
| JIT portal users coexist with tower-managed users: `sync-members` adopts an existing tenant user **by SSO subject** (`account.accountId`), never by email. | D-E4 | §4.3.2 step 1 |
| **Inbound email redesigned for the internal mail server.** Upstream IMAP is process-wide env and **refuses to schedule under pooled tenancy** (`conversation.email-imap-queue.ts:47-60`), so it cannot serve per-app mail as is. Default: **one fleet mailbox** on the internal mail server receiving `*@<inbound domain>`, polled by a fork **mail router** (ECS service from the fork image, reusing upstream's exported `createImapClient`/`pollOnce`/`workspaceSlugFromInboundAddress`) that routes by `mail_slug` and POSTs raw MIME to the app's existing raw-MIME door (**R2-7:** its own raw loop over `createImapClient`/`fetchUnseen`, not `pollOnce`). `apps/mail-edge` (SES receipt rule + Lambda + SQS DLQ) **removed**. **IE-1 kept** (D-C11 per-app address key is transport-independent). | D-E2, D-C11 | §3, §4.11, §5.1, §7, §8 Phase 8, §9, O-3, O-11 |
| Outbound email: SMTP to the SES SMTP VPC endpoint or an internal relay (`EMAIL_SMTP_*`); SES/SNS delivery events disabled (E-3). | D-E2 | §4.10, §4.11 |
| No internet anywhere: tower, provisioner, mail router, IdP/broker, SCIM and all AWS calls (RDS, Secrets Manager, KMS, ECS, S3, SES) go to intranet hosts or VPC endpoints. Cognito dropped as a broker example (its OAuth endpoints are public); the broker must be intranet-hosted. S3 via VPC endpoint with fleet static keys in Secrets Manager (E-2); bytes stream through the app (`S3_PROXY=true`), no CDN; **V-7** updated. | D-E2 | §4.3 step 5, §4.5.1, §4.10, §8 Phase 0 |
| Internet-facing pieces removed: public DNS / public ACM validation, CDN origin, SES receipt, public custom domains. App and tower hostnames live in internal DNS with an internally trusted wildcard certificate on the internal ALB (ACM-imported private-CA cert or ACM Private CA). In-VPC callers (tower, provisioner, mail router) reach apps via a private DNS zone that resolves the same hostnames to the internal ALB, bypassing the edge SSO proxy (O-13). | D-E1, D-E2, D-C6 | §3, §4.1, O-13, O-14 |
| Seams table corrected to match `SEAMS.md`: the schema-floor hook is shared **F-11** (was listed as C-2 here); plan-owned count is **1 seam (IE-1) + 1 conditional (C-1)** (3 seams after the second pass: + TW-1, TW-2). | 02 §10 | §7 |

## Second-pass review changes

Driven by `REVIEW-2026-09-19-SECOND-PASS.md` and owner decisions **D-C15** (tower owns the whole app role set of
every tower-managed person) and **D-C16** (SCIM/directory API available; disable is a tenant-level denial on every
auth path). Where this section and an earlier changes table disagree, this section wins; the body below is
rewritten to match it.

| Finding | Change | Where |
| --- | --- | --- |
| R2-1 | **Image = upstream target.** Every runner path in this image (`fleet-migrator`, pool acquisition via `ensureWorkspaceSchemaCurrent`, `pool-cache.ts:303-308`, `fork-migrate`) migrates a workspace to *all* migrations bundled in the image, not to a recorded target (`migrate-runtime.ts:202,257`; enrol sets the target to `latestBundledVersion()`, `fleet/migrator.ts:931-936`). Rule: `fork-migrate` runs the full `runMigrations` only when the workspace's upstream ledger already contains **every** migration bundled in the running image (`missingBundledMigrations(readAppliedLedger(sql))` is empty, `ensure-schema-current.ts:32-34`). Otherwise it takes the **fork-only path** (fork lineage + fork catalogue reconcile, never upstream migrate or upstream seed) if the ledger meets the fork's declared upstream requirement, else skips with `upstream_pending`. **Serving-time cohort holds are not supported**: one serving image per fleet, and the web/worker roll is gated on every *active* workspace being at that image's bundle. A tenant that must stay on an older upstream version must be **suspended** (the registry refuses suspended tenants to requests and workers, `registry.ts:371`), because any active tenant a new-image web or worker task touches is caught up on pool acquisition whatever its target. | §4.4.2, §4.4.5, §9 |
| R2-2 | **Maintenance scope** (`fork/fleet/maintenance-scope.ts`, new files, no seam): opens a direct connection to a `suspended` (or `provisioning`) tenant, runs the same identity checks as `verifyWorkspaceDatabase` (`pool-cache.ts:266-300`: secrets, fingerprint, physical identity, canary) but **not** `ensureWorkspaceSchemaCurrent` or `assertSchemaFloor`, and builds an unpooled, unroutable `WorkspaceScope` (`createWorkspaceScope`/`runWithWorkspaceScope`, `workspace-context.ts:146,302`). `resume` and `create` run everything while the registry says `suspended`: identity → upstream catch-up (`migrateDirect`, `fleet/migrator.ts:496`) → fork lineage + seed → template reconcile → `sync-members` → baseline → **catalogue marker written in its own transaction after the reconcile commits** → both floors evaluated in-process → hostnames restored (still suspended) → state flips to `active` as the last write, then HTTP probes. A crash before the flip leaves the tenant suspended; a crash after it is caught by the `probing` reaper. `fleet-migrator run --workspace` is no longer used by `resume` (it refuses suspended tenants, `requireWorkspace`, `fleet/migrator.ts:978-987`). | §4.3, §4.4.4, §4.4.6, §9 |
| R2-3 | **Tower owns the whole role set (D-C15).** `adopted_local` and "other local roles untouched" removed. One writer: plan 10's `applyManagedRoleSet(principalId, { legacyRole, workspaceRoles, teamScopedRoles }, { kind: 'tower', syncRunId, grantorPrincipalId }, { executor })`, which sets the legacy role via upstream `setPrincipalRole` and replaces **all** workspace-wide and team-scoped rows of the managed principal (including preset Owner/Manager rows and locally granted rows) atomically under upstream's advisory lock 7061636 + principal-row `FOR UPDATE`. Provenance lives only in plan 10's `fork_role_assignment_sources` (`bundle_keys text[]`); this plan's `fork_tower_assignments` table is **dropped**. `fork_tower_principals` is plan 10's managed-principal registry (new columns `last_applied_legacy_role`, `last_applied_at`, `last_sync_run_id`, `entitlement_expires_at`), inserted in the same transaction as the first apply. Local or upstream edits (a role granted in the app, a legacy role changed by an app admin) are reverted at the next sync (`drift_reverted`). Empty desired set for an active person → legacy **`user` with zero rows** (no sentinel; the `no_access` sentinel is only for a `member` with team roles but no workspace-wide template); disabled person → plan 10's `denyPrincipal` (R2-4). | §4.3.2, §5.3, §9, §10 |
| R2-4 | **Disable is separate from grants (D-C16).** Directory sync (SCIM push preferred, directory-API polling fallback) marks a person disabled and queues a **deny** per app, which calls plan 10's `denyPrincipal` (`fork_principal_denials` row; sessions deleted; OAuth access + refresh tokens revoked; legacy `user` with zero rows; API keys the person created revoked via `revokeApiKey`). Check sites owned here: **new seam TW-1** — MCP OAuth path, in R-4's fenced block after `mcp/handler.ts:244` (the handler verifies the JWT and re-reads only `principal.role`, `:88-113`); **new seam TW-2** — `databaseHooks.session.create.before` (`auth/index.ts:631-638`), which every sign-in method passes, refuses a new session for a denied user. API keys: plan 10's R-1. Plan 10's F-8 sweep (every 5 min) re-applies denials. 15 minutes is a **target** with a budget table; no hard maximum unless the optional entitlement lease (plan 10 O-R8, default off) is on. Sync failure alarms. *Superseded in part by the third-review section: denial is also enforced at existing-session resolution (plan 10 R-13…R-15), the sweep is cleanup only, and the lease renews only from directory observations.* | §2 R13, §4.3.2, §4.5.4, §5, §7, §9 |
| R2-7 | **Raw-message router.** `pollOnce` is **not** used: it parses before calling back (`conversation.email-imap.ts:78-96`) and loses the raw MIME and delivery headers. The router runs its own loop over `createImapClient(config)` → `ImapClient.fetchUnseen()` (raw RFC822 + UID) / `markSeen` / `close` (`:34-45,241`), forwards the raw bytes and only the trusted envelope header. The internal mail server must **delete any inbound copy** of the routing header before stamping its own (V-9); no `To`/`Cc` fallback. Tenant-side deduplication is upstream's: all three ingest paths refuse a repeat `Message-ID` (reply `conversation.email-inbound.service.ts:501-508`, cold `:645-652`, ticket reply `:825-832`), backed by the unique index `conversation_messages_email_message_id_idx` (`packages/db/src/schema/conversation.ts:365-367`); the router also sends `x-qb-transport-message-id` (`email-cloudflare-handler.ts:132,602-605`) so id-less messages dedup too. No fork dedup table. Door status handling: 2xx delivered; 400/413/415/422 permanent → dead-letter, no retry; 401/404/408/429/5xx/timeout → retry with backoff, re-signed with a fresh timestamp. | §4.11, §5.1, §7, §9 |

**Acceptance tests added** (all in §9, mandatory):

- **R2-1:** run a new image against a tenant whose upstream ledger is at an intentionally older target. `fork-migrate`
  (new image) applies only the fork lineage/catalogue or skips with `upstream_pending`; it never applies the
  withheld upstream migration. While the tenant is held it is **suspended**, and neither a scoped request nor a
  worker sweep from the new image applies the withheld migration (registry refusal). The deploy gate refuses to
  roll web/worker while any **active** tenant is behind the image's bundle.
- **R2-2:** suspend a tenant before multiple catalogue releases, raise both serving floors, then `resume` with the
  newest image. Crash (kill the task) after each stage: identity, upstream catch-up, fork lineage, seed, template
  reconcile, sync, marker, hostname restore, flip, probes. After every crash the tenant is still `suspended` (or,
  after the flip, re-suspended by the reaper if probes did not finish), no public route serves it early, and the
  catalogue marker is never newer than the committed reconcile. A re-run completes.
- **R2-3:** locally grant a role to a managed person, add the same role through the tower, remove it in the tower,
  change the legacy role in the app, then run seed/migration/`fork-migrate` and sync. Expected at each step: local
  grant present until the next sync, then removed; tower grant present with `source='tower'` provenance; after
  tower removal the role is gone (no local survivor) and, with no bundle left, the person is legacy `user` with
  zero rows (no sentinel); the legacy-role change survives only until the next sync (`drift_reverted`);
  seed/migrate never adds Manager (a team-roles-only `member` holds the `no_access` sentinel);
  `assertTowerPrincipalsFailClosed` reports clean after every sync.
- **R2-4:** disable a locally privileged tower-managed user in the directory while they keep using an already
  issued app session, an unexpired MCP JWT (and refresh token), and an API key they created, without visiting the
  tower. Within the target: session requests get 401, MCP returns 401 even though the JWT verifies (TW-1), refresh
  fails, the API key is refused (R-1), and a fresh sign-in by any method creates no session (TW-2). Repeat with the directory/SCIM unavailable: the
  `directory_sync_stale` alarm fires at 2× the poll interval; with the lease on, access ends at lease expiry; with
  it off, access ends within the target after sync recovers.
- **R2-7:** deliver cold mail and replies to two tenants, including BCC, multiple recipients across tenants, and
  messages carrying forged `Delivered-To`/routing headers; kill the router after the tenant accepted a delivery
  but before `cp_mail_deliveries` records it, then let it retry. Verify: no delivery to a tenant the envelope did
  not name, no duplicate visible message, raw MIME bytes byte-identical (as decoded by `SocketImapClient`) through
  the exact adapter, 413 dead-lettered without retry, 5xx/timeout retried.

## Third-review changes

Driven by `REVIEW-2026-09-19-MAIN-FOLLOWUP.md` findings **R3-1** and **R3-2**. Plan 10 owns the denial design
(§0c and §4.9 there). This plan uses the same seams and states the same bound. Where this section and an earlier
changes table disagree, this section wins, and the body (§2 R13, §4.3.2, §4.5.4, §5, §7, §9, §10, §11) is
rewritten to match. The correct fixes need more integration than the second pass estimated. The dependencies
are recorded in §7 and in plan 10 §7, and they must be tested semantically on every upstream upgrade.

| Finding | Change | Acceptance test | Where |
| --- | --- | --- | --- |
| R3-1 (P1): deletion + sign-in check is not immediate denial | The deny operation no longer relies on session deletion. Plan 10's `denyPrincipal` Tx 1 commits the denial row. From then on, plan 10's **existing-session checks** refuse the principal on every request: **R-13** (`auth/index.ts` `auth.api` proxy `getSession` + `auth.handler`), **R-14** (`getWidgetSession`) and **R-15** (chat-stream token + open-stream heartbeat). This plan's **TW-2** (`databaseHooks.session.create.before`, `auth/index.ts:631-641`, the **same file** as R-13) blocks new sessions, and **TW-1** covers MCP JWTs. Session deletion, token revocation, demotion and the F-8 sweep are cleanup. The "OIDC after-hook" wording is removed. There is one seam location per check, the same in both plans. Last admin: if demotion fails (`LAST_ADMIN`), the denial still applies, `denial_demote_blocked` alerts ops, and the provisioner restores the break-glass admin (§4.3 step 6, legacy `admin`, not tower-managed), after which the sweep completes the demotion. | Plan 10 §0c R3-1 test, run end to end from a directory disable: hold an SSO sign-in after TW-2's check, let the revocation worker commit the deny, release the insert, then immediately make a portal write, a dashboard request, a widget-Bearer call, a widget upload and a stream handshake with the sweep stopped. All are refused. Repeat with the managed user as the last admin (break-glass removed): still refused, alert raised. | §4.3.2, §4.5.4, §7, §9 |
| R3-2 (P1): tenant sync success is not directory freshness | **Lease renewal comes only from a recorded directory observation.** The tower records, per user, `directory_observed_at` and `directory_observation_ref` (§5.2). A successful directory-API poll that covered the user writes them (full read, or a delta whose cursor advanced from the last successful cursor; value = the read's start time, ref = poll run id + cursor/version). So does a SCIM request carrying the user's full resource with `active = true` (value = receipt time, ref = request id). A failed or partial poll writes nothing. `sync-members` passes that observation to plan 10's `recordEntitlementObservation`, which sets `entitlement_expires_at = GREATEST(current, LEAST(observedAt, now()) + lease)` and ignores observations that are not newer. A successful tenant apply **never** renews the lease. **One bound, identical to plan 10 §4.9:** with the lease on, access ends at the last directory observation of the person as active + lease duration (at most the lease after disablement), checked on every authenticated request by `isPrincipalDenied`/`isUserDenied`, whatever sync, provisioner or sweep do. With it off, the 15-min target applies and there is no hard maximum. | Lease on (60 min). Stop the directory poll and SCIM while scheduled `sync-members` keeps succeeding, and stop the tenant sweep worker. `entitlement_expires_at` never advances. At `last observation + 60 min` the user is refused on web, portal, widget, stream, MCP and API keys, and a new SSO sign-in creates no session. After the poll resumes, the next sync renews the lease and lifts only `lease_expired`. | §4.3.2, §4.5.4, §5.2, §5.3, §9, §10 O-9 |

## 1. Changes from v1

| v1 issue (review §3.1 / §2)                                                                                                                    | v2 resolution                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Blocker:** `/fleet/*` in the tenant app hits the root `beforeLoad` (`routes/__root.tsx:74-89`, exemptions hard-coded in `ONBOARDING_EXEMPT_PATHS` `:57-68`) which needs a workspace scope | **Eliminated by D-C1.** The tower is `apps/control-tower/`, its own process, router and root route. Zero edits to `__root.tsx`.                                                                                                                                                                                                |
| **Blocker:** a path bypass would miss server functions (`/_serverFn/…`); `FLEET_PATHS` is a hard-coded list (`workspaces/request-scope.ts:70-75`, checked at `:88`) | **Eliminated by D-C1.** No workspace-exempt prefix is needed; `request-scope.ts` is untouched.                                                                                                                                                                                                                                  |
| **Blocker:** provisioner must write the stamped `settings` row, admin principal and setup state (onboarding refuses on `settings_row_missing`, `fingerprint.ts:119,186`; bootstrap claim closed for stamped DBs, `bootstrap-admin.ts:90`) | §4.3: the provisioner writes settings (+ `setupState` with `completionSource: 'managed'`), stamp, canary, member principals, roles, IdP + linked `account` rows itself. No onboarding wizard, no bootstrap claim.                                                                                                              |
| **Major:** in-process fan-out shares the per-request auth memo (`functions/auth-request-cache.ts:26`) across tenants                            | **Eliminated.** The tower never enters an app process; each call is an independent HTTPS MCP call authenticated by that app.                                                                                                                                                                                                 |
| **Major:** contract requires distinct pooled/direct endpoints and matching role/db (`vendor/contract.ts:422-438, 446-451`); role per tenant      | D-C3: pooled DSN → RDS Proxy endpoint, direct → writer endpoint (different hosts), one DB role + DB per app, password-less DSNs with `role@…/db` matching `db_role`/`db_name`. §4.2.                                                                                                                                             |
| **Major:** second Better Auth instance needs its own tables                                                                                      | The tower runs its own Better Auth with its own tables (`tower_auth_*`) in the control DB, own lineage in `apps/control-tower/migrations`. §4.5.                                                                                                                                                                              |
| **Major:** fleet code would trip module-state / authz CI                                                                                         | Tower code is outside `apps/web` scan roots. Fork code inside `apps/web`: provisioner (`lib/server/fork/provisioner/`), inbound-email key + mail router (`lib/server/fork/inbound-email/`, `lib/server/fork/mail-router/`), one unauthenticated fork API route, and fork MCP tools under `mcp/tools/fork-*.ts` (attested by `policy/authz-matrix/scan.ts:321` `scanAllMcpTools`). No module state. |
| **Wrong fact:** fingerprint columns 0251/0252                                                                                                    | Real: `0255_settings_cloud_tenant_id.sql` → renamed by `0256_workspace_key_columns.sql` (`cloud_workspace_key`); canary `0266_settings_cloud_secret_canary.sql`. Not in the Drizzle schema; read via `to_jsonb(s) ->> …` (`fingerprint.ts:262-263`).                                                                           |
| **Wrong fact:** `OSS_TIER_LIMITS` location; service names                                                                                        | Moot: seat/plan limits do not apply (D4), and the tower calls MCP tools, not services.                                                                                                                                                                                                                                         |
| **Wrong fact:** `env://` refs                                                                                                                    | `env://` only accepts `QUACKBACK_TENANT_SECRET_[A-Z0-9_]+` (`vendor/secret-ref.ts:141-142`). v2 uses `sealed+aead://` for DB passwords, so onboarding an app needs no task-definition change (§4.2).                                                                                                                             |
| **Human attribution:** API keys mint a service principal per key (`api-key.service.ts:132`)                                                       | D-C2: the tower acts only through app MCP with the user's own OAuth token; `principalId` comes from the verified JWT and is re-read from `principal` (`mcp/handler.ts:98-126`). Dual audit (§4.8).                                                                                                                             |
| X6: `withWorkspaceScopeById` wrong file/signature                                                                                                | It is `workspaces/fleet.ts:147` with `(workspaceKey, origin: WorkspaceScopeOrigin, body)`. Only the provisioner uses it (origin `'script'`), for active apps; suspended/provisioning apps use the fork maintenance scope (§4.4.6, R2-2).                                                                                                                                                                                  |
| §4.2/4.3: fleet `viewer` clashes; fleet admins all seeded as tenant **admin**                                                                    | Configurable tower role bundles (D-C9), each naming a tenant custom-role template from 10 (§6). Enforced over MCP once D3 ships.                                                                                                                                                                                               |
| v1 §7.1 registry DDL "reverse-engineer later"                                                                                                    | §5.1 concrete DDL reproducing `SELECT_COLUMNS`/`RegistryRow` + **parity test** against the real reader.                                                                                                                                                                                                                      |
| v1 control DB schema in `packages/`                                                                                                              | Control-DB migrations are their own lineage in `apps/control-tower/migrations/`, never in `packages/db`.                                                                                                                                                                                                                      |
| v1 fan-out design (in-process, limit 5)                                                                                                          | MCP fan-out with bounded concurrency, per-app timeouts, partial results, explicit dormancy policy (§4.7).                                                                                                                                                                                                                      |
| v1 surfaces assumed domain services for every action                                                                                             | Verified MCP coverage table (§4.6); gaps become fork MCP tools registered through shared seam F-3.                                                                                                                                                                                                                             |
| Caveats (inbound email, `PLATFORM_CREDENTIALS_SOURCE`)                                                                                           | Inbound email is now built (D-C11, §4.11; IMAP from the internal mail server). Platform credentials re-verified (§4.10).                                                                                                                                                                                                                                            |
| Fleet migrator + fork lineage                                                                                                                    | Fork-only releases are not claimed by the fleet migrator; the provisioner's `fork-migrate` command (fork SQL + catalogue reconcile + fork floor, §4.4) covers them.                                                                                                                                                         |

## 2. Requirements

- **R1** Each app is an isolated Quackback workspace served by the upstream pooled runtime
  (`QUACKBACK_TENANCY=pooled`) in `apps/web`; end users never see another app.
- **R2** Fleet users sign in **once** to the tower through the org IdP on the intranet, which may be **OIDC or
  SAML** (D-C7). Each app is configured with the same IdP by the provisioner; it is also how every employee
  (all end users, D-E4) signs in to app portals.
- **R3** The tower aggregates support inbox, tickets, feedback, roadmap, changelog and per-app counts across
  all active apps; it degrades per app (partial results).
- **R4** The tower acts on one app at a time; **every action is attributable to the human** in both the tower
  audit and the app's native activity/audit (D-C2).
- **R5** Tower authorization is **configurable role bundles** (D-C9). A bundle sets which tower surfaces and
  actions a user gets **and** which custom role the user holds in every app. Users may hold several bundles
  (D-R4). App RBAC still bounds what each app accepts (defence in depth).
- **R6** Connecting to all apps shows **no consent screens** and needs no clicks while the IdP session is live
  (D-C12).
- **R7** Provisioning, suspension and member sync are privileged jobs holding the root key; the tower never
  holds `QUACKBACK_FLEET_ROOT_KEY` nor any app DSN credential (D-C4).
- **R8** Each app receives inbound email on its own address, verified with its own key (D-C11).
- **R9** Upgrade safety: 3 upstream seams owned by this plan (IE-1, TW-1, TW-2; +1 conditional; F-11/F-12 shared); upstream registry drift caught
  by a test; fork-only releases reach every tenant (active now, suspended on resume) with catalogue reconciled.
- **R12** Every provisioned app carries the **04 §3 sign-in baseline** from the moment its hostname is published:
  public visibility, anonymous off, sign-up closed except IdP JIT, SSO the only sign-in method, widget HMAC
  required (D-E3; supersedes D-N5). Readers are kept out by the edge SSO + Quackback SSO (D-E1).
- **R14** No component makes an internet connection (D-E2): tower, provisioner, mail router, IdP/broker and
  every AWS dependency are intranet hosts or VPC endpoints.
- **R13** Removing a user from an IdP group replaces their app role set, and disabling them in the directory
  denies them in every app on every auth path (sessions, OAuth/MCP tokens, API keys they created, new sign-ins),
  within a **15-minute target** (not a hard maximum; budget and failure behaviour in §4.5.4; optional hard lease)
  (D-C16, O-9). The bound is plan 10 §4.9's single statement: once the tenant denial commits, every path refuses
  on its next request; with the lease on, access also ends at the last directory observation + lease.
- **Later (not delivered by Phases 0–5):** R10 announcements across apps (Phase 6, D-N8); R11 read-only
  portfolio / prioritization views (Phase 7). Until those phases ship the tower offers neither surface.

## 3. Architecture

```
     intranet org IdP (OIDC or SAML)     SAML only: intranet OIDC broker in front of the IdP for apps (§4.5.1)
               │                │
  tower login  │                │  app SSO (pre-linked account; silent while IdP session is live)
  (OIDC/SAML)  ▼                ▼          employees ──▶ edge SSO proxy / VPN ──▶ internal ALB
 ┌────────────────────┐  HTTPS MCP (Bearer = user's per-app token)  ┌────────────────────────────┐
 │ apps/control-tower │ ─── private DNS → internal ALB ───────────▶ │ apps/web (pooled, N hosts) │
 │  Better Auth + SSO │                                             │  /api/mcp, /api/auth/oauth2 │
 │  tower_* tables    │◀── column-limited SELECT ── control DB ───▶ │  registry reader            │
 └────────┬───────────┘                                             └──────┬───────────▲──────────┘
          │ ECS RunTask (no secrets; ECS VPC endpoint)                      │           │ raw MIME + HMAC
          ▼                                                                 ▼           │
 provisioner task (fork image, root key) ──▶ one Aurora cluster: DB per app    mail router (fork image, ECS)
                                             + fleet S3 bucket via VPC endpoint      ▲ IMAP (TLS)
                                               (w/<settings.id>/)                    │
                                                                        internal mail server: fleet mailbox
                                                                        for *@<inbound domain>
```

Two planes; the tower is a pure **client** of the app plane. Nothing in the picture has an internet route
(D-E2); AWS APIs are reached through VPC endpoints and every other host is on the intranet.

## 4. Design

### 4.1 App plane (unchanged upstream runtime)

`apps/web` runs pooled exactly as upstream documents (`workspaces/TENANCY.md`): Host → registry
(`resolveWorkspaceByHostname`, `registry.ts:265`) → pool (`pool-cache.ts`) → fingerprint. Web/worker/migrator
tasks get `QUACKBACK_CONTROL_DATABASE_URL` (role `cp_reader`) and `QUACKBACK_FLEET_ROOT_KEY` from Secrets
Manager. App hostnames (D-C6): `<slug>.<fleet-domain>` on an **internal** ALB, where `<fleet-domain>` is an
intranet domain in internal DNS (no public DNS records) and the wildcard certificate is internally trusted —
a private-CA certificate imported into ACM, or ACM Private CA (a public ACM certificate would need public DNS
validation; O-14). Tower on `tower.<fleet-domain>` behind a separate internal ALB listener. Employees reach
both through the edge SSO proxy / VPN (D-E1). In-VPC callers (tower, provisioner, mail router) resolve the
**same hostnames** through a private DNS zone straight to the internal ALB, so Host-based registry routing and
the MCP token audience (`${baseUrl}/api/mcp`) are unchanged while server-to-server calls skip the edge proxy,
which has no session for them (O-13). Custom domains per app come later (`kind = 'custom'` hostnames) and are
likewise internal DNS names with private-CA certificates.

Web/worker env follows the 04 §3 baseline: `DISABLE_TELEMETRY=true`; `QUACKBACK_CONTROL_PLANE_URL`,
`QUACKBACK_CP_STATUS_URL`, `INTEGRATION_OAUTH_GATEWAY_URL`, `EMAIL_RESEND_API_KEY` unset; AI (when enabled) via
the internal OpenAI-compatible proxy; `SSRF_ALLOWED_CIDRS` / `SSRF_ALLOWED_HOSTS` (F-12) naming the IdP/broker
and other intranet services.

### 4.2 AWS database layout (D-C3, D-C8)

- **One shared Aurora PostgreSQL cluster.** One database + one login role per app (`qb_<key>` / `qb_<key>`),
  owner of its DB, no cross-DB grants. The control DB `quackback_control` lives in the same cluster.
- `db_pooled_url = postgresql://qb_<key>@<proxy-endpoint>:5432/qb_<key>?sslmode=require`
  `db_direct_url = postgresql://qb_<key>@<cluster-writer-endpoint>:5432/qb_<key>?sslmode=require` — different
  hosts, so `contract.ts:422-438` passes; role/db match `db_role`/`db_name` (`contract.ts:446-451`).
- `db_credential_ref = sealed+aead://v<gen>/<key>/db/<blob>` — password sealed under the root key by the
  provisioner. `env://` is rejected because each new app would need a new `QUACKBACK_TENANT_SECRET_*` env var
  and a task-definition roll (`secret-ref.ts:141-142`).
- RDS Proxy authenticates each client role from a Secrets Manager secret; the provisioner creates
  `quackback/tenant/<key>/db` and attaches it to the proxy's auth list (IAM auth off — see V-2).
- **Backups (D-C8):** Aurora automated backups + PITR and scheduled cluster snapshots only. There is no
  per-app backup or per-app restore procedure; restoring means restoring the cluster (or a clone of it) and
  is an ops runbook item (Phase 9).
- **Validation tasks (Phase 0):**
  - **V-1 RDS Proxy pinning.** `pool-cache.ts:179,402` hard-code `prepare: true` (rationale `TENANCY.md:204-207`).
    RDS Proxy may pin sessions on extended-protocol prepared statements. Measure
    `DatabaseConnectionsCurrentlySessionPinned` under load. If pinning defeats pooling, apply conditional seam
    **C-1** (env-driven `prepare`). Zero-seam alternative: point `db_pooled_url` at a second DNS name for the
    writer (satisfies the host rule, no pooling; acceptable at 5–10 apps with `WORKSPACE_POOL_MAX=3`).
  - **V-2 IAM auth.** `secret-ref.ts` resolves `env://`, `sealed+aead://` and `derived+hkdf://` only; no IAM-token
    ref. Use password auth (a custom `setWorkspaceSecretsResolver`, `workspace-secrets.ts:90`, is not planned).
  - **V-3** `DSN_RE` accepts `?sslmode=require`; `pg_cluster_id`/`pg_database_oid` read correctly through RDS
    Proxy (anti-clone check in `physical-identity.ts`).

### 4.3 Provisioner (privileged job; holds the root key)

**Where:** logic in `apps/web/src/lib/server/fork/provisioner/*.ts`, entry `apps/web/scripts/fork-provision.ts`
(new files; no seam), bundled as `/app/fork-provision.mjs` (§4.4.1). It runs from the **fork image** as an ECS task with the provisioner task role
(root key + RDS master secret + `secretsmanager:CreateSecret` + `rds:ModifyDBProxy`), because it reuses the
vendored contract (`workspaces/vendor/*`), `runMigrations`, app defaults and domain services. The tower
triggers it with `ecs:RunTask` (command + args only; no secrets pass through the tower).

Commands: `create`, `sync-members`, `suspend`, `resume`, `deprovision`, `rotate-db-password`, `fork-migrate`
(§4.4), `verify` (wraps `apps/web/scripts/verify-workspace-secrets.ts` and the checks below).

`create --key <key> --slug <slug> --name <name> [--mail-slug <s>]` (idempotent; each step checks before writing):

1. `CREATE ROLE qb_<key> LOGIN PASSWORD …; CREATE DATABASE qb_<key> OWNER qb_<key>` (master creds); create the
   Secrets Manager secret; attach it to RDS Proxy.
2. Migrate via `runMigrations(directDsn)` (`packages/db/src/migrate-runtime.ts:202`): upstream lineage, then
   the fork lineage (F-1), then `seedSystemData`.
3. Derive the workspace `SECRET_KEY` via vendored `fleet-secrets.ts` (`deriveWorkspaceSecret`, `:137`) from
   `derived+hkdf://v1/<key>/app-secrets`.
4. In one transaction on the direct DSN, insert the **settings row**, mirroring `functions/onboarding.ts:265-279`
   (`id = generateId('workspace')`, name, slug, `DEFAULT_ASSISTANT_CONFIG`, `featureFlags`) **but with the
   sign-in baseline of §4.3.1 instead of `DEFAULT_PORTAL_CONFIG`, `DEFAULT_AUTH_CONFIG` and
   `DEFAULT_WIDGET_CONFIG`** — every baseline field written explicitly, because the upstream defaults are open
   (an absent `openSignup` means `true`, `settings.types.ts:166-197`; `DEFAULT_AUTH_CONFIG.oauth` turns
   `google`/`github`/`password` on, `:167-171`), with `setupState` = all steps complete,
   `completionSource: 'managed'` (`packages/db/src/types.ts:353`) so `isOnboardingComplete` (`types.ts:561`)
   is true; then
   - fingerprint stamp `{ v: 1, workspaceKey, stampedAt }` (`vendor/contract.ts:524-545`) into
     `settings.metadata.cloudTenant`; leave `cloud_workspace_key` NULL (avoids `stamp_source_conflict`);
   - `cloud_secret_canary = sealSecretKeyCanary(secretKey, key)` (`vendor/fleet-secrets.ts:249`), raw SQL
     (column not in the Drizzle schema).
5. Read `pg_database.oid` + cluster id; insert `cp_workspace_registry` with **`state = 'suspended'`,
   `state_reason = 'provisioning'`** (R2-2: neither requests nor worker sweeps acquire it, `registry.ts:371`,
   `listActiveWorkspaces` `:322`) + `cp_workspace_schema_state` (target = image max) + `cp_fork_schema_state` —
   **no `cp_workspace_hostnames` row yet**, so the app is not routable while it is being configured.
   - `storage` (D-C10) = the **fleet-bucket form**: `{ provider: 'r2', bucket: <fleet bucket>, endpoint:
     <S3 VPC endpoint URL — the regional endpoint behind a gateway endpoint, or the interface endpoint's
     DNS name>, region, forcePathStyle: <per V-7>, publicUrl: https://<slug>.<fleet-domain>/api/storage }`
     (`publicUrl` is required and pinned, `vendor/contract.ts:75-86,290`; pointing it at the app's own
     `/api/storage` route with `S3_PROXY=true` (`routes/api/storage/$.ts:245`) streams bytes through the app, so
     browsers never need an S3 or CDN route — there is no CDN on the intranet) with
     **no `credentialRef`** — absent is the documented pooled default ("the isolation is in the key rather
     than in the key pair", `vendor/contract.ts:88-102`). Every object name is composed under
     `w/<settings.id>/` by `storage/namespace.ts` (`WORKSPACE_NAMESPACE_ROOT = 'w'` `:61`,
     `workspaceNamespace` `:103`, `composeNamespacedKey` `:114`). No per-app bucket or bucket credential.
   - `mail_slug` (D-C11) = `--mail-slug` or the slug; must match the mail-slug grammar, **max 13 characters**
     (`vendor/mail-slug-pattern.ts:31`; the local-part budget in `conversation.email-channel.ts:169-175`), and
     is `UNIQUE` in the registry. The provisioner refuses a longer slug rather than truncating.
6. Enter the **maintenance scope** (§4.4.6; `withWorkspaceScopeById` would refuse the still-suspended row,
   `fleet.ts:147` → `resolver.ts:151` → `registry.ts:371`) — it runs the real fingerprint, physical-identity and
   canary checks — and, using domain services:
   - `ensureNewWorkspaceLabs` (as onboarding does);
   - `ensurePersonaRoles` (owned by 10; same service behind its MCP tool `fork_install_persona_roles`) for every
     `template_key` named by any `tower_roles` row; roles are then looked up by `template_key` in 10's
     `fork_role_templates(role_id PK, template_key unique)`, never by display name;
   - create the **tower-sync service principal** (`createServicePrincipal`, `principal.factory.ts:186`; name
     "Control Tower sync", no role assignments, no API key) and record its id in `fork_settings`
     `tower.sync_principal_id`; it is the grantor of every tower-owned assignment (§4.3.2);
   - create the app **identity_provider** row (`packages/db/src/schema/auth.ts:682-741`; `enabled`,
     `autoCreateUsers=true` (JIT, D-E4), `autoProvisionRole='user'` (portal user; no promotion,
     `auth/hooks.ts:652-665`), `claimMapping=null` (tower roles come only from `sync-members`), `showButton=true`)
     pointing at the intranet org IdP (OIDC) or the intranet OIDC broker (SAML IdP, §4.5.1), through the
     identity-provider service so its URL check (`identity-providers.service.ts:384-395`, needs **F-12**) and
     client-secret encryption apply;
   - **break-glass before publish:** create a dedicated break-glass admin user (legacy `admin`, no SSO account;
     not tower-managed) and mint its recovery codes (`generateRecoveryCode` /
     `hashRecoveryCode`, `auth/recovery-codes.ts:48,81`), store the plaintext in Secrets Manager
     `quackback/tenant/<key>/break-glass` (provisioner and ops only). Upstream will not let a workspace become
     SSO-only without active codes (`assertBreakGlassAvailable`, `sign-in-method-availability.ts:203-209`); the
     provisioner writes settings directly (step 4 already made the still-unpublished app SSO-only), so it upholds
     that invariant itself before step 7;
   - `sso_verified_domain` for the company email domain (`schema/auth.ts:756-785`) linked to the provider, with
     the **fleet verification token** (the same token in every app, so one internal-DNS TXT record
     `_quackback-verify.<domain>` = `qb-domain-verify=<token>` serves the fleet, `functions/sso.ts:614-615`);
     the provisioner runs the same `lookupVerificationTxt` check (`auth/dns-verify.ts:22`, system resolver →
     internal DNS) before stamping `verifiedAt`, and leaves `enforced=false` until §4.3.1 "enforcement";
   - `sync-members` (§4.3.2);
   - register the tower's **OAuth client** and set `skip_consent` (§4.5.2); write `fork_settings` keys
     `tower.oauth_client_id`, `tower.redirect_uri`, `tower.sso_provider_id` (read by §4.5.3);
   - ensure `developerConfig.mcpEnabled` (default `true`, `settings.types.ts:509`);
   - **in-scope baseline check** (§4.3.1): re-read the stored portal/auth/widget config, the provider row and
     the verified domain, and assert the baseline field by field; evaluate the upstream gates in-process —
     `workspaceAllowsAnonymous` (`settings.types.ts:394`) false, `isSsoOnlySignIn` (`sign-in-method-
     availability.ts:84`) true, `isAccountCreationAllowed(<non-domain email>, 'portal')`
     (`auth/signup-policy.ts:191`) false, `hasActiveRecoveryCodes()` (`auth/recovery-codes-status.ts:8`) true —
     all must hold.
7. **Publish:** write the catalogue marker (§4.4.2 step 4, its own transaction after the step-6 work committed),
   evaluate both floors in the maintenance scope, insert `cp_workspace_hostnames` (`kind = 'platform'`,
   `<slug>.<fleet-domain>`) while still suspended (the hostname answers "suspended"), set
   `cp_fork_schema_state.resume_status = 'probing'`, flip `state = 'active'` as the last registry write, then
   run the **HTTP probes** of §4.3.1 against that hostname (in-VPC, via the private DNS zone — i.e. at Quackback
   level, without the edge proxy). Any probe that does not get the expected refusal → delete the hostname row,
   set `state = 'suspended'`, `state_reason = 'access_probe_failed'`, exit non-zero. Success clears
   `resume_status`. A crash between flip and probe result is caught by the `probing` reaper (§4.4.4).
8. `verify`: `resolveWorkspaceById` ok, `verify-workspace-secrets.ts` passes, the SSO start redirects to the
   intranet IdP (proves F-12 + discovery), tower client has `skip_consent = true`, storage write/read
   round-trip lands under `w/<settings.id>/` and reads back through `/api/storage`, fork floor satisfied
   (§4.4.3), enforcement state reported (§4.3.1).

Any failure in steps 4–7 leaves the app suspended (`provisioning` or `access_probe_failed`), with or without a
hostname row; `create` is re-runnable from the failed step.

#### 4.3.1 Sign-in baseline (D-E3, 04 §3; C1 fail-closed rules kept)

The upstream defaults are open — `DEFAULT_PORTAL_CONFIG` has `allowAnonymous: true`
(`settings.types.ts:370-383`), `DEFAULT_AUTH_CONFIG` has `openSignup: true` and password/Google/GitHub on
(`:166-197`) — so the provisioner never writes them unmodified. `fork/provisioner/access-profile.ts` →
`signInBaseline()` (one value for every app; there is no per-app access input any more):

| Field | Value |
| ----- | ----- |
| `portalConfig.access.visibility` | `'public'` (D-E3; readers are kept out by edge SSO + Quackback SSO, D-E1) |
| `portalConfig.access.allowedDomains` / `allowedSegmentIds` / `widgetSignIn` | `[]` / `[]` / `false` (private-portal controls, unused under public visibility) |
| `portalConfig.features.allowAnonymous` | `false` (also the fail-closed read in `workspaceAllowsAnonymous`, `:394`) |
| `portalConfig.openSignup` and `authConfig.openSignup` | `false`, both explicit. JIT still works: IdP callbacks for a provider with `autoCreateUsers` at a verified domain are exempt (`isSsoAutoProvisionGrant`, `auth/signup-policy.ts:398-421`) |
| `authConfig.oauth` | `password: false`, `magicLink: false`, every social provider key `false` (`lib/shared/signin-methods.ts:7-15`) |
| Identity provider | intranet OIDC IdP or broker, `autoCreateUsers: true`, `autoProvisionRole: 'user'`, `claimMapping: null` (§4.3 step 6) |
| `sso_verified_domain` | company domain, verified via internal DNS TXT, then `enforced: true` (below) |
| `widgetConfig.hmacRequired` | `true` (identified employees only, `settings.types.ts:723`) |
| `support`, help center, status page | upstream defaults; they inherit the same sign-in rules |

**Enforcement.** `enforced=true` hard-binds the domain to the provider (`isHardBound`,
`auth/auth-restrictions.ts:173-188`). Upstream only allows it after SSO is proven working for that provider
(`isSsoEnforcementUnlocked`, `sso-gates.ts:77-87`: a successful test or a real SSO sign-in after the last
details change) and with break-glass codes present (`functions/sso.ts:703-718`). The provisioner never stamps
a test result it did not run: `verify --access` (run by `create`, `resume`, the 15-minute `sync-members`
schedule and on demand) sets `enforced=true` as soon as the unlock rule holds — normally the first
connect-all or portal SSO sign-in after provisioning. Until then the app is already SSO-only, because every
other method is off (the step-6 check). O-12.

**Email OTP.** 04 §3 leaves "how email OTP is gated" as an open verification item. The probe below tries it;
if upstream does not refuse it under this baseline the probe fails and the app is not published (fail
closed) until 04 resolves the item.

**HTTP probes** (Quackback level: no cookie/token, and with an anonymous session minted at
`/api/auth/sign-in/anonymous`, which stays registered — `auth/index.ts:767`, optional seam E-4):

- **Writes refused:** create post, vote, comment, submit a support conversation/ticket, widget identify
  without a valid HMAC, public REST write endpoints → 401/403, never a created row (checked in-scope after).
- **Non-SSO doors closed:** email/password sign-in and sign-up, magic-link send, email-OTP send, social
  sign-in for each upstream provider id → refused.
- **SSO works:** the provider's sign-in start returns a redirect to the intranet IdP/broker authorize URL.

Reads are **not** probed for denial at Quackback level: public visibility serves them by design (D-E3). A
separate **edge probe** (when the provisioner has a route to the edge proxy; O-13) asserts that an
unauthenticated request to the hostname through the edge gets the edge SSO challenge, never app content. The
probe list lives next to the sign-in baseline tests (§9) so both change together. `suspend`/`resume` and
`verify --access` re-assert the baseline and re-run the probes.

#### 4.3.2 `sync-members` (privileged; the only writer of tower-managed role sets)

Runs per app from the provisioner (never from a human MCP token): on every change to `tower_role_members`,
`tower_roles`, `tower_role_app_teams` or `tower_users`, after every directory reconcile (§4.5.4), and on a
**15-minute schedule**. Inputs are read with the `cp_provisioner` grant. Scope: the ordinary workspace scope for an
active app, the maintenance scope (§4.4.6) during `create`/`resume`. For each tower user linked to this app:

1. **Identity (C3, §4.5.4):** upsert `user` (email, name, `emailVerified`) and `principal` keyed by the
   recorded `tower_user_app_identities.tenant_user_id` (never re-matched by email). On first sync, if the user
   already exists in the app through JIT (a tower user who signed in to the portal first, D-E4), it is
   **adopted by subject**: the `account` row with `providerId = tower.sso_provider_id` and `accountId = ` the
   app-facing subject identifies it; otherwise it is created. A same-email user with a different or no SSO
   subject is never merged — it is reported `identity_conflict` and skipped;
   ensure exactly one `account` row for the app's SSO provider with `accountId = ` the user's app-IdP subject
   (`tower_user_idp_links`); delete any other `account` row for that provider on this user (e.g. created by
   email auto-linking, `auth/index.ts:524-531`) and revoke its sessions. The `fork_tower_principals` registry row
   (plan 10 §4.8's managed-principal registry) is inserted **in the same transaction as the first
   `applyManagedRoleSet`** (step 3), so a principal is never registered without its managed role set; the
   tower-side mapping row is written after commit.
2. **Desired role set** — the **complete** set this person holds in this app (D-C15), in plan 10's shape
   `{ legacyRole, workspaceRoles, teamScopedRoles }` with `bundleKeys` per role: `legacyRole` = `admin` if any
   bundle has `tenant_legacy_role = 'admin'`, else `member` if any role results, else `user`; `workspaceRoles` =
   the bundles' workspace-wide templates; `teamScopedRoles` = {(tenant team id, team template)} from
   `tower_role_app_teams` for this app. A team-scoped bundle with no team mapping for this app contributes
   nothing here and is reported `unmapped_team` (fail closed). A `member` with team roles but no workspace-wide
   template gets plan 10's `no_access` sentinel as its workspace row (added by the writer). If the person holds
   no bundle, the set is **empty** ⇒ `{ user, [], [] }`. If the person is `disabled` (directory-driven,
   §4.5.4), sync does not compute a set; it runs the **deny** operation below instead.
3. **Apply atomically** through plan 10's single authoritative writer (plan 10 §4.8):
   `applyManagedRoleSet(principalId, desired, { kind: 'tower', syncRunId, grantorPrincipalId:
   tower.sync_principal_id }, { executor })`. In one transaction, under upstream's locks in upstream's order
   (`pg_advisory_xact_lock(7061636)`, then the principal row `FOR UPDATE`, `principal.factory.ts:277,320`), it
   sets the legacy role through upstream `setPrincipalRole` and replaces **every** workspace-wide and
   team-scoped row of the principal with exactly `desired` — including preset Owner/Manager rows, rows granted
   locally in the app, and tier-team rows — and writes `fork_role_assignment_sources` (`source = 'tower'`,
   `bundle_keys`, `sync_run_id`) for every surviving row plus the registry's `last_applied_legacy_role`,
   `last_applied_at`, `last_sync_run_id`. Rows are inserted with `granted_by_principal_id =
   tower.sync_principal_id` (except the Owner preset, NULL-grantor as upstream writes it). Tier membership goes
   through plan 30's service with the same `executor`. It refuses a principal missing from the registry
   (`NOT_MANAGED`) and turns any desired set into `{ user, [], [] }` while a denial is active, so a stale sync
   can never re-grant a disabled person. This plan does not delete or insert assignment rows itself and keeps no
   second provenance table. With the entitlement lease on (plan 10 O-R8), `sync-members` also calls plan 10's
   `recordEntitlementObservation(principalId, { observedAt, observationRef }, { executor })` in the same
   transaction, **only** when the tower's `tower_users.directory_observed_at` for this person is newer than the
   tenant's `entitlement_observed_at` (§4.5.4). A successful apply on its own never extends the lease (R3-2).
   Commit, then bust the returned `cacheKeysToBust`; report
   `driftReverted` items to the tower as `drift_reverted`. A failure rolls back that principal only; it keeps
   its previous set, is reported, and is retried next run.

**Ownership rules (D-C15).** The tower owns the whole app role set of every tower-managed principal; unmanaged
principals (no `fork_tower_principals` row) are never touched, and plan 10's local (fork-UI) writers refuse
managed principals (`TOWER_MANAGED`).

| Case | Behaviour |
| ---- | --------- |
| Role granted locally by an app admin to a managed principal (whether or not the tower also grants it) | Removed at the next sync unless it is in the desired set; if it is, the row is kept and re-attributed (`source = 'tower'`). There is no locally adopted role and no local survivor. Fleet runbook: grant through the tower. |
| App admin changes a managed principal's legacy role (upstream UI; not blocked, plan 10 O-R9) | Upstream's replace-all runs (`principal.factory.ts:357-398`) and may insert a preset row. The change is live until the next sync (≤ one sync interval, or immediately when triggered), which restores the desired legacy role and set, deletes the preset, and reports `drift_reverted`. `assertTowerPrincipalsFailClosed` (plan 10) flags the state meanwhile. |
| Tier membership edited locally for a managed principal | Refused by plan 30/10's local writer (`TOWER_MANAGED`); any row written another way is reverted at the next sync. |
| `tower_roles` row deleted or `tenant_template_key` retargeted | The desired set changes; the writer replaces the set in one transaction. Deleting a bundle is a soft delete (`retired_at`) until every app reports a clean sync. |
| Desired set empty, person active (last bundle removed) | `{ user, [], [] }`: legacy **`user`, zero rows, no sentinel** (plan 10 §4.8). `user` maps to no preset and the seed backfill selects only `admin`/`member`, so nothing can grant Manager. The person keeps portal access as an employee. |
| Team roles only, no workspace-wide template (defensive: the §5.2 `tower_roles` CHECK normally prevents it) | `member` + team rows + the `no_access` sentinel workspace row (plan 10), so no zero-row Manager fallback. |
| Person disabled in the directory | **Deny** (below): not a grant change; applies even if the desired set would be non-empty. |
| Person re-enabled | `liftPrincipalDenial(principalId, { onlyReason })` (plan 10 §4.9), then the normal set is applied. Revoked credentials stay revoked; the person signs in again. |
| Person leaves the tower entirely | Apply the final state (`{ user, [], [] }`, or deny) first, then delete the registry row (plan 10 §4.8). |

**Deny operation** (`fork-provision deny --user <tower user> [--workspace <key>]`; run per app by the revocation
worker, §4.5.4, and by every sync while the person stays disabled). It calls plan 10's
**`denyPrincipal(principalId, reason, { syncRunId, actor })`** (plan 10 §4.9; `reason` = `idp_removed` or
`tower_disabled`), which: in Tx 1 upserts the `fork_principal_denials` row, deletes every `session` row of the
user and sets `revoked` on every `oauth_access_token` / `oauth_refresh_token` row (all clients); in Tx 2 applies
`{ user, [], [] }` through `applyManagedRoleSet`; then revokes every API key the person created through upstream
`revokeApiKey`. The denial is effective at Tx 1 commit. After the call the tower marks its grants for the person
`revoked`. The denial does not depend on those deletions. From the Tx 1 commit it is enforced where credentials
are resolved:

- existing cookie, Bearer and widget sessions and realtime streams, by plan 10's **R-13 / R-14 / R-15**
  (plan 10 §4.9);
- an unexpired MCP JWT, by **TW-1**;
- a new sign-in by any method, by **TW-2**;
- API keys, by plan 10's R-1, which checks the key principal **and** its creator.

So a session that a sign-in racing the denial inserts is refused on first use. Demotion is cleanup: when it is
refused with `LAST_ADMIN`, the denial still holds and `denial_demote_blocked` alerts ops to restore the
break-glass admin. Plan 10's `fork-principal-denial-sweep` (shared F-8, every 5 min) is cleanup only. It deletes
leftover rows, retries demotion and records `lease_expired` denials. No bound depends on it.

Upstream IdP claim mapping only assigns **legacy** roles (`oidc-claim-mapping.ts:98-110`, `KNOWN_ROLES`), so
custom-role assignment has to be explicit — hence `sync-members` rather than app-side claim mapping.

### 4.4 Fleet migrations, catalogue reconciliation and the fork lineage

#### 4.4.1 Production artifact

The web, worker, migrator and provisioner tasks run one image. Upstream's `apps/web/Dockerfile` copies only
`packages/db/drizzle` to `/app/drizzle` (`:119`) and bundles `migrate.mjs`/`fleet-migrator.mjs` (`:72-95`), so the
fork adds a fork-owned **`apps/web/Dockerfile.fork`** (not a seam) built after the upstream image:
`ARG BASE` (= the upstream-Dockerfile image of the same commit); a builder stage bundles
`apps/web/scripts/fork-provision.ts` and `apps/web/scripts/fork-mail-router.ts` exactly as upstream bundles
`fleet-migrator.ts` (`bun build --target=bun`);
the final stage is `FROM ${BASE}` + `COPY packages/db/drizzle-fork /app/drizzle-fork` + `COPY
/tmp/fork-provision.mjs /app/fork-provision.mjs` + the same for `/app/fork-mail-router.mjs` + `ENV FORK_MIGRATIONS_FOLDER=/app/drizzle-fork`. The fork
lineage module statically imports the fork journal (inlined by bundling, like `schema-version.ts:36`) and
resolves the folder from `FORK_MIGRATIONS_FOLDER` (fallback: path relative to the module, as upstream does for
`MIGRATIONS_FOLDER`, `schema-version.ts:48`). `fork-provision` refuses to start if the folder's
`meta/_journal.json` differs from the inlined journal. **CI image gate:** the built image contains
`/app/drizzle-fork/meta/_journal.json`, `/app/fork-provision.mjs`, `/app/fork-mail-router.mjs`,
`/app/fleet-migrator.mjs`, and
`fork-provision.mjs self-check` passes inside the image.

#### 4.4.2 `fork-migrate` (fork SQL **and** catalogue)

Upstream `fleet-migrator run` reconciles apps via `runMigrations`, so on releases with upstream migrations the
fork lineage and `seedSystemData` ride along through F-1. A release with **only** fork migrations or only
catalogue changes (new fork permission keys via F-7, changed preset bundles such as Manager exclusions,
template changes) is never claimed: the claim requires `current_version < target_version`
(`fleet/schema-state.ts:121`) and `set-target` above the image max is refused (`fleet/migrator.ts:882-899`).
Catalogue reconciliation lives only in `seedSystemData` (`packages/db/src/seed-system.ts:47-102`, called from
`migrate-runtime.ts:271`), so applying fork SQL alone would never land new keys.

**Code version vs cohort target (R2-1).** No runner in an image migrates to a *target*: `runMigrations` applies
the whole bundled directory (`migrate-runtime.ts:202,257`), `fleet-migrator` enrols at `latestBundledVersion()`
(`fleet/migrator.ts:931-936`) and treats the target only as a claim trigger, and ordinary pool acquisition runs
`ensureWorkspaceSchemaCurrent` — catch-up to **every** bundled migration — before any floor check
(`pool-cache.ts:303-308`, `ensure-schema-current.ts:32-45`). So the running image's bundle **is** the upstream
target of every tenant that image touches. Rules:

- **Full path** — `runMigrations(directDsn, { seed: true, verify: true })` — only when the workspace's upstream
  ledger already contains every migration bundled in *this* image (`missingBundledMigrations(readAppliedLedger(sql))`
  is empty). Then the upstream step is a genuine no-op, F-1 applies the fork lineage and `seedSystemData`
  reconciles the catalogue and preset bundles.
- **Fork-only path** (recommended over skipping, so fork releases still land during a staged upstream rollout)
  — when the ledger is behind the image. It runs **only** the fork-lineage runner that F-1 calls inside
  `runMigrations` (02, invoked on its own under the same advisory lock) and `reconcileForkCatalogue(sql)`, a
  fork function that upserts the fenced fork keys (F-7) and recomputes their preset-bundle membership (Manager
  exclusions). It never calls upstream `migrate` or upstream `seedSystemData`. Every fork migration and
  `reconcileForkCatalogue` declare the newest upstream migration they depend on; `FORK_UPSTREAM_REQUIREMENT`
  (fork constant, max of those) must be in the ledger, else skip with `upstream_pending`. CI applies the fork
  lineage + `reconcileForkCatalogue` + template reconcile to a database migrated to exactly
  `FORK_UPSTREAM_REQUIREMENT` and fails if any statement touches a later upstream column. Status `fork_only`;
  `sync-members` is deferred to the next full-path run.
- **Never an ordinary scope for fork work.** All of `fork-migrate` runs on the maintenance scope (§4.4.6), which
  performs identity checks without `ensureWorkspaceSchemaCurrent`, so a new-image `fork-migrate` cannot catch a
  behind-the-image tenant up by acquiring a pool.
- **Serving images.** Cohort targets only stage the **pre-roll** migration pass (§4.4.5 step 2) while the old
  image still serves. Holding an active tenant on an older upstream version *after* the roll is **not supported**:
  new-image web requests and worker sweeps (`listActiveWorkspaces`) would catch it up on pool acquisition whatever
  its target. A tenant that must stay behind is **suspended** before the roll (the registry refuses it to requests
  and workers, `registry.ts:371`) and caught up at `resume`. Running several serving images pinned per cohort would
  need host routing *and* a worker-side cohort filter before pool acquisition (an upstream seam); deferred (O-15).

`fork-provision fork-migrate [--workspace <key>] [--include-suspended]`, per workspace:

1. Open the maintenance scope (§4.4.6). Choose the full or fork-only path (or `upstream_pending`) as above.
2. Run that path under the standard advisory lock.
3. In the maintenance scope run plan 10 §reconcile for fork role templates (template permission sets that
   changed in this release), then — full path only — `sync-members` for this app if the catalogue changed a
   tower-mapped template. Each reconcile commits per template.
4. **Only after step 3 committed**, in its own transaction: write `fork_settings.fork.catalogue_version =
   FORK_CATALOGUE_VERSION` (an integer constant in fork code; a CI snapshot test fails if the fork
   catalogue/templates change without bumping it); then upsert `cp_fork_schema_state(workspace_key,
   fork_version, fork_tag, catalogue_version, status, resume_status, last_error, updated_at)`. A crash before
   this step leaves the old marker, so the floor keeps refusing and a re-run redoes steps 2–3 idempotently.

It continues past per-workspace failures, exits non-zero if any active workspace failed, and is idempotent.
Suspended workspaces are listed as `deferred_until_resume` unless `--include-suspended` is given.

#### 4.4.3 Runtime fork floor (shared seam F-11)

Upstream's runtime floor (`fleet/schema-floor.ts:144-150`, called on every pool verification at
`pool-cache.ts:308`, after upstream catch-up `ensure-schema-current.ts`) reads only
`drizzle.__drizzle_migrations`. Shared seam **F-11**: first statement of `assertSchemaFloor` →
`await forkAssertSchemaFloor(workspaceKey, sql)` (`FORK-SEAM(fork-floor)`). The fork function
(`fork/fleet/fork-schema-floor.ts`):

- `FORK_MIN_SCHEMA_VERSION` (resolved against the inlined fork journal; unknown tag ⇒ throws at boot, like
  upstream `configuredSchemaFloor`) — prefix check on `drizzle.__fork_migrations`;
- `FORK_MIN_CATALOGUE_VERSION` — `fork_settings.fork.catalogue_version` must be ≥ it;
- on failure throws `WorkspaceSchemaFloorRefusal` (same code `schema_below_floor`, so the upstream 503 path and
  alarms apply unchanged). Unset variables ⇒ gate off. It does **not** migrate on the request path.

The maintenance scope never calls it on entry (that is what lets `resume` repair a tenant below the floor); it
calls `assertSchemaFloor` explicitly as the last check before the registry flips to `active` (§4.4.4).

#### 4.4.4 Suspended tenants and resume (fail closed)

`suspend` sets `state = 'suspended'`. `resume --key` keeps the registry `suspended` until the last step, and does
all work through the maintenance scope (§4.4.6) — `fleet-migrator run --workspace` is **not** used because it
refuses suspended tenants (`requireWorkspace`, `fleet/migrator.ts:978-987`):

1. Park the hostname rows (moved to `cp_parked_hostnames`); set `cp_fork_schema_state.resume_status = 'running'`.
2. Open the maintenance scope (identity checks; a failure stops here).
3. Upstream catch-up to the image bundle: `migrateDirect(workspaceKey, directDsn)` (`fleet/migrator.ts:496`; the
   gap-aware planner `ensureWorkspaceSchemaCurrent` also uses), which runs `runMigrations` — F-1 fork lineage and
   `seedSystemData` ride along. Update `cp_workspace_schema_state`.
4. `fork-migrate` steps 2–3 for this workspace (full path; the ledger now holds the bundle): template reconcile,
   then `sync-members` (role sets, and deny for disabled people).
5. Sign-in baseline assertion in-process (§4.3.1 step-6 checks).
6. Catalogue marker + `cp_fork_schema_state` (fork-migrate step 4) — its own transaction, after 3–5 committed.
7. In the maintenance scope call `assertSchemaFloor(workspaceKey, sql)` (upstream + F-11) and require success.
8. Restore the hostname rows from `cp_parked_hostnames` while still `suspended` (the host answers "suspended").
9. Set `resume_status = 'probing'`, then flip `state = 'active'` (last registry write).
10. Run the §4.3.1 HTTP probes; success → `resume_status = NULL`.

Any failure in 2–10 → hostnames parked again, `state = 'suspended'`, `state_reason = 'resume_failed:<code>'`. A
crash before step 9 leaves the tenant suspended (nothing served; re-run is idempotent: every step checks before
writing and the marker cannot precede its work). A crash between 9 and 10 is caught by the **probing reaper**: the
provisioner at start-up and every `sync-members` schedule tick re-suspends any workspace with `resume_status =
'probing'` older than 10 minutes (`state_reason = 'resume_unverified'`). `create` follows the same order (§4.3).

#### 4.4.5 Deployment order

1. Build upstream image, then `Dockerfile.fork`; CI image gate (§4.4.1).
2. With the **new** image as one-off tasks, while the **old** web/worker still serve:
   `fleet-migrator run` (cohort by cohort, if staged) → `fork-provision fork-migrate` (full or fork-only path per
   workspace, §4.4.2). Fork and upstream migrations are additive (02 §3.5), so old code on the new schema is
   supported; this is rehearsed (§9).
3. Gate: every **active** workspace has an upstream ledger containing the whole new bundle, fork status `ok`
   (not `fork_only` / `upstream_pending`) and `cp_fork_schema_state.catalogue_version = FORK_CATALOGUE_VERSION`;
   any workspace that must stay behind is suspended first. Failures block step 4.
4. Roll web/worker to the new image.
5. Only in a **later** release, raise `FORK_MIN_SCHEMA_VERSION` / `FORK_MIN_CATALOGUE_VERSION` to values every
   active workspace already reports; suspended workspaces meet them at resume (which, via the maintenance scope,
   does not need to pass the floor to start).

#### 4.4.6 Maintenance scope (R2-2)

`fork/fleet/maintenance-scope.ts` → `withForkMaintenanceScope(workspaceKey, body)` (new files, no seam). Used only
by the provisioner (`create`, `resume`, `fork-migrate`, `deny` on a suspended tenant); never by web/worker, never
cached, never reachable from a Host header.

1. Read the registry row with upstream's exported `SELECT_COLUMNS` (`registry.ts:224-239`). Accept `state` ∈
   {`active`, `suspended`}; refuse `deleting` and unknown keys.
2. Validate the record with upstream's `interpretRow` (`registry.ts:354`) on an **in-memory copy** whose `state`
   is set to `active` — the same contract validation the serving path applies; nothing is written.
3. Open a direct, session-mode connection (`db_direct_url`, password from `resolveWorkspacePassword`,
   `pool-cache.ts:213`), then run the identity sequence of `verifyWorkspaceDatabase` (`pool-cache.ts:266-300`)
   from exported pieces: `resolveWorkspaceSecrets` (`workspace-secrets.ts:118`), `observeWorkspaceIdentity`
   (`fingerprint.ts:294`), `evaluateWorkspaceIdentity` (`:538`, fingerprint + physical identity) and
   `evaluateSecretKeyCanary` (`:446`). Any refusal aborts. It deliberately omits `ensureWorkspaceSchemaCurrent`
   and `assertSchemaFloor`.
4. `createWorkspaceScope({ workspace, db, sql, secrets, origin: 'script' })` (`workspace-context.ts:146`) and
   `runWithWorkspaceScope` (`:302`) around `body`; the connection is closed afterwards.

Drift risk: step 3 is a second composition of upstream's fail-closed check (upstream warns about exactly this,
`pool-cache.ts:262-264`). A **contract test** runs `openWorkspaceDirectPool` and the maintenance scope against the
same fixtures (right DB; wrong DB; cloned DB with a different OID/cluster; wrong key; missing stamp; missing canary)
and asserts identical accept/refuse verdicts and codes; it runs on every upstream merge.

### 4.5 Identity, role bundles and app grants

#### 4.5.1 Tower login (D-C7) and SAML for apps

`apps/control-tower` (TanStack Start or Hono + React; own `package.json`, picked up by the root
`workspaces: ["apps/*"]` glob; `bun.lock` regenerated on merge). Better Auth with the **SSO plugin
(`@better-auth/sso`)**, which registers OIDC and SAML 2.0 providers from configuration; tables
`tower_auth_user|session|account|verification|sso_provider` via `modelName` mapping. The IdP (either protocol)
is an **intranet** service and is configuration, not code; the tower fetches its metadata/JWKS/token endpoint
directly on the intranet (the tower is outside `apps/web`, so the upstream SSRF guard does not apply to it). No self-signup: a subject with no role after claim mapping is refused. Cookie on
`tower.<fleet-domain>` only; MFA enforced at the IdP. Plugin version and SAML feature set verified in Phase 4
(**V-8**).

**Claim → role mapping is data** (`tower_claim_role_mappings`, §5.2): on every sign-in **and on every
directory reconcile (§4.5.4)** the tower reads the configured claim path (OIDC claim, SAML attribute or SCIM
group, e.g. `groups`), computes the set of matching roles, and replaces the user's `source = 'claim'`
memberships with it (`source = 'manual'` memberships, granted in the tower UI by `roles.manage`, are kept).
A change triggers `sync-members` for all apps.

**Apps and SAML (verified):** upstream `apps/web` signs in through Better Auth `genericOAuth` only
(`auth/index.ts:764`); `identity_provider` models OIDC (`discoveryUrl`, `issuer`, `kind` okta/auth0/keycloak/
entra/google/other, `schema/auth.ts:682-698`); the only SAML references are comments about "SAML-to-OIDC
bridges" (`auth/map-profile-claims.ts:13`, `lib/shared/oidc-claim-mapping.ts:205`). No `@better-auth/sso` in
`apps/web/package.json`. So:

- **OIDC IdP:** each app's `identity_provider` points straight at it.
- **SAML IdP:** apps point at an **intranet-hosted OIDC broker** that federates the SAML IdP (e.g. Keycloak, or
  the IdP product's own OIDC side). A cloud broker whose OAuth endpoints are on the public internet (e.g.
  Cognito hosted UI) is ruled out by D-E2. Zero seams; the broker session makes app SSO silent exactly as a native OIDC session would. The
  tower may use the SAML IdP natively or the same broker.
- Rejected: native SAML in `apps/web` (adding the SSO plugin to `auth/index.ts`, a SAML shape on the upstream
  `identity_provider` schema, login UI) — several seams in high-churn upstream auth files. See **O-2**.
- **F-12 prerequisite (verified):** every app-side call to the IdP/broker goes through the SSRF guard —
  provider save (`identity-providers.service.ts:384-395`), the SSO test (`auth/sso-test-handshake.ts:187-190`),
  and **every runtime sign-in** (discovery + userinfo via `safeFetch`, `auth/index.ts:222-239`,
  `auth/hooks.ts:815-816,832-833`). Without the F-12 allow-list naming the IdP/broker, app SSO does not work at
  all; Phase 3 cannot start before F-12 ships.

#### 4.5.2 Per-app OAuth grant (D-C2, D-C12)

Verified facts about the app authorization server:

- `@better-auth/mcp` 1.7.4 (`apps/web/package.json:27`), registered in `auth/index.ts:721-760`: `loginPage
  '/auth/login'`, `consentPage '/oauth/consent'`, dynamic client registration on by default (toggle
  `developerConfig.oauthDynamicClientRegistrationEnabled`), scopes `MCP_AS_SCOPES` = `openid profile email
  offline_access` + `read:feedback write:feedback write:changelog read:article write:article read:chat
  write:chat` (`lib/shared/api-key-scopes.ts:19-48`).
- `/auth/login` redirects to the portal root with the sign-in dialog (`routes/auth.login.tsx:11-15`,
  `lib/shared/auth-prompt.ts:24-31`) — i.e. without an app session, authorize **needs a click**. §4.5.3 removes
  that click.
- Tokens are JWTs **audience-bound to that app** (`${baseUrl}/api/mcp`, `handler.ts:89-95`) ⇒ one grant per
  (user, app). `customAccessTokenClaims` embeds `principalId` (`auth/index.ts:748-760`); the handler re-reads
  the role on every call (`handler.ts:106-113`).
- Refresh tokens: `offline_access`, rotated on refresh with family revocation on reuse, softened by
  `OAUTH_REFRESH_GRACE_SECONDS` (default 7 d, `auth/refresh-grace.ts`).
- `oauth_client.skip_consent` exists (`schema/auth.ts:1003`).
- Step-up: missing scope → HTTP 403 `insufficient_scope` (`handler.ts:210-247`).

Design:

- **Client registration:** the provisioner registers one confidential client per app ("Quackback Control
  Tower", `redirect_uri = https://tower.<fleet-domain>/oauth/callback/<key>`, `client_secret_basic`,
  `authorization_code refresh_token`) through the app's unauthenticated RFC 7591 endpoint (via the private DNS zone), then — inside the workspace
  scope — sets **`skip_consent = true`** on that one `oauth_client` row (D-C12: the tower is a trusted
  first-party client). `client_id/secret` go to the tower sealed with the tower's KMS key into
  `tower_tenant_clients`. Attribution is unchanged: the human still authenticates to the app.
- **Scopes requested** = union of the OAuth scopes required by the user's tower capabilities (§6), plus
  `openid email offline_access`. When a user gains a capability that needs a new scope, the grant is marked
  `needs_reconnect` and re-obtained by the silent flow.
- **Storage:** `tower_tenant_grants` holds refresh + current access token, envelope-encrypted with a KMS data
  key (tower CMK, tower task role only). Access tokens refreshed on demand under a row lock per grant (tower
  replicas never refresh the same grant concurrently, avoiding reuse-triggered family revocation). Refresh
  failure → `needs_reconnect`.
- **V-4 (validation):** access/refresh-token TTLs of the deployed plugin; that `skip_consent` suppresses the
  consent page for `authorization_code` + PKCE. The tower relies on `expires_in` only.

#### 4.5.3 "Connect all apps" — silent SSO chain (D-C12)

Why it can be silent: (1) the user already has an **IdP session** from the tower login; (2) every app has an
`identity_provider` for that IdP and a **pre-linked `account`** for the user (§4.3), so app SSO completes
without any app-side prompt or account-linking step; (3) the tower's client has **`skip_consent`**. What is
missing upstream is only an entry point that starts app SSO without the sign-in dialog click. It is a new
fork file, **not a seam**: `apps/web/src/routes/api/fork/tower-connect.ts` (GET):

1. Validates `next` is a same-origin `/api/auth/oauth2/authorize` URL whose `client_id` equals
   `fork_settings.tower.oauth_client_id` and whose `redirect_uri` equals `tower.redirect_uri`. Anything else →
   400. (No open redirect: both targets come from `fork_settings`, written by the provisioner.)
2. If an app session exists → 302 to `next`.
3. Otherwise it calls Better Auth's social sign-in server-side for `tower.sso_provider_id` (the path
   `startOidcSignIn` uses, `lib/client/start-oidc-sign-in.ts:7-20`) with `callbackURL = next` and
   `errorCallbackURL = /api/fork/tower-connect?failed=1&state=<state>`, forwarding the state cookie, and 302s to
   the IdP.
4. `failed=1` → 302 to `tower.redirect_uri?error=sso_failed&state=<state>` so every failure returns to the tower.

The route has no `requireAuth`/`withApiKeyAuth` gate, so the authz-matrix scan (`scan.ts:30-41`) records
nothing and no `classifications.ts` entry is needed.

Chain, per run:

1. Tower creates `tower_connect_runs` (queue of apps lacking a live grant with the needed scopes). It pre-checks
   each app with `GET https://<host>/api/health` and marks unreachable apps `skipped: unreachable`.
2. For the head of the queue: tower generates PKCE + `state` (run id, app key, nonce; verifier kept
   server-side) and navigates the top window to `https://<host>/api/fork/tower-connect?next=<authorize URL>`.
3. App → IdP (session live, returns immediately) → app callback (pre-linked account, session) → authorize
   (`skip_consent`) → `tower/oauth/callback/<key>?code=…`.
4. Tower exchanges the code and checks the access token's `sub` (= tenant `user.id`, `mcp/handler.ts:98-99,122`)
   and `principalId` claim against `tower_user_app_identities` for (tower user, app) — **not** email (else
   revoke + `failed: identity_mismatch`; no mapping row yet → `failed: not_provisioned`, run `sync-members`).
   It stores the grant with that `tenant_principal_id` and redirects to the next app's `tower-connect` URL.
5. After the last app: summary page (connected / failed with reason / skipped).

Failures: IdP needs interaction (expired session, MFA step-up) → the IdP page shows, then the chain resumes on
its own; app SSO error, disabled or unlinked account → `failed: sso_failed` via step 4 of the route; consent
page appears (client lacks `skip_consent`) → user may approve, and `verify` reports the misconfigured app;
OAuth `error=` on the callback → `failed: <error>`; user abandons mid-chain → the run stays open and the tower
home offers "resume" (next hop continues from the queue). A failed app never blocks the rest of the chain.

**Edge SSO proxy (D-E1).** The browser hops pass through the edge proxy like any employee request; while the
edge session is live (normally one IdP session covers edge, tower and apps) the proxy adds at most a silent
redirect per new host. The tower's server-side calls (code exchange, refresh, MCP) and the `/api/health`
pre-check use the private DNS zone to the internal ALB (§4.1, O-13).

#### 4.5.4 Identity mapping, sync authority and revocation (C3)

**Identity chain** (email is an attribute on every hop, never the link):

| Hop | Key | Stored in | Written by |
| --- | --- | --- | --- |
| Tower user | `tower_users.id` | control DB | tower (first login) |
| Org IdP identity | (`issuer`, `subject`) of the tower login | `tower_user_idp_links` (`provider_key = 'tower'`) | tower |
| App-facing IdP identity | (`issuer`, `subject`) the **app** sees: the org IdP's for OIDC; the **broker's** own subject for SAML (a broker issues its own `sub`) | `tower_user_idp_links` (`provider_key = 'app'`) | provisioner — for a broker it creates/looks up the brokered user through the broker admin API with the federated link to the SAML NameID (persistent format required) before any app sign-in |
| Tenant user | `user.id` = MCP token `sub` (`mcp/handler.ts:98-99,122`) | `tower_user_app_identities.tenant_user_id`; tenant `account(providerId, accountId = app-facing subject)` | provisioner (`sync-members`) |
| Tenant principal | `principal.id` = token `principalId` claim | `tower_user_app_identities.tenant_principal_id`; tenant `fork_tower_principals.tower_user_id` | provisioner |

`tower_users.email` may change at the IdP without relinking anything. Upstream links SSO accounts by verified
email for trusted providers (`auth/index.ts:524-531`); the fork does not rely on or patch that — `sync-members`
removes any extra `account` row for the tower SSO provider (§4.3.2 step 1) and the connect chain rejects a
token whose `sub`/`principalId` differ from the mapping.

**Sync authority** — who performs which operation:

| Operation | Performed by | Credential |
| --------- | ------------ | ---------- |
| create / suspend / resume / deprovision / fork-migrate / rotate | provisioner task | root key + master DB creds |
| First provisioning of members, identity mapping, account pre-linking | provisioner `sync-members` | root key (scoped DB) |
| Role / bundle / team-mapping changes, scheduled reconcile | provisioner `sync-members` | root key |
| Directory-driven changes (group removal → role-set resync; user disabled → deny) — no human token exists | tower `tower_revocation_jobs` → revocation worker (`fork-provision worker`) running `deny` / `sync-members --user` per app | root key |
| Tower OAuth client registration, `skip_consent` | provisioner | root key |
| Read and act surfaces, announcements, portfolio | tower via **human MCP** token (D-C2) | user's per-app OAuth grant |

Human MCP tokens are never used to change roles or membership, and the provisioner never performs a surface
action on a user's behalf.

**Directory sync and revocation (D-C16, R2-4; O-9).** Login-time claims are not revocation, and a tower session
cap does not reach an existing app session or token, so revocation is driven by **directory sync** only and ends
in a tenant-level deny, not a grant change.

- **Sources.** (1) **SCIM 2.0 push** (preferred): the tower exposes `/scim/v2/Users|Groups` (bearer secret in
  Secrets Manager) for the intranet IdP; `active=false`, user delete, or group membership change is applied to
  `tower_users.status` / `source = 'claim'` memberships in the same request. (2) **Directory-API polling**
  (fallback, and a safety net even when push is configured): every `TOWER_DIRECTORY_POLL_MS` (default 5 min) a
  full or delta read of users and groups, same effect. `tower_directory_sync_state` records the last successful
  push and poll.
- **Directory observations (R3-2).** The lease (below) renews only from these observations, which are written
  in the same control-DB transaction as the change they come from:
  - **Poll.** A poll that completes successfully sets, for every user it covered:
    - `tower_users.directory_observed_at` = the read's **start** time;
    - `directory_observation_ref` = poll run id + the directory's cursor/version (delta token or `ETag`).

    A full read covers every user it returns. A delta read counts only when it advanced from the last
    successful cursor, and then covers every user in scope.
  - **SCIM.** A request carrying a user's **full** resource with `active = true` (POST or PUT) sets
    `directory_observed_at` = the receipt time, with ref = the request id, for that user. A PATCH does not.
  - **Failures.** An errored, partial or cursor-reset poll writes no observation.
  - **Tenant writes** never create one.
- **Queue.** Every change writes a durable `tower_revocation_jobs` row per (user, app) in the same control-DB
  transaction: `kind` ∈ {`deny`, `resync`, `undeny`}. A long-running **revocation worker** (the provisioner image
  run as an ECS service, `fork-provision worker`, same task role — no `RunTask` cold start) claims jobs
  (`FOR UPDATE SKIP LOCKED`), runs `deny` / `sync-members --user` per app (§4.3.2), concurrency 5 apps.
  The tower marks its own grants for the user `revoked` immediately, so tower surfaces stop at once.
- **Retries.** Per job: exponential backoff 30 s, 1, 2, 4 min (≈ 8 min in-target budget), then every 5 min
  indefinitely with `revocation_lag` alarming; an unreachable or suspended app keeps its job pending (a suspended
  app runs it at `resume`, §4.4.4 step 4).

**Budget — 15 minutes is a target (p99), not a hard maximum.**

| Stage | Push path | Poll path |
| --- | --- | --- |
| IdP → tower learns of the change | ≤ 1 min (IdP-dependent) | ≤ 5 min (poll interval) + read time ≤ 1 min |
| Job queued → claimed | ≤ 30 s | ≤ 30 s |
| Deny applied in one app (one tenant transaction + cache bust) | ≤ 30 s | ≤ 30 s |
| Retry allowance for transient app/DB failures | ≤ 8 min | ≤ 8 min |
| **End-to-end target** | **≤ 10 min** | **≤ 15 min** |

Effect once `denyPrincipal` Tx 1 commits (§4.3.2):

- the next web, portal, widget or upload request gets 401, because plan 10's R-13/R-14 check the denial when
  the session is resolved, even for a session row that survived or raced the deletion;
- a stream handshake is refused and an open stream closes within one heartbeat (R-15);
- the next MCP call gets 401 (TW-1, even for a valid JWT);
- refresh is refused, API keys are refused (plan 10 R-1), and a new sign-in by any method is refused (TW-2).

Plan 10's F-8 sweep then cleans up every 5 min. It is not part of the bound.

**Failure behaviour.** Directory unavailable (push errors and no successful poll for 2× the poll interval) →
`directory_sync_stale` alarm; deny jobs already queued keep running; no one is revoked who was not reported.
Per-app deny failing past the budget → `revocation_lag` alarm naming the app and user.

**Optional hard bound: the entitlement lease** (off by default; plan 10 O-R8,
`fork_settings['rbac.entitlement_lease']`).

- **Renewal (R3-2).** `sync-members` hands the person's latest **directory observation** (above) to plan 10's
  `recordEntitlementObservation`, which sets
  `fork_tower_principals.entitlement_expires_at = GREATEST(current, LEAST(observedAt, now()) + lease)`
  (e.g. 60 min). It ignores an observation that is not newer than the recorded one.
- **What does not renew it.** A successful `applyManagedRoleSet` or a whole successful `sync-members` run
  without a newer observation leaves the expiry unchanged. Reapplying cached tower state therefore never
  extends access.
- **Enforcement.** Plan 10's `isPrincipalDenied`/`isUserDenied` treat an expired lease as a denial on
  **every authenticated request**: R-13/R-14/R-15, TW-1, TW-2 and R-1. The F-8 sweep only records
  `lease_expired` and cleans up.
- **Lifting.** A renewal that moves the expiry past `now()` lifts only `lease_expired`.
- **The bound, identical to plan 10 §4.9.** With the lease on, access ends at the last directory observation
  of the person as active + lease duration. That is at most the lease duration after disablement, even when
  the directory, the tower, the provisioner, `sync-members` or the sweep is down. With the lease off, there is
  no hard maximum, only the target above.
- **Cost.** A directory outage longer than the lease locks out every tower-managed person. Break-glass admins
  are not tower-managed and are unaffected.
- **Prerequisites.** The lease requires the directory poll (plan 10 O-R10): SCIM push alone cannot renew
  people whose state did not change. `verify` refuses to enable the lease unless the poll is healthy and every
  registry row has an observation. `verify` also reports push/poll health, the oldest observation per app and
  the lease mode per deployment.

### 4.6 MCP coverage for tower surfaces

Verified in `apps/web/src/lib/server/mcp/tools/*.ts` (index `tools/index.ts:1-50`):

| Surface          | Existing tools (file)                                                                                              | Gap → fork tool (`mcp/tools/fork-fleet.ts` unless noted)                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Support inbox    | `list_conversations`, `get_conversation`, `reply_to_conversation` (auto-assigns), `set_conversation_status` (conversations.ts) | `assign_conversation` (→ `assignConversation`, `conversation.service.ts:1477`; team via `assignTeam` `:1542`) |
| Tickets          | `list_tickets`, `get_ticket`, `create_ticket`, `reply_to_ticket`, `add_ticket_note`, `link_ticket`, `unlink_ticket` (tickets.ts) | `assign_ticket` (`ticket.service.ts:744`), `set_ticket_status` (`ticket.service.ts:415`) |
| Feedback         | `search`, `get_details`, `triage_post`, `merge_post`, `unmerge_post`, `delete_post`, `restore_post`, `get_post_activity`, comment tools | —                                                                             |
| Roadmap          | resource `quackback://roadmaps` (read); column = post status (`roadmap.types.ts:23`) so a move is `triage_post {statusId}` | `list_roadmap_posts` (→ `getRoadmapPosts`, `roadmap.query.ts:214`)            |
| Changelog        | `create_changelog`, `update_changelog`, `delete_changelog`, `search {entity:"changelogs"}`                         | —                                                                             |
| Dashboard counts | none                                                                                                               | `get_workspace_overview` (→ `getAdminOverview`, `admin-overview.query.ts:69`)  |
| Announcements    | none                                                                                                               | `fork-announcements.ts` (owned by 60): `list_announcements` (read, `announcement.view`), `upsert_announcement`, `archive_announcement`, `list_announcement_templates` (`announcement.manage`) |
| Portfolio        | none relied on (`get_details` is not part of the contract)                                                         | batch `list_post_prioritization` (owned by 50, §4.9.1 there), read-only        |

Rules for this plan's fork tools (`fork-fleet.ts`): `registerTool` with `{ scope, teamOnly: true }`
(`tools/helpers.ts:150-199`) — the MCP scan attests name/scope/teamOnly (`scan.ts:297-322`); after D3 each also
checks its permission key through the plan 10 actor helper. Keys and scopes are exactly those in the
contract table (§6.1); every read tool uses a read scope, so read-only bundles never request a write scope.
Registration via shared seam **F-3** (`fork-index.ts` → `fork-fleet.ts`).

### 4.7 Fan-out

- App list: tower reads `cp_workspace_registry` (state `active`) + hostnames + `cp_workspace_activity` through
  a **column-limited grant** (no `db_*`, `*_ref` columns).
- Per request: `mapWithLimit(apps, TOWER_FANOUT_CONCURRENCY=6, t => withTimeout(mcpCall(t, tool, args),
  TOWER_TENANT_TIMEOUT_MS=4000))`; results tagged `{workspaceKey, hostname}`; failures returned as
  `degraded[{key, reason: timeout|needs_reconnect|http_<code>|refused}]`; merged/sorted in the tower.
  Composite cursor `{key: toolCursor}`. Only apps where the viewer holds a live grant are queried.
- MCP transport is stateless JSON (`handler.ts` `enableJsonResponse: true`); one POST per tool call.
- **Dormancy:** every MCP call is an activity signal (`workspaces/activity.ts:106-113`) and wakes a dormant
  app. So: no background polling; aggregate views skip apps whose `last_active_at` is older than
  `WORKSPACE_DORMANT_AFTER_HOURS` ("dormant — load" per app); dashboard counts cached 60 s per (user, app).
- Rate limit: per-user token bucket; bulk actions sequential per app with confirmation.

### 4.8 Actions and dual audit

Write flow: tower capability check → confirm dialog → `tower_audit` row `status='pending'` → MCP `tools/call`
with that user's token → update row `ok|denied|error|uncertain` + app result ids (`uncertain` = no tool result
received: timeout, reset, 5xx; the tower never retries a non-idempotent write automatically — it re-reads the
target first, as §4.9 does by `broadcastId`). App side the domain service acts as the
user's principal, producing native records (post activity, conversation messages, changelog author).
Validation V-5: for every tool the tower calls, a native record naming the principal exists.

### 4.9 Announcements surface (Phase 6, D-N8)

Tower page composes one announcement and fans it out as `upsert_announcement` to selected apps with a shared
`broadcastId` (idempotent upsert, 60 §4.9), plus `archive_announcement`, and a saved-text picker fed by
`list_announcement_templates` (D-N4). Per-app outcome is one of **`succeeded`**, **`failed`** (a tool,
permission or validation error returned by the app) or **`uncertain`** (timeout, connection reset, 5xx
without a tool result). An `uncertain` app is reconciled — automatically and on "retry" — by
`list_announcements({ broadcastId })` and, if absent, re-sending the same `upsert_announcement`; the UI shows
"uncertain → succeeded/failed", never `failed` while uncertain, and a `tower_audit` row never substitutes for a
missing app row. Writes are gated by tower capability `announcements.publish` (Fleet Owner and Fleet Agent
seed bundles, D-N8) and app key `announcement.manage`; the read-only list view is gated by
`announcements.view` and app key `announcement.view` with scope `read:feedback`, so Observer tokens stay
read-only. Until Phase 6 ships the tower has no announcements surface (R10).

### 4.10 Caveats (re-verified)

- **Platform credentials:** `config.platformCredentialsSource` returns `'control-plane'` whenever
  `QUACKBACK_TENANCY=pooled` (`config.ts:635-637`); `QUACKBACK_CONTROL_PLANE_URL` stays unset (04 §3), so
  integration OAuth apps relying on platform credentials are unavailable. SaaS integrations are not used on the
  intranet anyway (04 §4); **V-6** only confirms that the intranet integrations in use (self-hosted GitLab / n8n /
  ntfy, after F-12) do not rely on platform credentials. App SSO sign-in is **not** affected (identity_provider
  credentials are per-workspace).
- **Fleet S3 credential (E-2):** with no `credentialRef`, `resolveStorageCredentials` (`s3.ts:210-222`) uses
  `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` — static keys only, no AWS default credential chain — so the fleet
  uses one IAM user scoped by bucket policy (and a `aws:SourceVpce` condition) to the fleet bucket, keys in
  Secrets Manager injected into the task env. If IAM roles are mandatory, conditional seam **E-2a** (owned by 04)
  applies instead. `provider` must be the literal `'r2'` (`vendor/contract.ts:71,285`); **V-7** confirms AWS S3
  works through that record shape against the **S3 VPC endpoint** (the client is generic S3;
  endpoint/region/path style come from the record) with `S3_PROXY=true` and `publicUrl` on the app's own
  `/api/storage`.
- **Email (process-wide, acceptable for one operator):** outbound via SMTP to the SES SMTP VPC endpoint or an
  internal relay (`EMAIL_SMTP_HOST/_PORT/_USER/_PASS`, `packages/email/src/index.ts:181-195`; SES SMTP
  credentials are static and live in Secrets Manager, E-2); the SES-API variables and `EMAIL_RESEND_API_KEY` stay
  unset (SES API would take precedence over SMTP, `index.ts:170-174`). SES/SNS delivery-event ingestion is
  **disabled** (E-3): bounces/complaints are not tracked in-app; SES account-level suppression still applies.
  Each app's `email_from` is on an internal domain. Set a workspace logo (the default template logo is an
  internet URL, 04 §3).
- **AI:** process-wide, through the internal OpenAI-compatible proxy (D-E5/D-E6, 04 §3); `ai_enabled` per app in
  the registry is unchanged.
- **AWS access without internet:** the provisioner's and tower's AWS calls (RDS/RDS Proxy API, Secrets Manager,
  KMS, ECS `RunTask`, S3, CloudWatch Logs) use VPC interface/gateway endpoints; no task has a NAT or internet
  gateway route.
- Root-key blast radius (D-C4): Secrets Manager + KMS, only web/worker/migrator/provisioner task roles;
  rotation by bumping `v<gen>` (requires re-encryption; `stored-ciphertext.ts` — never re-stamp the canary over
  un-re-encrypted data). Rotating an app's `SECRET_KEY` also rotates its inbound address key (§4.11).

### 4.11 Per-app inbound email (D-C11; permanently fork-only per D1)

Mail arrives from the company's **internal mail server** (D-E2): there is no SES receiving, no internet MX and no
provider webhook.

**Upstream today (verified):**

- Reply addresses are `<mailSlug>+<c|t><id-suffix>.<tag>@<inbound domain>`; the tag is
  `HMAC-SHA256(key, "<slug>\0<id>")` (`signInboundTag`, `conversation.email-channel.ts:413-417`), minted by
  `inboundReplyToAddress`/`inboundTicketReplyToAddress` and verified by `claimVerifies` (`:546-552`). The key
  comes from `signingKey(env)` (`:243-248`), which reads the **process-wide** `EMAIL_INBOUND_SIGNING_SECRET`
  (`:143`). `TENANCY.md:673-676` calls one shared secret the blocker for enabling email on a pooled fleet. The
  bare `<mailSlug>@<inbound domain>` is each workspace's platform inbox (cold mail).
- The mail slug is a registry field (`registry.ts:459`, `vendor/contract.ts:197`) read by `currentMailSlug()`
  from the current workspace scope (`conversation.mail-slug.ts`).
- **IMAP inbound is process-wide and refuses pooled tenancy.** `readImapConfig` reads one mailbox from
  `EMAIL_INBOUND_PROVIDER=imap` + `IMAP_HOST/PORT/USER/PASSWORD/TLS/MAILBOX` env (`conversation.email-imap.ts:53-70`);
  `isEmailImapPollable` returns false under `QUACKBACK_TENANCY=pooled` and logs why — every workspace loop would
  poll the same mailbox and ingest the same message into its own database (`conversation.email-imap-queue.ts:17-24,
  47-60`). The lower layer is reusable: `createImapClient(config)` (`conversation.email-imap.ts:241`) returns an
  `ImapClient` with `fetchUnseen()` (raw RFC822 + UID), `markSeen(uid)` and `close()` (`:34-45`), all exported and
  free of workspace dependencies. `pollOnce` (`:78-96`) is **not** reusable for routing: it hands its callback only
  `parseRawEmail(raw)`, dropping the raw message and delivery headers (R2-7).
- Two front doors on `POST /api/chat/email/inbound`: the Resend webhook (Svix-verified with the inbound secret,
  `email-webhook-handler.ts:37`) and the raw-MIME edge door (`email-cloudflare-handler.ts`), authenticated by a
  separate fleet key `INBOUND_HMAC_SECRET` (`:99`) over `timestamp.mailSlug.body`; it refuses mail whose signed
  slug is not this host's workspace (`deliveryNamesThisWorkspace`, `:374`, called at `:551`); it is live when
  the inbound domain, inbound secret and edge key are set (`:226-228`).
- CSAT email links already use the workspace `SECRET_KEY` (`csat-email-token.ts:35-39`), not the inbound secret.

**Choice of per-app mailbox model.** Two ways to give each app its own inbound address on the internal server:

| Model | What it needs | Verdict |
| --- | --- | --- |
| **A. One fleet mailbox + per-app plus-addressing by `mail_slug`** (default) | Mail team, once: a dedicated inbound mail domain (e.g. `qb-mail.<company>`) whose every recipient is delivered into one mailbox, delivered one copy per envelope recipient, with any inbound copy of the routing header deleted and the envelope recipient stamped in it (V-9). Fork: the mail router below. | Zero seams, no per-app mail-server work, reuses the upstream address grammar and the upstream raw-MIME door with its slug binding. |
| B. One mailbox per app | Mail team: a mailbox + credentials per app. Fork: a per-workspace poll job (shared seam F-8) reading sealed per-app IMAP credentials from `fork_settings`, reusing `createImapClient`/`pollOnce`/`ingestParsedEmail` in scope (here `pollOnce` fits: ingest is local, no forwarding). | Fallback only if the mail team cannot provide a catch-all domain (O-11). |

**Fork change (model A):**

1. **Per-app address key (kept; D-C11).** New `apps/web/src/lib/server/fork/inbound-email/address-key.ts`:
   `forkInboundAddressKey(): Buffer | null | undefined` — `undefined` when not pooled (upstream path
   unchanged for single-tenant); otherwise `HKDF-SHA256(getWorkspaceSecretKey(), salt 'quackback-fork',
   info 'fork:inbound-address:v1:<workspaceKey>:<currentMailSlug()>', 32)`, or `null` with no workspace scope
   (fail closed: no mint, no verify). `getWorkspaceSecretKey()` (`workspace-context.ts:229`) is synchronous
   and is itself `HKDF(root key, <key>, 'app-secrets')` (`vendor/fleet-secrets.ts:120-138`), so the address key
   is derived from the fleet root key without the app ever handling the root key and **without** adding a
   purpose to the vendored closed list `FLEET_SECRET_PURPOSES` (`fleet-secrets.ts:87`, which would be a seam in
   the vendored contract). No module state; pure function. The transport change does not touch this: the key
   signs and verifies addresses, whoever delivers the mail.
2. **Seam IE-1** — first line of `signingKey()` in `conversation.email-channel.ts`:
   `const forkKey = forkInboundAddressKey(); if (forkKey !== undefined) return forkKey`. Both minting
   (`signInboundTag`) and verification (`claimVerifies`) go through `signingKey`, so both become per-app.
   Mint and verify run inside the app's scope (senders via `currentMailSlug()`; the inbound door is resolved by
   Host), so the same key is derived on both sides.
3. **Mail router (replaces `apps/mail-edge`; R2-7).** Logic `apps/web/src/lib/server/fork/mail-router/*`, entry
   `apps/web/scripts/fork-mail-router.ts`, bundled as `/app/fork-mail-router.mjs` by `Dockerfile.fork` (§4.4.1).
   Runs as one ECS service (singleton by a Postgres advisory lock in the control DB; a second task idles).
   It does **not** use `pollOnce`: that function parses each message before its callback
   (`ingest(parseRawEmail(message.raw))`, `conversation.email-imap.ts:78-96`), so the callback never sees the raw
   MIME or the delivery headers. The router has its own loop over the lower layer: every
   `FORK_MAIL_ROUTER_POLL_MS` (default 15 s) `createImapClient(config)` (`:241`; `config` built from
   `FORK_MAIL_ROUTER_IMAP_*` in Secrets Manager, not from `readImapConfig`'s env) → `fetchUnseen()` (returns
   `{ uid, raw }`, `:34-45`; at most 50 UIDs per poll, `MAX_UIDS_PER_POLL`) → per message: steps 1–2, then
   **spool** — put the raw bytes to the fleet bucket at `mail-spool/<message_key>.eml` (idempotent) and insert one
   `cp_mail_deliveries` row per slug (`pending`, `ON CONFLICT DO NOTHING`) — then `markSeen(uid)` → `close()`.
   Delivery (steps 3–4) runs from the spool, not from IMAP, so messages waiting for a retry never occupy the
   50-UID window and starve new mail. A crash between spool and `markSeen` re-fetches the same bytes → same
   `message_key` → no new rows.
   1. **Trusted recipient.** Exactly one routing header, `FORK_MAIL_ROUTER_RCPT_HEADER` (default
      `X-Fleet-Envelope-To`), read from the raw header block. **Mail-server requirement (V-9):** on the inbound
      domain's transport the server delivers **one copy per envelope recipient**, first **deletes every inbound
      instance** of that header, then stamps its own with the SMTP `RCPT TO`. A copy with zero or several
      instances is spooled and dead-lettered at once (`status = 'dead'`, `mail_slug = '*'`,
      `last_error = 'bad_envelope'`) with an alarm. There is **no `To`/`Cc` fallback** — headers are
      sender-controlled, and a BCC recipient never appears in them.
   2. Slug via `workspaceSlugFromInboundAddress` (`conversation.email-channel.ts:612-617`); resolve
      `mail_slug → primary_hostname, state` through the column-limited control-DB role `cp_mail_router`. Unknown
      slug or non-active app → `unroutable` (terminal, recorded at spool time; alarm metric; no bounce — the sender is an employee on the
      same mail system, O-11).
   3. For each `pending`/`retrying` row whose `next_attempt_at` has passed: POST the spooled **raw bytes unchanged** to `https://<primary_hostname>/api/chat/email/inbound` (private DNS →
      internal ALB, §4.1) with the upstream edge wire contract (`email-cloudflare-handler.ts:10-20`):
      `x-qb-mail-slug`, `x-qb-envelope-to` = the trusted recipient, `x-qb-timestamp` = now (fresh on every
      attempt, so a retry is never outside the door's replay window), `x-qb-signature` over
      `timestamp.mailSlug.body` with `INBOUND_HMAC_SECRET`, and `x-qb-transport-message-id` = SHA-256 of the raw
      message with the routing-header lines removed (identical on every copy and every retry;
      `email-cloudflare-handler.ts:120-132,602-605`).
   4. **Outcome per (copy, slug)**, recorded in `cp_mail_deliveries(message_key, mail_slug, …)`
      (`message_key` = SHA-256 of that copy's raw bytes, stable across retries):

      | Door response | Router action |
      | --- | --- |
      | 2xx (any JSON status, including `duplicate`) | `delivered` (terminal) |
      | 400, 403, 405, 413, 415, 422 and any other 4xx not listed below | **permanent**: `dead` (terminal) — spooled copy kept (moved to `mail-dead-letter/<yyyy-mm-dd>/<message_key>.eml`), alarm, **no retry**; ops can replay with `fork-mail-router replay <message_key> <slug>` |
      | 401 (door could not verify — our key management), 404 (host does not serve that slug yet — routing disagreement that resolves itself; the door deliberately does not mark it permanent, `email-cloudflare-handler.ts:403-416`), 408, 429, 5xx, timeout, connection error | `retrying`; `next_attempt_at = now() + min(30 s × 2^attempts, 15 min)`; after **24 h** from `first_seen_at` → `dead` as above |

   **Deduplication across the crash window.** If the router dies after the tenant accepted a delivery but before
   `cp_mail_deliveries` says `delivered`, the next poll re-POSTs. The tenant refuses the repeat itself: every
   ingest path checks `inboundDedupeKey` — the `Message-ID`, else the transport id above
   (`conversation.email-inbound.ts:167-175`) — before writing (reply `conversation.email-inbound.service.ts:501-508`,
   cold `:645-652`, ticket reply `:825-832`), backed by the partial unique index
   `conversation_messages_email_message_id_idx` (`packages/db/src/schema/conversation.ts:365-367`), and answers
   2xx `duplicate`. No fork dedup table or seam is needed. Residual (upstream behaviour): a `Message-ID` longer than
   `MAX_DEDUPE_KEY_CHARS` (255, `conversation.email-inbound.ts:137`) yields no key at all, so such a message can
   duplicate on redelivery.
   The router inherits upstream IMAP's text decoding (`socket.setEncoding('utf8')`, `conversation.email-imap.ts:122`)
   and signs exactly the bytes it sends, so the door's byte signature verifies; fidelity for non-UTF-8 8-bit
   bodies is the same as single-tenant IMAP. Friendly per-app addresses (e.g. `payroll-help@<company>`) are
   aliases on the mail server that forward to `<mail_slug>@<inbound domain>`.
   The edge key `INBOUND_HMAC_SECRET` stays fleet-wide: it only authenticates the router, and because the slug
   is inside its signature a captured delivery cannot be re-aimed at another app (handler note 3). See **O-3**.
4. **Configuration.** Web/worker: `EMAIL_INBOUND_DOMAIN` = the inbound mail domain; `INBOUND_HMAC_SECRET`
   (router key); `EMAIL_INBOUND_SIGNING_SECRET` must still be set (a random fleet value, never shared) because
   the "configured" gates test for it (`:270-271`, `:296-297`); under pooled it signs no addresses.
   **Leave `EMAIL_INBOUND_PROVIDER` / `IMAP_*` unset on web/worker** — upstream's poller would refuse pooled
   anyway (with an error log); the mailbox credentials exist only in the router task. The Resend door is unused:
   it stays reachable with the fleet inbound secret, which never leaves Secrets Manager; the internal ALB may
   additionally drop requests on that path carrying `svix-*` headers. Set `EMAIL_EVENTS_SIGNING_SECRET` to its
   own random value so the (disabled, E-3) delivery-event route never falls back to the inbound secret
   (`email/email-delivery-webhook.ts:32-35`); no SNS subscription is created.
5. **Rotation.** Bumping an app's `app-secrets` generation changes its address key; old Reply-To addresses
   then fail verification and replies fall back to `In-Reply-To`/`References` threading or a new conversation
   (the documented degradation, `conversation.email-channel.ts:275-295`). Acceptable given rare rotations.

## 5. Data model

### 5.1 Control DB — registry (`apps/control-tower/migrations/0001_registry.sql`)

Own lineage (`apps/control-tower/migrations/meta/_journal.json`, ledger `drizzle.__tower_migrations`), applied
by `apps/control-tower/scripts/migrate.ts`. Never in `packages/db`.

```sql
CREATE TYPE cp_workspace_state AS ENUM ('active','suspended','deleting');          -- vendor/contract.ts:65
CREATE TYPE cp_hostname_kind  AS ENUM ('system','platform','platform_redirect','custom'); -- contract.ts:67
CREATE TABLE cp_workspace_registry (
  workspace_key text PRIMARY KEY, contract_version integer NOT NULL,
  state cp_workspace_state NOT NULL DEFAULT 'active', state_reason text,
  primary_hostname text NOT NULL, base_url text NOT NULL,
  db_pooled_url text NOT NULL, db_direct_url text NOT NULL, db_name text NOT NULL, db_role text NOT NULL,
  db_credential_ref text NOT NULL, app_secrets_ref text NOT NULL,
  workspace_id text NOT NULL, fingerprint_stamped_at timestamptz NOT NULL,
  storage jsonb NOT NULL, email_from text NOT NULL, mail_slug text NOT NULL UNIQUE,
  ai_enabled boolean NOT NULL DEFAULT false, revision bigint NOT NULL DEFAULT 1,
  pg_database_oid bigint, pg_cluster_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE cp_workspace_hostnames (
  hostname text PRIMARY KEY,
  workspace_key text NOT NULL REFERENCES cp_workspace_registry ON DELETE CASCADE,
  kind cp_hostname_kind NOT NULL, redirect_to_hostname text,
  CHECK ((kind = 'platform_redirect') = (redirect_to_hostname IS NOT NULL)));
CREATE INDEX ON cp_workspace_hostnames (workspace_key);
CREATE TABLE cp_workspace_activity (
  workspace_key text PRIMARY KEY REFERENCES cp_workspace_registry ON DELETE CASCADE,
  last_active_at timestamptz NOT NULL);                     -- upsert shape: activity.ts:144-146
-- revision bump (resolver.ts:8-10: "bumped by a database trigger on any change")
CREATE FUNCTION cp_bump_revision() ... BEFORE UPDATE ON cp_workspace_registry
  -> NEW.revision := OLD.revision + 1; NEW.updated_at := now();
CREATE FUNCTION cp_bump_parent_revision() ... AFTER INSERT/UPDATE/DELETE ON cp_workspace_hostnames
  -> UPDATE cp_workspace_registry SET revision = revision + 1 WHERE workspace_key = …;
```

Columns reproduce `RegistryRow` (`registry.ts:61-86`) and `SELECT_COLUMNS` (`:224-239`; `state::text`,
`kind::text` at `:275`), `toRecord` (`:436-462`), `listActiveWorkspaces` (`:322-347`).

`0002_schema_state.sql`: the CP fixture `fleet/__tests__/fixtures/0049_tenant_schema_state.sql` verbatim, then
the CP-0054 rename the upstream test reproduces (`schema-state.test.ts`): `cp_tenant_schema_state` →
`cp_workspace_schema_state`, `tenant_id` → `workspace_key`, FK retargeted. `status` stays `text + CHECK`.

`0004_fork_state.sql` (fork-only, §4.4): `cp_fork_schema_state(workspace_key pk fk, fork_version int, fork_tag
text, catalogue_version int, status text check in (ok,fork_only,failed,upstream_pending,deferred_until_resume),
last_error text, updated_at)`; `cp_parked_hostnames` (same columns as `cp_workspace_hostnames` + `parked_at`,
`reason`) for publish-last on create/resume; `cp_mail_deliveries(message_key text, mail_slug text, status text
check in (pending,delivered,retrying,unroutable,dead), attempts int, http_status int, first_seen_at,
next_attempt_at, spool_key text, last_error text, updated_at; pk (message_key, mail_slug))` for the mail router's
spool (§4.11, R2-7), pruned (with `mail-spool/` objects) after 30 days; dead letters kept 90 days.
`cp_fork_schema_state` also carries `resume_status text null check in (running, probing)` for the probing reaper
(§4.4.4).

Grants: `cp_reader` (web/worker): SELECT registry/hostnames, INSERT/UPDATE activity; `cp_migrator`: + RW
schema_state; `cp_provisioner`: RW all `cp_*` + SELECT `tower_users`, `tower_roles`, `tower_role_members`,
`tower_role_app_teams`, `tower_user_idp_links` + RW `tower_user_app_identities`;
`cp_mail_router` (mail router): column SELECT `(mail_slug, primary_hostname, state)` on the registry + RW
`cp_mail_deliveries` (its task role also gets S3 put/get/delete on the fleet bucket's `mail-spool/` and
`mail-dead-letter/` prefixes only); `tower_app`: column SELECT
on registry (`workspace_key, state, state_reason, primary_hostname, base_url, revision`), SELECT
hostnames/activity, RW `tower_*`.

### 5.2 Control DB — tower (`0003_tower.sql`)

| Table                       | Columns                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tower_users`               | `id uuid pk`, `idp_subject text unique`, `email citext unique`, `name`, `status text check in (active,disabled)`, `last_login_at`, `directory_observed_at timestamptz null` and `directory_observation_ref text null` (R3-2: the last successful directory read that covered this user, §4.5.4; the only lease renewal source), timestamps (replaces v2-r1 `tower_admins`); `idp_subject` is a denormalised copy of the `tower` row in `tower_user_idp_links` |
| `tower_roles`               | `id uuid pk`, `key text unique`, `name`, `description`, `capabilities text[]` (⊆ code catalogue §6, checked on write), `tenant_template_key text null` (workspace-wide `fork_role_templates.template_key` from 10; null ⇒ none, e.g. Fleet Owner = legacy Admin), `tenant_team_template_key text null` (team-scoped template; non-null requires `tenant_template_key` non-null or legacy `admin`, CHECK), `tenant_legacy_role text check in (admin,member) default 'member'`, `is_seed bool`, `retired_at timestamptz null` (soft delete, §4.3.2), timestamps |
| `tower_role_app_teams`      | `role_id fk`, `workspace_key fk`, `tenant_team_id text` (verified to exist at every sync; missing ⇒ `unmapped_team`), `set_by uuid`, timestamps; pk (`role_id`,`workspace_key`) |
| `tower_user_idp_links`      | `user_id fk`, `provider_key text check in (tower,app)`, `issuer text`, `subject text`, `linked_at`; pk (`user_id`,`provider_key`); unique (`issuer`,`subject`) |
| `tower_user_app_identities` | `user_id fk`, `workspace_key fk`, `tenant_user_id text`, `tenant_principal_id text`, `linked_at`, `verified_at`; pk (`user_id`,`workspace_key`); unique (`workspace_key`,`tenant_user_id`), unique (`workspace_key`,`tenant_principal_id`) — written only by the provisioner |
| `tower_role_members`        | `user_id fk`, `role_id fk`, `source text check in (claim,manual)`, `granted_by uuid null`, `created_at`; pk (`user_id`,`role_id`,`source`) — multi-role (D-R4)                   |
| `tower_claim_role_mappings` | `id uuid pk`, `provider_id text` (tower SSO provider), `claim_path text` (OIDC claim or SAML attribute), `match text check in (equals,contains)`, `value text`, `role_id fk`, `enabled`, timestamps |
| `tower_tenant_clients`      | `workspace_key pk fk`, `client_id`, `client_secret_ct bytea`, `wrapped_dek`, `registered_at` (accepted, X-R6)                                                                   |
| `tower_tenant_grants`       | `id uuid pk`, `user_id fk`, `workspace_key fk`, `tenant_principal_id text` (must equal `tower_user_app_identities`), `scopes text[]`, `refresh_token_ct bytea`, `access_token_ct bytea`, `access_expires_at`, `wrapped_dek bytea`, `kms_key_id`, `status text (active,needs_reconnect,revoked)`, `last_used_at`; unique (`user_id`,`workspace_key`) |
| `tower_connect_runs`        | `id uuid pk`, `user_id fk`, `queue jsonb` (ordered `[{key, status: pending|connected|failed|skipped, reason}]`), `created_at`, `completed_at`                                     |
| `tower_audit`               | `id uuid pk`, `user_id fk`, `user_email`, `workspace_key`, `tool text`, `args_digest`, `args_summary jsonb` (redacted), `target_ref`, `status (pending,ok,denied,error,uncertain)`, `tenant_result jsonb`, `request_id`, `created_at`; indexes (`workspace_key`,`created_at`), (`user_id`,`created_at`); append-only except status transition via function. Role/membership/mapping edits are audited here too (`tool = 'tower.roles.*'`). |
| `tower_directory_sync_state` | `source text pk check in (scim_push,directory_poll)`, `last_success_at`, `last_success_started_at` (poll read start; the observation time), `last_error_at`, `last_error text`, `cursor text null` (delta token), `version text null` (directory ETag/version of the last successful read) — drives `directory_sync_stale` (§4.5.4) and the observation refs |
| `tower_revocation_jobs` | `id uuid pk`, `user_id fk`, `workspace_key fk`, `kind text check in (deny,resync,undeny)`, `cause text` (e.g. `scim:active=false`), `status text check in (queued,running,done,retrying)`, `attempts int`, `next_attempt_at`, `enqueued_at`, `done_at`, `last_error`; index (`status`,`next_attempt_at`); claimed with `FOR UPDATE SKIP LOCKED` by the revocation worker |
| `tower_auth_*`              | Better Auth user/session/account/verification/sso_provider (generated shape, own lineage)                                                                                       |

PKCE verifiers for in-flight hops live in `tower_auth_verification` (Better Auth) or the tower session, keyed by
`state`.

### 5.3 Tenant DB (fork lineage, `packages/db/drizzle-fork/`)

| Table | Columns |
| ----- | ------- |
| `fork_tower_principals` | Plan 10 §4.8's **managed-principal registry**: `principal_id pk → principal.id ON DELETE CASCADE`, `tower_user_id uuid unique`, `app_idp_issuer`, `app_idp_subject`, `managed_since`, `last_applied_legacy_role text`, `last_applied_at timestamptz`, `last_sync_run_id text` (written by `applyManagedRoleSet`), `last_sync_status text`, `entitlement_expires_at timestamptz null`, `entitlement_observed_at timestamptz null`, `entitlement_observation_ref text null` (lease, plan 10 O-R8; written only by plan 10's `recordEntitlementObservation` from a directory observation, R3-2). Inserted in the same transaction as the first `applyManagedRoleSet`; deleted only after the final state or a denial is applied (D-C15). |

`fork_principal_denials` and `fork_role_assignment_sources` are plan 10's tables (§5 there); this plan writes them
only through `denyPrincipal` / `applyManagedRoleSet`.

**Removed (R2-3):** `fork_tower_assignments` (and its `adopted_local` flag). Assignment provenance lives only in
plan 10's `fork_role_assignment_sources` (`source = 'tower'`), written by `applyManagedRoleSet`; because the tower
owns the whole role set, removal needs no provenance lookup (everything not desired goes).

Plus `fork_settings` keys: `tower.oauth_client_id`, `tower.redirect_uri`, `tower.sso_provider_id`,
`tower.sync_principal_id`, `fork.catalogue_version`. If a principal is deleted its rows cascade away and
the next sync recreates the principal from the tower-side mapping (and updates `tower_user_app_identities`).

## 6. Permissions

**Tower capability catalogue** (code, `apps/control-tower/src/server/capabilities.ts`). The OAuth scopes a
grant requests are derived from §6.1 (union over the user's capabilities, plus `openid email offline_access`);
every `*.view` capability maps to read scopes only.

| Capability | App OAuth scopes |
| ---------- | ---------------- |
| `dashboard.view`, `roadmap.view`, `feedback.view`, `portfolio.view`, `changelog.view`, `announcements.view` | `read:feedback` |
| `inbox.view`, `tickets.view` | `read:chat` |
| `feedback.act`, `roadmap.act`, `announcements.publish` | `write:feedback` (+ `read:feedback`) |
| `inbox.act`, `tickets.act` | `write:chat` (+ `read:chat`) |
| `changelog.publish` | `write:changelog` (+ `read:feedback`) |
| `apps.provision`, `apps.suspend`, `roles.manage`, `audit.view` | — (tower-only; executed by the provisioner) |

**Seed bundles** (`is_seed = true`, fully editable; more can be added — D-C9; defaults confirmed under D-C5 🟡):

| Seed bundle | Tower capabilities | Workspace-wide app role (`tenant_template_key`) | Team-scoped role |
| ----------- | ------------------ | ---------------------------------------------- | ---------------- |
| Fleet Owner | all | legacy **Admin** (Owner preset) (D-C5 🟡) | — |
| Fleet Agent | all `*.view`, `inbox.act`, `tickets.act`, `feedback.act`, `roadmap.act`, `announcements.publish` (D-N8) | "Fleet Agent" (D-C5 🟡) | — |
| Fleet Observer | all `*.view` | "Fleet Observer" (D-C5 🟡, D-R7) | — |
| UX | `feedback.*`, `roadmap.*`, `portfolio.view`, `dashboard.view` | "UX Team" | — |
| Dev | `feedback.view`, `roadmap.*`, `changelog.*`, `dashboard.view` | "Dev Team" | — |
| Stakeholder | `dashboard.view`, `roadmap.view`, `portfolio.view`, `changelog.view` | "Stakeholder (read-only)" | — |
| Tier 1/2/3 Agent | `inbox.*`, `tickets.*`, `dashboard.view` | "Tier N Agent" (workspace-wide part) | "Tier N Agent" on the team mapped per app in `tower_role_app_teams` (O-10 🟡); no mapping ⇒ no grant in that app |

### 6.1 Shared contract: capability → tools/arguments → app permission → scope

The tower calls **only** these tools. App permission is what the app checks after D3 (plan 10's
argument-aware MCP map; plan 10 owns argument/branch resolution). A bundle's tenant template must hold the
listed keys for its capabilities to work; the `verify --contract` provisioner check compares each tower-mapped
template's permission set with this table and reports gaps per app.

| Capability | MCP tool (arguments the tower sends) | App permission | Scope |
| ---------- | ------------------------------------ | -------------- | ----- |
| `dashboard.view` | `get_workspace_overview {}` (fork) | `analytics.view` | `read:feedback` |
| `feedback.view` | `search {entity:'posts', query?, cursor?}`; `get_details {id: post}`; `get_post_activity {postId}` | teammate read (+ `post.view_private` for private items) | `read:feedback` |
| `feedback.act` | `triage_post {postId, statusId?}` / `{tagIds?}` / `{ownerPrincipalId?}` — one argument family per call | `post.set_status` / `post.set_tags` / `post.set_owner` | `write:feedback` |
| `feedback.act` | `merge_post {duplicatePostId, canonicalPostId}`, `unmerge_post` | `post.merge` | `write:feedback` |
| `roadmap.view` | resource `quackback://roadmaps`; `list_roadmap_posts {roadmapId, cursor?}` (fork) | teammate read | `read:feedback` |
| `roadmap.act` | `triage_post {postId, statusId}` only | `post.set_status` | `write:feedback` |
| `changelog.view` | `search {entity:'changelogs'}` | teammate read (+ `changelog.view_draft` for drafts) | `read:feedback` |
| `changelog.publish` | `create_changelog`, `update_changelog`, `delete_changelog` | `changelog.manage` | `write:changelog` |
| `inbox.view` | `list_conversations`, `get_conversation` | `conversation.view` (+ `conversation.view_all`) | `read:chat` |
| `inbox.act` | `reply_to_conversation`; `set_conversation_status`; `assign_conversation {conversationId, assigneePrincipalId?, teamId?}` (fork) | `conversation.reply`; `conversation.set_status`; `conversation.assign` | `write:chat` |
| `tickets.view` | `list_tickets`, `get_ticket` | `ticket.view` (+ `ticket.view_all`) | `read:chat` |
| `tickets.act` | `reply_to_ticket`; `add_ticket_note`; `set_ticket_status` (fork); `assign_ticket` (fork) | `ticket.reply`; `ticket.note`; `ticket.set_status`; `ticket.assign` | `write:chat` |
| `announcements.view` | `list_announcements {broadcastId?, state?}` (60) | `announcement.view` | `read:feedback` |
| `announcements.publish` | `upsert_announcement {broadcastId, …}`, `archive_announcement`, `list_announcement_templates` (60) | `announcement.manage` | `write:feedback` |
| `portfolio.view` | `list_post_prioritization {statusSlugs?, boardIds?, states?, framework?, minScore?, sort?, cursor?, limit?}` (50 §4.9.1) | `post.view_private` | `read:feedback` |

Not called by the tower: `delete_post`, `restore_post`, `create_post`, `vote_post`, `proxy_vote`, help-center,
suggestion and widget tools, tier escalation and account actions.

- **Tower enforcement:** a user's capabilities = union over their bundles; checked in `apps/control-tower`
  server handlers before any MCP call, and UI surfaces are hidden without the capability.
- **App enforcement (after D3):** each app enforces the custom role(s) `sync-members` assigned. Tower and app
  bundles are derived from the same `tower_roles` row; drift only arises from a local edit to a template, which
  plan 10's template reconcile repairs and `verify --contract` reports. **Until D3 ships, MCP enforces only
  legacy role + scopes** (`tools/helpers.ts:219-251`), so Phase 5 is gated on plan 10 Phase 1a.
- **New permission keys from this plan:** none. It consumes 60's `announcement.view` / `announcement.manage`
  and 50's use of `post.view_private`.

## 7. Seams

| # | Upstream file | Change (one line) | Why unavoidable | Re-apply on conflict |
| - | ------------- | ----------------- | --------------- | -------------------- |
| IE-1 | `apps/web/src/lib/server/domains/conversation/conversation.email-channel.ts` (`signingKey`, `:243`) | `const forkKey = forkInboundAddressKey(); if (forkKey !== undefined) return forkKey` (`FORK-SEAM(inbound-email)`) + its import | The address key is read from process env in the one function both mint and verify use; no injection point exists. Permanently fork-only (D1). | Re-add as the first statement of whatever function returns the HMAC key for `signInboundTag`/`claimVerifies`. |
| shared | `apps/web/src/lib/server/fleet/schema-floor.ts` (`assertSchemaFloor`, `:144`) | first statement `await forkAssertSchemaFloor(workspaceKey, sql)` (`FORK-SEAM(fork-floor)`) | **F-11** (shared, `SEAMS.md`; previously listed here as C-2). The fork function (`fork/fleet/fork-schema-floor.ts`) is owned by this plan; not counted here. | — |
| shared (prerequisite) | `apps/web/src/lib/server/content/ssrf-guard.ts` (+ webhook write check) | env allow-list for intranet CIDRs/hosts | **F-12** (Foundations, E-1). Without it app SSO against the intranet IdP cannot be saved, tested, enforced or used (§4.5.1). Not counted here. | — |
| TW-1 (R2-4) | `apps/web/src/lib/server/mcp/handler.ts` (`handleMcpRequest`, after `:244` `if (auth instanceof Response) return auth`, inside plan 10's R-4 fenced block — one edit site) | `if (auth.authMethod === 'oauth' && await isPrincipalDenied([auth.principalId])) return <upstream 401 + WWW-Authenticate>` (`FORK-SEAM(principal-deny)`), before scope step-up | `resolveOAuthContext` verifies the JWT statelessly and re-reads only `principal.role` (`:88-113`); it never consults `oauth_access_token.revoked`, so a revoked but unexpired JWT still authenticates. `isPrincipalDenied` is plan 10's (§4.9; also covers the lease). API-key MCP calls are covered by plan 10's R-1. | Re-add immediately after `resolveAuthContext` returns a context, before any scope/plan gate, in the same fenced block as R-4. |
| TW-2 (R2-4, R3-1) | `apps/web/src/lib/server/auth/index.ts` (`databaseHooks.session.create.before`, `:631-641`) | first statement: `if (await isUserDenied(sessionData.userId)) return false` (`FORK-SEAM(principal-deny)`) — refuses the session row before it exists | Every Better Auth sign-in method (SSO, magic link, email OTP, password, recovery code, one-time token) creates its session through this hook, so it is the one place to stop a new session. It is **not** what makes denial immediate: a row inserted by a sign-in that raced the denial, or written without the hook (`routes/api/widget/identify.ts:138`), is refused on use by plan 10's **R-13** (same file: the `auth.api` proxy `:899-911` and `auth.handler` `:912-925`), **R-14** (`getWidgetSession`) and **R-15** (chat stream). A directory-disabled person is normally refused by the IdP, but a stale IdP session, a re-enabled IdP account, or an expired lease must not mint a session. `isUserDenied` is plan 10's (§4.9). | Re-add as the first statement of whatever Better Auth hook runs before a session row is inserted. **Semantic test on every upgrade:** plan 10's R3-1 race test (§9). |
| C-1 (conditional, V-1) | `apps/web/src/lib/server/workspaces/pool-cache.ts` | `prepare: config.workspacePoolPrepare` at `:179`/`:402` (env `WORKSPACE_POOL_PREPARE`, default true) | Only if RDS Proxy pins on prepared statements. | Replace the two literals again. |
| shared | `mcp/tools/index.ts` | `registerForkTools` | **F-3**, not counted here. | — |
| dep | `packages/db/src/migrate-runtime.ts`; MCP actor construction | fork lineage; custom-role enforcement | **F-1** (Foundations) and R-3…R-5 (10-rbac); not counted here. | — |

**Count: 3 seams (IE-1, TW-1, TW-2) (+1 conditional, C-1).** Second pass (R2-4) added TW-1 (same fenced block
as plan 10's R-4) and TW-2.

**Third review (R3-1): no new seam here, but more integration than estimated.** Denial of existing sessions
needs plan 10's R-13 (`auth/index.ts`, the file TW-2 already edits), R-14 (`functions/widget-auth.ts`) and
R-15 (`routes/api/chat/stream.ts`), which are counted in plan 10. Revocation in this plan depends on all of
them. Together with TW-1, TW-2 and R-1 they must be **semantically** tested on every upstream upgrade (plan
10's R3-1 race test and resolver guard), not only found by grep. Added no seam: the maintenance scope (R2-2) composes exported upstream pieces
(`SELECT_COLUMNS`, `interpretRow`, `resolveWorkspacePassword`, `resolveWorkspaceSecrets`, the fingerprint
evaluators, `createWorkspaceScope`/`runWithWorkspaceScope`, `migrateDirect`, `assertSchemaFloor`) and is guarded by
a parity contract test; the deny operation is plan 10's `denyPrincipal` (fork code; its sweep uses shared
F-8). The tower role-set writer is plan 10's `applyManagedRoleSet` (its seams, incl. R-1, are plan 10's). Removed by the intranet revision: nothing
that was a seam — the deleted `apps/mail-edge/**` (SES receipt + Lambda + SQS DLQ) was fork-owned; the mail router
that replaces it is new files and needs no seam: it imports `createImapClient`/`ImapClient` (not `pollOnce`,
R2-7), `workspaceSlugFromInboundAddress`, and speaks the existing raw-MIME door contract; tenant-side dedup is
upstream's Message-ID / transport-id check. Model B
(per-app mailboxes, O-11) would add a use of shared seam F-8. Everything else is new files: `apps/control-tower/**`,
`apps/web/src/lib/server/fork/{provisioner,inbound-email,mail-router,fleet}/**`, `apps/web/src/routes/api/fork/tower-connect.ts`,
`apps/web/scripts/fork-provision.ts`, `apps/web/scripts/fork-mail-router.ts`, `apps/web/Dockerfile.fork`, `apps/web/src/lib/server/mcp/tools/fork-fleet.ts`,
fork migrations for §5.3. Generated: `MATRIX.md` (fork tools), `GRAPH.md`, `bun.lock`. Upstream's
`apps/web/Dockerfile` is **not** edited (§4.4.1).

## 8. Phases

| Phase | Deliverable | Validation gate |
| ----- | ----------- | --------------- |
| **0. AWS spikes** (in the no-egress VPC) | Shared Aurora cluster + RDS Proxy + fleet S3 bucket + VPC endpoints (S3, Secrets Manager, KMS, ECS, RDS, Logs, SES SMTP) + internal ALB, internal DNS/private-CA certificate + 1 hand-made app | V-1 pinning measured (C-1 decision recorded); V-2 password auth; V-3 DSN/OID via proxy; V-7 S3 via `provider:'r2'` record through the VPC endpoint with static keys + `S3_PROXY=true`; V-4 token TTLs + `skip_consent` behaviour; V-9 internal mail server delivers one copy per envelope recipient, deletes inbound copies of the routing header and stamps its own (a forged header sent from outside is gone on arrival); V-10 private-DNS bypass of the edge proxy keeps Host/audience; no task has an internet route (egress test) |
| **1. Control DB** | `apps/control-tower/migrations` 0001–0004 + migrate script + grants | Registry parity test green; `apps/web` boots pooled against a hand-seeded row; `fleet-migrator status/enrol` work |
| **2. Provisioner** | `Dockerfile.fork` + image gate; `fork-provision create/verify/suspend/resume/deprovision/fork-migrate`; maintenance scope (§4.4.6) + parity contract test; full/fork-only `fork-migrate` paths; probing reaper; sign-in baseline (§4.3.1) + break-glass codes; F-11 fork floor; `cp_fork_schema_state` | Two apps provisioned; `verify` passes (secrets, storage prefix + `/api/storage` read-back, `skip_consent`, baseline fields); Quackback-level probes: writes refused without a session and with an anonymous session, every non-SSO sign-in/sign-up door refused; edge probe gets the SSO challenge; forced probe failure unpublishes + suspends; fingerprint refusals on a mis-wired row = 503 with the right code; `workspace-probe` isolation passes; mail slug > 13 chars refused; the F1 rehearsals and the R2-1/R2-2 tests (§9) pass |
| **3. App SSO + members** (after **F-12** and plan 10 Phase 3 + Phase 3t incl. R-13/R-14/R-15 + §4.9) | IdP rows (OIDC direct or via intranet broker), verified domain, enforcement flip, `sync-members` over `applyManagedRoleSet` with bundles + multi-role + adopt-by-subject, deny via `denyPrincipal`, seams TW-1/TW-2, SCIM endpoint + directory poll with per-user directory observations (R3-2) + `tower_revocation_jobs` + revocation worker, `tower-connect` route | SSO start reaches the intranet IdP (F-12 allow-list; fails without it); user signs into both apps via the IdP (direct OIDC and via broker) and lands on the mapped principal (no duplicate user, no email-linked extra account); a non-tower employee is JIT-created as portal `user`; a tower user who JIT-signed-in first is adopted by subject; `enforced` flips after the first real SSO sign-in; the managed-role-set (R2-3) tests (§9) pass; the R2-4 disable test passes (session, MCP JWT, refresh, API key, new sign-in all refused within the target; `directory_sync_stale` fires with sync down); the R3-1 existing-session and R3-2 lease-freshness tests (§9) pass with the sweep stopped; `tower-connect` rejects a foreign `client_id`/`redirect_uri` |
| **4. Tower shell** | Better Auth + SSO plugin (OIDC and SAML), `tower_roles`/members/claim mappings + roles UI, silent "connect all", grants (KMS), `tower_audit` | Sign-in via an OIDC IdP and via a SAML IdP; claim-mapped roles applied, unknown subject refused; connect-all across 2 apps with **no consent screen and no click**; one app down → skipped, chain continues; identity mismatch → revoked; token refresh + `needs_reconnect`; tower task has no root-key/DSN access (IAM policy test) |
| **5. Read + act** (after 10-rbac 1a) | `fork-fleet.ts` tools, unified inbox/tickets/feedback/roadmap/changelog/dashboard, actions | One app down → partial result; dormant app skipped; reply in A + status change in B from one screen; `tower_audit` + app activity both name the human; Fleet Observer write via MCP denied by the app; capability hidden in UI and refused server-side |
| **6. Announcements** (after 60; later — R10 not delivered before it ships) | Tower announcements page over `fork-announcements.ts` | Fleet Owner **and** Fleet Agent publish to 2 apps; per-app `succeeded/failed/uncertain`; a timeout after tenant commit shows `uncertain` then reconciles to `succeeded` with no duplicate row; Fleet Observer lists but cannot publish (token has no write scope); bundle without `announcements.publish` cannot |
| **7. Portfolio** (after 50; later — R11 not delivered before it ships) | Read-only cross-app views over `list_post_prioritization` | Scores match app UI; bundle template lacking `post.view_private` → app denies and `verify --contract` reports it; no write path |
| **8. Per-app inbound email** (after Phase 2; parallel to 3–7) | `fork/inbound-email/address-key.ts`, seam IE-1, raw-message mail router over `createImapClient`/`fetchUnseen` with S3 spool (`fork/mail-router/`, `/app/fork-mail-router.mjs`, ECS service), `cp_mail_router` grant + `cp_mail_deliveries`, fleet mailbox + inbound domain on the internal mail server (V-9 header stripping) | Reply to app A's address lands in A; an address minted in A, re-slugged to B, fails verification in B; A's key ≠ B's key; single-tenant install unchanged (env key); unknown slug recorded `unroutable` + alarm; the R2-7 test (§9) passes (BCC, cross-tenant recipients, forged headers, crash after tenant accept → no duplicate, 413 dead-lettered, 5xx retried); mail to A and B in one message lands in both; router signature matches the upstream contract test vectors; web/worker have no `IMAP_*` |
| **9. Ops hardening** | Deploy runbook (§4.4.5), cluster backup/PITR + restore drill (D-C8), rate limits, alarms (fork-migrate failures, `schema_below_floor`, `drift_reverted`, `revocation_lag`, `directory_sync_stale`, `resume_unverified`, mail `dead`) | Upgrade rehearsal on a **populated** fleet (active + suspended apps, local and tower-owned grants, denied principals): merge upstream, image gate, migrate fleet, fork-migrate, resume an old suspended app, probe + tower e2e + inbound email e2e green |

## 9. Testing

- **Registry parity** (`apps/web/src/lib/server/fork/control-plane/__tests__/registry-ddl.test.ts`): scratch DB
  from `apps/control-tower/migrations/*.sql`; run the real `listActiveWorkspaces`, `resolveWorkspaceByHostname`,
  `resolveWorkspaceById` against a provisioned-shape row (fleet-bucket storage, no `credentialRef`) → `kind: 'ok'`;
  assert every `SELECT_COLUMNS` identifier exists; revision bumps; `schema-state.ts` claim/complete.
- **Provisioner integration:** scratch Postgres; maintenance scope and `withWorkspaceScopeById` pass for the
  right database; negative cases (canary under wrong key, stamp for another key, cloned DB); `sync-members`
  idempotence and multi-role add/remove.
- **Maintenance-scope parity (R2-2, mandatory, every upstream merge):** `openWorkspaceDirectPool` and
  `withForkMaintenanceScope` over the same fixtures (right DB; wrong DB; cloned DB with a different OID/cluster;
  wrong key; missing stamp; missing canary) give identical accept/refuse verdicts and codes; the maintenance
  scope never calls `ensureWorkspaceSchemaCurrent` (spy) and refuses `deleting`.
- **Fork rollout rehearsals (F1, mandatory, scratch fleet of ≥ 3 workspaces, one suspended):**
  1. *Fork-only permission release:* image adds a fork permission key + a Manager exclusion, no upstream
     migration → `fleet-migrator run` claims nothing; `fork-migrate` lands the key, the Manager preset loses the
     excluded key, `catalogue_version` bumps; without `fork-migrate` the raised fork floor refuses with
     `schema_below_floor`.
  2. *Suspended-then-resumed (R2-2):* suspended app misses two catalogue releases while both serving floors are
     raised; `resume` with the newest image catches up upstream + fork + catalogue before hostnames return. Kill
     the task after each of the ten §4.4.4 steps: before step 9 the tenant is still `suspended` and every route
     answers "suspended"; after step 9 without probes the reaper re-suspends it (`resume_unverified`); the
     catalogue marker is never newer than the committed reconcile; a re-run completes. Forced catch-up failure
     leaves it suspended with `resume_failed:*`.
  2a. *Image vs cohort target (R2-1):* a tenant whose upstream ledger is held at an older target; new-image
     `fork-migrate` takes the fork-only path (or `upstream_pending` below `FORK_UPSTREAM_REQUIREMENT`) and the
     withheld upstream migration is absent afterwards; the tenant is suspended for the roll, and a request to its
     host and a worker sweep from the new image both leave the ledger unchanged; the deploy gate refuses to roll
     while an **active** tenant is behind the image bundle; the CI check applies the fork lineage + catalogue +
     template reconcile to a DB at exactly `FORK_UPSTREAM_REQUIREMENT`.
  3. *Partial failure:* one workspace's fork migration fails → others succeed, exit non-zero, deploy gate
     blocks web rollout, re-run completes idempotently.
  4. *Previous-code / new-schema:* old image serves every surface against the new upstream + fork schema
     (additive rule), then new image rolls.
  Plus: image gate (files present, journal match, `self-check`); `fork-migrate` path choice (full / fork-only /
  `upstream_pending`); marker written only after reconcile commit (crash injection).
- **Sign-in baseline (C1 fail-closed rules + D-E3, mandatory):** freshly provisioned app — every §4.3.1 field
  stored explicitly (no upstream default leaks through: `allowAnonymous`, both `openSignup`, every `oauth` key,
  `hmacRequired`); without a session and with an anonymous session, create post / vote / comment / support
  submit / widget identify without HMAC / public REST writes are refused and no row is created; email/password
  sign-in + sign-up, magic link, email OTP and each social provider refused; SSO start redirects to the IdP;
  a non-domain email cannot sign up; a domain employee is JIT-created as portal `user` despite closed sign-up;
  `enforced` stays false until the unlock rule holds, then flips, and a non-SSO method for the domain is then
  hard-blocked; no SSO-only state without active break-glass codes; partial config (write fails mid-way) → no
  hostname published; `resume` re-asserts. Edge probe (deployment test): unauthenticated request through the
  edge gets the SSO challenge.
- **Tower-managed role sets (R2-3/D-C15, mandatory):** initial Fleet Observer provisioning (registry row +
  exactly the Observer row with `source = 'tower'` provenance in one transaction, no Manager row, legacy
  `member`); the R2-3 sequence — local grant of role X → tower adds X (row re-attributed to `tower`) → tower
  removes X (row gone, no local survivor; with no bundle left: legacy `user`, zero rows, no sentinel,
  `permissionsForPrincipal` returns ∅ teammate permissions) → app admin changes the legacy role (preset inserted;
  live until next sync) → `seedSystemData` / `fork-migrate` / sync (desired set restored, preset removed,
  `drift_reverted`; seed heal 5a/5b adds nothing); template replacement (bundle retargeted → one transaction);
  Tier bundle with/without a team mapping; team-roles-only `member` holds the `no_access` sentinel; deleted
  tower role; concurrent sync runs and a concurrent upstream `setPrincipalRole` on one principal serialise (no
  zero-row `member` observed); a sync racing a deny re-grants nothing; `assertTowerPrincipalsFailClosed` clean
  after every step.
- **Disable / revocation (R2-4/D-C16, mandatory):** a locally privileged managed user with a live web session,
  an unexpired MCP JWT + refresh token and an API key they created, who never visits the tower, is disabled in
  the directory. SCIM push path and poll path: within the §4.5.4 target, web request 401, MCP 401 despite a
  valid JWT (TW-1), refresh refused, API key refused (plan 10 R-1), a new sign-in by SSO and by each other
  method creates no session (TW-2), tower grants `revoked`; per-stage timings recorded against the budget
  table. Directory/SCIM unavailable: `directory_sync_stale` at 2× poll interval, nothing revoked that was not
  reported; after recovery the deny lands within the target; with the lease on, access ends at lease expiry
  (plan 10 sweep). App unreachable → job retried, `revocation_lag` alarm, applied when it returns; suspended
  app → applied at `resume`. Grep test on `FORK-SEAM(principal-deny)` over **all** denial sites: TW-1 and TW-2
  here, plus plan 10's R-1, R-13 (2 sites), R-14 and R-15 (2 sites). The grep is not sufficient on its own; the
  two tests below are mandatory.
- **Existing-session denial (R3-1, mandatory, sweep stopped):**
  1. Disable a managed user in the directory while an SSO sign-in for them is held after TW-2's check.
  2. The revocation worker commits the deny, then the insert is released.
  3. Before any sweep, each of these is refused: a portal write, a dashboard request, `/api/auth/get-session`,
     a widget-Bearer call, a widget upload, a portal upload, and a chat-stream handshake (cookie and
     pre-minted token). An open stream closes within one heartbeat.
  4. **Last-admin case:** with the break-glass admin removed, the demotion reports
     `demote_blocked_last_admin` and `denial_demote_blocked` alerts ops, while every request above is still
     refused. After the provisioner restores the break-glass admin, the sweep completes the demotion.
- **Lease freshness (R3-2, mandatory, lease on, sweep stopped):**
  1. Stop the directory poll and SCIM, and keep scheduled `sync-members` succeeding.
  2. `tower_users.directory_observed_at` and the tenant `entitlement_expires_at` never advance.
  3. At `last observation + lease` every path (web, portal, widget, stream, MCP JWT, API key, new SSO sign-in)
     is refused, with no worker running.
  4. When the poll resumes, the next sync renews the lease and lifts only `lease_expired`.

  Also check:
  - a failed or partial poll and a SCIM PATCH record no observation;
  - `verify` refuses to enable the lease while the poll is unhealthy or any registry row lacks an
    observation.
- **Identity (C3):** OIDC direct and SAML-via-broker users map to the recorded `tenant_user_id`/principal; an
  email change at the IdP does not relink; an email-auto-linked extra account is removed by sync; connect chain
  rejects a token whose `sub`/`principalId` differ from the mapping; IdP group removal → role set replaced
  in every app within the target (SCIM push and poll paths); contract test: every tool in §6.1 exists with the listed
  scope and permission (`scan.ts` output) and read capabilities never request a write scope.
- **Inbound email (fork `__tests__`):** mint/verify round-trip under two scoped workspaces with distinct keys;
  cross-workspace forgery refused; `forkInboundAddressKey()` returns `undefined` when not pooled and `null`
  unscoped; seam present (grep test on `FORK-SEAM(inbound-email)`). Mail router (fake `ImapClient` exposing
  `fetchUnseen`/`markSeen`/`close`, as upstream's tests fake it): exactly one trusted routing header required,
  zero or several → `bad_envelope` dead letter; `To`/`Cc` never used (BCC recipient routed only by its envelope
  copy); slug normalisation parity with `workspaceSlugFromInboundAddress`; unknown/suspended slug →
  `unroutable`; spool then `markSeen` (crash between → same `message_key`, no new rows); retrying messages do not
  block new mail beyond the 50-UID window; status table (2xx incl. `duplicate` → delivered; 400/413/415/422 →
  dead, no retry; 401/404/408/429/5xx/timeout → backoff, re-signed with a fresh timestamp; 24 h → dead); request
  bytes and headers match the upstream edge contract vectors; singleton lock. **End-to-end (R2-7, mandatory):**
  against two real tenants through the real door — cold mail, replies, BCC, one message to both tenants, forged
  routing header injected by the sender (stripped by the mail server fixture), crash after tenant 2xx before
  the delivery record → redelivery answered `duplicate`, one visible message; an id-less message retried → still
  one message (transport id); raw MIME bytes byte-identical at the door; no delivery to a tenant the envelope
  did not name.
- **tower-connect route:** open-redirect cases (foreign host, foreign `client_id`, foreign `redirect_uri`),
  session-present shortcut, failure bounce to the tower.
- **MCP fork tools:** per-tool scope, teamOnly, D3 permission denial; authz-matrix snapshot regenerated;
  F-11 seam present (grep `FORK-SEAM(fork-floor)`).
- **Tower:** capability union from multiple bundles; claim mapping (OIDC claim, SAML attribute); fan-out
  (timeouts, partials, cursor merge); grant crypto (KMS mocked); e2e with two apps and a Keycloak container
  acting as OIDC IdP and as SAML IdP (plus broker) on a private address (F-12 allow-list set) covering
  connect-all → act → dual audit, run in a network with no internet route.
- **Isolation:** `apps/web/workspace-probe/` after every tenancy change and upstream sync.

## 10. Open items

- **D-C5 (🟡)** Are the seed bundles in §6 (capabilities and app roles, e.g. Fleet Owner → app Admin, Fleet
  Observer → "Fleet Observer" read-only incl. `announcement.view`) the right defaults? Seeds stay editable.
- **O-2 (🟡)** D-C7 says every app supports OIDC **and** SAML. Upstream `apps/web` is OIDC-only; this plan
  meets SAML for apps through an OIDC broker (zero seams) rather than native SAML in `apps/web` (several auth
  seams). Narrowed by D-E2: the broker must be **intranet-hosted** (e.g. Keycloak), not a cloud broker with
  public endpoints. 🟡 default: intranet broker. Question: is signing in to apps through an intranet OIDC broker
  (e.g. Keycloak) in front of a SAML IdP acceptable?
- **O-3 (🟡)** D-C11 is met by per-app **address** keys (IE-1). The router→app key `INBOUND_HMAC_SECRET` stays
  fleet-wide (slug-bound, so not re-aimable). Making it per-app too would require the mail router to hold
  per-app keys. 🟡 default: one fleet-wide router-to-app HMAC secret. Question: is a shared router-to-app inbound
  HMAC secret acceptable (address keys stay per-app)?
- **O-8 — closed by D-C15:** the tower owns the entire app role set of tower-managed people; local grants are
  removed at the next sync (§4.3.2).
- **O-9 (🟡, = O-C9)** Default: **15 minutes is a target** (p99; ≤ 10 min on SCIM push), budgeted in §4.5.4, with
  alarms when it is missed; **no hard maximum** unless the tenant-side entitlement lease (plan 10 O-R8, default
  off) is enabled. With the lease on, access ends at the last **directory observation** + lease, which is at
  most the lease after disablement. It is enforced per request even with sync, provisioner and sweep down (R3-2;
  a successful tenant sync alone never renews it). The cost is that it locks out every managed person during a
  directory outage longer than the lease, and it requires the directory poll (plan 10 O-R10). Question: is a
  target acceptable, or is a hard maximum (the lease) required, and if so, what lease length?
- **O-10 (🟡)** Default: Tier bundles need an explicit per-app team mapping (`tower_role_app_teams`) and
  grant nothing in apps without one. Question: is per-app team mapping for Tier bundles, maintained in the
  tower by `roles.manage`, acceptable?
- **O-11 (🟡, new)** Default: inbound email uses **one fleet mailbox** on the internal mail server for a
  dedicated inbound mail domain (one copy per envelope recipient delivered into it, routing header stripped then
  stamped, O-16),
  routed per app by `mail_slug` by the fork mail router; unroutable mail is logged and alarmed, not bounced.
  Fallback: one mailbox per app (model B, §4.11; uses F-8). Question: can the mail team provide a catch-all
  inbound domain into one mailbox, or must each app have its own mailbox?
- **O-12 (🟡, new)** Default: apps are SSO-only from publish (every other method off); domain `enforced` is
  switched on by the provisioner only after upstream's own unlock rule holds (first real SSO sign-in), and
  break-glass recovery codes for each app are held by fleet ops in Secrets Manager. Question: is it acceptable
  that the domain hard-bind lands after the first SSO sign-in rather than at provisioning, and that ops hold the
  break-glass codes?
- **O-13 (🟡, new)** Default: in-VPC callers (tower, provisioner, mail router) reach apps through a private DNS
  zone that resolves the same hostnames to the internal ALB, bypassing the edge SSO proxy; each app still
  authenticates them (per-user OAuth tokens, HMAC). Employees always go through the edge. Question: may these
  server-to-server paths bypass the edge SSO proxy, or must the proxy carry an allow-list for them instead?
- **O-14 (🟡, new)** Default: `<fleet-domain>` is an intranet-only DNS domain and the wildcard certificate comes
  from the company's private CA (imported into ACM, or ACM Private CA) on the internal ALB; per-app custom
  domains, when they come, are internal names too. Question: which internal domain and CA should the fleet use?
- **O-15 (🟡, new, R2-1)** Default: **one serving image per fleet**; cohort targets only stage the pre-roll
  migration pass, and a tenant that must stay on an older upstream version is suspended for the roll. Serving
  several images pinned per cohort would need host routing per cohort **and** an upstream seam so workers skip
  other cohorts before pool acquisition. Question: is suspending held-back tenants acceptable, or must some
  tenants keep serving on an older release?
- **O-16 (🟡, new, R2-7)** Default: the internal mail server can deliver one copy per envelope recipient into the
  fleet mailbox and **delete any inbound copy** of a dedicated routing header (e.g. `X-Fleet-Envelope-To`)
  before stamping its own (V-9). Without that, the router has no trusted recipient and falls back to model B
  (one mailbox per app). Question: can the mail team configure header stripping + stamping on the inbound
  domain?

## 11. Relationship to other v2 plans

Contracts this plan **consumes** (stated here, owned elsewhere):

- **10-rbac:** Phase 1a (D3) makes app roles bind over MCP with an argument-aware permission map; tenant
  templates for every bundle (looked up by `template_key` in `fork_role_templates`), `ensurePersonaRoles` /
  `fork_install_persona_roles`, the template reconcile primitive (plan 10 §reconcile) that `fork-migrate`
  calls, the managed writer `applyManagedRoleSet` + `fork_role_assignment_sources` + `assertTowerPrincipalsFailClosed`
  (plan 10 §4.8, R2-3), and the denial primitive `denyPrincipal` / `liftPrincipalDenial` / `isPrincipalDenied` +
  `fork_principal_denials` + the F-8 denial sweep + R-1 creator check + lease setting O-R8 (plan 10 §4.9, R2-4).
  Plan 20 owns the registry table `fork_tower_principals` those read, and seams TW-1/TW-2 that call
  `isPrincipalDenied`. Plan 10 owns the existing-session denial checks R-13/R-14/R-15 (R3-1),
  `recordEntitlementObservation`, and the single revocation bound (plan 10 §4.9) that §4.5.4 restates. This
  plan supplies the directory observations that are the lease's only renewal source (R3-2). The template permission sets must satisfy §6.1; `verify --contract` reports any gap per app.
- **30-tiered:** tier teams and the tier-membership service used for Tier bundle team grants (called with
  `applyManagedRoleSet`'s executor; its local writer refuses managed principals). Tier escalation
  and account actions are not exposed in the tower in v2.
- **50-prioritization:** `list_post_prioritization` (§4.9.1 there) for Phase 7.
- **60-announcements:** `list_announcements` (`announcement.view`), `upsert_announcement` /
  `archive_announcement` / `list_announcement_templates` (`announcement.manage`), `broadcastId` idempotent
  upsert and uncertain-outcome reconciliation, for Phase 6.
- **04-intranet-deployment:** the §3 configuration baseline (sign-in, AI proxy, SMTP, telemetry off, unset
  internet URLs), E-1/F-12 (prerequisite for app SSO), E-2 static keys (conditional E-2a), E-3 delivery events
  disabled, optional E-4 (anonymous plugin gate) and the open email-OTP verification item (the §4.3.1 probe
  fails closed on it).
- **Foundations (02):** F-1 (fork lineage in `runMigrations`), F-3 (MCP registration), F-7 (catalogue fence), F-12 (SSRF allow-list),
  `fork_settings`, the fork migrations folder. `fork-migrate`, the fork floor (F-11) and `Dockerfile.fork` are
  owned by this plan.
