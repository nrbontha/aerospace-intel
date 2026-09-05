BEGIN;
-- Migration 0007: additive FAA two-model ensemble qualification storage.
-- High-recall filter persistence only; the runner persists evaluations and
-- results without writing candidates/leads/source_signals.status.

CREATE TABLE IF NOT EXISTS faa_ensemble_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id uuid NOT NULL REFERENCES source_signals(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL DEFAULT 'faa_qualification_v1',
  raw_response TEXT,
  parsed JSONB,
  decision TEXT CHECK (decision IN ('reject', 'research', 'high_priority')),
  confidence INT CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  company_type TEXT,
  aerospace_defense_relevance TEXT,
  manufacturing_evidence TEXT,
  thesis_signals JSONB DEFAULT '[]',
  disqualifiers JSONB DEFAULT '[]',
  missing_evidence JSONB DEFAULT '[]',
  false_negative_risk TEXT,
  reason TEXT,
  tokens JSONB,
  cost_usd NUMERIC,
  error TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (signal_id, model_id, prompt_version)
);

CREATE TABLE IF NOT EXISTS faa_ensemble_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id uuid UNIQUE NOT NULL REFERENCES source_signals(id) ON DELETE CASCADE,
  prompt_version TEXT DEFAULT 'faa_qualification_v1',
  adjudicator_prompt_version TEXT DEFAULT 'faa_adjudicator_v1',
  model_a_id TEXT,
  model_b_id TEXT,
  model_a_decision TEXT,
  model_b_decision TEXT,
  agreed BOOLEAN,
  adjudication_required BOOLEAN,
  adjudicator_model TEXT,
  adjudicator_output JSONB,
  final_decision TEXT NOT NULL CHECK (final_decision IN ('reject', 'research', 'high_priority')),
  final_confidence INT CHECK (final_confidence IS NULL OR (final_confidence >= 0 AND final_confidence <= 100)),
  reason TEXT,
  false_negative_risk TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS faa_ensemble_evaluations_signal_idx
  ON faa_ensemble_evaluations (signal_id);
CREATE INDEX IF NOT EXISTS faa_ensemble_results_final_decision_idx
  ON faa_ensemble_results (final_decision);

COMMIT;
