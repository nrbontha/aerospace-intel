BEGIN;

-- Migration 0018: retain only non-secret OpenRouter receipt identity needed to
-- verify a generation's exact charge after an interrupted or unreadable body.
-- Legacy receipts remain nullable and cannot be inferred from timing or totals.
ALTER TABLE research_provider_usage
  ADD COLUMN provider_generation_id TEXT,
  ADD COLUMN provider_key_fingerprint CHAR(64),
  ADD COLUMN provider_http_status INTEGER,
  ADD COLUMN provider_cost_verified_at TIMESTAMPTZ;

ALTER TABLE research_provider_usage
  ADD CONSTRAINT research_provider_usage_generation_id_chk
    CHECK (
      provider_generation_id IS NULL
      OR length(btrim(provider_generation_id)) > 0
    ),
  ADD CONSTRAINT research_provider_usage_key_fingerprint_chk
    CHECK (
      provider_key_fingerprint IS NULL
      OR provider_key_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  ADD CONSTRAINT research_provider_usage_http_status_chk
    CHECK (
      provider_http_status IS NULL
      OR provider_http_status BETWEEN 100 AND 599
    );

-- One provider generation can belong to only one receipt for a specific key.
-- This prevents a replayed reconciliation from assigning one charge twice.
CREATE UNIQUE INDEX research_provider_usage_provider_generation_uidx
  ON research_provider_usage (
    provider,
    provider_key_fingerprint,
    provider_generation_id
  )
  WHERE provider_key_fingerprint IS NOT NULL
    AND provider_generation_id IS NOT NULL;

COMMIT;
