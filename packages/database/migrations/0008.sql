-- Elastic Observability integration (plan 12, plan 14), first release scope E0–E2. Resolve keeps connections, app
-- mappings, normalized snapshots, links and evidence; it is not a log store. E3 tables (pre-flight, receipts,
-- incident subscriptions) are deliberately absent.

-- One row per provider connection; ServiceNow (plan 13) will share this table.
CREATE TABLE integration_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider text NOT NULL CHECK (provider IN ('elastic')),
 name text NOT NULL,
 -- Elastic: Elasticsearch and Kibana origins and the Kibana space.
 settings jsonb NOT NULL,
 -- Exactly one credential source: a sealed key (bound to this row) or a secret-store reference.
 credential_enc text,
 credential_ref text,
 credential_rotated_at timestamptz NOT NULL DEFAULT now(),
 ca_pem text,
 kill_switch boolean NOT NULL DEFAULT false,
 kill_switch_reason text,
 -- Latest discovery result (versions, reachable families); replaced on every test.
 discovery jsonb,
 -- Bumped by anything that changes what reads return (credential, endpoints, kill switch); stamped on results.
 revision integer NOT NULL DEFAULT 1,
 -- Optimistic concurrency for admin edits.
 version integer NOT NULL DEFAULT 0,
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((credential_enc IS NULL) <> (credential_ref IS NULL)),
 UNIQUE (provider, name)
);

-- Which Elastic data belongs to an app and environment. Activation requires a preview and an isolation check.
CREATE TABLE elastic_app_mappings (
 app_key text NOT NULL,
 environment text NOT NULL,
 connection_id uuid NOT NULL REFERENCES integration_connections(id),
 mapping jsonb NOT NULL,
 state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'disabled')),
 preview_passed_at timestamptz,
 isolation_passed_at timestamptz,
 revision integer NOT NULL DEFAULT 1,
 version integer NOT NULL DEFAULT 0,
 updated_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (app_key, environment),
 CHECK (state <> 'active' OR (preview_passed_at IS NOT NULL AND isolation_passed_at IS NOT NULL))
);

-- Leased, fenced background work (polling, reconciliation). A stale holder's write is refused by the fencing token.
CREATE TABLE integration_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 connection_id uuid NOT NULL REFERENCES integration_connections(id),
 app_key text,
 kind text NOT NULL,
 -- Idempotency: one operation per (connection, kind, key).
 operation_key text NOT NULL,
 payload_digest text,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
 lease_owner text,
 lease_expires_at timestamptz,
 fencing_token bigint NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0,
 not_before timestamptz NOT NULL DEFAULT now(),
 failure_code text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (connection_id, kind, operation_key)
);
CREATE INDEX integration_operations_due ON integration_operations (not_before) WHERE state IN ('pending', 'running');

CREATE TABLE integration_checkpoints (
 connection_id uuid NOT NULL REFERENCES integration_connections(id),
 app_key text NOT NULL,
 family text NOT NULL,
 checkpoint jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (connection_id, app_key, family)
);

-- Normalized health per app/environment; the latest row plus 24 h of history (proposed retention).
CREATE TABLE observability_health_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 app_key text NOT NULL,
 environment text NOT NULL,
 state text NOT NULL CHECK (state IN ('unknown', 'healthy', 'degraded', 'critical', 'stale')),
 completeness text NOT NULL CHECK (completeness IN ('complete', 'partial', 'unavailable')),
 components jsonb NOT NULL,
 source_ids jsonb NOT NULL,
 connection_revision integer NOT NULL,
 mapping_revision integer NOT NULL,
 observed_at timestamptz,
 fetched_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX observability_health_latest ON observability_health_snapshots (app_key, environment, fetched_at DESC);

-- An Elastic alert or case, normalized. Provider ids are unique per connection, space and app/environment.
CREATE TABLE known_issues (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 connection_id uuid NOT NULL REFERENCES integration_connections(id),
 space_id text NOT NULL,
 app_key text NOT NULL,
 environment text NOT NULL,
 provider_kind text NOT NULL CHECK (provider_kind IN ('alert', 'case')),
 provider_id text NOT NULL,
 title text NOT NULL,
 state text NOT NULL CHECK (state IN ('active', 'recovered', 'closed')),
 criteria jsonb NOT NULL,
 first_seen_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL,
 UNIQUE (connection_id, space_id, app_key, environment, provider_kind, provider_id)
);

-- A ticket or conversation linked to a known issue by a person, with the criteria that matched when they linked it.
CREATE TABLE known_issue_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 issue_id uuid NOT NULL REFERENCES known_issues(id),
 app_key text NOT NULL,
 object_kind text NOT NULL CHECK (object_kind IN ('ticket', 'conversation')),
 object_id text NOT NULL,
 linked_by uuid NOT NULL REFERENCES users(id),
 matched_criteria jsonb NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 -- Reserved for ServiceNow (plan 13): the INC this issue is attached to, when that integration exists.
 incident_ref text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (issue_id, app_key, object_kind, object_id)
);

-- Immutable evidence. A refresh adds a revision pointing at the previous one; nothing is rewritten.
CREATE TABLE evidence_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 previous_id uuid REFERENCES evidence_snapshots(id),
 app_key text NOT NULL,
 environment text NOT NULL,
 object_kind text NOT NULL CHECK (object_kind IN ('ticket', 'conversation')),
 object_id text NOT NULL,
 -- SHA-256 of app key and verified external id; the id itself is not stored.
 subject_ref text,
 requested_from timestamptz NOT NULL,
 requested_to timestamptz NOT NULL,
 source_from timestamptz,
 source_to timestamptz,
 facts jsonb NOT NULL,
 source_ids jsonb NOT NULL,
 query_revision text NOT NULL,
 completeness text NOT NULL CHECK (completeness IN ('complete', 'partial', 'unavailable')),
 classification text NOT NULL CHECK (classification IN ('service', 'subject', 'restricted')),
 content_hash text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL UNIQUE,
 captured_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 hold boolean NOT NULL DEFAULT false,
 -- The internal note that links to this snapshot (operation key, so a lost response is reconciled, not reposted).
 note_operation_key uuid,
 note_state text CHECK (note_state IN ('pending', 'succeeded', 'failed', 'uncertain')),
 CHECK (requested_to > requested_from)
);
CREATE INDEX evidence_snapshots_object ON evidence_snapshots (app_key, object_kind, object_id, captured_at DESC);

CREATE OR REPLACE FUNCTION evidence_snapshots_immutable() RETURNS trigger AS $$
BEGIN
 -- Only the note outcome and the hold flag may change after capture.
 IF (NEW.facts, NEW.source_ids, NEW.content_hash, NEW.classification, NEW.captured_at, NEW.subject_ref, NEW.object_id)
    IS DISTINCT FROM (OLD.facts, OLD.source_ids, OLD.content_hash, OLD.classification, OLD.captured_at, OLD.subject_ref, OLD.object_id) THEN
  RAISE EXCEPTION 'evidence snapshots are immutable';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER evidence_snapshots_immutable BEFORE UPDATE ON evidence_snapshots FOR EACH ROW EXECUTE FUNCTION evidence_snapshots_immutable();
