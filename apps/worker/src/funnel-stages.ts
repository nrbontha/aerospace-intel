import type { Database } from "@asi/database/client";
import { populateUnifiedTargets, promoteEnsembleLeads } from "@asi/database";
import {
  canSpendExa,
  EXA_CONTENTS_COST_USD,
  EXA_SEARCH_COST_USD,
  getExaDailySpendUsd,
  OWNERSHIP_CHECK_TICK_CAP,
  runJevSweep,
  runLadderRescreen,
  runMuseVerification,
  runOwnershipChecks,
  runWebsiteEnrichment,
} from "@asi/research";

/** Max website enrichments per tick (unvetted HP/P1 without website evidence). */
export const WEBSITE_ENRICHMENT_TICK_CAP = 10;

export interface FunnelStageConfig {
  scheduleMinutes: number;
  batchLimit: number;
  concurrency: number;
  delayMs: number;
  sweepLimit: number;
  sweepConcurrency: number;
  verifyLimit: number;
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
 * BACKFILL INVARIANT: every stage below selects work by artifact ABSENCE, not
 * by recency or by "created since last tick". A target qualifies when an
 * upstream artifact exists (or the source row exists) AND the stage's own
 * output artifact is missing. Consequence: adding a brand-new stage step
 * automatically backfills it over all existing targets on the next tick, with
 * no migration and no catch-up job.
 *
 * Per-stage examples:
 * - jev-sweep: a signal with no JEv evaluation row gets screened, even if it
 *   was ingested months before this stage existed.
 * - muse-verify: a JEv-flagged signal with no Muse evaluation row gets
 *   verified, even if flagged long ago.
 * - ownership: an HP-unified name with no ownership observation gets checked,
 *   even if unified before ownership checks were added.
 * - website-enrich: an unvetted HP/P1 name with no website evidence rows gets
 *   enriched, even if it predates the enricher.
 * - unify-refresh: per-source upserts are idempotent, so a newly added source
 *   key backfills every one of its rows on the next tick.
 * - promote: an HP result row that was never promoted becomes a lead, even if
 *   it qualified before promotion existed.
 *
 * Keep this property when adding stages: gate on the absence of YOUR output
 * artifact, never on timestamps or tick cursors.
 */
export const FUNNEL_STAGES: readonly FunnelStage[] = [
  {
    key: "jev-sweep",
    label: "JEv sweep",
    async run(ctx) {
      const sweep = await runJevSweep(ctx.db, {
        limit: ctx.config.sweepLimit,
        concurrency: ctx.config.sweepConcurrency,
      });
      return {
        done: sweep.screened,
        note: `screened=${sweep.screened} flagged=${sweep.flagged} errors=${sweep.errors}`,
        screened: sweep.screened,
        flagged: sweep.flagged,
        errors: sweep.errors,
      };
    },
  },
  {
    key: "jev-ladder",
    label: "JEv ladder rescreen",
    async run(ctx) {
      const ladder = await runLadderRescreen(ctx.db, {
        limit: ctx.config.sweepLimit,
        concurrency: ctx.config.sweepConcurrency,
      });
      return {
        done: ladder.screened,
        note:
          `screened=${ladder.screened} hp=${ladder.hp} ` +
          `research=${ladder.research} rejected=${ladder.rejected} ` +
          `costUsd=${ladder.costUsd}`,
        screened: ladder.screened,
        hp: ladder.hp,
        research: ladder.research,
        rejected: ladder.rejected,
        costUsd: ladder.costUsd,
      };
    },
  },
  {
    key: "muse-verify",
    label: "Muse verification",
    async run(ctx) {
      const verification = await runMuseVerification(ctx.db, {
        limit: ctx.config.verifyLimit,
        concurrency: ctx.config.concurrency,
      });
      return {
        done: verification.verified,
        note:
          `verified=${verification.verified} confirmed=${verification.confirmed} ` +
          `overruled=${verification.overruled} errors=${verification.errors}`,
        verified: verification.verified,
        confirmed: verification.confirmed,
        overruled: verification.overruled,
        errors: verification.errors,
      };
    },
  },
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
      const refreshed = await populateUnifiedTargets(ctx.db);
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
      const promotion = await promoteEnsembleLeads(ctx.db);
      return {
        done: promotion.promoted,
        note: `promoted=${promotion.promoted} skipped=${promotion.skipped}`,
        promoted: promotion.promoted,
        skipped: promotion.skipped,
      };
    },
  },
];
