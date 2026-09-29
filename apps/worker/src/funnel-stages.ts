import type { Database } from "@asi/database/client";
import { populateUnifiedTargets, promoteEnsembleLeads } from "@asi/database";
import {
  currentFaaReviewInputContract,
  reconcileCurrentReviewInputs,
  runJevReviews,
  runMuseReviews,
} from "@asi/research";

export interface FunnelStageConfig {
  scheduleMinutes: number;
  batchLimit: number;
  concurrency: number;
  ladderConcurrency: number;
  verifyLimit: number;
  analystMode: "disabled" | "free_only" | "bounded_paid";
  exaBudgetScopeId?: string;
  jevSourceSignalIds?: readonly string[];
}

export interface FunnelStageContext {
  db: Database;
  config: FunnelStageConfig;
}

export interface FunnelStageSummary {
  done: number;
  note: string;
  [key: string]: unknown;
}

export interface FunnelStage {
  key: string;
  label: string;
  run: (ctx: FunnelStageContext) => Promise<FunnelStageSummary>;
}

/**
 * REVIEW INVARIANT: durable review state and lease fencing are authoritative.
 * Cheap Jev screening, persistent Muse research, and database-only maintenance
 * run under independent scheduler locks so provider waits cannot starve Jev.
 */
export const FAST_STAGES: readonly FunnelStage[] = [
  {
    key: "jev-ladder",
    label: "Current-input JEv review",
    async run(ctx) {
      const review = await runJevReviews(ctx.db, {
        limit: ctx.config.batchLimit,
        concurrency: ctx.config.ladderConcurrency,
        ...(ctx.config.jevSourceSignalIds === undefined
          ? {}
          : { sourceSignalIds: ctx.config.jevSourceSignalIds }),
      });
      return {
        done: review.screened,
        note:
          `screened=${review.screened} hp=${review.hp} ` +
          `research=${review.research} rejected=${review.rejected} ` +
          `errors=${review.errors} stale=${review.stale} costUsd=${review.costUsd}`,
        ...review,
      };
    },
  },
];
/**
 * Muse has its own loop so resource latency, quota, or allowance state cannot
 * delay cheap Jev screening or database-only reconciliation.
 */
export const MUSE_STAGES: readonly FunnelStage[] = [
  {
    key: "muse-verify",
    label: "Muse verification",
    async run(ctx) {
      const verification = await runMuseReviews(ctx.db, {
        limit: ctx.config.verifyLimit,
        concurrency: ctx.config.concurrency,
        analystMode: ctx.config.analystMode,
        ...(ctx.config.exaBudgetScopeId === undefined
          ? {}
          : { exaBudgetScopeId: ctx.config.exaBudgetScopeId }),
      });
      return {
        done: verification.verified,
        note:
          `verified=${verification.verified} confirmed=${verification.confirmed} ` +
          `overruled=${verification.overruled} errors=${verification.errors} ` +
          `stale=${verification.stale}`,
        ...verification,
      };
    },
  },
];

/**
 * Slow independent maintenance/projection loop. Promotion remains safe when
 * Muse is unavailable because it consumes only lease-fenced settled reviews.
 */
export const SLOW_STAGES: readonly FunnelStage[] = [
  {
    key: "unify-refresh",
    label: "Unified refresh",
    async run(ctx) {
      await reconcileCurrentReviewInputs(ctx.db, {
        ...(ctx.config.jevSourceSignalIds === undefined
          ? {}
          : { sourceSignalIds: ctx.config.jevSourceSignalIds }),
      });
      const refreshed = await populateUnifiedTargets(ctx.db, {
        expectedReviewInputContract: currentFaaReviewInputContract(),
      });
      const sourceCount = Object.keys(refreshed).length;
      return {
        done: sourceCount,
        note: `sources=${sourceCount}`,
        sources: refreshed,
      };
    },
  },
  {
    key: "promote",
    label: "Lead promotion",
    async run(ctx) {
      await reconcileCurrentReviewInputs(ctx.db, {
        ...(ctx.config.jevSourceSignalIds === undefined
          ? {}
          : { sourceSignalIds: ctx.config.jevSourceSignalIds }),
      });
      const promotion = await promoteEnsembleLeads(ctx.db, {
        expectedReviewInputContract: currentFaaReviewInputContract(),
      });
      return {
        done: promotion.promoted,
        note:
          `promoted=${promotion.promoted} eligible=${promotion.eligible} ` +
          `held=${promotion.held} excluded=${promotion.excluded} ` +
          `skipped=${promotion.skipped}`,
        ...promotion,
      };
    },
  },
];

/** Full registry in durable lifecycle order. */
export const FUNNEL_STAGES: readonly FunnelStage[] = [
  ...FAST_STAGES,
  ...MUSE_STAGES,
  ...SLOW_STAGES,
];
