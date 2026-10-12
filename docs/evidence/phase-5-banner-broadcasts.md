# Phase 5 evidence — banner broadcasts

Status: 2026-10-12. Built and tested against the development mock fleet, which implements the target announcement
tools (`list_announcements`, `upsert_announcement`, `archive_announcement`, `get_announcement_by_key`, all v1). The fork
has an announcement service but no OAuth tools or scope for it yet (QB-ANN-1), and no broadcast key or replay check (QB-ANN-2).

Owner decisions applied (plan 05, plan 08):
- **Content only:** Resolve pushes a banner's content: type of notice, title, message, link, surfaces and expiry. The fork's banner widgets own its
  presentation (styles per kind, icons, ordering, dismissal); Resolve sends no styling and does not imitate it.
- **"All registered apps" follows the registry until publication:** a scheduled "All apps" banner also reaches apps registered
  before its publish time, so Resolve schedules publication itself.
- **Partial delivery:** needs the author's explicit confirmation. Apps that can't take the banner are recorded as not delivered and can be retried.

## What exists

- **Data model** (migration 0007):
  - `broadcasts`: author, status, draft, current revision, version.
  - `broadcast_revisions`:
    - pinned content and its hash, targeting
    - the reviewed recipients and their readiness, the registry revision and review hash
    - partial confirmation, the publish request id, and the publish time
  - `broadcast_deliveries`: one row per app per revision, with the key `resolve-broadcast:v1:<broadcast>:<revision>:<app>`,
    the payload hash, state, reason, tenant announcement id and version, surface outcome and archive state.
- **Authoring** (`/announcements`, `apps/api/lib/broadcasts.ts`):
  - **Writing:** type of notice, title, plain-text message, an optional https link, surfaces (portal, inside the app), publish time and expiry.
    The preview shows the content, not a look-alike banner.
  - **Review:** lists every recipient with its readiness, and with the reason when it isn't ready:
    suspended, not open, not connected, reconnect needed, missing announcement scope, unsupported, unreachable.
    "All" never silently shrinks to the apps you're connected to.
  - **Publishing:**
    - **Review hash:** publication must match the reviewed content, recipients and readiness; any change means reviewing again.
    - **Partial delivery:** refused until confirmed.
    - **Idempotency:** a repeated request id is the same publication.
- **Delivery:**
  - **As the author:** each app receives the banner as the author, with the author's own grant, in bounded parallel with one app's failure isolated.
  - **Before each send:** the author's authority (enabled, holding `broadcast.publish`) and the app's readiness are checked again.
  - **Uncertain:** a timeout or lost response is *uncertain*. It's settled only by asking the app by key (**Check result**),
    never by resending blindly. A key always maps to one tenant announcement.
  - **Send again:** a failed or blocked delivery is sent with the same key.
  - **Surfaces:** the result reports each surface. "Published to the portal" is shown apart from "the in-app banner needs the host app's script", and is never claimed as seen.
- **Scheduling:** the job dispatcher publishes due revisions. For "All apps" it re-resolves recipients at that moment,
  re-checks readiness and the author's authority, and records anything that can't take the banner as not delivered.
- **Edit and archive:**
  - **Edit:** a new revision updates every app's announcement, version-checked. A banner edited inside an application is reported as
    a conflict, not overwritten.
  - **Archive:** a published banner is archived in each app it reached, version-checked the same way. A scheduled banner that hasn't gone out is cancelled.
- **Attribution and audit:**
  - **Author:** only the author can act on a broadcast's deliveries, because they're published as them.
  - **Audit:** the author's draft, review, publish (with the banner text, sealed), revise, archive and every delivery outcome, with the tenant record id.
  - **Tenant side:** the author is named on each announcement.
- **Scopes:** proposed scopes (`read:announcement`/`write:announcement`) are requested only once a tenant advertises them, and only
  for people whose capabilities need them. Today's fork is unaffected.

## Exit criteria (plan 00)

| Criterion | Evidence |
|---|---|
| Duplicate requests produce one tenant mutation and one audit | `broadcasts.spec` › repeated publishes and a lost response…: a dropped response, a repeated publish and a check by key leave one announcement with one mutation. The mock replays a key (`broadcasts.unit.test`) |
| Observer cannot publish | `broadcasts.spec` › observers and agents cannot publish: no navigation entry, and the API refuses (403) |
| Unknown completion reconciled safely | Uncertain → **Check result** → published; "Send again" is refused while uncertain |
| Existing local banners do not mean the fleet API exists | The tools are tracked as missing in the inventory (QB-ANN-1/2), and Resolve requires the advertised versions (contract 6) |

## Further acceptance (plan 08)

| Requirement | Evidence |
|---|---|
| All-app and selected-app publish only to the reviewed apps | `broadcasts.spec` (all apps through the UI; selected apps through the API) |
| A newly registered app does not join silently; with "All", a scheduled banner includes it, visibly | `broadcasts.spec` › a scheduled All-apps banner…: the app onboarded after review appears as not delivered (not connected) |
| Unbound, suspended, unauthorized or disconnected apps stay visible | Facilities (suspended) and Legal Ops (not connected) appear in review and results with reasons |
| Duplicate submits, retries and crashes after commit create no duplicate | Delivery keys, the tenant replay rule, and resending stale pending deliveries |
| Missing embed installation is distinguished from publication | HR reports "script not installed"; Payroll reports the in-app surface as published |
| Observer is denied; the author is preserved in Resolve and the tenant | The tenant announcement names Bea; the audit has her publish event with the text |
| Scheduling, expiry, edit/archive, partial failure across two or more tenants | Scheduled test, expiry test (gone from the portal after expiry), edit/archive test with a local-edit conflict in HR |
| WCAG 2.2 AA | axe on the editor, the review, the results and the mock portal banner (dismissible by keyboard) |
| Content only, the fork owns presentation | The tenant contract carries the fork's field names and refuses `style`, `color`, `icon`, `priority` and the like (`broadcasts.unit.test`) |

## Found while building

- **Concurrent dispatch** (Phase 4 code): two simultaneous dispatches of one request both ran provisioning side effects and could collide in the entitlement queue.
  - **Fix:** side effects now run only for the request that created the job, and queueing tolerates a concurrent identical insert.
- **Role changes for unlisted apps:** role-change jobs for an app the fleet doesn't list now wait without calling the worker,
  so a missing or still-creating instance can't hold up the queue.

## Not yet done

- **The fork's tools:**
  - announcement tools and scope (QB-ANN-1);
  - key and payload-hash replay, and lookup by key (QB-ANN-2);
  - reporting embed installation in results.
- **Real rendering:** the mock portal page stands in for the fork's `portal-banner-strip`/`banner-bar`. Rendering belongs to the fork.
- **Templates:** fork templates and `priority` aren't exposed; banners use the fork's default ordering.
- **Recipient changes:** changing a published broadcast's recipients needs a new broadcast. Editing changes content only.
- **Changed instances:** if an app's instance binding changes after confirmation, the delivery still goes to the app key. The binding-revision check (plan 08) waits on the fork's registry projection (QB-REG-1).
