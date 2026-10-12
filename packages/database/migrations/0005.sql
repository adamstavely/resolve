-- Owner decision 2026-10-12: the audit records every user event, including the text of messages sent.
-- Message text is sealed (AES-256-GCM, bound to the audit event id) and readable only through the audit API.
-- Retention and access rules for audit content remain an open owner input (plan 05, question 7).
ALTER TABLE audit_events ADD COLUMN content_enc text;
CREATE INDEX audit_events_operation ON audit_events (operation, at DESC);
