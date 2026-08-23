import { eq, sql } from "drizzle-orm";

import { getDatabase } from "../client.js";
import {
  agentTicks,
  researchAgents,
  type AgentTick,
  type TickOutcome,
} from "../schema.js";

/** Exponential failure backoff: 15m * 2^failures, capped at 24h. */
export const FAILURE_BACKOFF_BASE_SECONDS = 15 * 60;
export const FAILURE_BACKOFF_MAX_SECONDS = 24 * 60 * 60;
/** Budget-parked agents wake just after the daily cap window resets. */
export const BUDGET_PARK_BUFFER_MS = 2 * 60_000;

/** First instant after `now`'s UTC day ends (plus a small buffer). */
export function budgetParkUntil(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      Math.round(BUDGET_PARK_BUFFER_MS / 1000),
    ),
  );
}

/**
 * Open a tick journal row. Outcome starts as 'planned'; completion helpers
 * finalize it, so a worker crash mid-tick leaves visible evidence.
 */
export async function startTick(
  agentId: string,
  options: { now?: Date } = {},
): Promise<AgentTick> {
  const now = options.now ?? new Date();
  const [row] = await getDatabase()
    .insert(agentTicks)
    .values({ agentId, startedAt: now, outcome: "planned" })
    .returning();
  return row!;
}

export interface CompleteTickInput {
  tickId: string;
  /** Success-family outcome recorded by the handler ('executed' default). */
  outcome?: Extract<TickOutcome, "executed" | "done" | "stuck">;
  actionsExecuted?: number;
  findings?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  costUsd?: number;
  now?: Date;
}

/**
 * Finalize a successful tick: journal row closed, cadence scheduled,
 * failure streak reset, lease released, today's spend accumulated.
 * Returns the scheduled next_tick_at.
 */
export async function completeTick(
  agentId: string,
  input: CompleteTickInput,
): Promise<Date> {
  const now = input.now ?? new Date();
  const outcome = input.outcome ?? "executed";
  const costUsd = input.costUsd ?? 0;

  await getDatabase().transaction(async (tx) => {
    const [agent] = await tx
      .select({ cadenceSeconds: researchAgents.cadenceSeconds })
      .from(researchAgents)
      .where(eq(researchAgents.id, agentId))
      .for("update");
    const cadenceSeconds = agent?.cadenceSeconds ?? 900;

    await tx
      .update(agentTicks)
      .set({
        finishedAt: now,
        outcome,
        actionsExecuted: input.actionsExecuted ?? 0,
        findings: input.findings ?? {},
        plan: input.plan ?? {},
        costUsd: costUsd.toFixed(6),
      })
      .where(eq(agentTicks.id, input.tickId));

    const nextTickAt = new Date(now.getTime() + cadenceSeconds * 1000);
    await tx
      .update(researchAgents)
      .set({
        lastTickAt: now,
        nextTickAt,
        consecutiveFailures: 0,
        spendTodayUsd: sql`${researchAgents.spendTodayUsd} + ${costUsd}`,
        leasedBy: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: now,
      })
      .where(eq(researchAgents.id, agentId));
    return nextTickAt;
  });

  // Recompute for the return value (transaction body cannot return through
  // the drizzle callback type cleanly here).
  const [row] = await getDatabase()
    .select({ nextTickAt: researchAgents.nextTickAt })
    .from(researchAgents)
    .where(eq(researchAgents.id, agentId));
  return row!.nextTickAt!;
}

/**
 * Finalize a failed tick: journal row closed with outcome 'error', failure
 * streak incremented, and next_tick_at pushed out by
 * 15m * 2^(previous failures), capped at 24h. Lease released.
 * Returns the scheduled next_tick_at.
 */
export async function failTick(
  agentId: string,
  input: {
    tickId: string;
    error: string;
    costUsd?: number;
    now?: Date;
  },
): Promise<Date> {
  const now = input.now ?? new Date();
  const costUsd = input.costUsd ?? 0;

  await getDatabase().transaction(async (tx) => {
    await tx
      .update(agentTicks)
      .set({
        finishedAt: now,
        outcome: "error",
        error: input.error.slice(0, 4000),
        costUsd: costUsd.toFixed(6),
      })
      .where(eq(agentTicks.id, input.tickId));

    // SET reads pre-UPDATE column values, so the exponent is the previous
    // failure count: first failure backs off 15m, second 30m, ...
    await tx.execute(sql`
      UPDATE ${researchAgents}
      SET last_tick_at = ${now},
          next_tick_at = ${now}::timestamptz + LEAST(
            make_interval(secs => ${FAILURE_BACKOFF_BASE_SECONDS}::double precision * POWER(2, ${researchAgents.consecutiveFailures})),
            make_interval(secs => ${FAILURE_BACKOFF_MAX_SECONDS}::double precision)
          ),
          consecutive_failures = consecutive_failures + 1,
          spend_today_usd = ${researchAgents.spendTodayUsd} + ${costUsd},
          leased_by = NULL,
          lease_expires_at = NULL,
          heartbeat_at = NULL,
          updated_at = ${now}
      WHERE id = ${agentId}
    `);
  });

  const [row] = await getDatabase()
    .select({ nextTickAt: researchAgents.nextTickAt })
    .from(researchAgents)
    .where(eq(researchAgents.id, agentId));
  return row!.nextTickAt!;
}

/**
 * Park a budget-blocked agent: journal row with outcome 'budget_exhausted'
 * and a far-future next_tick_at (just after UTC midnight). Never throws for
 * bookkeeping reasons — budget exhaustion must never crash the loop.
 * Pass `tickId` when a tick row was already opened; otherwise one is created.
 */
export async function parkBudgetExhausted(
  agentId: string,
  input: {
    tickId?: string;
    reason: string;
    costUsd?: number;
    now?: Date;
  },
): Promise<Date> {
  const now = input.now ?? new Date();
  const parkUntil = budgetParkUntil(now);
  const costUsd = input.costUsd ?? 0;

  let tickId = input.tickId;
  if (tickId === undefined) {
    const [row] = await getDatabase()
      .insert(agentTicks)
      .values({
        agentId,
        startedAt: now,
        finishedAt: now,
        outcome: "budget_exhausted",
        error: input.reason.slice(0, 4000),
        costUsd: costUsd.toFixed(6),
      })
      .returning({ id: agentTicks.id });
    tickId = row!.id;
  } else {
    await getDatabase()
      .update(agentTicks)
      .set({
        finishedAt: now,
        outcome: "budget_exhausted",
        error: input.reason.slice(0, 4000),
        costUsd: costUsd.toFixed(6),
      })
      .where(eq(agentTicks.id, tickId));
  }

  await getDatabase()
    .update(researchAgents)
    .set({
      lastTickAt: now,
      nextTickAt: parkUntil,
      spendTodayUsd: sql`${researchAgents.spendTodayUsd} + ${costUsd}`,
      leasedBy: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      updatedAt: now,
    })
    .where(eq(researchAgents.id, agentId));

  return parkUntil;
}

/**
 * Mark a preempted (aborted mid-flight) tick without scheduling semantics of
 * success/failure: keeps the failure streak untouched and re-dues the agent
 * promptly so takeover resumes work. Used on graceful-shutdown aborts.
 */
export async function markPreempted(
  agentId: string,
  input: { tickId: string; error: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  await getDatabase().transaction(async (tx) => {
    await tx
      .update(agentTicks)
      .set({ finishedAt: now, outcome: "preempted", error: input.error.slice(0, 4000) })
      .where(eq(agentTicks.id, input.tickId));
    await tx
      .update(researchAgents)
      .set({
        nextTickAt: now,
        leasedBy: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        updatedAt: now,
      })
      .where(eq(researchAgents.id, agentId));
  });
}
