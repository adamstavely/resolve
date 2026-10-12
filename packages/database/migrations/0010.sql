-- Elastic E3 (plan 12 §7, plan 14): pre-flight checks before an action, verified receipts after it, and
-- subscriptions so a person is told when a known issue clears. Applied to the actions Resolve performs today;
-- account actions keep waiting for their executor.

-- What the person was shown before acting. A dispatch uses it only while it is fresh and for the same target and action.
CREATE TABLE action_preflights (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 app_key text NOT NULL,
 object_kind text NOT NULL CHECK (object_kind IN ('ticket', 'conversation')),
 object_id text NOT NULL,
 action text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('allow', 'warn', 'block', 'unknown')),
 checks jsonb NOT NULL,
 evidence jsonb NOT NULL,
 policy_version integer NOT NULL,
 evaluated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 -- Set when an action used it; an advisory warning overridden by a person records their reason.
 operation_id uuid UNIQUE,
 override_reason text,
 used_at timestamptz
);
CREATE INDEX action_preflights_target ON action_preflights (app_key, object_kind, object_id, evaluated_at DESC);

-- Downstream evidence for an action, found in telemetry by its operation id. Late evidence upgrades "unverified".
CREATE TABLE action_receipt_observations (
 operation_id uuid PRIMARY KEY,
 app_key text NOT NULL,
 operation text NOT NULL,
 expectation text NOT NULL,
 state text NOT NULL CHECK (state IN ('pending', 'observed', 'unverified', 'failed')),
 deadline_at timestamptz NOT NULL,
 observed_at timestamptz,
 source text,
 detail text,
 checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX action_receipt_observations_open ON action_receipt_observations (created_at) WHERE state IN ('pending', 'unverified');

-- "Notify me when it clears": one per person and issue. Clearing never re-runs anything; it asks for a new attempt.
CREATE TABLE issue_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 issue_id uuid NOT NULL REFERENCES known_issues(id),
 object_kind text CHECK (object_kind IN ('ticket', 'conversation')),
 object_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 acknowledged_at timestamptz,
 UNIQUE (user_id, issue_id)
);
