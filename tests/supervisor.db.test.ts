/**
 * DB-gated integration suite for the AgentSupervisor loop.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/supervisor.db.test.ts
 *
 * Boots a SCRATCH postgres:18 container on a docker-assigned port, applies
 * the repo migrations, and exercises the supervisor against it with a fake
 * clock and injected handlers — NO network, NO OpenRouter calls.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentType } from "@asi/database";
import {
  agentTicks,
  claimDueAgents,
  closeDatabase,
  completeTick,
  failTick,
  getDatabase,
  heartbeat,
  listAgents,
  researchAgents,
  startTick,
} from "@asi/database";

import {
  startSupervisor,
  type SupervisorOptions,
  type SupervisorRuntime,
  type TickHandler,
  type TickHandlerRegistry,
} from "../apps/worker/src/supervisor/index.js";
import { runMigrations } from "../packages/database/src/migrate.js";
// The repo imports @asi/database (built dist) AND source paths for
// runMigrations; each module instance keeps its own pool — close both.
import { closeDatabase as closeSourceDatabase } from "../packages/database/src/client.js";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);
const CONTAINER = "asi-supervisor-scratch";
const IMAGE = "postgres:18-alpine";

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, {
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await docker([
        "exec",
        CONTAINER,
        "psql",
        "-U",
        "asi",
        "-d",
        "asi_app",
        "-c",
        "SELECT 1",
      ]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`scratch postgres did not become ready (${CONTAINER})`);
}

function loadDatabaseUrl(): void {
  if (
    process.env.DATABASE_URL !== undefined &&
    process.env.DATABASE_URL !== ""
  ) {
    return;
  }
  for (const candidate of [repoPath(".env.local"), repoPath(".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
}

/** Fake clock: deterministic time source advanced explicitly. */
class FakeClock {
  private current: number;

  constructor(startMs: number) {
    this.current = startMs;
  }

  now = (): Date => new Date(this.current);

  advanceMs(delta: number): Date {
    this.current += delta;
    return new Date(this.current);
  }
}

let createdAgentIds: string[] = [];

type AgentInsert = typeof researchAgents.$inferInsert;
type AgentRow = typeof researchAgents.$inferSelect;

async function insertAgent(
  overrides: Partial<AgentInsert> = {},
): Promise<AgentRow> {
  const [row] = await getDatabase()
    .insert(researchAgents)
    .values({
      key: overrides.key ?? `test-agent-${Math.random().toString(36).slice(2)}`,
      name: overrides.name ?? "Test agent",
      agentType: overrides.agentType ?? "discover_source",
      goal: "prove the supervisor loop",
      cadenceSeconds: overrides.cadenceSeconds ?? 900,
      status: overrides.status ?? "running",
      nextTickAt: new Date(0),
      ...overrides,
    })
    .returning();
  createdAgentIds.push(row!.id);
  return row!;
}

async function loadAgent(id: string): Promise<AgentRow> {
  const [row] = await getDatabase()
    .select()
    .from(researchAgents)
    .where(eq(researchAgents.id, id));
  return row!;
}

async function latestTick(
  agentId: string,
): Promise<typeof agentTicks.$inferSelect | undefined> {
  const rows = await getDatabase()
    .select()
    .from(agentTicks)
    .where(eq(agentTicks.agentId, agentId));
  return rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
}


/** Handler that records every execution; configurable per test. */
class RecordingHandler {
  readonly executions: string[] = [];
  constructor(private readonly impl: TickHandler) {}

  handle: TickHandler = async (context) => {
    this.executions.push(context.agent.key);
    return this.impl(context);
  };
}
function registryOf(handler: TickHandler): TickHandlerRegistry {
  return new Map([["discover_source", handler]]);
}

function registryOfTypes(
  handlers: Partial<Record<AgentType, TickHandler>>,
): TickHandlerRegistry {
  return new Map(Object.entries(handlers) as Array<[AgentType, TickHandler]>);
}


interface SupervisorTestOptions {
  pollIntervalMs?: number;
  leaseSeconds?: number;
  tickWallTimeMs?: number;
  dailySpendUsd?: number;
}

function startTestSupervisor(
  clock: FakeClock,
  handlers: TickHandlerRegistry,
  testOptions: SupervisorTestOptions = {},
): SupervisorRuntime {
  const debugLogger =
    process.env.ASI_SUPERVISOR_DEBUG === "1"
      ? (level: string, event: string, fields?: Record<string, unknown>) =>
          console.log(`[sup:${level}]`, event, fields ?? {})
      : undefined;
  const options: SupervisorOptions = {
    handlers,
    pollIntervalMs: testOptions.pollIntervalMs ?? 10,
    leaseSeconds: testOptions.leaseSeconds ?? 5,
    maxConcurrentAgents: 4,
    tickWallTimeMs: testOptions.tickWallTimeMs ?? 60_000,
    heartbeatIntervalMs: 20,
    gracefulDrainMs: 100,
    abortDrainMs: 100,
    now: () => clock.now(),
    getDailySpendUsd: async () => testOptions.dailySpendUsd ?? 0,
  };
  if (debugLogger !== undefined) options.logger = debugLogger;
  return startSupervisor(options);
}

const noop: TickHandler = async () => ({});

describe.skipIf(!DB_TESTS_ENABLED)("agent supervisor (DB)", () => {
  let clock: FakeClock;

  beforeAll(async () => {
    await docker(["rm", "-f", CONTAINER]).catch(() => undefined);
    await docker([
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-e",
      "POSTGRES_USER=asi",
      "-e",
      "POSTGRES_PASSWORD=test",
      "-e",
      "POSTGRES_DB=asi_app",
      "-p",
      "127.0.0.1::5432",
      IMAGE,
      "-c",
      "fsync=off",
    ]);
    const portMapping = await docker(["port", CONTAINER, "5432"]);
    const assigned = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(portMapping);
    if (assigned?.[1] === undefined) {
      throw new Error(`could not parse docker port mapping: ${portMapping}`);
    }
    process.env.DATABASE_URL = `postgres://asi:test@127.0.0.1:${assigned[1]}/asi_app`;
    // Deterministic global cap regardless of developer shell env.
    process.env.OPENROUTER_MAX_COST_PER_DAY_USD = "1";
    await waitForPostgres();
    loadDatabaseUrl();
    await runMigrations();
  }, 180_000);

  afterAll(async () => {
    try {
      await Promise.allSettled([closeDatabase(), closeSourceDatabase()]);
    } finally {
      await docker(["rm", "-f", CONTAINER]).catch(() => undefined);
    }
  });

  afterEach(async () => {
    if (createdAgentIds.length > 0) {
      await getDatabase()
        .delete(researchAgents)
        .where(inArray(researchAgents.id, createdAgentIds));
      createdAgentIds = [];
    }
  });

  it("claims due agents exclusively under concurrent supervisors", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 8, 0, 0));
    for (let i = 0; i < 3; i += 1) {
      await insertAgent({ key: `claim-${i}` });
    }

    // Four racing claimers, two slots each: SKIP LOCKED must hand out each
    // agent exactly once with a fresh lease.
    const rounds = await Promise.all(
      [0, 1, 2, 3].map((r) =>
        claimDueAgents({
          limit: 2,
          instanceId: `instance-${r}`,
          leaseSeconds: 90,
          now: clock.now(),
        }),
      ),
    );
    const claimedIds = rounds.flat().map((row) => row.id);
    expect(claimedIds).toHaveLength(3);
    expect(new Set(claimedIds).size).toBe(3);
    for (const row of rounds.flat()) {
      expect(row.leasedBy).toMatch(/^instance-\d$/);
      expect(row.leaseExpiresAt!.getTime()).toBe(clock.now().getTime() + 90_000);
      expect(row.heartbeatAt!.getTime()).toBe(clock.now().getTime());
    }

    // A fresh lease blocks any further claim even though next_tick_at is past.
    const again = await claimDueAgents({
      limit: 2,
      instanceId: "instance-x",
      leaseSeconds: 90,
      now: clock.now(),
    });
    expect(again).toHaveLength(0);
  });

  it("heartbeat refreshes liveness and extends the lease", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 9, 0, 0));
    const agent = await insertAgent({ key: "heartbeat" });
    const [claimed] = await claimDueAgents({
      limit: 1,
      instanceId: "instance-a",
      leaseSeconds: 30,
      now: clock.now(),
    });
    expect(claimed!.id).toBe(agent.id);
    const originalExpiry = claimed!.leaseExpiresAt!;

    clock.advanceMs(15_000);
    const refreshed = await heartbeat(agent.id, {
      leaseSeconds: 30,
      now: clock.now(),
    });
    expect(refreshed).toBe(true);

    const stored = await loadAgent(agent.id);
    expect(stored.heartbeatAt!.getTime()).toBe(clock.now().getTime());
    expect(stored.leaseExpiresAt!.getTime()).toBeGreaterThan(
      originalExpiry.getTime(),
    );

    // Heartbeat on an unleased/unknown agent reports false, never throws.
    await expect(
      heartbeat("00000000-0000-0000-0000-000000000000", {
        leaseSeconds: 30,
        now: clock.now(),
      }),
    ).resolves.toBe(false);
  });

  it("completion schedules cadence, resets failures, books spend, releases lease", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 10, 0, 0));
    const agent = await insertAgent({
      key: "completing",
      cadenceSeconds: 900,
      consecutiveFailures: 3,
    });
    const tick = await startTick(agent.id, { now: clock.now() });

    const nextTickAt = await completeTick(agent.id, {
      tickId: tick.id,
      outcome: "executed",
      actionsExecuted: 2,
      findings: { newLeads: 4 },
      plan: { summary: "noop batch" },
      costUsd: 0.25,
      now: clock.advanceMs(2_000),
    });

    expect(nextTickAt.getTime()).toBe(clock.now().getTime() + 900_000);
    const stored = await loadAgent(agent.id);
    expect(stored.lastTickAt!.getTime()).toBe(clock.now().getTime());
    expect(stored.nextTickAt!.getTime()).toBe(clock.now().getTime() + 900_000);
    expect(stored.consecutiveFailures).toBe(0);
    expect(stored.spendTodayUsd).toBe("0.25");
    expect(stored.leasedBy).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();

    const [journal] = await getDatabase()
      .select()
      .from(agentTicks)
      .where(eq(agentTicks.id, tick.id));
    expect(journal!.outcome).toBe("executed");
    expect(journal!.finishedAt!.getTime()).toBe(clock.now().getTime());
    expect(journal!.actionsExecuted).toBe(2);
    expect(journal!.findings).toEqual({ newLeads: 4 });
    expect(journal!.costUsd).toBe("0.250000");

    const summaries = await listAgents(clock.now());
    const mine = summaries.find((s) => s.agent.id === agent.id)!;
    expect(mine.ticksToday).toBe(1);
    expect(mine.spendTodayUsd).toBeCloseTo(0.25, 6);
    expect(mine.lastTickOutcome).toBe("executed");
  });

  it("completion honors an explicit provider reset instead of cadence", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 10, 30, 0));
    const agent = await insertAgent({ key: "provider-reset", cadenceSeconds: 60 });
    const tick = await startTick(agent.id, { now: clock.now() });
    const resetAt = new Date(Date.UTC(2026, 5, 2, 0, 0, 0));

    const nextTickAt = await completeTick(agent.id, {
      tickId: tick.id,
      outcome: "budget_exhausted",
      findings: { idleReason: "provider_quota", resetAt: resetAt.toISOString() },
      nextTickAt: resetAt,
      now: clock.now(),
    });

    expect(nextTickAt).toEqual(resetAt);
    expect((await loadAgent(agent.id)).nextTickAt).toEqual(resetAt);
    expect((await latestTick(agent.id))?.outcome).toBe("budget_exhausted");
  });

  it("failures back off exponentially (15m doubling) capped at 24h", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 11, 0, 0));
    const agent = await insertAgent({ key: "backoff", cadenceSeconds: 60 });

    let previousDelay = -1;
    for (let failure = 1; failure <= 9; failure += 1) {
      const tick = await startTick(agent.id, { now: clock.now() });
      const nextTickAt = await failTick(agent.id, {
        tickId: tick.id,
        error: `simulated failure #${failure}`,
        now: clock.now(),
      });
      const expectedSeconds = Math.min(15 * 60 * 2 ** (failure - 1), 24 * 3600);
      const actualSeconds =
        (nextTickAt.getTime() - clock.now().getTime()) / 1000;
      expect(actualSeconds).toBe(expectedSeconds);
      if (previousDelay >= 0 && expectedSeconds < 24 * 3600) {
        expect(actualSeconds).toBe(previousDelay * 2);
      }
      previousDelay = actualSeconds;

      const stored = await loadAgent(agent.id);
      expect(stored.consecutiveFailures).toBe(failure);
      expect(stored.leasedBy).toBeNull();

      // Advance just past the backoff so the next failure can be attempted
      // without the supervisor involved (direct persistence-level proof).
      clock.advanceMs((expectedSeconds + 60) * 1000);
    }

    // The loop advanced ~82h of fake time, so older errors left the 24h
    // window; one more failure "now" must be counted by the aggregate.
    const freshTick = await startTick(agent.id, { now: clock.now() });
    await failTick(agent.id, {
      tickId: freshTick.id,
      error: "fresh failure for window check",
      now: clock.now(),
    });
    const summaries = await listAgents(clock.now());
    const mine = summaries.find((s) => s.agent.id === agent.id)!;
    expect(mine.errorsLast24h).toBe(1);
  });

  it("takes over a crashed worker's stale lease with zero double execution", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 12, 0, 0));
    const agent = await insertAgent({ key: "crash-takeover" });

    // Worker A claims the agent, opens its journal row (as runTick does),
    // then dies mid-tick: the row stays 'planned' forever and the lease
    // simply goes stale as the fake clock advances past its expiry.
    const [ghostClaim] = await claimDueAgents({
      limit: 1,
      instanceId: "ghost-worker",
      leaseSeconds: 5,
      now: clock.now(),
    });
    expect(ghostClaim!.id).toBe(agent.id);
    const ghostTick = await startTick(agent.id, { now: clock.now() });
    expect(ghostTick.outcome).toBe("planned");

    // While the ghost's lease is FRESH, a live supervisor must NOT execute:
    // next_tick_at is past, but the freshness guard blocks re-claiming.
    const early = new RecordingHandler(noop);
    const earlyRuntime = startTestSupervisor(clock, registryOf(early.handle));
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(early.executions).toEqual([]);

      // Ghost dies; its lease expires on the fake clock only.
      clock.advanceMs(10_000);

      // The live supervisor reclaims exactly once and executes exactly once.
      await vi.waitFor(
        () => expect(early.executions).toEqual(["crash-takeover"]),
        { timeout: 5_000, interval: 20 },
      );
      // Cadence keeps it quiet afterwards: no second execution sneaks in.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(early.executions).toEqual(["crash-takeover"]);

      const stored = await loadAgent(agent.id);
      expect(stored.nextTickAt!.getTime()).toBe(
        clock.now().getTime() + 900_000,
      );
      expect(stored.consecutiveFailures).toBe(0);

      const ticks = await getDatabase()
        .select()
        .from(agentTicks)
        .where(eq(agentTicks.agentId, agent.id))
        .orderBy(agentTicks.startedAt);
      // Exactly one 'planned' row from the ghost (never finalized) plus one
      // completed row from the takeover: proof there was no double execution.
      expect(ticks).toHaveLength(2);
      expect(ticks[0]!.outcome).toBe("planned");
      expect(ticks[1]!.outcome).toBe("executed");
    } finally {
      await earlyRuntime.stop();
    }
  });

  it("parks agents when the GLOBAL daily cap is exhausted", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 13, 0, 0));
    const agent = await insertAgent({ key: "global-cap-park" });

    const handler = new RecordingHandler(noop);
    const runtime = startTestSupervisor(clock, registryOf(handler.handle), {
      dailySpendUsd: 5, // >= $1 cap
    });
    try {
      await vi.waitFor(
        async () => {
          const tick = await latestTick(agent.id);
          expect(tick?.outcome).toBe("budget_exhausted");
        },
        { timeout: 5_000, interval: 20 },
      );
      expect(handler.executions).toEqual([]);

      const stored = await loadAgent(agent.id);
      expect(stored.status).toBe("running");
      expect(stored.leasedBy).toBeNull();
      // Far-future park: beyond an hour, near UTC midnight reset.
      expect(stored.nextTickAt!.getTime()).toBeGreaterThan(
        clock.now().getTime() + 3_600_000,
      );
      const tick = await latestTick(agent.id);
      expect(tick!.error).toContain("global daily cap");
    } finally {
      await runtime.stop();
    }
  });

  it("parks agents over their per-agent share or absolute budget, runs the rest", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 14, 0, 0));
    const shareParked = await insertAgent({
      key: "share-parked",
      budgetSharePct: "25", // 25% of $1 cap = $0.25
      spendTodayUsd: "0.30",
    });
    const absoluteParked = await insertAgent({
      key: "absolute-parked",
      agentType: "enrich_candidate",
      dailyBudgetUsd: "0.10",
      spendTodayUsd: "0.20",
    });
    const healthy = await insertAgent({ key: "healthy-runner" });

    const executed: string[] = [];
    const runtime = startTestSupervisor(
      clock,
      registryOfTypes({
        discover_source: async (context) => {
          executed.push(context.agent.key);
          return {};
        },
        enrich_candidate: async (context) => {
          executed.push(context.agent.key);
          return {};
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(executed).toEqual([healthy.key]), {
        timeout: 5_000,
        interval: 20,
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(executed).toEqual([healthy.key]);

      for (const parked of [shareParked, absoluteParked]) {
        const tick = await latestTick(parked.id);
        expect(tick!.outcome).toBe("budget_exhausted");
        const stored = await loadAgent(parked.id);
        expect(stored.nextTickAt!.getTime()).toBeGreaterThan(
          clock.now().getTime() + 3_600_000,
        );
      }
    } finally {
      await runtime.stop();
    }
  });

  it("graceful stop stops claiming, aborts in-flight ticks, preempts without penalty", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 15, 0, 0));
    const agent = await insertAgent({ key: "graceful-stop" });

    let started = 0;
    const runtime = startTestSupervisor(
      clock,
      registryOfTypes({
        discover_source: async (context) => {
          started += 1;
          // Hang until aborted (a well-behaved long tick).
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener("abort", () => resolve());
          });
          return {};
        },
      }),
    );

    await vi.waitFor(() => expect(started).toBe(1), {
      timeout: 5_000,
      interval: 20,
    });

    // Must not hang: drains ≤ gracefulDrainMs + abortDrainMs (200ms here).
    await runtime.stop();
    expect(started).toBe(1); // no re-claim after stop

    const stored = await loadAgent(agent.id);
    const tick = await latestTick(agent.id);
    expect(tick!.outcome).toBe("preempted");
    expect(stored.consecutiveFailures).toBe(0); // no failure penalty
    // Re-due immediately so another instance resumes the work.
    expect(stored.nextTickAt!.getTime()).toBeLessThanOrEqual(
      clock.now().getTime(),
    );
    expect(stored.leasedBy).toBeNull();

    // Takeover: a fresh supervisor picks the preempted agent right up.
    const successor = new RecordingHandler(noop);
    const successorRuntime = startTestSupervisor(
      clock,
      registryOf(successor.handle),
    );
    try {
      await vi.waitFor(
        () => expect(successor.executions).toEqual([agent.key]),
        { timeout: 5_000, interval: 20 },
      );
    } finally {
      await successorRuntime.stop();
    }
  });

  it("fails ticks that exceed the wall-time bound and backs off", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 16, 0, 0));
    const agent = await insertAgent({ key: "wall-time" });

    const runtime = startTestSupervisor(
      clock,
      registryOf(async () => new Promise<never>(() => {})), // hangs forever
      { tickWallTimeMs: 50 },
    );
    try {
      await vi.waitFor(
        async () => {
          const tick = await latestTick(agent.id);
          expect(tick?.outcome).toBe("error");
        },
        { timeout: 5_000, interval: 20 },
      );
      const tick = await latestTick(agent.id);
      expect(tick!.error).toContain("wall time");
      const stored = await loadAgent(agent.id);
      expect(stored.consecutiveFailures).toBe(1);
      expect(stored.nextTickAt!.getTime()).toBe(
        clock.now().getTime() + 15 * 60_000,
      );
    } finally {
      await runtime.stop();
    }
  });

  it("threads a handler reset through completion and does not repeat the tick", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 16, 30, 0));
    const agent = await insertAgent({ key: "quota-reset-through-supervisor" });
    const resetAt = new Date(Date.UTC(2026, 5, 2, 0, 0, 0));
    let executions = 0;
    const runtime = startTestSupervisor(
      clock,
      registryOf(async () => {
        executions += 1;
        return {
          outcome: "budget_exhausted",
          findings: {
            idleReason: "sam_daily_quota_exhausted",
            resetAt: resetAt.toISOString(),
          },
          nextTickAt: resetAt,
        };
      }),
    );
    try {
      await vi.waitFor(
        async () => {
          expect((await latestTick(agent.id))?.outcome).toBe("budget_exhausted");
        },
        { timeout: 5_000, interval: 20 },
      );
      expect(executions).toBe(1);
      expect((await loadAgent(agent.id)).nextTickAt).toEqual(resetAt);
    } finally {
      await runtime.stop();
    }
  });

  it("runs the full loop repeatedly on cadence and never touches paused/idle agents", async () => {
    clock = new FakeClock(Date.UTC(2026, 5, 1, 17, 0, 0));
    const runner = await insertAgent({ key: "cadence-runner", cadenceSeconds: 300 });
    await insertAgent({ key: "paused-agent", status: "paused" });
    await insertAgent({ key: "idle-agent", status: "idle" });

    const executed: string[] = [];
    const runtime = startTestSupervisor(
      clock,
      registryOfTypes({
        discover_source: async (context) => {
          executed.push(context.agent.key);
          return { outcome: "done", findings: { pass: executed.length } };
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(executed).toEqual([runner.key]), {
        timeout: 5_000,
        interval: 20,
      });

      // Advance past one cadence window: exactly one more tick.
      clock.advanceMs(301_000);
      await vi.waitFor(() => expect(executed.length).toBe(2), {
        timeout: 5_000,
        interval: 20,
      });
      clock.advanceMs(120_000); // inside cadence: nothing more
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(executed.length).toBe(2);

      const runnerTicks = await getDatabase()
        .select()
        .from(agentTicks)
        .where(eq(agentTicks.agentId, runner.id))
        .orderBy(agentTicks.startedAt);
      expect(runnerTicks).toHaveLength(2);
      expect(runnerTicks[0]!.outcome).toBe("done");
      expect(runnerTicks[1]!.findings).toEqual({ pass: 2 });

      // paused/idle agents were never claimed or journalled.
      const allTicks = await getDatabase()
        .select()
        .from(agentTicks)
        .orderBy(agentTicks.startedAt);
      expect(allTicks.every((t) => t.agentId === runner.id)).toBe(true);
    } finally {
      await runtime.stop();
    }
  });
});
