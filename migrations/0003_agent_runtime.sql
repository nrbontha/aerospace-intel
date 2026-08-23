BEGIN;
-- Migration 0003: autonomous research agents (control plane) + candidate tiers.
-- ADDITIVE ONLY: new enums, two new tables, nullable owner column on
-- frontier_items, tier columns on candidates. Existing rows untouched.
DO $$ BEGIN CREATE TYPE agent_type AS ENUM ('discover_source','enrich_candidate','monitor_ownership','refresh_stale','golden_neighbor'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE agent_status AS ENUM ('idle','running','paused','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tick_outcome AS ENUM ('planned','executed','stuck','done','budget_exhausted','error','preempted'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tier_override_t AS ENUM ('high_interest','evaluate','low_interest','watchlist'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tier_source AS ENUM ('engine','human'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Long-horizon memory for one autonomous agent. `key` is the stable slug used
-- by registry seeds ('discover-usaspending', …). Lease columns implement
-- crash-safe takeover: a stale lease_expires_at lets any supervisor reclaim.
CREATE TABLE IF NOT EXISTS research_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  name text NOT NULL,
  agent_type agent_type NOT NULL,
  goal text NOT NULL,
  seed_scope jsonb NOT NULL DEFAULT '{}',
  policy_version text,
  budget_share_pct numeric(5,2) CHECK(budget_share_pct IS NULL OR budget_share_pct BETWEEN 0 AND 100),
  daily_budget_usd numeric(10,2) CHECK(daily_budget_usd IS NULL OR daily_budget_usd>=0),
  cadence_seconds integer NOT NULL DEFAULT 900 CHECK(cadence_seconds>0),
  status agent_status NOT NULL DEFAULT 'idle',
  last_tick_at timestamptz,
  next_tick_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  leased_by text,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  spend_today_usd numeric(10,2) NOT NULL DEFAULT 0 CHECK(spend_today_usd>=0),
  config jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_agents_key_uidx ON research_agents(key);
-- Matches the supervisor due-query: WHERE status='running' AND next_tick_at <= now().
CREATE INDEX IF NOT EXISTS research_agents_status_next_tick_idx ON research_agents(status,next_tick_at);

-- Bounded per-agent journal (scheduled cleanup prunes old rows); started_at is
-- the row clock, findings carries the {newLeads,newCandidates,…} delta.
CREATE TABLE IF NOT EXISTS agent_ticks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES research_agents(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome tick_outcome NOT NULL,
  plan jsonb NOT NULL DEFAULT '{}',
  actions_executed integer NOT NULL DEFAULT 0 CHECK(actions_executed>=0),
  findings jsonb NOT NULL DEFAULT '{}',
  cost_usd numeric(10,6) NOT NULL DEFAULT 0 CHECK(cost_usd>=0),
  error text
);
CREATE INDEX IF NOT EXISTS agent_ticks_agent_started_idx ON agent_ticks(agent_id,started_at);

-- Frontier items gain a second possible owner: an agent working outside any
-- campaign. Exactly one of campaign_id / agent_id must be present. Safe to
-- drop NOT NULL first because every pre-existing row has campaign_id, so the
-- validated CHECK below holds for all existing data.
ALTER TABLE frontier_items ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE frontier_items ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES research_agents(id) ON DELETE SET NULL;
ALTER TABLE frontier_items DROP CONSTRAINT IF EXISTS frontier_owner_check;
ALTER TABLE frontier_items ADD CONSTRAINT frontier_owner_check CHECK (campaign_id IS NOT NULL OR agent_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS frontier_items_agent_idx ON frontier_items(agent_id);

-- Tier system (REDESIGN_PLAN §2.1): engine proposes from routing; humans may
-- override; tier_source records who owns the current effective tier.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS tier_override tier_override_t;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS tier_source tier_source NOT NULL DEFAULT 'engine';

COMMIT;
