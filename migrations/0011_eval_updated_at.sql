BEGIN;
-- Migration 0011: track evaluation refresh time. persistEvaluation
-- upserts on (signal_id, model_id, prompt_version), so without updated_at
-- a refreshed judgment is indistinguishable from a stale one when
-- monitoring (created_at never moves on conflict update). Additive only.
ALTER TABLE faa_ensemble_evaluations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

UPDATE faa_ensemble_evaluations SET updated_at = created_at WHERE updated_at IS NULL;

COMMIT;
