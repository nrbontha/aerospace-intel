import { randomUUID } from "node:crypto";

import {
  claimDueAgents,
  completeTick,
  failTick,
  heartbeat,
  markPreempted,
  parkBudgetExhausted,
  startTick,
  type ResearchAgent as AgentRow,
} from "@asi/database";
import { dailyBudgetCapUsd, getDailySpendUsd } from "@asi/research";

import type {
  SupervisorOptions,
  SupervisorRuntime,
  TickResult,
} from "./types.js";

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_LEASE_SECONDS = 90;
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;
export const DEFAULT_TICK_WALL_TIME_MS = 60_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_GRACEFUL_DRAIN_MS = 10_000;
export const DEFAULT_ABORT_DRAIN_MS = 10_000;

class ShutdownAbortError extends Error {
  constructor() {
    super("supervisor shutting down");
    this.name = "ShutdownAbortError";
  }
}

/** Per-agent daily cap: budget_share_pct of the global cap and/or absolute. */
export function agentDailyBudgetUsd(
  agent: Pick<AgentRow, "budgetSharePct" | "dailyBudgetUsd">,
  globalCapUsd: number,
): number | null {
  const limits: number[] = [];
  if (agent.budgetSharePct !== null) {
    limits.push((globalCapUsd * Number(agent.budgetSharePct)) / 100);
  }
  if (agent.dailyBudgetUsd !== null) {
    limits.push(Number(agent.dailyBudgetUsd));
  }
  return limits.length > 0 ? Math.min(...limits) : null;
}

/**
 * Race `promise` against the wall-time bound; breach aborts via
 * `controller` and rejects, so hung handlers cannot pin the loop forever.
 */
function withWallTime(
  promise: Promise<TickResult>,
  wallTimeMs: number,
  controller: AbortController,
): Promise<TickResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`tick exceeded wall time (${wallTimeMs}ms)`));
      reject(new Error(`tick exceeded wall time (${wallTimeMs}ms)`));
    }, wallTimeMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * AgentSupervisor (REDESIGN_PLAN §1.2): single long-lived loop inside the
 * worker process. Polls for due agents, claims them via SKIP LOCKED leases,
 * runs bounded ticks with heartbeats, journals outcomes, and enforces
 * budget gates. A crashed worker's stale lease is reclaimed by any live
 * instance; human intervention is never needed to unstick an agent.
 */
export function startSupervisor(options: SupervisorOptions): SupervisorRuntime {
  const handlers = options.handlers;
  const log = options.logger ?? (() => {});
  const instanceId =
    options.instanceId ??
    `supervisor-${process.pid}-${randomUUID().slice(0, 8)}`;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const maxConcurrentAgents =
    options.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS;
  const tickWallTimeMs = options.tickWallTimeMs ?? DEFAULT_TICK_WALL_TIME_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const gracefulDrainMs = options.gracefulDrainMs ?? DEFAULT_GRACEFUL_DRAIN_MS;
  const abortDrainMs = options.abortDrainMs ?? DEFAULT_ABORT_DRAIN_MS;
  const now = options.now ?? (() => new Date());
  const readGlobalSpend =
    options.getDailySpendUsd ?? (() => getDailySpendUsd());

  let stopping = false;
  let abortingForShutdown = false;
  const controllers = new Set<AbortController>();
  const inFlight = new Set<Promise<void>>();
  let wakePoll: (() => void) | undefined;

  const sleepUntilNextPoll = (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(finish, pollIntervalMs);
    wakePoll = finish;
    function finish(): void {
      clearTimeout(timer);
      wakePoll = undefined;
      resolve();
    }
    return promise;
  };

  const finalizeSuccess = async (
    agent: AgentRow,
    tickId: string,
    result: TickResult,
  ): Promise<void> => {
    const nextTickAt = await completeTick(agent.id, {
      tickId,
      outcome: result.outcome ?? "executed",
      plan: result.plan ?? {},
      actionsExecuted: result.actionsExecuted ?? 0,
      findings: result.findings ?? {},
      costUsd: result.costUsd ?? 0,
      ...(result.nextTickAt === undefined ? {} : { nextTickAt: result.nextTickAt }),
      now: now(),
    });
    log("info", "supervisor.tick_completed", {
      agentId: agent.id,
      agentKey: agent.key,
      outcome: result.outcome ?? "executed",
      actionsExecuted: result.actionsExecuted ?? 0,
      costUsd: result.costUsd ?? 0,
      nextTickAt: nextTickAt.toISOString(),
    });
  };

  /** Run one claimed agent's tick: journal → heartbeat → bounded handler. */
  const runTick = (agent: AgentRow): void => {
    const controller = new AbortController();
    controllers.add(controller);
    const settled = Promise.withResolvers<void>();
    inFlight.add(settled.promise);
    void (async () => {
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let tickId: string | undefined;
      try {
        const tick = await startTick(agent.id, { now: now() });
        tickId = tick.id;
        heartbeatTimer = setInterval(
          () => {
            void heartbeat(agent.id, { leaseSeconds, now: now() }).catch(
              (error) => {
                log("warn", "supervisor.heartbeat_failed", {
                  agentId: agent.id,
                  error,
                });
              },
            );
          },
          heartbeatIntervalMs,
        );
        const handler = handlers.get(agent.agentType);
        if (handler === undefined) {
          throw new Error(`no tick handler registered for ${agent.agentType}`);
        }
        const result = await withWallTime(
          handler({ agent, signal: controller.signal }),
          tickWallTimeMs,
          controller,
        );
        if (abortingForShutdown && controller.signal.aborted) {
          throw new ShutdownAbortError();
        }
        await finalizeSuccess(agent, tickId, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          if (tickId === undefined) {
            // Journal row never opened; nothing to finalize.
            log("error", "supervisor.tick_start_failed", {
              agentId: agent.id,
              error,
            });
          } else if (
            error instanceof ShutdownAbortError ||
            (abortingForShutdown && controller.signal.aborted)
          ) {
            // Graceful shutdown: reschedule promptly, no failure penalty.
            await markPreempted(agent.id, { tickId, error: message, now: now() });
          } else {
            await failTick(agent.id, {
              tickId,
              error: message,
              costUsd: 0,
              now: now(),
            });
          }
        } catch (bookkeepingError) {
          // Journal/booking failures must never crash the loop.
          log("error", "supervisor.tick_bookkeeping_failed", {
            agentId: agent.id,
            tickId,
            error: bookkeepingError,
          });
        }
      } finally {
        clearInterval(heartbeatTimer);
        controllers.delete(controller);
        inFlight.delete(settled.promise);
        settled.resolve();
        wakePoll?.();
      }
    })();
  };

  const parkOrRun = async (due: AgentRow[]): Promise<void> => {
    const globalCapUsd = dailyBudgetCapUsd();
    let globalSpendUsd: number;
    try {
      globalSpendUsd = await readGlobalSpend();
    } catch (error) {
      // If spend cannot be read, fail safe: treat as exhausted this cycle.
      log("warn", "supervisor.daily_spend_read_failed", { error });
      globalSpendUsd = Number.POSITIVE_INFINITY;
    }

    for (const agent of due) {
      const perAgentCap = agentDailyBudgetUsd(agent, globalCapUsd);
      const agentSpend = Number(agent.spendTodayUsd);
      if (
        globalSpendUsd >= globalCapUsd ||
        (perAgentCap !== null && agentSpend >= perAgentCap)
      ) {
        const reason =
          globalSpendUsd >= globalCapUsd
            ? `global daily cap reached ($${globalSpendUsd.toFixed(4)} / $${globalCapUsd})`
            : `agent daily budget reached ($${agentSpend.toFixed(4)} / $${perAgentCap?.toFixed(2)})`;
        try {
          await parkBudgetExhausted(agent.id, { reason, now: now() });
          log("warn", "supervisor.agent_budget_parked", {
            agentId: agent.id,
            agentKey: agent.key,
            reason,
          });
        } catch (error) {
          log("error", "supervisor.park_failed", { agentId: agent.id, error });
        }
        continue;
      }
      runTick(agent);
    }
  };

  const pollOnce = async (): Promise<void> => {
    const capacity = maxConcurrentAgents - inFlight.size;
    if (capacity <= 0) return;
    const due = await claimDueAgents({
      limit: capacity,
      instanceId,
      leaseSeconds,
      now: now(),
    });
    if (due.length === 0) return;
    log("info", "supervisor.claimed", {
      count: due.length,
      keys: due.map((agent) => agent.key),
    });
    await parkOrRun(due);
  };

  void (async () => {
    while (!stopping) {
      try {
        await pollOnce();
      } catch (error) {
        log("error", "supervisor.poll_failed", { error });
      }
      await sleepUntilNextPoll();
    }
  })();

  const drainInFlight = (ms: number): Promise<void> =>
    Promise.race([
      Promise.allSettled([...inFlight]).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ]);

  return {
    instanceId,
    async stop(): Promise<void> {
      stopping = true;
      wakePoll?.();
      // Phase 1: give in-flight ticks a chance to finish naturally.
      await drainInFlight(gracefulDrainMs);
      // Phase 2: propagate abort, wait a bounded grace for handlers to honor it.
      abortingForShutdown = true;
      for (const controller of controllers) {
        controller.abort(new Error("supervisor shutting down"));
      }
      await drainInFlight(abortDrainMs);
      log("info", "supervisor.stopped", { instanceId });
    },
  };
}
