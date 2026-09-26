BEGIN;
-- Migration 0010: round-2 investor-review fields for unified acquisition
-- targets. Ownership status and pipeline decision derived from the
-- 2026-09-09 Booie verdicts (see deriveRound2Verdict in
-- packages/database/src/unified-targets/populate.ts). Additive only.
ALTER TABLE unified_targets
  ADD COLUMN IF NOT EXISTS ownership_status TEXT CHECK (ownership_status IN ('independent', 'pe_owned', 'strategic_owned', 'public', 'dead', 'unknown')) DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS pipeline_decision TEXT CHECK (pipeline_decision IN ('add', 'hold', 'pass_acquired', 'pass_scale', 'pass_dead', 'pass_sector', 'unreviewed')) DEFAULT 'unreviewed';

-- Backfill rows written before this migration (defaults only apply to new
-- rows on some Postgres versions when added with a check).
UPDATE unified_targets SET ownership_status = 'unknown' WHERE ownership_status IS NULL;
UPDATE unified_targets SET pipeline_decision = 'unreviewed' WHERE pipeline_decision IS NULL;

COMMIT;
