import { z } from "zod";

import { populateUnifiedTargets, promoteEnsembleLeads } from "@asi/database";
import { getDatabase } from "@asi/database/client";
import {
  dailyBudgetCapUsd,
  getDailySpendUsd,
  OpenRouterClient,
  runEnsembleBatch,
} from "@asi/research";

import type { QueueLogger } from "./queue.js";

/**
 * Autonomous ensemble screening loop for Railway.
 *
 * Every tick: probe the ensemble model (skip while unhealthy) -> enforce the
 * daily spend cap -> run the ensemble batch -> refresh unified targets ->
 * promote high-priority results to leads. Every step is individually guarded;
 * this module never throws so the worker process always survives.
 *
 * Dependency note: `runEnsembleBatch` (Agent RunnerLib,
 * packages/research/src/faa-ensemble/runner.ts) and
 * `populateUnifiedTargets` / `promoteEnsembleLeads` (Agent PopulateLib,
 * packages/database/src/unified-targets/) are imported from the package
 * roots; those agents own re-exporting them there.
 */

export const ENSEMBLE_SCHEDULE_ENV = "ENSEMBLE_SCHEDULE_MINUTES";
export const ENSEMBLE_BATCH_LIMIT_ENV = "ENSEMBLE_BATCH_LIMIT";
export const ENSEMBLE_CONCURRENCY_ENV = "ENSEMBLE_CONCURRENCY";
export const ENSEMBLE_DELAY_MS_ENV = "ENSEMBLE_DELAY_MS";

const DEFAULT_SCHEDULE_MINUTES = 30;
const DEFAULT_BATCH_LIMIT = 0;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DELAY_MS = 1_000;

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

      // 3. Ensemble screening batch.
      try {
        const result = await runEnsembleBatch({
          limit: config.batchLimit,
          concurrency: config.concurrency,
          delayMs: config.delayMs,
        });
        logger("info", "ensemble.scheduler_batch_completed", {
          signals: result.signals,
          metrics: result.metrics,
        });
      } catch (error) {
        logger("error", "ensemble.scheduler_batch_failed", {
          reason: toLogReason(error),
        });
      }

      // 4. Nightly-style unified refresh (runs every tick; populate is
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

      // 5. High-priority to lead promotion.
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
