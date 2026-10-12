# Elastic E5 evidence: local qualification

Status: 2026-10-12. The parts of E5 ([plan 14](../../plans/14-elastic-implementation.md), plan 12 §9) that can run without a real cluster:
- a load harness
- scripted failure drills
- an upgrade rehearsal against recorded fixtures
- an egress check

Staging qualification against a real Elastic Cloud Hosted deployment, at the volumes the owner sets, remains. It's part of Phase 6.

## Load (`npm run load:observability`)

**What it runs:** the real worker, read models, invalidation stream and customer-context queries, against PostgreSQL (a throwaway schema)
and the in-process mock Elastic with a simulated per-request latency.

**What it doesn't model:** real index sizes, query cost and network. Treat the numbers as the cost of Resolve's own work, not the cluster's.

**Defaults:** 50 apps, 4 workers, 5 s poll (6× more often than the proposed 30 s), 20 ms per request.

| Measure | Result |
|---|---|
| Polls | 10/s, the 10/s needed, none deferred |
| Poll duration p50 / p95 / max | 53 / 64 / 121 ms |
| Elastic requests per poll | 4.1 |
| Apps stale at the end | 0 of 50 |
| Read models, 100 concurrent readers | p95 126 ms, **0 Elastic requests** |
| Customer context, 50 concurrent agents (uncached) | p95 113 ms, 3 requests each |
| Invalidations, 500 streams × 20 events | all 10,000 delivered, p95 6 ms, one listener connection |

**Heavy:** 300 apps, 5 s poll, 50 ms per request, 300 readers, 200 agents, 2,000 streams.

| Measure | 4 workers | 8 workers |
|---|---|---|
| Polls | 29.5/s of the 60/s needed: **falls behind** (lag 5.1 s) | 56.6/s, lag 0.1 s |
| Capacity estimate at p95 | about 157 apps per 5 s | about 298 apps per 5 s |
| Read models, 300 concurrent readers | p95 73 ms, 0 Elastic requests | p95 71 ms |
| Customer context, 200 agents | p95 169 ms | — |
| Invalidations, 2,000 streams × 20 events | 40,000 delivered, p95 7 ms, max 8 ms | — |

**Findings fixed:**
- **Health reads didn't scale.** They scanned all snapshot history and every reader recomputed the same result: about 790 ms p95 at 300 readers.
  - **Now:** one indexed lookup per mapping, plus a shared cache keyed on a fingerprint of everything health depends on (latest snapshot, mappings, connections and the kill switch).
  - **Result:** about 71 ms p95, and a kill switch or a new poll shows on the very next read (drill below).
- **Worker capacity is per process.** Capacity scales linearly with parallel polls, now `INTEGRATION_WORKER_LANES` (default 4).
  - **At the proposed 30 s poll:** 4 lanes cover about 940 apps at 50 ms per Elastic request.
  - **Below that:** add lanes or worker processes; leases make several workers safe.
- **The harness itself:**
  - It now reports scheduling lag, since "nothing stale" in a short run hid a falling-behind queue.
  - It counts only its own invalidations. The notification channel is database-wide, so another worker's events were being counted too.

## Failure drills (`tests/database/observability-drills.db.test.ts`)

| Drill | Shown |
|---|---|
| Slow index | A poll past the client's 10 s timeout is deferred with backoff; the last snapshot goes stale and is never shown as healthy |
| Rollover | A new backing index is picked up through the data-stream pattern; the old one can disappear |
| Mapping change | A renamed field drops unparsable results, and the checks show as unknown, not passing |
| Key revoked mid-run | The next poll is "unavailable" at once; restoring or rotating the key recovers |
| Worker crash | A dead worker's lease expires, another takes over, and the dead worker's late write is fenced off |
| Late telemetry | A receipt past its window is "unverified"; evidence arriving later upgrades it to observed |
| Retention expiry | Expired snapshots are gone unless on hold |
| UTC and DST | Windows are absolute instants; a 24-hour window across Europe's DST change is exactly 24 hours |
| Reconnect storm | 300 open streams share one named listener; when its connection is killed, every stream is told to re-read, keeps receiving, and one listener remains |
| Shared read cache | A kill switch and a new poll are visible on the very next read, inside the cache lifetime |

## Upgrade rehearsal (`tests/elastic.unit.test.ts`)

Against the recorded fixtures:
- **Additive changes:** fields a newer minor version adds parse unchanged.
- **Breaking changes:** a removed or retyped field (SLO status, alert start, case status, service name, synthetics status) fails validation. The item is dropped, never guessed, and health shows the gap as unknown.
- **Before upgrading a real cluster:** run `npm run elastic:fixtures` against staging on the new version, then the same tests.

## Egress check (`npm run qualify:egress`)

**What it lists:** every endpoint the Resolve server calls:
- the IdP, registry, directory, worker, summary model and database
- each registered tenant
- each stored Elastic connection

It resolves every host and **fails if any is public**, or doesn't resolve. Kibana deep links are listed as browser-only.

**On development:** every server endpoint is loopback.

**Run it in each environment.** The address classifier is unit-tested: private, CGNAT and ULA ranges pass; public, metadata and link-local fail.

## Full run on 2026-10-12

| Suite | Result |
|---|---|
| Typecheck and console build | Clean |
| Unit | 258 passed |
| Database | 81 passed |
| Contract | 32 passed |
| Browser (Chrome, one worker) | 91 passed |

## Remaining for Phase 6 (needs staging and owner input)

- **Load:** at the agreed app and operator volumes against a real cluster (plan 12 §10.7), including real query latency for customer context.
- **Upgrade rehearsal:** a real 9.x minor upgrade, with fixtures recorded from staging.
- **Network:** a private-network trace in staging, using the egress check plus network captures.
- **Rollout:** canary on one nonproduction app, then one production app; a kill-switch drill in staging; the runbook.
- **Accessibility:** a manual review (screen reader, 320 px reflow, enlarged text) of the new screens.
