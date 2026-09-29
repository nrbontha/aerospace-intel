import { getDatabase, type Database } from "@asi/database/client";

import { FAST_STAGES, MUSE_STAGES, SLOW_STAGES } from "./funnel-stages.js";

import type { FunnelStage, FunnelStageConfig } from "./funnel-stages.js";
import type { QueueLogger } from "./queue.js";

/**
 * Autonomous, independently retryable review loops.
 *
 * Cheap Jev screening, persistent Muse research, and database-only
 * reconciliation run on separate locks. There is intentionally no
 * scheduler-wide provider probe: each stage owns its durable defer policy, so
 * source or quota waits cannot stop cheap screening.
 */

export const ENSEMBLE_SCHEDULE_ENV = "ENSEMBLE_SCHEDULE_MINUTES";
export const ENSEMBLE_BATCH_LIMIT_ENV = "ENSEMBLE_BATCH_LIMIT";
export const ENSEMBLE_CONCURRENCY_ENV = "ENSEMBLE_CONCURRENCY";
export const JEV_LADDER_CONCURRENCY_ENV = "JEV_LADDER_CONCURRENCY";
export const JEV_FAST_INTERVAL_MS_ENV = "JEV_FAST_INTERVAL_MS";
export const VERIFY_BATCH_LIMIT_ENV = "VERIFY_BATCH_LIMIT";

const DEFAULT_SCHEDULE_MINUTES = 30;
const DEFAULT_BATCH_LIMIT = 120;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_JEV_LADDER_CONCURRENCY = 32;
const DEFAULT_JEV_FAST_INTERVAL_MS = 60_000;
const DEFAULT_VERIFY_BATCH_LIMIT = 120;

export interface EnsembleSchedulerOptions {
  logger: QueueLogger;
  scheduleMinutes?: number;
  fastIntervalMs?: number;
  batchLimit?: number;
  concurrency?: number;
  ladderConcurrency?: number;
  verifyLimit?: number;
  analystMode?: "disabled" | "free_only" | "bounded_paid";
  exaBudgetScopeId?: string;
  jevSourceSignalIds?: readonly string[];
}

export interface EnsembleSchedulerHandle {
  stop(): void;
}

export interface EnsembleLoopState {
  inFlight: boolean;
}

export type EnsembleLoop = "fast" | "muse" | "slow";

export interface FunnelRunSummary {
  completed: number;
  failed: number;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}


export function resolveSchedulerConfig(
  options: EnsembleSchedulerOptions,
): FunnelStageConfig & { fastIntervalMs: number } {
  return {
    scheduleMinutes: readPositiveInt(
      options.scheduleMinutes?.toString() ?? process.env[ENSEMBLE_SCHEDULE_ENV],
      DEFAULT_SCHEDULE_MINUTES,
    ),
    fastIntervalMs: readPositiveInt(
      options.fastIntervalMs?.toString() ??
        process.env[JEV_FAST_INTERVAL_MS_ENV],
      DEFAULT_JEV_FAST_INTERVAL_MS,
    ),
    batchLimit: readPositiveInt(
      options.batchLimit?.toString() ?? process.env[ENSEMBLE_BATCH_LIMIT_ENV],
      DEFAULT_BATCH_LIMIT,
    ),
    concurrency: readPositiveInt(
      options.concurrency?.toString() ?? process.env[ENSEMBLE_CONCURRENCY_ENV],
      DEFAULT_CONCURRENCY,
    ),
    ladderConcurrency: readPositiveInt(
      options.ladderConcurrency?.toString() ??
        process.env[JEV_LADDER_CONCURRENCY_ENV],
      DEFAULT_JEV_LADDER_CONCURRENCY,
    ),
    verifyLimit: readPositiveInt(
      options.verifyLimit?.toString() ?? process.env[VERIFY_BATCH_LIMIT_ENV],
      DEFAULT_VERIFY_BATCH_LIMIT,
    ),
    analystMode: options.analystMode ?? "disabled",
    ...(options.exaBudgetScopeId === undefined
      ? {}
      : { exaBudgetScopeId: options.exaBudgetScopeId }),
    ...(options.jevSourceSignalIds === undefined
      ? {}
      : { jevSourceSignalIds: options.jevSourceSignalIds }),
  };
}

function toLogReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

/**
 * Run one registry in order while isolating every stage failure. Database
 * phase claims decide eligibility, so continuing after an upstream outage is
 * safe: downstream review stages find no claimable incomplete input, while
 * independent projection stages still reconcile stale output.
 */
export async function runFunnelStages(input: {
  stages: readonly FunnelStage[];
  loop: EnsembleLoop;
  db: Database;
  config: FunnelStageConfig;
  logger: QueueLogger;
}): Promise<FunnelRunSummary> {
  let completed = 0;
  let failed = 0;
  for (const stage of input.stages) {
    try {
      const summary = await stage.run({
        db: input.db,
        config: input.config,
      });
      const { done, note, ...fields } = summary;
      input.logger("info", "ensemble.scheduler_stage_completed", {
        stage: stage.key,
        done,
        note,
        loop: input.loop,
        ...fields,
      });
      completed += 1;
    } catch (error) {
      failed += 1;
      const reason = toLogReason(error);
      input.logger("error", "ensemble.scheduler_stage_failed", {
        stage: stage.key,
        loop: input.loop,
        reason,
      });
    }
  }
  return { completed, failed };
}

export function startEnsembleScheduler(
  options: EnsembleSchedulerOptions,
): EnsembleSchedulerHandle {
  const config = resolveSchedulerConfig(options);
  let stopped = false;
  const fastLoop: EnsembleLoopState = { inFlight: false };
  const museLoop: EnsembleLoopState = { inFlight: false };
  const slowLoop: EnsembleLoopState = { inFlight: false };

  async function tick(
    stages: readonly FunnelStage[],
    loop: EnsembleLoop,
    state: EnsembleLoopState,
  ): Promise<void> {
    if (stopped) return;
    if (state.inFlight) {
      options.logger("warn", "ensemble.scheduler_tick_overlap_skipped", {
        loop,
      });
      return;
    }
    state.inFlight = true;
    try {
      const summary = await runFunnelStages({
        stages,
        loop,
        db: getDatabase(),
        config,
        logger: options.logger,
      });
      options.logger("info", "ensemble.scheduler_tick_completed", {
        loop,
        ...summary,
      });
    } catch (error) {
      options.logger("error", "ensemble.scheduler_tick_failed", {
        loop,
        reason: toLogReason(error),
      });
    } finally {
      state.inFlight = false;
    }
  }

  const fastTimer = setInterval(() => {
    void tick(FAST_STAGES, "fast", fastLoop);
  }, config.fastIntervalMs);
  const museTimer = setInterval(
    () => {
      void tick(MUSE_STAGES, "muse", museLoop);
    },
    config.scheduleMinutes * 60 * 1_000,
  );
  const slowTimer = setInterval(
    () => {
      void tick(SLOW_STAGES, "slow", slowLoop);
    },
    config.scheduleMinutes * 60 * 1_000,
  );
  fastTimer.unref();
  museTimer.unref();
  slowTimer.unref();
  void tick(FAST_STAGES, "fast", fastLoop);
  void tick(MUSE_STAGES, "muse", museLoop);
  void tick(SLOW_STAGES, "slow", slowLoop);

  return {
    stop(): void {
      stopped = true;
      clearInterval(fastTimer);
      clearInterval(museTimer);
      clearInterval(slowTimer);
    },
  };
}
