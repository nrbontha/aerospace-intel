BEGIN;
DO $$ BEGIN CREATE TYPE candidate_status AS ENUM ('queued_research','in_research','research_ready','partner_review','shortlist','hold','rejected','watchlist','archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE novelty_status AS ENUM ('not_matched_to_current_known_universe','possible_known_universe_match','confirmed_known_company','unable_to_assess'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE score_axis AS ENUM ('fit','novelty','confidence','actionability'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE program_axis AS ENUM ('fit','actionability','novelty','confidence'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE program_status AS ENUM ('champion','challenger','rejected','archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE experiment_kind AS ENUM ('scorer','research_policy','enrichment_benchmark','blind_discovery','entity_resolution','evidence_quality','efficiency'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE feedback_channel AS ENUM ('identity','investment','research_quality','source'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE research_question_status AS ENUM ('open','answered','stale'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE campaign_status AS ENUM ('draft','queued','running','paused','completed','failed','cancelled','budget_exhausted','frontier_exhausted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE frontier_item_type AS ENUM ('source','query','url','document','pdf','spreadsheet','company','facility','domain','alias','cage_code','uei','pma_holder','part_number','nsn','niin','qualification','certification','platform','subsystem','product_family','lead','research_question'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE frontier_item_status AS ENUM ('pending','in_progress','done','failed','skipped','blocked'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- rationale holds why_interesting / risks / unknowns arrays; current_scores denormalizes
-- the latest per-axis value for fast feed queries (history lives in candidate_scores).
CREATE TABLE IF NOT EXISTS candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, status candidate_status NOT NULL DEFAULT 'queued_research', novelty_status novelty_status NOT NULL DEFAULT 'unable_to_assess', novelty_snapshot_ids uuid[] NOT NULL DEFAULT '{}', rationale jsonb NOT NULL DEFAULT '{}', current_scores jsonb NOT NULL DEFAULT '{}', research_priority numeric(6,2), partner_review_priority numeric(6,2), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(research_priority IS NULL OR research_priority BETWEEN 0 AND 100), CHECK(partner_review_priority IS NULL OR partner_review_priority BETWEEN 0 AND 100));
CREATE TABLE IF NOT EXISTS scoring_programs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, version integer NOT NULL CHECK(version>=1), axis program_axis NOT NULL, program jsonb NOT NULL, status program_status NOT NULL DEFAULT 'challenger', complexity numeric(5,3) DEFAULT 0, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(complexity IS NULL OR complexity>=0));
CREATE UNIQUE INDEX IF NOT EXISTS scoring_programs_name_version_uidx ON scoring_programs(name,version);

CREATE UNIQUE INDEX IF NOT EXISTS candidates_company_id_uidx ON candidates(company_id);
CREATE INDEX IF NOT EXISTS candidates_status_idx ON candidates(status);
CREATE INDEX IF NOT EXISTS candidates_novelty_status_idx ON candidates(novelty_status);

-- Append-only: score history is never rewritten; latest per axis is denormalized onto candidates.current_scores.
CREATE TABLE IF NOT EXISTS candidate_scores (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE, axis score_axis NOT NULL, value numeric(5,2), scoring_program_id uuid REFERENCES scoring_programs(id) ON DELETE SET NULL, feature_schema_version text NOT NULL DEFAULT 'v1', details jsonb NOT NULL DEFAULT '{}', computed_at timestamptz NOT NULL DEFAULT now(), CHECK(value IS NULL OR value BETWEEN -1 AND 101));
CREATE INDEX IF NOT EXISTS candidate_scores_candidate_idx ON candidate_scores(candidate_id,computed_at);
CREATE INDEX IF NOT EXISTS candidate_scores_program_idx ON candidate_scores(scoring_program_id);

CREATE TABLE IF NOT EXISTS feature_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, schema_version text NOT NULL DEFAULT 'v1', features jsonb NOT NULL, content_sha256 char(64) NOT NULL, thesis_version text NOT NULL DEFAULT 'thesis-v0', created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS feature_snapshots_identity_uidx ON feature_snapshots(company_id,schema_version,content_sha256);
CREATE INDEX IF NOT EXISTS feature_snapshots_company_idx ON feature_snapshots(company_id);

CREATE TABLE IF NOT EXISTS experiment_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind experiment_kind NOT NULL, label text NOT NULL, primary_metric_name text, primary_metric_value numeric(8,4), result jsonb NOT NULL DEFAULT '{}', keep boolean, decision text, lineage_parent_id uuid REFERENCES experiment_runs(id) ON DELETE SET NULL, campaign_id uuid, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS experiment_runs_kind_created_idx ON experiment_runs(kind,created_at);
CREATE INDEX IF NOT EXISTS experiment_runs_campaign_idx ON experiment_runs(campaign_id);
CREATE INDEX IF NOT EXISTS experiment_runs_lineage_parent_idx ON experiment_runs(lineage_parent_id);

CREATE TABLE IF NOT EXISTS feedback (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel feedback_channel NOT NULL, company_id uuid REFERENCES companies(id) ON DELETE SET NULL, candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL, lead_id uuid REFERENCES leads(id) ON DELETE SET NULL, action text NOT NULL, reason text, payload jsonb NOT NULL DEFAULT '{}', notes text, actor uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), CHECK(btrim(action)<>''), CHECK(channel<>'investment' OR action IN ('strong_fit','possible_fit','shortlist','hold','needs_more_research','reject','historical_ideal_unactionable')), CHECK(channel<>'identity' OR action IN ('same_company','different_company','duplicate','alias','subsidiary','parent','acquired_into','already_in_pipeline','already_known_outside_pipeline','incorrect_match','correct_match')), CHECK(company_id IS NOT NULL OR candidate_id IS NOT NULL OR lead_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS feedback_channel_created_idx ON feedback(channel,created_at);
CREATE INDEX IF NOT EXISTS feedback_candidate_idx ON feedback(candidate_id);
CREATE INDEX IF NOT EXISTS feedback_company_idx ON feedback(company_id);
CREATE INDEX IF NOT EXISTS feedback_lead_idx ON feedback(lead_id);

CREATE TABLE IF NOT EXISTS research_questions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), candidate_id uuid REFERENCES candidates(id) ON DELETE SET NULL, company_id uuid REFERENCES companies(id) ON DELETE SET NULL, question text NOT NULL, status research_question_status NOT NULL DEFAULT 'open', answer jsonb, priority numeric(5,2), created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, CHECK(btrim(question)<>''), CHECK(priority IS NULL OR priority BETWEEN 0 AND 100), CHECK(candidate_id IS NOT NULL OR company_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS research_questions_candidate_idx ON research_questions(candidate_id);
CREATE INDEX IF NOT EXISTS research_questions_company_idx ON research_questions(company_id);
CREATE INDEX IF NOT EXISTS research_questions_status_idx ON research_questions(status);

CREATE TABLE IF NOT EXISTS research_campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, objective text, thesis_version text NOT NULL DEFAULT 'thesis-v0', policy_version text NOT NULL DEFAULT 'policy-v0', seeds jsonb NOT NULL DEFAULT '{}', excluded_sources jsonb NOT NULL DEFAULT '[]', budget_usd numeric(10,2), spend_usd numeric(10,2) NOT NULL DEFAULT 0, concurrency integer NOT NULL DEFAULT 2, max_depth integer NOT NULL DEFAULT 2, status campaign_status NOT NULL DEFAULT 'draft', creator uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, paused_at timestamptz, completed_at timestamptz, metrics jsonb NOT NULL DEFAULT '{}', CHECK(spend_usd>=0), CHECK(concurrency BETWEEN 1 AND 16), CHECK(max_depth>=0));
CREATE UNIQUE INDEX IF NOT EXISTS research_campaigns_name_uidx ON research_campaigns(name);

-- campaign_id on experiment_runs intentionally has no FOREIGN KEY: run journals may
-- reference campaigns that are created or pruned independently of this journal.

CREATE TABLE IF NOT EXISTS frontier_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_id uuid NOT NULL REFERENCES research_campaigns(id) ON DELETE CASCADE, item_type frontier_item_type NOT NULL, normalized_value text NOT NULL, parent_item_id uuid REFERENCES frontier_items(id) ON DELETE SET NULL, discovery_path text, priority numeric(6,2) NOT NULL DEFAULT 0, estimated_value numeric(6,2), estimated_cost_usd numeric(8,4) NOT NULL DEFAULT 0, depth integer NOT NULL DEFAULT 0, status frontier_item_status NOT NULL DEFAULT 'pending', attempt_count integer NOT NULL DEFAULT 0, last_attempt_at timestamptz, next_attempt_at timestamptz, idempotency_key text, normalized_url text, content_sha256 char(64), failure_reason text, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, CHECK(depth>=0), CHECK(attempt_count>=0), CHECK(estimated_cost_usd>=0));
CREATE UNIQUE INDEX IF NOT EXISTS frontier_items_idempotency_key_uidx ON frontier_items(idempotency_key);
CREATE INDEX IF NOT EXISTS frontier_items_campaign_status_idx ON frontier_items(campaign_id,status);
CREATE INDEX IF NOT EXISTS frontier_items_status_next_attempt_idx ON frontier_items(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS frontier_items_parent_idx ON frontier_items(parent_item_id);

DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['candidate_scores','experiment_runs'] LOOP EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I','deny_'||n||'_mutation',n); EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION deny_immutable_record_change()','deny_'||n||'_mutation',n); END LOOP; END $$;
COMMIT;
