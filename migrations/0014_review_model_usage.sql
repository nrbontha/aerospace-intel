BEGIN;
-- Migration 0014: separate observed FAA provider charges from verdict history so
-- spend survives later rung failures and lease/current-input fences.
CREATE TABLE IF NOT EXISTS faa_review_model_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_signal_id UUID REFERENCES source_signals(id) ON DELETE SET NULL,
  configured_model TEXT NOT NULL,
  returned_model TEXT,
  phase TEXT CHECK (phase IS NULL OR phase IN ('jev', 'muse')),
  rung TEXT CHECK (rung IS NULL OR rung IN ('r1', 'r2', 'r3', 'r4')),
  prompt_version TEXT NOT NULL,
  input_hash TEXT,
  cost_usd NUMERIC(14,8) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  legacy_evaluation_id UUID UNIQUE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS faa_review_model_usage_observed_at_cost_idx
  ON faa_review_model_usage (observed_at)
  WHERE cost_usd IS NOT NULL;
CREATE INDEX IF NOT EXISTS faa_review_model_usage_source_signal_idx
  ON faa_review_model_usage (source_signal_id);

-- Evaluation rows remain diagnostic history. Copy each legacy recorded cost
-- once, preserving its original evaluation identity and observation timestamp.
INSERT INTO faa_review_model_usage (
  source_signal_id,
  configured_model,
  returned_model,
  phase,
  rung,
  prompt_version,
  input_hash,
  cost_usd,
  legacy_evaluation_id,
  observed_at
)
SELECT
  evaluation.signal_id,
  evaluation.model_id,
  NULL,
  CASE
    WHEN evaluation.prompt_version LIKE 'jev-ladder-%'
      OR evaluation.model_id LIKE '%/jev-%'
      THEN 'jev'
    ELSE NULL
  END,
  CASE
    WHEN evaluation.prompt_version ~ 'jev-ladder-r[1-4]$'
      THEN substring(evaluation.prompt_version FROM '(r[1-4])$')
    ELSE NULL
  END,
  evaluation.prompt_version,
  evaluation.input_hash,
  evaluation.cost_usd,
  evaluation.id,
  evaluation.updated_at
FROM faa_ensemble_evaluations evaluation
WHERE evaluation.cost_usd IS NOT NULL
ON CONFLICT (legacy_evaluation_id) DO NOTHING;

-- Daily spend now reads the receipt ledger, so this evaluation-only index is
-- obsolete. Keep the historical cost values themselves unchanged.
DROP INDEX IF EXISTS faa_ensemble_evaluations_updated_at_cost_idx;
COMMIT;
