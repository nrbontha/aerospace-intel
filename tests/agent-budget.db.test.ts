/**
 * DB-gated integration suite for agent BUDGET enforcement (REDESIGN_PLAN §1.2
 * "Budgets"). Companion to tests/supervisor.db.test.ts, which covers the loop
 * itself with an INJECTED daily-spend reader; this suite wires the REAL
 * `getDailySpendUsd` (model_usage telemetry sum) into the supervisor and proves:
 *
 *   1. a per-agent share/absolute cap parks only that agent;
 *   2. tick cost_usd accumulates into spend_today_usd and gates the next claim;
 *   3. an unreadable spend read FAILS SAFE (park, never crash, never overspend);
 *   4. crossing the GLOBAL daily cap parks ALL due running agents.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/agent-budget.db.test.ts
 *
 * Boots a SCRATCH postgres:18 container on a docker-assigned port, applies the
 * repo migrations, seeds model_usage rows directly — NO network, NO model calls.
 *
 * Isolation contract: model_usage is append-only (deny-immutable triggers), so
 * seeded telemetry accumulates across tests within this scratch DB. Test ORDER
 * therefore matters — every test pins OPENROUTER_MAX_COST_PER_DAY_USD at its
 * start, seeds nothing until the final global-cap test, which seeds enough to
 * cross the cap regardless of prior accumulation. Running any single test via
 * `-t` also works because each is self-sufficient.
 *
 * Timing note: the supervisor's poll loop runs on real timers by design (that
 * IS the behavior under test), so negative assertions ("nothing else ran")
 * need a short real settle sleep; every positive condition awaits vi.waitFor,
 * never a guessed duration.
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
  closeDatabase,
  getDatabase,
  modelUsage,
  researchAgents,
  researchRuns,
} from "@asi/database";
import { getDailySpendUsd } from "@asi/research";

import {
  startSupervisor,
  type SupervisorOptions,
  type SupervisorRuntime,
  type TickHandler,
  type TickHandlerRegistry,
} from "../apps/worker/src/supervisor/index.js";
// The repo imports @asi/database (built dist) AND source paths for
// runMigrations; each module instance keeps its own pool — close both.
import { runMigrations } from "../packages/database/src/migrate.js";
import { closeDatabase as closeSourceDatabase } from "../packages/database/src/client.js";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);
const CONTAINER = "asi-agent-budget-scratch";
const IMAGE = "postgres:18-alpine";

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout.trim();
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await docker(["exec", CONTAINER, "pg_isready", "-U", "asi", "-d", "asi_app"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("scratch postgres never became ready");
}

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL.length > 0) return;
  const envLocalPath = repoPath(".env.local");
  if (!existsSync(envLocalPath)) return;
  const match = /^DATABASE_URL=(.+)$/m.exec(readFileSync(envLocalPath, "utf8"));
  if (match?.[1] !== undefined) process.env.DATABASE_URL = match[1].trim();
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
      key: overrides.key ?? `budget-agent-${Math.random().toString(36).slice(2)}`,
      name: overrides.name ?? "Budget test agent",
      agentType: overrides.agentType ?? "discover_source",
      goal: "prove budget gating",
      cadenceSeconds: overrides.cadenceSeconds ?? 900,
      status: overrides.status ?? "running",
      nextTickAt: new Date(0),
      ...overrides,
    })
    .returning();
  createdAgentIds.push(row!.id);
  return row!;
}

/**
 * Seed `totalUsd` of model spend since UTC midnight via a real model_usage row.
 * Each call creates its own research_run so per-row sequence stays unique.
 */
async function seedModelSpend(totalUsd: number): Promise<void> {
  const [run] = await getDatabase()
    .insert(researchRuns)
    .values({
      targetType: "company",
      objective: "scratch spend telemetry for budget gate tests",
      promptVersion: "test",
    })
    .returning({ id: researchRuns.id });
  await getDatabase().insert(modelUsage).values({
    researchRunId: run!.id,
    sequence: 0,
    provider: "openrouter",
    model: "test/model",
    status: "succeeded",
    promptSha256: "0".repeat(64),
    request: {},
    costUsd: totalUsd.toFixed(8),
  });
}

async function loadStoredAgent(id: string): Promise<AgentRow> {
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

function registryOfTypes(
  handlers: Partial<Record<AgentType, TickHandler>>,
): TickHandlerRegistry {
  return new Map(Object.entries(handlers) as Array<[AgentType, TickHandler]>);
}

interface SupervisorTestOptions {
  pollIntervalMs?: number;
  getDailySpendUsd?: () => Promise<number>;
}

function startTestSupervisor(
  clock: FakeClock,
  handlers: TickHandlerRegistry,
  testOptions: SupervisorTestOptions = {},
): SupervisorRuntime {
  const options: SupervisorOptions = {
    handlers,
    pollIntervalMs: testOptions.pollIntervalMs ?? 10,
    leaseSeconds: 5,
    maxConcurrentAgents: 4,
    tickWallTimeMs: 60_000,
    heartbeatIntervalMs: 20,
    gracefulDrainMs: 100,
    abortDrainMs: 100,
    now: () => clock.now(),
  };
  // Omitted ⇒ the supervisor uses the REAL getDailySpendUsd over seeded
  // model_usage rows; provided ⇒ injected (fail-safe test).
  if (testOptions.getDailySpendUsd !== undefined) {
    options.getDailySpendUsd = testOptions.getDailySpendUsd;
  }
  return startSupervisor(options);
}

/** Wait until every listed agent has a budget_exhausted tick journal row. */
async function expectAllParked(agentIds: string[]): Promise<void> {
  await vi.waitFor(
    async () => {
      for (const id of agentIds) {
        await expect(latestTick(id)).resolves.toMatchObject({
          outcome: "budget_exhausted",
        });
      }
    },
    { timeout: 5_000, interval: 20 },
  );
}

describe.skipIf(!DB_TESTS_ENABLED)("agent budget enforcement (DB)", () => {
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
    // Deterministic global cap regardless of developer shell env; each test
    // re-pins it at its own start (see isolation contract above).
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

  it("tick cost_usd accumulates into spend attribution and gates the next claim", async () => {
    clock = new FakeClock(Date.UTC(2026, 7, 23, 10, 0, 0));
    // No telemetry seeded yet ⇒ global spend $0 < $1 cap; only the agent's
    // own share can stop it.
    process.env.OPENROUTER_MAX_COST_PER_DAY_USD = "1";
    // Share cap $0.20; the first tick books $0.25 ⇒ next claim must park it.
    const agent = await insertAgent({
      key: "attribution",
      budgetSharePct: "20",
      cadenceSeconds: 1,
    });

    let executions = 0;
    const runtime = startTestSupervisor(clock, registryOfTypes({
      discover_source: async () => {
        executions += 1;
        return { costUsd: 0.25, actionsExecuted: 1 };
      },
    }));
    try {
      await vi.waitFor(() => expect(executions).toBe(1), {
        timeout: 5_000,
        interval: 20,
      });

      const storedAfterFirst = await loadStoredAgent(agent.id);
      expect(Number(storedAfterFirst.spendTodayUsd)).toBeCloseTo(0.25, 6);

      // Advance past cadence on the fake clock: instead of a second
      // execution, accumulated spend crosses the share cap and parks it.
      clock.advanceMs(2_000);
      await expectAllParked([agent.id]);
      expect(executions).toBe(1);

      const tick = await latestTick(agent.id);
      expect(tick!.error).toContain("$0.25"); // spent attribution
      expect(tick!.error).toContain("$0.20"); // share cap
    } finally {
      await runtime.stop();
    }
  });

  it("unreadable daily spend fails safe: parks everything, loop survives", async () => {
    clock = new FakeClock(Date.UTC(2026, 7, 23, 11, 0, 0));
    process.env.OPENROUTER_MAX_COST_PER_DAY_USD = "1";
    const agents = [
      await insertAgent({ key: "safe-a" }),
      await insertAgent({ key: "safe-b", agentType: "refresh_stale" }),
    ];

    const executed: string[] = [];
    const runtime = startTestSupervisor(
      clock,
      registryOfTypes({
        discover_source: async (context) => {
          executed.push(context.agent.key);
          return {};
        },
        refresh_stale: async (context) => {
          executed.push(context.agent.key);
          return {};
        },
      }),
      {
        getDailySpendUsd: async () => {
          throw new Error("spend query unavailable");
        },
      },
    );
    try {
      await expectAllParked(agents.map((agent) => agent.id));
      expect(executed).toEqual([]);

      for (const agent of agents) {
        const tick = await latestTick(agent.id);
        expect(tick!.error).toContain("global daily cap");
        const stored = await loadStoredAgent(agent.id);
        expect(stored.leasedBy).toBeNull();
        expect(stored.nextTickAt!.getTime()).toBeGreaterThan(
          clock.now().getTime() + 3_600_000,
        );
      }

      // Fail-safe means fail-safe: the loop kept polling and stop() drains.
      await runtime.stop();
      clock.advanceMs(5_000);
      const successor = startTestSupervisor(clock, registryOfTypes({
        discover_source: async (context) => {
          executed.push(context.agent.key);
          return {};
        },
      }));
      try {
        // Settle sleep: parked far-future agents must stay unclaimed.
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(executed).toEqual([]);
      } finally {
        await successor.stop();
      }
    } finally {
      await runtime.stop();
    }
  });

  it("per-agent share/absolute caps park only that agent; others keep running", async () => {
    clock = new FakeClock(Date.UTC(2026, 7, 23, 9, 0, 0));
    process.env.OPENROUTER_MAX_COST_PER_DAY_USD = "1";
    // Global spend well under the $1 cap: the global gate must NOT fire.
    await seedModelSpend(0.05);

    const shareParked = await insertAgent({
      key: "share-parked",
      budgetSharePct: "25", // 25% × $1 = $0.25 < $0.30 spent today
      spendTodayUsd: "0.30",
    });
    const absoluteParked = await insertAgent({
      key: "absolute-parked",
      agentType: "enrich_candidate",
      dailyBudgetUsd: "0.05", // absolute floor below $0.06 spent today
      spendTodayUsd: "0.06",
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
      // Settle sleep: prove neither capped agent executed afterwards.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(executed).toEqual([healthy.key]);

      await expectAllParked([shareParked.id, absoluteParked.id]);
      for (const parked of [shareParked, absoluteParked]) {
        const tick = await latestTick(parked.id);
        expect(tick!.error).toContain("agent daily budget reached");
        const stored = await loadStoredAgent(parked.id);
        expect(stored.status).toBe("running");
        expect(stored.nextTickAt!.getTime()).toBeGreaterThan(
          clock.now().getTime() + 3_600_000,
        );
      }
    } finally {
      await runtime.stop();
    }
  });

  it("crossing the GLOBAL daily cap parks ALL due running agents", async () => {
    clock = new FakeClock(Date.UTC(2026, 7, 23, 8, 0, 0));
    process.env.OPENROUTER_MAX_COST_PER_DAY_USD = "1";
    // Runs LAST: earlier tests left $0.05 of telemetry behind, so seeding
    // $1.10 here guarantees ≥ $1 total regardless of execution order.
    await seedModelSpend(0.6);
    await seedModelSpend(0.5);

    const agents = [
      await insertAgent({ key: "cap-a" }),
      await insertAgent({ key: "cap-b", agentType: "enrich_candidate" }),
      await insertAgent({ key: "cap-c", agentType: "monitor_ownership" }),
    ];

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
        monitor_ownership: async (context) => {
          executed.push(context.agent.key);
          return {};
        },
      }),
    );
    try {
      await expectAllParked(agents.map((agent) => agent.id));

      // Settle sleep: prove NO handler ran anywhere once parking completed.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(executed).toEqual([]);

      for (const agent of agents) {
        const stored = await loadStoredAgent(agent.id);
        expect(stored.status).toBe("running");
        expect(stored.leasedBy).toBeNull();
        expect(stored.leaseExpiresAt).toBeNull();
        // Parked just past UTC-midnight reset, not merely backed off.
        expect(stored.nextTickAt!.getTime()).toBeGreaterThan(
          clock.now().getTime() + 3_600_000,
        );
        const tick = await latestTick(agent.id);
        expect(tick!.error).toContain("global daily cap");
        expect(tick!.costUsd).toBe("0.000000");
      }

      // Sanity: the shared campaign-budget reader agrees with what gated us.
      await expect(getDailySpendUsd()).resolves.toBeCloseTo(1.15, 6);
    } finally {
      await runtime.stop();
    }
  });
});
