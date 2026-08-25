BEGIN;
-- Migration 0005: durable, unqualified external source observations.
-- source_signals are deliberately separate from leads: no observation reaches the
-- lead/target surface until a qualifier verifies it and creates a lead.
DO $$ BEGIN
  CREATE TYPE source_signal_status AS ENUM (
    'queued_qualification',
    'qualifying',
    'qualified',
    'rejected',
    'quarantined'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Do not seed or otherwise use this value in this migration transaction.
-- PostgreSQL does not permit a freshly added enum value to be used until the
-- transaction that added it has committed.
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'qualify_award_lead';

CREATE TABLE IF NOT EXISTS source_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL,
  source_locator text NOT NULL,
  source_fingerprint text NOT NULL UNIQUE,
  agent_id uuid REFERENCES research_agents(id) ON DELETE SET NULL,
  raw_name text NOT NULL,
  raw_domain text,
  uei text,
  cage text,
  city text,
  state text,
  country text,
  award_count integer CHECK (award_count IS NULL OR award_count >= 0),
  award_value numeric(18,2) CHECK (award_value IS NULL OR award_value >= 0),
  freshest_award timestamptz,
  source_payload jsonb NOT NULL DEFAULT '{}',
  status source_signal_status NOT NULL DEFAULT 'queued_qualification',
  qualification jsonb NOT NULL DEFAULT '{}',
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  qualified_at timestamptz,
  rejected_at timestamptz
);

CREATE INDEX IF NOT EXISTS source_signals_status_created_at_idx
  ON source_signals(status, created_at);
CREATE INDEX IF NOT EXISTS source_signals_source_key_status_idx
  ON source_signals(source_key, status);
CREATE INDEX IF NOT EXISTS source_signals_agent_id_idx
  ON source_signals(agent_id);
CREATE INDEX IF NOT EXISTS source_signals_lead_id_idx
  ON source_signals(lead_id);

-- Status transitions remain mutable. Callers MUST append the corresponding
-- audit_events row in their transaction; source_signals are not append-only.
COMMIT;
