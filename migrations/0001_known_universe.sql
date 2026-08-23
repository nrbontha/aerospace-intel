BEGIN;
DO $$ BEGIN CREATE TYPE snapshot_member_match_status AS ENUM ('exact','probable','possible','none','unresolved'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE golden_example_type AS ENUM ('strong_positive','positive_with_caveat','borderline','negative_business_model','ideal_archetype_but_unactionable','known_non_target','unclassified'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE label_scale AS ENUM ('strong_positive','positive','neutral','negative','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE build_to_print_risk AS ENUM ('none','low','medium','high','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE lead_status AS ENUM ('new','resolving','resolved','unresolved_lead','discarded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE match_decision AS ENUM ('pending','merged','rejected_merge','alias','parent_subsidiary','acquired_into'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE review_status AS ENUM ('unclassified','proposed','reviewed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS known_universe_snapshots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL, name text NOT NULL, source_type text NOT NULL CHECK(source_type IN ('golden_set_workbook','grata_enrichment','preliminary_pipeline','manual','external_export')), import_file_name text, content_sha256 char(64), effective_date date, notes text, row_count integer NOT NULL DEFAULT 0 CHECK(row_count>=0), active boolean NOT NULL DEFAULT true, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS known_universe_snapshots_key_uidx ON known_universe_snapshots(key);
CREATE TABLE IF NOT EXISTS known_universe_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), snapshot_id uuid NOT NULL REFERENCES known_universe_snapshots(id) ON DELETE CASCADE, company_id uuid REFERENCES companies(id) ON DELETE SET NULL, matched_company_id uuid REFERENCES companies(id) ON DELETE SET NULL, raw_name text NOT NULL, raw_domain text, normalized_domain text, normalized_name text, match_status snapshot_member_match_status NOT NULL DEFAULT 'unresolved', match_confidence numeric(4,3), raw_payload jsonb NOT NULL DEFAULT '{}', source_row integer, created_at timestamptz NOT NULL DEFAULT now(), CHECK(match_confidence IS NULL OR match_confidence BETWEEN 0 AND 1));
CREATE UNIQUE INDEX IF NOT EXISTS known_universe_members_identity_uidx ON known_universe_members(snapshot_id,lower(normalized_domain),lower(normalized_name)) NULLS NOT DISTINCT WHERE normalized_domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS known_universe_members_name_uidx ON known_universe_members(snapshot_id,lower(normalized_name)) NULLS NOT DISTINCT WHERE normalized_domain IS NULL AND normalized_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS known_universe_members_snapshot_idx ON known_universe_members(snapshot_id);
CREATE UNIQUE INDEX IF NOT EXISTS known_universe_members_identity_uidx ON known_universe_members(snapshot_id,lower(normalized_domain),lower(normalized_name)) WHERE normalized_domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS known_universe_members_matched_company_idx ON known_universe_members(matched_company_id);

CREATE TABLE IF NOT EXISTS golden_examples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid REFERENCES companies(id) ON DELETE SET NULL, snapshot_id uuid REFERENCES known_universe_snapshots(id) ON DELETE SET NULL, name text NOT NULL, domain text, description_raw text, grata_payload jsonb NOT NULL DEFAULT '{}', workbook_row integer, proposed_labels jsonb NOT NULL DEFAULT '{}', archetype_fit label_scale, current_actionability label_scale, business_model_fit label_scale, ownership_fit label_scale, golden_example_type golden_example_type, build_to_print_risk build_to_print_risk, review_notes text, review_status review_status NOT NULL DEFAULT 'unclassified', reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS golden_examples_name_domain_uidx ON golden_examples(lower(name),coalesce(lower(domain),'')) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS golden_examples_company_idx ON golden_examples(company_id);
CREATE INDEX IF NOT EXISTS golden_examples_review_status_idx ON golden_examples(review_status);

-- campaign_id intentionally has no FOREIGN KEY: the campaigns table arrives in a later migration.
CREATE TABLE IF NOT EXISTS leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), research_run_id uuid REFERENCES research_runs(id) ON DELETE SET NULL, campaign_id uuid, source_document_id uuid REFERENCES source_documents(id) ON DELETE SET NULL, raw_name text NOT NULL, context jsonb NOT NULL DEFAULT '{}', url text, possible_domain text, possible_location text, possible_identifiers jsonb NOT NULL DEFAULT '[]', possible_products jsonb NOT NULL DEFAULT '[]', extraction_method text, extraction_confidence numeric(4,3), status lead_status NOT NULL DEFAULT 'new', resolved_company_id uuid REFERENCES companies(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CHECK(extraction_confidence IS NULL OR extraction_confidence BETWEEN 0 AND 1));
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status,created_at);
CREATE INDEX IF NOT EXISTS leads_resolved_company_idx ON leads(resolved_company_id);
CREATE INDEX IF NOT EXISTS leads_source_document_idx ON leads(source_document_id);

CREATE TABLE IF NOT EXISTS identity_match_candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE, company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, signal_type text NOT NULL, features jsonb NOT NULL DEFAULT '{}', confidence numeric(4,3) NOT NULL CHECK(confidence BETWEEN 0 AND 1), explanation text, decision match_decision NOT NULL DEFAULT 'pending', decided_by uuid REFERENCES users(id) ON DELETE SET NULL, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS identity_match_candidates_lead_company_uidx ON identity_match_candidates(lead_id,company_id);
CREATE INDEX IF NOT EXISTS identity_match_candidates_company_idx ON identity_match_candidates(company_id);

DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['known_universe_members'] LOOP EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I','deny_'||n||'_mutation',n); EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION deny_immutable_record_change()','deny_'||n||'_mutation',n); END LOOP; END $$;
COMMIT;
