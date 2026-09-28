import type { Database } from "@asi/database/client";
import { populateUnifiedTargets, promoteEnsembleLeads } from "@asi/database";
import {
  currentFaaReviewInputContract,
  reconcileCurrentReviewInputs,
  canSpendExa,
  EXA_CONTENTS_COST_USD,
  EXA_SEARCH_COST_USD,
  getExaDailySpendUsd,
  OWNERSHIP_CHECK_TICK_CAP,
  runSignalEvidenceResearch,
  runJevReviews,
  runMuseReviews,
  runOwnershipChecks,
  runWebsiteEnrichment,
} from "@asi/research";

/** Max website enrichments per tick across the bounded research backlog. */
export const WEBSITE_ENRICHMENT_TICK_CAP = 10;

export interface FunnelStageConfig {
  scheduleMinutes: number;
  batchLimit: number;
  concurrency: number;
  delayMs: number;
  ladderConcurrency: number;
  verifyLimit: number;
  evidenceLimit: number;
  evidenceConcurrency: number;
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
 * REVIEW INVARIANT: raw signals are first registered in signal_review_state,
 * then each network/model stage claims a bounded, lease-fenced phase. Stage
 * ordering is a prompt handoff only; durable review state is authoritative,
 * so one stage failing cannot let a downstream stage consume incomplete
 * input or block independent reconciliation.
 *
 * Legacy enrichment stages still select by artifact absence. The new review
 * lifecycle instead owns currentness, retry backoff, and same-signal
 * exclusion in the database.
 */

/**
 * Fast loop: bounded sourced evidence research (including review-state
 * bootstrap), then current-input JEv review. Each stage owns its real
 * dependency/budget checks and durable retry state; the scheduler does not
 * probe or globally gate them.
 */
export const FAST_STAGES: readonly FunnelStage[] = [
  {
    key: "signal-evidence",
    label: "Signal evidence research",
    async run(ctx) {
      const research = await runSignalEvidenceResearch({
        db: ctx.db,
        limit: ctx.config.evidenceLimit,
        concurrency: ctx.config.evidenceConcurrency,
      });
      return {
        done: research.completed,
        note:
          `claimed=${research.claimed} completed=${research.completed} ` +
          `retryableFailures=${research.retryableFailures} deferred=${research.deferred} ` +
          `ambiguous=${research.ambiguous} noFinding=${research.noFinding} ` +
          `skipped=${research.skipped ?? "none"} costUsd=${research.costUsd}`,
        ...research,
      };
    },
  },
  {
    key: "jev-ladder",
    label: "Current-input JEv review",
    async run(ctx) {
      const review = await runJevReviews(ctx.db, {
        limit: ctx.config.batchLimit,
        concurrency: ctx.config.ladderConcurrency,
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
 * Muse has its own loop so provider latency/outage cannot delay Exa
 * maintenance or database-only reconciliation.
 */
export const MUSE_STAGES: readonly FunnelStage[] = [
  {
    key: "muse-verify",
    label: "Muse verification",
    async run(ctx) {
      const verification = await runMuseReviews(ctx.db, {
        limit: ctx.config.verifyLimit,
        concurrency: ctx.config.concurrency,
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
    key: "ownership",
    label: "Ownership checks",
    async run(ctx) {
      if (!canSpendExa(EXA_SEARCH_COST_USD)) {
        return {
          done: 0,
          note: "exa-budget-skipped",
          budgetSkipped: true,
          spendUsd: getExaDailySpendUsd(),
          checked: 0,
          affirmed: 0,
          skipped: "budget",
          costUsd: 0,
        };
      }
      const ownership = await runOwnershipChecks(ctx.db, {
        limit: OWNERSHIP_CHECK_TICK_CAP,
      });
      return {
        done: ownership.checked,
        note:
          `checked=${ownership.checked} affirmed=${ownership.affirmed} ` +
          `skipped=${ownership.skipped ?? "none"} costUsd=${ownership.costUsd}`,
        checked: ownership.checked,
        affirmed: ownership.affirmed,
        skipped: ownership.skipped,
        costUsd: ownership.costUsd,
      };
    },
  },
  {
    key: "website-enrich",
    label: "Website enrichment",
    async run(ctx) {
      if (!canSpendExa(EXA_CONTENTS_COST_USD)) {
        return {
          done: 0,
          note: "exa-budget-skipped",
          budgetSkipped: true,
          spendUsd: getExaDailySpendUsd(),
          checked: 0,
          enriched: 0,
          skipped: "budget",
          costUsd: 0,
        };
      }
      const enrichment = await runWebsiteEnrichment(ctx.db, {
        limit: WEBSITE_ENRICHMENT_TICK_CAP,
      });
      return {
        done: enrichment.checked,
        note:
          `checked=${enrichment.checked} enriched=${enrichment.enriched} ` +
          `skipped=${enrichment.skipped ?? "none"} costUsd=${enrichment.costUsd}`,
        checked: enrichment.checked,
        enriched: enrichment.enriched,
        skipped: enrichment.skipped,
        costUsd: enrichment.costUsd,
      };
    },
  },
  {
    key: "unify-refresh",
    label: "Unified refresh",
    async run(ctx) {
      await reconcileCurrentReviewInputs(ctx.db);
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
      await reconcileCurrentReviewInputs(ctx.db);
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
