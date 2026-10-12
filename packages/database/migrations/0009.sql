-- Elastic E1 (plan 14): what an admin saw before activating a mapping, and the read-model fields health and known
-- issues need. Preview and isolation results belong to one mapping revision; editing the mapping clears them.
ALTER TABLE elastic_app_mappings ADD COLUMN preview jsonb, ADD COLUMN isolation jsonb;

ALTER TABLE observability_health_snapshots ADD COLUMN summary jsonb NOT NULL DEFAULT '{}';

ALTER TABLE known_issues ADD COLUMN service text, ADD COLUMN affected jsonb;
CREATE INDEX known_issues_app_state ON known_issues (app_key, environment, state);

-- Health history beyond the latest row is kept for 24 hours (proposed retention); the worker prunes it.
CREATE INDEX observability_health_fetched ON observability_health_snapshots (fetched_at);
