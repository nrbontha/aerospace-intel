BEGIN;
-- Preserve provider-reported charge precision. Legacy receipt costs were copied
-- through the original NUMERIC(14,8) typemod, so restore only receipts that can
-- be linked back to their exact diagnostic evaluation value.
ALTER TABLE faa_review_model_usage
  ALTER COLUMN cost_usd TYPE NUMERIC
  USING cost_usd::NUMERIC;

UPDATE faa_review_model_usage AS receipt
SET cost_usd = evaluation.cost_usd
FROM faa_ensemble_evaluations AS evaluation
WHERE receipt.legacy_evaluation_id = evaluation.id
  AND evaluation.cost_usd IS NOT NULL
  AND receipt.cost_usd IS NOT DISTINCT FROM round(evaluation.cost_usd, 8)
  AND receipt.cost_usd IS DISTINCT FROM evaluation.cost_usd;
COMMIT;
