BEGIN;
-- Migration 0008: unified acquisition-target table standardizing golden_v1,
-- curated, discovery, and FAA-ensemble sources. Populate is idempotent
-- (upsert on normalized_name); this DDL is additive only.

CREATE TABLE IF NOT EXISTS unified_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  domain TEXT,
  website_url TEXT,
  city TEXT,
  state_code TEXT,
  country_code TEXT,
  origins JSONB NOT NULL DEFAULT '[]',
  golden_v1_member BOOLEAN NOT NULL DEFAULT false,
  tier TEXT NOT NULL DEFAULT 'needs_research',
  pipeline_status TEXT,
  fit NUMERIC,
  novelty NUMERIC,
  confidence NUMERIC,
  actionability NUMERIC,
  ensemble_decision TEXT,
  ensemble_confidence INT,
  why_interesting TEXT,
  risks TEXT,
  unknowns TEXT,
  evidence_urls JSONB NOT NULL DEFAULT '[]',
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  signal_id uuid REFERENCES source_signals(id) ON DELETE SET NULL,
  candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (normalized_name),
  CHECK (tier IN ('reference', 'high_interest', 'evaluate', 'needs_research')),
  CHECK (ensemble_confidence IS NULL OR (ensemble_confidence >= 0 AND ensemble_confidence <= 100))
);

CREATE INDEX IF NOT EXISTS unified_targets_domain_idx
  ON unified_targets (domain);
CREATE INDEX IF NOT EXISTS unified_targets_tier_idx
  ON unified_targets (tier);

COMMIT;
