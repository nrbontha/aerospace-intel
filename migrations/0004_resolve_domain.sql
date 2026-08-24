-- Wave B (REDESIGN_PLAN §1.3): autonomous domain-resolution agent type.
--
-- PG 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as long as the
-- new value is not USED in the same transaction; the runner wraps each
-- migration in BEGIN/COMMIT, so this file is deliberately ALTER-only — the
-- registry seed row lives in the supervisor seeder instead.
ALTER TYPE agent_type ADD VALUE IF NOT EXISTS 'resolve_domain';
