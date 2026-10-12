-- Elastic E4 (plan 12 §9, plan 14): draft summaries of evidence snapshots and what people said about them. Optional:
-- with no internal model configured nothing is generated. A summary is tied to one snapshot (whose facts it cites)
-- and is never edited; a new one is a new row.
CREATE TABLE evidence_summaries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 snapshot_id uuid NOT NULL REFERENCES evidence_snapshots(id),
 status text NOT NULL CHECK (status IN ('ready', 'unavailable', 'insufficient')),
 model text,
 -- Validated claims: text, cited fact sections, and whether it is a supported fact or an uncited interpretation.
 claims jsonb NOT NULL,
 -- Claims the model produced that cited facts that do not exist (dropped, but counted).
 omitted integer NOT NULL DEFAULT 0,
 -- Generated from restricted facts: shown only to observability.restricted.
 uses_restricted boolean NOT NULL,
 reason text,
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_summaries_snapshot ON evidence_summaries (snapshot_id, created_at DESC);

CREATE TABLE evidence_summary_feedback (
 summary_id uuid NOT NULL REFERENCES evidence_summaries(id),
 user_id uuid NOT NULL REFERENCES users(id),
 verdict text NOT NULL CHECK (verdict IN ('accurate', 'off')),
 note text,
 at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (summary_id, user_id)
);
