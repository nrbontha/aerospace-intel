BEGIN;

-- Migration 0017: an auditable curation overlay over raw source signals.
-- This deliberately does not alter qualification, ranking, source history, or
-- provider-accounting tables.
CREATE TYPE investor_pick_origin_kind AS ENUM ('manual', 'golden', 'booie');

CREATE TABLE investor_picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_signal_id UUID NOT NULL REFERENCES source_signals(id) ON DELETE RESTRICT,
  note TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX investor_picks_source_signal_uidx
  ON investor_picks(source_signal_id);
CREATE INDEX investor_picks_active_updated_idx
  ON investor_picks(active, updated_at);

CREATE TABLE investor_pick_origins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_pick_id UUID NOT NULL REFERENCES investor_picks(id) ON DELETE CASCADE,
  kind investor_pick_origin_kind NOT NULL,
  label TEXT NOT NULL,
  snapshot_id UUID REFERENCES known_universe_snapshots(id) ON DELETE RESTRICT,
  snapshot_key TEXT,
  member_id UUID REFERENCES known_universe_members(id) ON DELETE RESTRICT,
  source_row INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investor_pick_origins_provenance_chk CHECK (
    (
      kind = 'manual'
      AND snapshot_id IS NULL
      AND snapshot_key IS NULL
      AND member_id IS NULL
      AND source_row IS NULL
    ) OR (
      kind = 'golden'
      AND snapshot_id IS NOT NULL
      AND snapshot_key = 'golden-set-v01'
      AND member_id IS NOT NULL
    ) OR (
      kind = 'booie'
      AND snapshot_id IS NOT NULL
      AND snapshot_key = 'booie-original29-2026-09-09'
      AND member_id IS NOT NULL
    )
  ),
  CONSTRAINT investor_pick_origins_label_chk CHECK (length(btrim(label)) > 0)
);
CREATE UNIQUE INDEX investor_pick_origins_member_uidx
  ON investor_pick_origins(member_id)
  WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX investor_pick_origins_manual_pick_uidx
  ON investor_pick_origins(investor_pick_id)
  WHERE kind = 'manual';
CREATE INDEX investor_pick_origins_pick_idx
  ON investor_pick_origins(investor_pick_id, created_at);
CREATE INDEX investor_pick_origins_snapshot_idx
  ON investor_pick_origins(snapshot_id, member_id);

COMMIT;
