-- Phase 1 identity, sessions and audit (plans 01 and 02).
-- Identity keys are issuer/subject pairs; email is mutable display data and never used for linking.

CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 display_name text NOT NULL,
 email text,
 -- Disabled is a denial state of its own, not an empty grant set.
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 issuer text NOT NULL,
 subject text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_login_at timestamptz,
 UNIQUE (issuer, subject)
);

-- One identity may serve both tower login and app-facing providers (plan 01).
CREATE TABLE identity_usages (
 identity_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
 usage text NOT NULL CHECK (usage IN ('tower_login', 'app_provider')),
 PRIMARY KEY (identity_id, usage)
);

CREATE TABLE role_members (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bundle text NOT NULL,
 source text NOT NULL CHECK (source IN ('claim', 'manual')),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id, bundle, source)
);

-- Short-lived, single-use OIDC login attempts. Only hashes of state and the browser binding are stored.
CREATE TABLE login_attempts (
 state_hash text PRIMARY KEY,
 binding_hash text NOT NULL,
 code_verifier text NOT NULL,
 nonce text NOT NULL,
 return_to text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);

CREATE TABLE sessions (
 id_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 identity_id uuid NOT NULL REFERENCES identities(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);
CREATE INDEX sessions_active_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 at timestamptz NOT NULL DEFAULT now(),
 operation_id uuid NOT NULL,
 actor_user_id uuid REFERENCES users(id),
 operation text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('pending', 'succeeded', 'failed', 'uncertain', 'denied')),
 summary jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_at ON audit_events (at DESC);
