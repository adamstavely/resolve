-- Phase 5 banner broadcasts (plan 08). Durable intent before any tenant call: a broadcast, its content revisions,
-- and one delivery row per app per revision with a stable key, so retries and reconciliation never create a second
-- tenant announcement.

CREATE TABLE broadcasts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 author_user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'partial', 'needs_attention', 'failed', 'archived')),
 -- Draft content and targeting; pinned into a revision when published.
 draft jsonb NOT NULL,
 current_revision integer NOT NULL DEFAULT 1,
 -- Optimistic concurrency for edits.
 version integer NOT NULL DEFAULT 0,
 archive_request_id uuid UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcast_revisions (
 broadcast_id uuid NOT NULL REFERENCES broadcasts(id),
 revision integer NOT NULL,
 content jsonb NOT NULL,
 content_hash text NOT NULL,
 targeting jsonb NOT NULL,
 -- The reviewed recipient list and readiness, and the registry revision it came from.
 reviewed_recipients jsonb NOT NULL,
 registry_revision text NOT NULL,
 review_hash text NOT NULL,
 confirmed_partial boolean NOT NULL DEFAULT false,
 publish_request_id uuid NOT NULL UNIQUE,
 confirmed_by uuid NOT NULL REFERENCES users(id),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 -- When Resolve publishes (it schedules itself, so "All apps" can follow the registry until then).
 publish_at timestamptz NOT NULL DEFAULT now(),
 -- Set once deliveries have been created for this revision.
 materialized_at timestamptz,
 PRIMARY KEY (broadcast_id, revision)
);
CREATE INDEX broadcast_revisions_due ON broadcast_revisions (publish_at) WHERE materialized_at IS NULL;

CREATE TABLE broadcast_deliveries (
 broadcast_id uuid NOT NULL,
 revision integer NOT NULL,
 app_key text NOT NULL,
 -- resolve-broadcast:v1:<broadcast>:<revision>:<app>; the tenant replays this key instead of creating twice.
 delivery_key text NOT NULL UNIQUE,
 payload_hash text NOT NULL,
 state text NOT NULL CHECK (state IN ('pending', 'blocked', 'succeeded', 'failed', 'uncertain')),
 reason text,
 failure_code text,
 tenant_announcement_id text,
 tenant_version integer,
 surfaces jsonb,
 attempts integer NOT NULL DEFAULT 0,
 dispatched_at timestamptz,
 archive_state text CHECK (archive_state IN ('pending', 'succeeded', 'failed', 'conflict', 'uncertain')),
 archive_failure_code text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (broadcast_id, revision, app_key),
 FOREIGN KEY (broadcast_id, revision) REFERENCES broadcast_revisions(broadcast_id, revision)
);
CREATE INDEX broadcast_deliveries_open ON broadcast_deliveries (state) WHERE state IN ('pending', 'uncertain');
