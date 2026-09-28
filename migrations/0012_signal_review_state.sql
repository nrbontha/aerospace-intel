BEGIN;
-- Migration 0012: durable, input-versioned signal review lifecycle.
-- Existing evaluations/results remain historical. NULL input hashes deliberately
-- cannot prove currentness, and source signal ingestion status is untouched.
ALTER TABLE source_signals
  ADD COLUMN IF NOT EXISTS review_revision INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_source_signal_review_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.raw_name,
    NEW.raw_domain,
    NEW.source_key,
    NEW.source_locator,
    NEW.source_fingerprint,
    NEW.uei,
    NEW.cage,
    NEW.city,
    NEW.state,
    NEW.country,
    NEW.award_count,
    NEW.award_value,
    NEW.freshest_award,
    NEW.source_payload,
    NEW.qualification,
    NEW.company_id
  ) IS DISTINCT FROM ROW(
    OLD.raw_name,
    OLD.raw_domain,
    OLD.source_key,
    OLD.source_locator,
    OLD.source_fingerprint,
    OLD.uei,
    OLD.cage,
    OLD.city,
    OLD.state,
    OLD.country,
    OLD.award_count,
    OLD.award_value,
    OLD.freshest_award,
    OLD.source_payload,
    OLD.qualification,
    OLD.company_id
  ) THEN
    NEW.review_revision := OLD.review_revision + 1;
  ELSE
    NEW.review_revision := OLD.review_revision;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS source_signals_review_revision_trg ON source_signals;
CREATE TRIGGER source_signals_review_revision_trg
  BEFORE UPDATE ON source_signals
  FOR EACH ROW
  EXECUTE FUNCTION bump_source_signal_review_revision();


ALTER TABLE faa_ensemble_evaluations
  ADD COLUMN IF NOT EXISTS input_hash TEXT,
  ADD COLUMN IF NOT EXISTS input_manifest JSONB;

UPDATE faa_ensemble_evaluations
  SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE faa_ensemble_evaluations
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE faa_ensemble_results
  ADD COLUMN IF NOT EXISTS input_hash TEXT,
  ADD COLUMN IF NOT EXISTS jev_evaluation_id UUID,
  ADD COLUMN IF NOT EXISTS muse_evaluation_id UUID;

ALTER TABLE faa_ensemble_evaluations
  DROP CONSTRAINT IF EXISTS faa_ensemble_evaluations_signal_id_model_id_prompt_version_key,
  DROP CONSTRAINT IF EXISTS faa_ensemble_evaluations_signal_model_prompt_uidx,
  DROP CONSTRAINT IF EXISTS faa_ensemble_evaluations_signal_model_prompt_input_uidx;
DROP INDEX IF EXISTS faa_ensemble_evaluations_signal_model_prompt_uidx;
DROP INDEX IF EXISTS faa_ensemble_evaluations_signal_model_prompt_input_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS faa_ensemble_evaluations_signal_model_prompt_input_uidx
  ON faa_ensemble_evaluations (signal_id, model_id, prompt_version, input_hash)
  NULLS NOT DISTINCT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'faa_ensemble_results_jev_evaluation_id_fk'
      AND conrelid = 'faa_ensemble_results'::regclass
  ) THEN
    ALTER TABLE faa_ensemble_results
      ADD CONSTRAINT faa_ensemble_results_jev_evaluation_id_fk
      FOREIGN KEY (jev_evaluation_id) REFERENCES faa_ensemble_evaluations(id)
      ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'faa_ensemble_results_muse_evaluation_id_fk'
      AND conrelid = 'faa_ensemble_results'::regclass
  ) THEN
    ALTER TABLE faa_ensemble_results
      ADD CONSTRAINT faa_ensemble_results_muse_evaluation_id_fk
      FOREIGN KEY (muse_evaluation_id) REFERENCES faa_ensemble_evaluations(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS signal_review_state (
  signal_id UUID PRIMARY KEY REFERENCES source_signals(id) ON DELETE CASCADE,
  source_revision INT NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'research'
    CHECK (phase IN ('research', 'jev', 'muse', 'settled')),
  input_hash TEXT,
  input_manifest JSONB,
  research_evidence JSONB NOT NULL DEFAULT '{}',
  jev_evaluation_id UUID REFERENCES faa_ensemble_evaluations(id) ON DELETE SET NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  research_due_at TIMESTAMPTZ,
  last_research_outcome JSONB,
  inputs_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT signal_review_state_lease_pair_chk
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
ALTER TABLE signal_review_state
  ADD COLUMN IF NOT EXISTS source_revision INT NOT NULL DEFAULT 0;


CREATE INDEX IF NOT EXISTS signal_review_state_due_idx
  ON signal_review_state (phase, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS signal_review_state_research_due_idx
  ON signal_review_state (research_due_at, created_at);

CREATE TABLE IF NOT EXISTS source_signal_evidence_links (
  signal_id UUID NOT NULL REFERENCES source_signals(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('domain', 'website', 'ownership', 'size')),
  research_revision TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT source_signal_evidence_links_pk PRIMARY KEY (signal_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS source_signal_evidence_links_evidence_idx
  ON source_signal_evidence_links (evidence_id);

COMMIT;
