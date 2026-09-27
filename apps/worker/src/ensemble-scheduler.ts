import { z } from "zod";

import { populateUnifiedTargets, promoteEnsembleLeads } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import {
  canSpendExa,
  dailyBudgetCapUsd,
  EXA_CONTENTS_COST_USD,
  EXA_SEARCH_COST_USD,
  getDailySpendUsd,
  getExaDailySpendUsd,
  OpenRouterClient,
  OWNERSHIP_CHECK_TICK_CAP,
  runJevSweep,
  runMuseVerification,
  runOwnershipChecks,
  runWebsiteEnrichment,
} from "@asi/research";

import type { QueueLogger } from "./queue.js";

/**
 * Autonomous ensemble screening loop for Railway.
 *
 * Every tick: probe the ensemble model (skip while unhealthy) -> enforce the
 * daily spend cap -> JEv sweep of the full queue (no Muse calls) ->
 * independent Muse verification of flagged items + audit sample -> Exa
 * ownership checks (HP names lacking ownership evidence, cap 10/tick) ->
 * Exa website enrichment (unvetted HP/P1 names without website evidence,
 * cap 10/tick) -> refresh unified targets -> promote high-priority results
 * to leads. Every step is individually guarded; this module never throws so
 * the worker process always survives.
 *
 * Dependency note: `runJevSweep` / `runMuseVerification` (Agent RunnerLib,
 * packages/research/src/faa-ensemble/runner.ts) and
 * `populateUnifiedTargets` / `promoteEnsembleLeads` (Agent PopulateLib,
 * packages/database/src/unified-targets/) are imported from the package
 * roots; those agents own re-exporting them there.
 */

export const ENSEMBLE_SCHEDULE_ENV = "ENSEMBLE_SCHEDULE_MINUTES";
export const ENSEMBLE_BATCH_LIMIT_ENV = "ENSEMBLE_BATCH_LIMIT";
export const ENSEMBLE_CONCURRENCY_ENV = "ENSEMBLE_CONCURRENCY";
export const ENSEMBLE_DELAY_MS_ENV = "ENSEMBLE_DELAY_MS";
export const JEV_SWEEP_LIMIT_ENV = "JEV_SWEEP_LIMIT";
export const JEV_SWEEP_CONCURRENCY_ENV = "JEV_SWEEP_CONCURRENCY";
export const VERIFY_BATCH_LIMIT_ENV = "VERIFY_BATCH_LIMIT";

const DEFAULT_SCHEDULE_MINUTES = 30;
const DEFAULT_BATCH_LIMIT = 0;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DELAY_MS = 1_000;
const DEFAULT_JEV_SWEEP_LIMIT = 0;
const DEFAULT_JEV_SWEEP_CONCURRENCY = 8;
const DEFAULT_VERIFY_BATCH_LIMIT = 120;
/** Max website enrichments per tick (unvetted HP/P1 without website evidence). */
const WEBSITE_ENRICHMENT_TICK_CAP = 10;

/** While unhealthy, skip runs for this long (prevents hollow-row eras). */
const UNHEALTHY_CACHE_MS = 15 * 60 * 1_000;
const PROBE_TIMEOUT_MS = 30_000;
/**
 * Probe budget. Reasoning models burn hundreds of thinking tokens before
 * emitting JSON; 32 tokens false-negatives them as unhealthy. 1200 covers
 * the thought plus the object for ~$0.0003/probe.
 */
const PROBE_MAX_OUTPUT_TOKENS = 1200;

const probeSchema = z.object({ ok: z.boolean() });

export interface EnsembleSchedulerOptions {
  logger: QueueLogger;
  apiKey: string;
  model: string;
  scheduleMinutes?: number;
  batchLimit?: number;
  concurrency?: number;
  delayMs?: number;
  sweepLimit?: number;
  sweepConcurrency?: number;
  verifyLimit?: number;
}

export interface EnsembleSchedulerHandle {
  stop(): void;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function resolveSchedulerConfig(options: EnsembleSchedulerOptions): {
  scheduleMinutes: number;
  batchLimit: number;
  concurrency: number;
  delayMs: number;
  sweepLimit: number;
  sweepConcurrency: number;
  verifyLimit: number;
} {
  return {
    scheduleMinutes:
      options.scheduleMinutes ??
      readPositiveInt(
        process.env[ENSEMBLE_SCHEDULE_ENV],
        DEFAULT_SCHEDULE_MINUTES,
      ),
    batchLimit:
      options.batchLimit ??
      readNonNegativeInt(
        process.env[ENSEMBLE_BATCH_LIMIT_ENV],
        DEFAULT_BATCH_LIMIT,
      ),
    concurrency:
      options.concurrency ??
      readPositiveInt(
        process.env[ENSEMBLE_CONCURRENCY_ENV],
        DEFAULT_CONCURRENCY,
      ),
    delayMs:
      options.delayMs ??
      readNonNegativeInt(process.env[ENSEMBLE_DELAY_MS_ENV], DEFAULT_DELAY_MS),
    sweepLimit:
      options.sweepLimit ??
      readNonNegativeInt(
        process.env[JEV_SWEEP_LIMIT_ENV],
        DEFAULT_JEV_SWEEP_LIMIT,
      ),
    sweepConcurrency:
      options.sweepConcurrency ??
      readPositiveInt(
        process.env[JEV_SWEEP_CONCURRENCY_ENV],
        DEFAULT_JEV_SWEEP_CONCURRENCY,
      ),
    verifyLimit:
      options.verifyLimit ??
      readNonNegativeInt(
        process.env[VERIFY_BATCH_LIMIT_ENV],
        DEFAULT_VERIFY_BATCH_LIMIT,
      ),
  };
}

function toLogReason(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

export function startEnsembleScheduler(
  options: EnsembleSchedulerOptions,
): EnsembleSchedulerHandle {
  const { logger, apiKey, model } = options;
  const config = resolveSchedulerConfig(options);
  const client = new OpenRouterClient(apiKey);
  let stopped = false;
  let inFlight = false;
  let unhealthyUntil = 0;

  async function tick(): Promise<void> {
    if (stopped || inFlight) {
      if (inFlight)
        logger("warn", "ensemble.scheduler_tick_overlap_skipped", {});
      return;
    }
    inFlight = true;
    try {
      // 1. Model health probe: skip the run while unhealthy.
      try {
        if (Date.now() < unhealthyUntil) {
          logger("warn", "ensemble.scheduler_unhealthy_cached_skip", { model });
          return;
        }
        await client.generateStructured({
          route: "fast",
          models: { fast: model, deep: model, fallback: model },
          schemaName: "ensemble-scheduler-health-probe",
          schema: probeSchema,
          systemPrompt:
            "Health probe. Reply with exactly one JSON object, nothing else.",
          prompt: '{"ok":true}',
          maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
          maxAttempts: 1,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        unhealthyUntil = 0;
      } catch (error) {
        unhealthyUntil = Date.now() + UNHEALTHY_CACHE_MS;
        logger("warn", "ensemble.scheduler_model_unhealthy", {
          model,
          reason: toLogReason(error),
        });
        return;
      }

      // 2. Daily spend guard (fail closed: never spend blind).
      try {
        const spendUsd = await getDailySpendUsd();
        const capUsd = dailyBudgetCapUsd();
        if (spendUsd >= capUsd) {
          logger("warn", "ensemble.scheduler_daily_cap_exceeded", {
            spendUsd,
            capUsd,
          });
          return;
        }
      } catch (error) {
        logger("error", "ensemble.scheduler_spend_check_failed", {
          reason: toLogReason(error),
        });
        return;
      }

      // 3. Stage 1: JEv sweep of the queue at full speed (zero Muse calls).
      try {
        const sweep = await runJevSweep(getDatabase(), {
          limit: config.sweepLimit,
          concurrency: config.sweepConcurrency,
        });
        logger("info", "ensemble.scheduler_jev_sweep_completed", {
          screened: sweep.screened,
          flagged: sweep.flagged,
          errors: sweep.errors,
        });
      } catch (error) {
        logger("error", "ensemble.scheduler_jev_sweep_failed", {
          reason: toLogReason(error),
        });
      }

      // 4. Stage 2: independent Muse verification of flagged items + audit sample.
      try {
        const verification = await runMuseVerification(getDatabase(), {
          limit: config.verifyLimit,
          concurrency: config.concurrency,
        });
        logger("info", "ensemble.scheduler_verification_completed", {
          verified: verification.verified,
          confirmed: verification.confirmed,
          overruled: verification.overruled,
          errors: verification.errors,
        });
      } catch (error) {
        logger("error", "ensemble.scheduler_verification_failed", {
          reason: toLogReason(error),
        });
      }

      // 5. Ownership news checks for HP-unified names lacking ownership
      // evidence (cap 10/tick), gated by EXA_DAILY_BUDGET_USD.
      try {
        if (!canSpendExa(EXA_SEARCH_COST_USD)) {
          logger("warn", "ensemble.scheduler_ownership_budget_skipped", {
            spendUsd: getExaDailySpendUsd(),
          });
        } else {
          const ownership = await runOwnershipChecks(getDatabase(), {
            limit: OWNERSHIP_CHECK_TICK_CAP,
          });
          logger("info", "ensemble.scheduler_ownership_completed", {
            checked: ownership.checked,
            affirmed: ownership.affirmed,
            skipped: ownership.skipped,
            costUsd: ownership.costUsd,
          });
        }
      } catch (error) {
        logger("error", "ensemble.scheduler_ownership_failed", {
          reason: toLogReason(error),
        });
      }

      // 6. Website enrichment for unvetted HP/P1 names without website
      // evidence (cap 10/tick), gated by EXA_DAILY_BUDGET_USD.
      try {
        if (!canSpendExa(EXA_CONTENTS_COST_USD)) {
          logger("warn", "ensemble.scheduler_enrichment_budget_skipped", {
            spendUsd: getExaDailySpendUsd(),
          });
        } else {
          const enrichment = await runWebsiteEnrichment(getDatabase(), {
            limit: WEBSITE_ENRICHMENT_TICK_CAP,
          });
          logger("info", "ensemble.scheduler_enrichment_completed", {
            checked: enrichment.checked,
            enriched: enrichment.enriched,
            skipped: enrichment.skipped,
            costUsd: enrichment.costUsd,
          });
        }
      } catch (error) {
        logger("error", "ensemble.scheduler_enrichment_failed", {
          reason: toLogReason(error),
        });
      }

      // 7. Nightly-style unified refresh (runs every tick; populate is
      // idempotent per-source upsert, so this is safe).
      try {
        const refreshed = await populateUnifiedTargets(getDatabase());
        logger("info", "ensemble.scheduler_unified_refresh_completed", {
          sources: refreshed,
        });
      } catch (error) {
        logger("error", "ensemble.scheduler_unified_refresh_failed", {
          reason: toLogReason(error),
        });
      }

      // 8. High-priority to lead promotion.
      try {
        const promotion = await promoteEnsembleLeads(getDatabase());
        logger("info", "ensemble.scheduler_promotion_completed", {
          promoted: promotion.promoted,
          skipped: promotion.skipped,
        });
      } catch (error) {
        logger("error", "ensemble.scheduler_promotion_failed", {
          reason: toLogReason(error),
        });
      }
    } catch (error) {
      logger("error", "ensemble.scheduler_tick_failed", {
        reason: toLogReason(error),
      });
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(
    () => {
      void tick();
    },
    config.scheduleMinutes * 60 * 1_000,
  );
  timer.unref();
  void tick();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
