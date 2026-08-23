/**
 * DB-gated integration suite for the agent control-plane API
 * (REDESIGN_PLAN §1.4): audit writes, lifecycle transitions, kill semantics,
 * and aggregate reads against the real schema.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/agents-routes.db.test.ts
 *
 * Requires the docker compose database and migrations. NO network, NO
 * OpenRouter calls; @/lib/auth is mocked to a seeded admin user.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  agentTicks,
  auditEvents,
  closeDatabase,
  getDatabase,
  researchAgents,
  users,
} from "@asi/database";
import { runMigrations } from "../packages/database/src/migrate.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);

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

const ACTOR_ID = "5eba1a7e-0000-4000-8000-00000000aa01";
// Per-run tag: keeps keys unique even if a previous run left rows behind.
const RUN_TAG = Date.now().toString(36);

/**
 * audit_events is append-only (deny_*_mutation trigger): audit rows written
 * by these tests can neither be updated nor deleted, and deleting the actor
 * user would cascade an ON DELETE SET NULL update into the same trigger.
 * The suite therefore reuses one fixed admin user and never cleans audit
 * rows or that user — only the research_agents it creates.
 */

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue({ id: ACTOR_ID }),
  requireUser: vi.fn().mockResolvedValue({ id: ACTOR_ID }),
  verifyCsrfRequest: vi.fn().mockResolvedValue(undefined),
}));

const { GET: listAgentsRoute, POST: registerAgent } = await import(
  "../apps/web/src/app/api/v1/agents/route.js"
);
const { GET: overview } = await import(
  "../apps/web/src/app/api/v1/agents/overview/route.js"
);
const { GET: agentDetail, PATCH: patchAgent } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/route.js"
);
const { GET: agentTicksRoute } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/ticks/route.js"
);
const { POST: pauseAgent } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/pause/route.js"
);
const { POST: resumeAgent } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/resume/route.js"
);
const { POST: killAgent } = await import(
  "../apps/web/src/app/api/v1/agents/[id]/kill/route.js"
);

const KEY_PREFIX = `test-agents-api-${RUN_TAG}-`;
let nextKeySeq = 0;

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function insertAgent(overrides: Partial<typeof researchAgents.$inferInsert> = {}) {
  const key = overrides.key ?? `${KEY_PREFIX}${nextKeySeq++}`;
  const [row] = await getDatabase()
    .insert(researchAgents)
    .values({
      key,
      name: `Test agent ${key}`,
      agentType: "discover_source",
      goal: "test mission",
      status: "idle",
      createdBy: ACTOR_ID,
      ...overrides,
    })
    .returning();
  return row;
}

async function lastAudit(action: string, entityId: string) {
  const [row] = await getDatabase()
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.entityId, entityId)))
    .orderBy(auditEvents.createdAt);
  return row;
}

describe.skipIf(!DB_TESTS_ENABLED)("agent control-plane routes (DB)", () => {
  let running: Awaited<ReturnType<typeof insertAgent>>;
  let paused: Awaited<ReturnType<typeof insertAgent>>;

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();

    await getDatabase()
      .insert(users)
      .values({
        id: ACTOR_ID,
        email: "agents-api-tests@example.invalid",
        displayName: "Agents API Tests",
        passwordHash: "test-only",
        role: "admin",
      })
      .onConflictDoNothing();

    const now = new Date();
    running = await insertAgent({
      status: "running",
      leasedBy: "worker-test-1",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      cadenceSeconds: 900,
    });
    paused = await insertAgent({ status: "paused" });

    // One open tick + one closed, find-producing tick for `running`.
    await getDatabase().insert(agentTicks).values([
      {
        agentId: running.id,
        startedAt: new Date(now.getTime() - 3_600_000),
        finishedAt: new Date(now.getTime() - 3_500_000),
        outcome: "executed",
        findings: { newLeads: 2 },
        costUsd: "0.010000",
      },
      {
        agentId: running.id,
        startedAt: now,
        outcome: "planned",
      },
    ]);
  });

  afterAll(async () => {
    // Cascade removes this run's ticks. Audit rows are intentionally kept —
    // audit_events is append-only. The prefix sweep also removes agents left
    // behind by earlier crashed runs (historical "test-agents-api-" keys).
    await getDatabase()
      .delete(researchAgents)
      .where(
        sql`key LIKE ${`${KEY_PREFIX}%`} OR key LIKE 'test-agents-api-%'`,
      );
    await closeDatabase();
  });

  it("registers an agent with zod validation and an audited create", async () => {
    const response = await registerAgent(
      jsonRequest("http://localhost/api/v1/agents", "POST", {
        key: `${KEY_PREFIX}registered`,
        name: "Registered",
        agentType: "enrich_candidate",
        goal: "work the queue oldest-first",
        cadenceSeconds: 300,
        budgetSharePct: 25,
        dailyBudgetUsd: 0.5,
        seedScope: { geographies: ["US"] },
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.key).toBe(`${KEY_PREFIX}registered`);
    expect(body.data.agentType).toBe("enrich_candidate");
    expect(body.data.budgetSharePct).toBe(25);
    expect(body.data.dailyBudgetUsd).toBe(0.5);
    expect(body.data.createdBy).toBe(ACTOR_ID);

    const audit = await lastAudit("agent.created", body.data.id);
    expect(audit).toBeDefined();
    expect(audit!.actorUserId).toBe(ACTOR_ID);
    expect(audit!.after).toMatchObject({
      key: `${KEY_PREFIX}registered`,
      agentType: "enrich_candidate",
    });
  });

  it("rejects invalid registration payloads with 400", async () => {
    const response = await registerAgent(
      jsonRequest("http://localhost/api/v1/agents", "POST", {
        key: "Not-A-Slug",
        name: "",
        agentType: "warp_drive",
        goal: "",
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("validation_failed");
  });

  it("rejects duplicate keys with 409", async () => {
    // The register test above created `${KEY_PREFIX}registered`; re-POSTing
    // the identical key must hit the unique index.
    const response = await registerAgent(
      jsonRequest("http://localhost/api/v1/agents", "POST", {
        key: `${KEY_PREFIX}registered`,
        name: "Duplicate",
        agentType: "discover_source",
        goal: "duplicate registration",
      }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("conflict");
  });

  it("patches cadence/budget edits and writes a before/after audit trail", async () => {
    const response = await patchAgent(
      jsonRequest(`http://localhost/api/v1/agents/${running.id}`, "PATCH", {
        cadenceSeconds: 60,
        dailyBudgetUsd: 0.25,
        goal: "updated mission",
      }),
      ctx(running.id),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.cadenceSeconds).toBe(60);
    expect(body.data.dailyBudgetUsd).toBe(0.25);
    expect(body.data.goal).toBe("updated mission");

    const audit = await lastAudit("agent.updated", running.id);
    expect(audit).toBeDefined();
    expect(audit!.before).toMatchObject({ cadenceSeconds: 900 });
    expect(audit!.after).toMatchObject({
      cadenceSeconds: 60,
      goal: "updated mission",
    });

    const [row] = await getDatabase()
      .select()
      .from(researchAgents)
      .where(eq(researchAgents.id, running.id));
    expect(row.cadenceSeconds).toBe(60);
    expect(row.dailyBudgetUsd).toBe("0.25");
  });

  it("pauses then resumes with an audit row per transition", async () => {
    const pauseResponse = await pauseAgent(
      jsonRequest(`http://localhost/api/v1/agents/${running.id}/pause`, "POST"),
      ctx(running.id),
    );
    expect(pauseResponse.status).toBe(200);
    expect((await pauseResponse.json()).data.status).toBe("paused");

    const resumeResponse = await resumeAgent(
      jsonRequest(`http://localhost/api/v1/agents/${running.id}/resume`, "POST"),
      ctx(running.id),
    );
    expect(resumeResponse.status).toBe(200);
    const resumed = (await resumeResponse.json()).data;
    expect(resumed.status).toBe("running");
    // Resume re-dues the agent immediately.
    expect(Date.parse(resumed.nextTickAt)).toBeGreaterThan(Date.now() - 5_000);

    const pauseAudit = await lastAudit("agent.pause", running.id);
    expect(pauseAudit!.before).toEqual({ status: "running" });
    expect(pauseAudit!.after).toEqual({ status: "paused" });
    const resumeAudit = await lastAudit("agent.resume", running.id);
    expect(resumeAudit!.before).toEqual({ status: "paused" });
    expect(resumeAudit!.after).toEqual({ status: "running" });
  });

  it("kills with lease invalidation, preempting only open ticks, and audits the reason", async () => {
    const killable = await insertAgent({
      status: "running",
      leasedBy: "worker-test-2",
      leaseExpiresAt: new Date(Date.now() + 120_000),
    });
    const openTick = await getDatabase()
      .insert(agentTicks)
      .values({ agentId: killable.id, startedAt: new Date(), outcome: "planned" })
      .returning();
    const closedTick = await getDatabase()
      .insert(agentTicks)
      .values({
        agentId: killable.id,
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 30_000),
        outcome: "executed",
      })
      .returning();

    const response = await killAgent(
      jsonRequest(`http://localhost/api/v1/agents/${killable.id}/kill`, "POST", {
        reason: "operator stop: policy review",
      }),
      ctx(killable.id),
    );
    expect(response.status).toBe(200);

    const [row] = await getDatabase()
      .select()
      .from(researchAgents)
      .where(eq(researchAgents.id, killable.id));
    expect(row.status).toBe("paused");
    expect(row.leasedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();

    const [open] = await getDatabase()
      .select()
      .from(agentTicks)
      .where(eq(agentTicks.id, openTick[0].id));
    expect(open.outcome).toBe("preempted");
    expect(open.finishedAt).not.toBeNull();
    expect(open.error).toContain("policy review");

    const [closed] = await getDatabase()
      .select()
      .from(agentTicks)
      .where(eq(agentTicks.id, closedTick[0].id));
    expect(closed.outcome).toBe("executed"); // untouched

    const audit = await lastAudit("agent.kill", killable.id);
    expect(audit).toBeDefined();
    expect(audit!.after).toMatchObject({
      status: "paused",
      reason: "operator stop: policy review",
    });
  });

  it("lists agents with health/spend/finds aggregates and filters", async () => {
    const response = await listAgentsRoute(
      jsonRequest(
        "http://localhost/api/v1/agents?status=running&page=1&pageSize=50",
        "GET",
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.totalItems).toBeGreaterThanOrEqual(1);
    for (const item of body.data) {
      expect(item.status).toBe("running");
    }
    const mine = body.data.find(
      (item: { id: string }) => item.id === running.id,
    );
    expect(mine).toBeDefined();
    expect(mine.findsToday).toBe(2); // findings.newLeads of today's tick
    expect(mine.ticksToday).toBeGreaterThanOrEqual(2);
    expect(typeof mine.spendTodayUsd).toBe("number");
  });

  it("serves the overview dashboard payload", async () => {
    const response = await overview(
      jsonRequest("http://localhost/api/v1/agents/overview", "GET"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.counts.running).toBeGreaterThanOrEqual(1);
    expect(body.data.counts.paused).toBeGreaterThanOrEqual(1);
    expect(body.data.spendTodayUsd).toBeGreaterThanOrEqual(0);
    expect(body.data.dailyCapUsd).toBeGreaterThan(0);
    expect(body.data.openProposals).toBeGreaterThanOrEqual(0);
    expect(body.data.lastFind).toMatchObject({
      agentId: running.id,
      agentKey: running.key,
    });
  });

  it("serves detail with recent ticks and 404s unknown agents", async () => {
    const ok = await agentDetail(
      jsonRequest(`http://localhost/api/v1/agents/${running.id}`, "GET"),
      ctx(running.id),
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.data.agent.id).toBe(running.id);
    expect(body.data.recentTicks.length).toBe(2);
    expect(body.data.aggregates.findsToday).toBe(2);

    const missing = await agentDetail(
      jsonRequest(
        "http://localhost/api/v1/agents/11111111-2222-4333-8444-555555555555",
        "GET",
      ),
      ctx("11111111-2222-4333-8444-555555555555"),
    );
    expect(missing.status).toBe(404);
  });

  it("paginates the tick log with outcome filters", async () => {
    const page = await agentTicksRoute(
      jsonRequest(
        `http://localhost/api/v1/agents/${running.id}/ticks?page=1&pageSize=1`,
        "GET",
      ),
      ctx(running.id),
    );
    expect(page.status).toBe(200);
    const body = await page.json();
    expect(body.data).toHaveLength(1);
    expect(body.meta.totalItems).toBe(2);
    expect(body.meta.totalPages).toBe(2);

    const filtered = await agentTicksRoute(
      jsonRequest(
        `http://localhost/api/v1/agents/${running.id}/ticks?outcome=executed`,
        "GET",
      ),
      ctx(running.id),
    );
    const filteredBody = await filtered.json();
    expect(filteredBody.meta.totalItems).toBe(1);
    expect(filteredBody.data[0].outcome).toBe("executed");

    const missing = await agentTicksRoute(
      jsonRequest(
        "http://localhost/api/v1/agents/11111111-2222-4333-8444-555555555555/ticks",
        "GET",
      ),
      ctx("11111111-2222-4333-8444-555555555555"),
    );
    expect(missing.status).toBe(404);
  });
});
