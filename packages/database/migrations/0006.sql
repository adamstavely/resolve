-- Phase 4 fleet administration (plans 02, 03 and 07): applications and their support-instance bindings,
-- onboarding runs, privileged worker jobs, per-app team mappings and per-person desired entitlements.
-- Resolve stores command intent and progress only: no tenant DSN, database credential or worker secret.

CREATE TABLE applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 -- Stable key; never renamed when the application is renamed.
 key text NOT NULL UNIQUE,
 name text NOT NULL,
 description text NOT NULL DEFAULT '',
 app_url text NOT NULL,
 owner_name text NOT NULL,
 owner_email text NOT NULL,
 support_team text NOT NULL,
 contact text NOT NULL DEFAULT '',
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX applications_url ON applications (lower(app_url));

-- One support instance per application and environment (owner decision 2026-10-12); a workspace belongs to one binding.
CREATE TABLE instance_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 application_id uuid NOT NULL REFERENCES applications(id),
 environment text NOT NULL CHECK (environment IN ('production', 'test')),
 workspace_key text NOT NULL UNIQUE,
 strategy text NOT NULL CHECK (strategy IN ('create', 'adopt')),
 support_hostname text UNIQUE,
 mail_slug text,
 lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'onboarding', 'ready', 'active', 'suspended', 'retired')),
 active_revision text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (application_id, environment)
);

-- Per-app monotonic desired-state version sent with every lifecycle command (contract 4), for bound and
-- externally managed apps alike.
CREATE TABLE app_state_versions (
 app_key text PRIMARY KEY,
 version bigint NOT NULL DEFAULT 0
);

CREATE TABLE onboarding_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 application_id uuid NOT NULL REFERENCES applications(id),
 environment text NOT NULL CHECK (environment IN ('production', 'test')),
 binding_id uuid REFERENCES instance_bindings(id),
 status text NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft', 'reviewed', 'provisioning', 'validating', 'ready', 'activating', 'active', 'failed', 'cancelled')),
 -- Saved wizard steps (drafts survive sign-out and failures).
 steps jsonb NOT NULL DEFAULT '{}',
 -- The reviewed configuration and its revision; cleared whenever a step changes.
 config jsonb,
 config_revision text CHECK (config_revision ~ '^[0-9a-f]{64}$'),
 report_revision text,
 -- Optimistic concurrency for step edits.
 version integer NOT NULL DEFAULT 0,
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX onboarding_runs_open ON onboarding_runs (application_id, environment) WHERE status NOT IN ('active', 'cancelled');

CREATE TABLE fleet_jobs (
 id uuid PRIMARY KEY,
 -- Idempotency: a repeated request id returns the same job (and the worker dedupes on it too).
 request_id uuid NOT NULL UNIQUE,
 app_key text NOT NULL,
 command text NOT NULL CHECK (command IN ('provision', 'validate', 'activate', 'suspend', 'resume')),
 parameters jsonb NOT NULL,
 payload_hash text NOT NULL,
 desired_state_version bigint NOT NULL,
 config_revision text,
 run_id uuid REFERENCES onboarding_runs(id),
 initiator_user_id uuid NOT NULL REFERENCES users(id),
 operation_id uuid NOT NULL,
 worker_job_id uuid,
 dispatched_at timestamptz,
 stage text NOT NULL DEFAULT 'requested',
 failure_code text,
 failed_stage text,
 checks jsonb NOT NULL DEFAULT '[]',
 evidence jsonb,
 resources jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Per-app operation lock: one running lifecycle job per app.
CREATE UNIQUE INDEX fleet_jobs_running ON fleet_jobs (app_key)
 WHERE stage IN ('requested', 'preparing', 'migrating', 'reconciling', 'validating', 'activating');
CREATE INDEX fleet_jobs_app ON fleet_jobs (app_key, created_at DESC);

-- Per-app team mappings: a Resolve bundle → tenant role and teams. A missing mapping grants nothing.
CREATE TABLE app_team_mappings (
 app_key text NOT NULL,
 bundle text NOT NULL,
 role text NOT NULL CHECK (role IN ('admin', 'agent', 'observer')),
 teams text[] NOT NULL DEFAULT '{}',
 PRIMARY KEY (app_key, bundle)
);
CREATE TABLE app_mapping_versions (
 app_key text PRIMARY KEY,
 version integer NOT NULL DEFAULT 0,
 updated_by uuid REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);

-- Desired state per person and app (plan 02). desired_version only increases; last_applied_version records the
-- newest version the tenant confirmed. An older apply can never replace a newer one.
CREATE TABLE user_entitlements (
 user_id uuid NOT NULL REFERENCES users(id),
 app_key text NOT NULL,
 desired_version bigint NOT NULL,
 payload jsonb NOT NULL,
 payload_hash text NOT NULL,
 last_applied_version bigint NOT NULL DEFAULT 0,
 last_applied_at timestamptz,
 last_error text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (user_id, app_key),
 CHECK (last_applied_version <= desired_version)
);

CREATE SEQUENCE entitlement_fencing;
-- Leased work items. A claim takes a new fencing token; a completion is accepted only with the current token,
-- so a stalled worker whose lease was reclaimed cannot overwrite a newer result.
CREATE TABLE entitlement_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 app_key text NOT NULL,
 version bigint NOT NULL,
 payload_hash text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'applied', 'superseded', 'failed')),
 lease_owner text,
 lease_expires_at timestamptz,
 fencing_token bigint,
 attempts integer NOT NULL DEFAULT 0,
 -- Retries back off: a job that cannot apply yet does not hold up newer work.
 not_before timestamptz NOT NULL DEFAULT now(),
 worker_job_id uuid,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (user_id, app_key, version)
);
CREATE INDEX entitlement_jobs_ready ON entitlement_jobs (not_before, created_at) WHERE status IN ('queued', 'leased');

-- Pilot evidence: a real person's sign-in, read and permitted action against the instance before activation.
CREATE TABLE pilot_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 run_id uuid NOT NULL REFERENCES onboarding_runs(id),
 user_id uuid NOT NULL REFERENCES users(id),
 config_revision text NOT NULL,
 checks jsonb NOT NULL,
 passed boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
