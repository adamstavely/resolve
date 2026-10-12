-- Phase 1 per-app OAuth grants and directory observation (plans 01 and 02).
-- Secrets and tokens are stored only as authenticated ciphertext (apps/api/lib/crypto.ts), bound to their row.

CREATE TABLE tenant_clients (
 app_key text PRIMARY KEY,
 client_id text NOT NULL,
 client_secret_enc text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connect_attempts (
 state_hash text PRIMARY KEY,
 attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 app_key text NOT NULL,
 session_hash text NOT NULL,
 code_verifier text NOT NULL,
 nonce text NOT NULL,
 requested_scopes text[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);

-- Resolve user <-> tenant account, per app. One tenant account belongs to at most one Resolve user.
CREATE TABLE tenant_identity_links (
 user_id uuid NOT NULL REFERENCES users(id),
 app_key text NOT NULL,
 tenant_issuer text NOT NULL,
 tenant_user_id text NOT NULL,
 tenant_principal_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id, app_key),
 UNIQUE (app_key, tenant_user_id)
);

CREATE TABLE user_tenant_grants (
 user_id uuid NOT NULL REFERENCES users(id),
 app_key text NOT NULL,
 state text NOT NULL CHECK (state IN ('not_connected', 'connecting', 'connected', 'reconnect_required', 'revoked', 'denied')),
 scopes text[] NOT NULL DEFAULT '{}',
 access_token_enc text,
 refresh_token_enc text,
 access_expires_at timestamptz,
 last_error text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id, app_key),
 -- Tokens exist only while connected.
 CHECK (state = 'connected' OR (access_token_enc IS NULL AND refresh_token_enc IS NULL))
);

-- Authoritative directory state. Versions only move forward; a stale observation never re-enables a user.
ALTER TABLE users ADD COLUMN directory_version bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN disabled_reason text;

CREATE TABLE directory_observations (
 id bigserial PRIMARY KEY,
 source text NOT NULL,
 issuer text NOT NULL,
 subject text NOT NULL,
 active boolean NOT NULL,
 version bigint,
 observed_at timestamptz NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('applied', 'stale', 'unchanged', 'unknown_user', 'absent'))
);
CREATE INDEX directory_observations_subject ON directory_observations (issuer, subject, observed_at DESC);

CREATE TABLE directory_sync_runs (
 id bigserial PRIMARY KEY,
 source text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 complete boolean NOT NULL DEFAULT false,
 error text
);
