import { describe, expect, it, vi } from "vitest";

import type { Database } from "../packages/database/src/client.js";
import {
  resolveSchedulerConfig,
  runFunnelStages,
  type FunnelRunSummary,
} from "../apps/worker/src/ensemble-scheduler.js";
import type {
  FunnelStage,
  FunnelStageConfig,
} from "../apps/worker/src/funnel-stages.js";
import type { QueueLogger } from "../apps/worker/src/queue.js";

const config: FunnelStageConfig = {
  scheduleMinutes: 30,
  batchLimit: 10,
  concurrency: 2,
  ladderConcurrency: 2,
  verifyLimit: 10,
  analystMode: "free_only",
};

const db = {} as Database;

function captureLogger(): {
  logger: QueueLogger;
  events: Array<{
    level: string;
    event: string;
    fields: Record<string, unknown>;
  }>;
} {
  const events: Array<{
    level: string;
    event: string;
    fields: Record<string, unknown>;
  }> = [];
  return {
    logger(level, event, fields = {}) {
      events.push({ level, event, fields });
    },
    events,
  };
}

async function run(
  stages: readonly FunnelStage[],
  logger: QueueLogger,
  analystMode = config.analystMode,
): Promise<FunnelRunSummary> {
  return runFunnelStages({
    stages,
    loop: "slow",
    db,
    config: { ...config, analystMode },
    logger,
  });
}

describe("ensemble scheduler stage isolation", () => {
  it("skips every mutating stage in disabled analyst mode and logs that status", async () => {
    const stages = [
      {
        key: "jev-ladder",
        label: "Current-input JEv review",
        run: vi.fn(async () => ({ done: 1, note: "screened=1" })),
      },
      {
        key: "muse-verify",
        label: "Muse verification",
        run: vi.fn(async () => ({ done: 1, note: "verified=1" })),
      },
      {
        key: "unify-refresh",
        label: "Unified refresh",
        run: vi.fn(async () => ({ done: 1, note: "sources=1" })),
      },
      {
        key: "promote",
        label: "Lead promotion",
        run: vi.fn(async () => ({ done: 1, note: "promoted=1" })),
      },
    ] satisfies readonly FunnelStage[];
    const { logger, events } = captureLogger();

    await expect(run(stages, logger, "disabled")).resolves.toEqual({
      completed: 0,
      failed: 0,
    });

    for (const stage of stages) {
      expect(stage.run).not.toHaveBeenCalled();
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "info",
        event: "ensemble.scheduler_stages_skipped",
        fields: {
          analystMode: "disabled",
          loop: "slow",
          reason: "analyst_mode_disabled",
        },
      }),
    );
  });

  it("continues database reconciliation when Muse is unavailable", async () => {
    const reconcile = vi.fn(async () => ({ done: 3, note: "reconciled=3" }));
    const { logger, events } = captureLogger();
    const summary = await run(
      [
        {
          key: "muse-verify",
          label: "Muse verification",
          run: async () => {
            throw new Error("Muse provider unavailable");
          },
        },
        {
          key: "unify-refresh",
          label: "Unified refresh",
          run: reconcile,
        },
      ],
      logger,
    );

    expect(summary).toEqual({ completed: 1, failed: 1 });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "ensemble.scheduler_stage_failed",
        fields: expect.objectContaining({
          stage: "muse-verify",
          reason: "Muse provider unavailable",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "info",
        event: "ensemble.scheduler_stage_completed",
        fields: expect.objectContaining({ stage: "unify-refresh", done: 3 }),
      }),
    );
  });

  it("retries a failed stage on the next tick without suppressing independent work", async () => {
    let attempts = 0;
    const review: FunnelStage = {
      key: "jev-ladder",
      label: "JEv ladder",
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary JEv failure");
        return { done: 1, note: "screened=1" };
      },
    };
    const reconcile = vi.fn(async () => ({ done: 1, note: "reconciled=1" }));
    const projection: FunnelStage = {
      key: "unify-refresh",
      label: "Unified refresh",
      run: reconcile,
    };
    const { logger } = captureLogger();

    await expect(run([review, projection], logger)).resolves.toEqual({
      completed: 1,
      failed: 1,
    });
    await expect(run([review, projection], logger)).resolves.toEqual({
      completed: 2,
      failed: 0,
    });

    expect(attempts).toBe(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("does not floor fractional positive work limits or intervals to zero", () => {
    const { logger } = captureLogger();
    const resolved = resolveSchedulerConfig({
      logger,
      scheduleMinutes: 0.5,
      fastIntervalMs: 0.5,
      batchLimit: 0.5,
      concurrency: 0.5,
      ladderConcurrency: 0.5,
      verifyLimit: 0.5,
    });

    for (const value of [
      resolved.scheduleMinutes,
      resolved.fastIntervalMs,
      resolved.batchLimit,
      resolved.concurrency,
      resolved.ladderConcurrency,
      resolved.verifyLimit,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
    }
    expect(resolved.analystMode).toBe("disabled");
  });
});
