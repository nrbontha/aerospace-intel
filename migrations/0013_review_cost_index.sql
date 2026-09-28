BEGIN;
-- Migration 0013: support repeated UTC daily-spend gates over recorded FAA
-- evaluation charges without scanning cost-free review rows.
CREATE INDEX IF NOT EXISTS faa_ensemble_evaluations_updated_at_cost_idx
  ON faa_ensemble_evaluations (updated_at)
  WHERE cost_usd IS NOT NULL;
COMMIT;
