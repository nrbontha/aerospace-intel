BEGIN;
-- Migration 0009: additive investor review fields for unified acquisition targets.
ALTER TABLE unified_targets
  ADD COLUMN IF NOT EXISTS investor_priority INT CHECK (investor_priority BETWEEN 1 AND 3),
  ADD COLUMN IF NOT EXISTS oversize_flag BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS proprietary_basis TEXT CHECK (proprietary_basis IN ('product', 'process_only', 'unknown')) DEFAULT 'unknown';

COMMIT;
