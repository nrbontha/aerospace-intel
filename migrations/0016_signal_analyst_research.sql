BEGIN;
-- Migration 0016: durable source-signal analyst episodes/action journal and
-- before-call paid-provider accounting. Model usage remains in its existing
-- independent ledgers and is deliberately not copied here.
CREATE TABLE signal_analyst_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID NOT NULL REFERENCES source_signals(id) ON DELETE CASCADE,
  source_revision INT NOT NULL,
  policy_version TEXT NOT NULL CHECK (length(btrim(policy_version)) > 0),
  input_hash CHAR(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN (
      'active', 'awaiting_review', 'deferred', 'completed', 'exhausted',
      'superseded'
    )),
  limits JSONB NOT NULL DEFAULT '{}',
  checkpoint JSONB NOT NULL DEFAULT '{}',
  memo JSONB,
  next_attempt_at TIMESTAMPTZ,
  stop_reason TEXT,
  next_step_sequence INT NOT NULL DEFAULT 1 CHECK (next_step_sequence >= 1),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT signal_analyst_cases_identity_uidx
    UNIQUE (signal_id, source_revision, policy_version)
);
CREATE INDEX signal_analyst_cases_signal_created_idx
  ON signal_analyst_cases (signal_id, created_at);
CREATE INDEX signal_analyst_cases_due_idx
  ON signal_analyst_cases (status, next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;

CREATE TABLE signal_analyst_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES signal_analyst_cases(id) ON DELETE CASCADE,
  sequence INT NOT NULL CHECK (sequence >= 1),
  kind TEXT NOT NULL CHECK (length(btrim(kind)) > 0),
  request JSONB NOT NULL,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN (
      'in_progress', 'completed', 'interrupted', 'late_result',
      'retryable_failure', 'quota_deferred', 'exhausted'
    )),
  response JSONB,
  observed_status TEXT
    CHECK (
      observed_status IS NULL OR observed_status IN (
        'completed', 'interrupted', 'retryable_failure',
        'quota_deferred', 'exhausted'
      )
    ),
  error TEXT,
  claim_phase TEXT NOT NULL
    CHECK (claim_phase IN ('research', 'jev', 'muse', 'settled')),
  claim_lease_token UUID NOT NULL,
  claim_input_hash CHAR(64)
    CHECK (claim_input_hash IS NULL OR claim_input_hash ~ '^[0-9a-f]{64}$'),
  model_usage_receipt_id UUID REFERENCES faa_review_model_usage(id)
    ON DELETE RESTRICT,
  cost_known BOOLEAN NOT NULL DEFAULT false,
  cost_usd NUMERIC,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  late_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT signal_analyst_steps_case_sequence_uidx UNIQUE (case_id, sequence),
  CONSTRAINT signal_analyst_steps_cost_chk CHECK (
    (cost_known AND cost_usd IS NOT NULL AND cost_usd >= 0)
    OR (NOT cost_known AND cost_usd IS NULL)
  ),
  CONSTRAINT signal_analyst_steps_finish_chk CHECK (
    (status = 'in_progress') = (finished_at IS NULL)
  ),
  CONSTRAINT signal_analyst_steps_late_result_chk CHECK (
    (status = 'late_result'
      AND observed_status IS NOT NULL
      AND late_observed_at IS NOT NULL)
    OR (status <> 'late_result'
      AND observed_status IS NULL
      AND late_observed_at IS NULL)
  )
);
CREATE INDEX signal_analyst_steps_case_request_idx
  ON signal_analyst_steps (case_id, request_hash, sequence);
CREATE UNIQUE INDEX signal_analyst_steps_completed_request_uidx
  ON signal_analyst_steps (case_id, request_hash)
  WHERE status = 'completed';

CREATE TABLE research_provider_budget_scopes (
  id TEXT PRIMARY KEY CHECK (length(btrim(id)) > 0),
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  starts_at TIMESTAMPTZ NOT NULL,
  total_cap_usd NUMERIC NOT NULL CHECK (total_cap_usd >= 0),
  permit_status TEXT NOT NULL
    CHECK (permit_status IN ('paused', 'active', 'closed')),
  permit_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX research_provider_budget_provider_status_idx
  ON research_provider_budget_scopes (provider, permit_status, starts_at);

CREATE FUNCTION protect_research_provider_budget_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.id, NEW.provider, NEW.starts_at, NEW.total_cap_usd)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.provider, OLD.starts_at, OLD.total_cap_usd) THEN
    RAISE EXCEPTION 'research provider budget scope identity and cap are immutable';
  END IF;
  IF OLD.sealed_at IS NOT NULL
    AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at THEN
    RAISE EXCEPTION 'sealed research provider budget scope cannot be unsealed';
  END IF;
  IF OLD.permit_status = 'closed' AND NEW.permit_status <> 'closed' THEN
    RAISE EXCEPTION 'closed research provider budget scope cannot be reopened';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER research_provider_budget_scope_protect_trg
  BEFORE UPDATE ON research_provider_budget_scopes
  FOR EACH ROW
  EXECUTE FUNCTION protect_research_provider_budget_scope();

CREATE TABLE research_provider_budget_scope_signals (
  budget_scope_id TEXT NOT NULL
    REFERENCES research_provider_budget_scopes(id) ON DELETE RESTRICT,
  source_signal_id UUID NOT NULL
    REFERENCES source_signals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_provider_budget_scope_signals_pk
    PRIMARY KEY (budget_scope_id, source_signal_id)
);
CREATE INDEX research_provider_budget_scope_signals_signal_idx
  ON research_provider_budget_scope_signals (source_signal_id);

CREATE FUNCTION protect_research_provider_budget_allowlist()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scope_sealed_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT sealed_at INTO scope_sealed_at
    FROM research_provider_budget_scopes
    WHERE id = NEW.budget_scope_id
    FOR SHARE;
    IF scope_sealed_at IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'research provider budget scope allowlist is immutable';
END;
$$;
CREATE TRIGGER research_provider_budget_allowlist_protect_trg
  BEFORE INSERT OR UPDATE OR DELETE ON research_provider_budget_scope_signals
  FOR EACH ROW
  EXECUTE FUNCTION protect_research_provider_budget_allowlist();

CREATE TABLE research_provider_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  operation TEXT NOT NULL CHECK (length(btrim(operation)) > 0),
  source_signal_id UUID NOT NULL REFERENCES source_signals(id) ON DELETE RESTRICT,
  analyst_step_id UUID REFERENCES signal_analyst_steps(id) ON DELETE SET NULL,
  budget_scope_id TEXT NOT NULL
    REFERENCES research_provider_budget_scopes(id) ON DELETE RESTRICT,
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  usage_day DATE NOT NULL,
  estimated_cost_usd NUMERIC NOT NULL CHECK (estimated_cost_usd >= 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'succeeded', 'failed', 'ambiguous')),
  actual_cost_usd NUMERIC CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
  observed_at TIMESTAMPTZ,
  error TEXT,
  provider_cooldown_retry_at TIMESTAMPTZ,
  provider_cooldown_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_provider_usage_settlement_chk CHECK (
    (status = 'reserved' AND observed_at IS NULL)
    OR (status <> 'reserved' AND observed_at IS NOT NULL)
  ),
  CONSTRAINT research_provider_usage_cooldown_pair_chk CHECK (
    (provider_cooldown_retry_at IS NULL) = (provider_cooldown_reason IS NULL)
  ),
  CONSTRAINT research_provider_usage_cooldown_retry_chk CHECK (
    provider_cooldown_retry_at IS NULL
    OR (
      observed_at IS NOT NULL
      AND provider_cooldown_retry_at > observed_at
    )
  )
);
CREATE INDEX research_provider_usage_provider_day_idx
  ON research_provider_usage (provider, usage_day, created_at);
CREATE INDEX research_provider_usage_signal_idx
  ON research_provider_usage (source_signal_id);
CREATE INDEX research_provider_usage_budget_scope_idx
  ON research_provider_usage (budget_scope_id);
CREATE UNIQUE INDEX research_provider_usage_step_uidx
  ON research_provider_usage (analyst_step_id)
  WHERE analyst_step_id IS NOT NULL;

-- Provider authorization/quota failures are provider-wide dependencies, not
-- company failures. The row is a renewable cooldown, never a permanent deny.
CREATE TABLE research_provider_cooldowns (
  provider TEXT PRIMARY KEY CHECK (length(btrim(provider)) > 0),
  retry_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  source_reservation_id UUID REFERENCES research_provider_usage(id)
    ON DELETE SET NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_provider_cooldowns_retry_chk
    CHECK (retry_at > observed_at)
);
CREATE INDEX research_provider_cooldowns_retry_idx
  ON research_provider_cooldowns (retry_at);

-- Quiesced cutover imports legacy file-ledger estimates here. They remain
-- explicitly estimated, never masquerade as exact provider receipts, and are
-- included in admission accounting for their original UTC day.
CREATE TABLE research_provider_legacy_estimates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (length(btrim(provider)) > 0),
  usage_day DATE NOT NULL,
  estimated_cost_usd NUMERIC NOT NULL CHECK (estimated_cost_usd >= 0),
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT research_provider_legacy_import_uidx
    UNIQUE (provider, idempotency_key)
);
CREATE INDEX research_provider_legacy_provider_day_idx
  ON research_provider_legacy_estimates (provider, usage_day);
COMMIT;
