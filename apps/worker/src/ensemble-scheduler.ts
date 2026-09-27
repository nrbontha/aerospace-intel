import { z } from "zod";

import { getDatabase } from "@asi/database/client";
import {
  dailyBudgetCapUsd,
  getDailySpendUsd,
  OpenRouterClient,
} from "@asi/research";

import { FAST_STAGES, SLOW_STAGES } from "./funnel-stages.js";

import type { FunnelStage } from "./funnel-stages.js";

import type { QueueLogger } from "./queue.js";

/**
 * Autonomous ensemble screening loops for Railway.
 *
 * Two independent loops share nothing but DB state (handoff is artifact
 * absence, never a shared tick lock), so either loop stalls or deploys
 * without blocking the other:
 *
 * - Fast loop (FAST_STAGES, every JEV_FAST_INTERVAL_MS, default 60s): JEv
 *   sweep of the full queue (no Muse calls) -> JEv ladder rescreen, both at
 *   32-wide concurrency.
 * - Slow loop (SLOW_STAGES, every ENSEMBLE_SCHEDULE_MINUTES, default 30min):
 *   independent Muse verification of flagged items + audit sample -> Exa
 *   ownership checks (HP names lacking ownership evidence, cap 10/tick) ->
 *   Exa website enrichment (unvetted HP/P1 names without website evidence,
 *   cap 10/tick) -> refresh unified targets -> promote high-priority results
 *   to leads.
 *
 * Every tick of either loop: probe the ensemble model (skip while unhealthy)
 * -> enforce the daily spend cap -> run that loop's stages in registry order.
 * Every step is individually guarded; this module never throws so the worker
 * process always survives.
 *
 * Dependency note: `runJevSweep` / `runMuseVerification` (Agent RunnerLib,
 * packages/research/src/faa-ensemble/runner.ts) and
 * `populateUnifiedTargets` / `promoteEnsembleLeads` (Agent PopulateLib,
 * packages/database/src/unified-targets/) are consumed through the
 * FAST_STAGES / SLOW_STAGES registries in ./funnel-stages.js; those agents
 * own re-exporting them from the package roots.
 */

export const ENSEMBLE_SCHEDULE_ENV = "ENSEMBLE_SCHEDULE_MINUTES";
export const ENSEMBLE_BATCH_LIMIT_ENV = "ENSEMBLE_BATCH_LIMIT";
export const ENSEMBLE_CONCURRENCY_ENV = "ENSEMBLE_CONCURRENCY";
export const ENSEMBLE_DELAY_MS_ENV = "ENSEMBLE_DELAY_MS";
export const JEV_SWEEP_LIMIT_ENV = "JEV_SWEEP_LIMIT";
export const JEV_SWEEP_CONCURRENCY_ENV = "JEV_SWEEP_CONCURRENCY";
export const JEV_LADDER_CONCURRENCY_ENV = "JEV_LADDER_CONCURRENCY";
export const JEV_FAST_INTERVAL_MS_ENV = "JEV_FAST_INTERVAL_MS";
export const VERIFY_BATCH_LIMIT_ENV = "VERIFY_BATCH_LIMIT";

const DEFAULT_SCHEDULE_MINUTES = 30;
const DEFAULT_BATCH_LIMIT = 0;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DELAY_MS = 1_000;
const DEFAULT_JEV_SWEEP_LIMIT = 0;
const DEFAULT_JEV_SWEEP_CONCURRENCY = 32;
const DEFAULT_JEV_LADDER_CONCURRENCY = 32;
const DEFAULT_JEV_FAST_INTERVAL_MS = 60_000;
const DEFAULT_VERIFY_BATCH_LIMIT = 120;

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
  fastIntervalMs?: number;
  batchLimit?: number;
  concurrency?: number;
  delayMs?: number;
  sweepLimit?: number;
  sweepConcurrency?: number;
  ladderConcurrency?: number;
  verifyLimit?: number;
}

export interface EnsembleSchedulerHandle {
  stop(): void;
}

/** Independent per-loop tick state (fast and slow loops never share one). */
export interface EnsembleLoopState {
  inFlight: boolean;
  unhealthyUntil: number;
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
  fastIntervalMs: number;
  batchLimit: number;
  concurrency: number;
  delayMs: number;
  sweepLimit: number;
  sweepConcurrency: number;
  ladderConcurrency: number;
  verifyLimit: number;
} {
  return {
    scheduleMinutes:
      options.scheduleMinutes ??
      readPositiveInt(
        process.env[ENSEMBLE_SCHEDULE_ENV],
        DEFAULT_SCHEDULE_MINUTES,
      ),
    fastIntervalMs:
      options.fastIntervalMs ??
      readPositiveInt(
        process.env[JEV_FAST_INTERVAL_MS_ENV],
        DEFAULT_JEV_FAST_INTERVAL_MS,
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
    ladderConcurrency:
      options.ladderConcurrency ??
      readPositiveInt(
        process.env[JEV_LADDER_CONCURRENCY_ENV],
        DEFAULT_JEV_LADDER_CONCURRENCY,
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

/**
 * Legacy per-step event names, kept alongside the unified
 * `ensemble.scheduler_stage_completed` / `ensemble.scheduler_stage_failed`
 * events so existing dashboards keep working.
 */
const LEGACY_STAGE_COMPLETED_EVENTS: Record<string, string> = {
  "jev-sweep": "ensemble.scheduler_jev_sweep_completed",
  "jev-ladder": "ensemble.scheduler_ladder_completed",
  "muse-verify": "ensemble.scheduler_verification_completed",
  ownership: "ensemble.scheduler_ownership_completed",
  "website-enrich": "ensemble.scheduler_enrichment_completed",
  "unify-refresh": "ensemble.scheduler_unified_refresh_completed",
  promote: "ensemble.scheduler_promotion_completed",
};

const LEGACY_STAGE_FAILED_EVENTS: Record<string, string> = {
  "jev-sweep": "ensemble.scheduler_jev_sweep_failed",
  "jev-ladder": "ensemble.scheduler_ladder_failed",
  "muse-verify": "ensemble.scheduler_verification_failed",
  ownership: "ensemble.scheduler_ownership_failed",
  "website-enrich": "ensemble.scheduler_enrichment_failed",
  "unify-refresh": "ensemble.scheduler_unified_refresh_failed",
  promote: "ensemble.scheduler_promotion_failed",
};

const LEGACY_STAGE_BUDGET_SKIPPED_EVENTS: Record<string, string> = {
  ownership: "ensemble.scheduler_ownership_budget_skipped",
  "website-enrich": "ensemble.scheduler_enrichment_budget_skipped",
};

export function startEnsembleScheduler(
  options: EnsembleSchedulerOptions,
): EnsembleSchedulerHandle {
  const { logger, apiKey, model } = options;
  const config = resolveSchedulerConfig(options);
  const client = new OpenRouterClient(apiKey);
  let stopped = false;
  // Independent per-loop state: the fast JEv loop and the slow verify loop
  // share nothing but DB state, so either loop stalls (overlap, unhealthy
  // model, spend cap) or deploys without blocking the other.
  const fastLoop: EnsembleLoopState = { inFlight: false, unhealthyUntil: 0 };
  const slowLoop: EnsembleLoopState = { inFlight: false, unhealthyUntil: 0 };

  async function tick(
    stages: readonly FunnelStage[],
    loop: "fast" | "slow",
    state: EnsembleLoopState,
  ): Promise<void> {
    if (stopped || state.inFlight) {
      if (state.inFlight)
        logger("warn", "ensemble.scheduler_tick_overlap_skipped", {});
      return;
    }
    state.inFlight = true;
    try {
      // 1. Model health probe: skip the run while unhealthy.
      try {
        if (Date.now() < state.unhealthyUntil) {
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
        state.unhealthyUntil = 0;
      } catch (error) {
        state.unhealthyUntil = Date.now() + UNHEALTHY_CACHE_MS;
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

      // 3. This loop's funnel stages in registry order (see
      // ./funnel-stages.js). Each stage is individually guarded: one throwing
      // never blocks the rest, and this tick never throws so the worker
      // process always survives.
      for (const stage of stages) {
        try {
          const summary = await stage.run({ db: getDatabase(), config });
          const { done, note, budgetSkipped, ...fields } = summary;
          logger("info", "ensemble.scheduler_stage_completed", {
            stage: stage.key,
            done,
            note,
            loop,
            ...fields,
          });
          if (budgetSkipped) {
            const skippedEvent = LEGACY_STAGE_BUDGET_SKIPPED_EVENTS[stage.key];
            if (skippedEvent !== undefined) {
              logger("warn", skippedEvent, { spendUsd: summary.spendUsd });
            }
            continue;
          }
          const completedEvent = LEGACY_STAGE_COMPLETED_EVENTS[stage.key];
          if (completedEvent !== undefined) {
            logger("info", completedEvent, { ...fields });
          }
        } catch (error) {
          logger("error", "ensemble.scheduler_stage_failed", {
            stage: stage.key,
            reason: toLogReason(error),
          });
          const failedEvent = LEGACY_STAGE_FAILED_EVENTS[stage.key];
          if (failedEvent !== undefined) {
            logger("error", failedEvent, {
              reason: toLogReason(error),
            });
          }
        }
      }
    } catch (error) {
      logger("error", "ensemble.scheduler_tick_failed", {
        reason: toLogReason(error),
      });
    } finally {
      state.inFlight = false;
    }
  }

  const fastTimer = setInterval(() => {
    void tick(FAST_STAGES, "fast", fastLoop);
  }, config.fastIntervalMs);
  const slowTimer = setInterval(
    () => {
      void tick(SLOW_STAGES, "slow", slowLoop);
    },
    config.scheduleMinutes * 60 * 1_000,
  );
  fastTimer.unref();
  slowTimer.unref();
  void tick(FAST_STAGES, "fast", fastLoop);
  void tick(SLOW_STAGES, "slow", slowLoop);

  return {
    stop(): void {
      stopped = true;
      clearInterval(fastTimer);
      clearInterval(slowTimer);
    },
  };
}
