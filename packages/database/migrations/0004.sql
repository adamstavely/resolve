-- Phase 3 operator actions (plans 01 and 09). One row per user intent, created before dispatch.
-- The operation id doubles as the tenant operation key, so a user-initiated retry is the same operation.
-- Every state transition is also appended to audit_events (append-only history).

CREATE TABLE operations (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 app_key text NOT NULL,
 operation text NOT NULL,
 target_type text NOT NULL CHECK (target_type IN ('conversation', 'ticket')),
 target_id text NOT NULL,
 -- Hash of the exact request; reusing an id with different content is refused.
 payload_hash text NOT NULL,
 -- Redacted: never message content.
 summary jsonb NOT NULL DEFAULT '{}',
 state text NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'uncertain', 'denied')),
 failure_code text,
 tenant_record_id text,
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 authorized_at timestamptz NOT NULL DEFAULT now(),
 dispatched_at timestamptz,
 completed_at timestamptz
);
CREATE INDEX operations_user ON operations (user_id, created_at DESC);
CREATE INDEX operations_open ON operations (state) WHERE state IN ('pending', 'uncertain');
