/**
 * DB-gated behavioral suite for migration 0003 (agent runtime + tiers).
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/agent-runtime-migration.db.test.ts
 *
 * Boots a SCRATCH postgres:18 container on a free port, restores the prod
 * backup (backups/prod-20260822T234724Z/database.dump), applies the repo
 * migrations, and proves:
 *   - additive-only: every pre-existing table keeps its exact row count
 *   - idempotency: a second migrate run is a no-op
 *   - frontier_items owner CHECK: neither campaign nor agent ⇒ rejected
 *   - tier precedence: human override survives rescore/promotion, engine
 *     re-route keeps engine ownership, ?tier= filter matches in SQL
 *   - setHumanTier writes investment feedback + 'candidate.tier_overridden'
 *     audit event transactionally
 *
 * No network egress, no OpenRouter calls.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditEvents,
  closeDatabase,
  companies,
  feedback,
  frontierItems,
  getDatabase,
  queryCandidates,
  researchAgents,
  researchCampaigns,
  setHumanTier,
  upsertCandidate,
  users,
} from "@asi/database";

import { promoteCompany, rescoreCandidate } from "../apps/web/src/lib/candidate-scoring.js";
import { runMigrations } from "../packages/database/src/migrate.js";
// The repo imports @asi/database (built dist) AND source paths for
// runMigrations; each module instance keeps its own pool — close both.
import { closeDatabase as closeSourceDatabase } from "../packages/database/src/client.js";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);
const DUMP_PATH = repoPath("backups/prod-20260822T234724Z/database.dump");
const CONTAINER = "asi-mig-0003-scratch";
const IMAGE = "postgres:18-alpine";


async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// Poll psql against the target DB: a bare pg_isready can pass during the
// init phase's temporary server, before POSTGRES_DB exists.
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

// Exact per-table counts (pg_stat n_live_tup is only an estimate — this suite
// asserts exact equality, so each table is counted for real).
async function snapshotTableCounts(): Promise<Map<string, number>> {
  const db = getDatabase();
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname NOT LIKE '\\_asi\\_%' ESCAPE '\\'
    ORDER BY c.relname
  `);
  const counts = new Map<string, number>();
  for (const { table_name } of tables.rows) {
    const counted = await db.execute<{ c: string }>(
      sql`SELECT count(*)::text AS c FROM ${sql.identifier(table_name)}`,
    );
    counts.set(table_name, Number(counted.rows[0]?.c ?? "0"));
  }
  return counts;
}

describe.skipIf(!DB_TESTS_ENABLED)("migration 0003 on restored prod copy (DB)", () => {
  let port: number;
  let databaseUrl: string;

  beforeAll(async () => {
    if (!existsSync(DUMP_PATH)) {
      throw new Error(
        `prod backup dump not found at ${DUMP_PATH} — required by this suite`,
      );
    }
    // Docker assigns the host port itself (-p 127.0.0.1::5432); probing a
    // free port up front races the OS ephemeral allocator on macOS.
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
    port = Number(assigned[1]);
    databaseUrl = `postgres://asi:test@127.0.0.1:${port}/asi_app`;
    process.env.DATABASE_URL = databaseUrl;
    await waitForPostgres();

    // Fresh scratch DB = restored prod backup.
    await docker(["cp", DUMP_PATH, `${CONTAINER}:/tmp/database.dump`]);
    await docker([
      "exec",
      CONTAINER,
      "pg_restore",
      "--no-owner",
      "-U",
      "asi",
      "-d",
      "asi_app",
      "/tmp/database.dump",
    ]);
  }, 240_000);

  afterAll(async () => {
    try {
      await Promise.allSettled([closeDatabase(), closeSourceDatabase()]);
    } finally {
      // Graceful stop first: SIGKILL from rm -f makes postmaster drop live
      // sockets, which surfaces as an unhandled pg client error.
      await docker(["stop", "-t", "10", CONTAINER]).catch(() => undefined);
      await execFileAsync("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    }
  });

  it("applies pending migrations leaving pre-existing counts untouched", async () => {
    // The prod backup was taken with only migration 0000 applied.
    const ledgerBefore = await getDatabase().execute<{ migration_name: string }>(
      sql`SELECT migration_name FROM public."_asi_migrations" ORDER BY migration_name`,
    );
    expect(ledgerBefore.rows.map((row) => row.migration_name)).toEqual([
      "0000_initial.sql",
    ]);

    const countsBefore = await snapshotTableCounts();
    expect(countsBefore.size).toBeGreaterThan(40);
    expect(countsBefore.has("research_agents")).toBe(false);

    const summary = await runMigrations();
    expect(summary.applied).toEqual([
      "0001_known_universe.sql",
      "0002_candidate_discovery.sql",
      "0003_agent_runtime.sql",
      "0004_resolve_domain.sql",
      "0005_source_signals.sql",
    ]);

    const countsAfter = await snapshotTableCounts();
    for (const [table, count] of countsBefore) {
      // The runner's own ledger legitimately grows with each applied file.
      if (table === "_asi_migrations") continue;
      expect(countsAfter.get(table), `table ${table}`).toBe(count);
    }
    expect(countsAfter.get("research_agents")).toBe(0);
    expect(countsAfter.get("agent_ticks")).toBe(0);
  }, 120_000);

  it("is a no-op when rerun", async () => {
    const summary = await runMigrations();
    expect(summary.applied).toEqual([]);
    expect(summary.skipped).toContain("0003_agent_runtime.sql");
  });

  it("enforces exactly-one-owner on frontier_items", async () => {
    const db = getDatabase();
    const [campaign] = await db
      .insert(researchCampaigns)
      .values({ name: `mig0003-campaign-${Date.now().toString(36)}` })
      .returning({ id: researchCampaigns.id });
    const [agent] = await db
      .insert(researchAgents)
      .values({
        key: "discover-test",
        name: "Test discoverer",
        agentType: "discover_source",
        goal: "prove frontier ownership",
      })
      .returning({ id: researchAgents.id });

    const base = {
      itemType: "url" as const,
      normalizedValue: "https://example.com/frontier-check",
      status: "pending" as const,
    };

    // Neither owner ⇒ rejected by frontier_owner_check. Drizzle wraps the pg
    // error, so the constraint name surfaces on the cause chain.
    let rejection: unknown;
    try {
      await db.execute(sql`
        INSERT INTO frontier_items (item_type, normalized_value)
        VALUES ('url', 'https://example.com/ownerless')
      `);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeDefined();
    const text =
      rejection instanceof Error
        ? `${rejection.message} ${String(rejection.cause)}`
        : "";
    expect(text).toMatch(/frontier_owner_check/);

    // Campaign-owned still works…
    await db.insert(frontierItems).values({ ...base, campaignId: campaign!.id });
    // …and so does agent-owned with no campaign.
    await db.insert(frontierItems).values({ ...base, agentId: agent!.id });

    const ownedRows = await db.execute<{ campaign_id: string | null; agent_id: string | null }>(
      sql`SELECT campaign_id::text, agent_id::text FROM frontier_items
          WHERE normalized_value = 'https://example.com/frontier-check'`,
    );
    expect(ownedRows.rows).toHaveLength(2);
    expect(ownedRows.rows.every((row) => row.campaign_id !== null || row.agent_id !== null)).toBe(
      true,
    );
  });

  it("keeps a human tier override alive across rescore/promotion", async () => {
    const db = getDatabase();
    const [actor] = await db
      .insert(users)
      .values({
        email: `mig0003-${Date.now().toString(36)}@test.local`,
        displayName: "Migration 0003 Actor",
        passwordHash: "x".repeat(60),
        role: "admin",
      })
      .returning({ id: users.id });
    const [company] = await db
      .insert(companies)
      .values({
        legalName: "Migration 0003 Testco",
        displayName: "Migration 0003 Testco",
        headquartersCountryCode: "US",
      })
      .returning({ id: companies.id });

    const promoted = await promoteCompany(db, company!.id);
    expect(promoted.candidate.tierSource).toBe("engine");
    expect(promoted.candidate.tierOverride).toBeNull();
    expect(promoted.candidate.effectiveTier).toBe("needs_research");
    const candidateId = promoted.candidate.id;

    // Human overrides to watchlist…
    const overridden = await setHumanTier(db, {
      candidateId,
      tier: "watchlist",
      actorId: actor!.id,
      note: "great business, blocked",
    });
    expect(overridden.tierOverride).toBe("watchlist");
    expect(overridden.tierSource).toBe("human");

    // …and the override survives both an idempotent re-promotion and a forced
    // rescore (the same preservation rule as analyst-set statuses).
    const repromoted = await promoteCompany(db, company!.id);
    expect(repromoted.candidate.id).toBe(candidateId);
    expect(repromoted.candidate.effectiveTier).toBe("watchlist");
    expect(repromoted.candidate.tierSource).toBe("human");

    const rescored = await rescoreCandidate(db, candidateId);
    expect(rescored.candidate.effectiveTier).toBe("watchlist");
    expect(rescored.candidate.tierSource).toBe("human");

    // A plain storage-level upsert (engine route queued_research) must not
    // clobber the override either.
    const rerouted = await db.transaction((tx) =>
      upsertCandidate(tx, {
        companyId: company!.id,
        routedStatus: "queued_research",
        noveltyStatus: "not_matched_to_current_known_universe",
        noveltySnapshotIds: [],
        rationale: { whyInteresting: [], risks: [], unknowns: [] },
        currentScores: {},
        researchPriority: null,
        partnerReviewPriority: null,
      }),
    );
    // The storage-level reroute preserves the analyst-set status too.
    expect(rerouted.status).toBe(promoted.candidate.status);
    expect(rerouted.tierOverride).toBe("watchlist");
    expect(rerouted.tierSource).toBe("human");
  }, 60_000);

  it("writes investment feedback + audit event on override", async () => {
    const db = getDatabase();
    const rows = await db
      .select({ id: auditEvents.id, action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.action, "candidate.tier_overridden"));
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const journal = await db
      .select({
        channel: feedback.channel,
        action: feedback.action,
        notes: feedback.notes,
      })
      .from(feedback)
      .where(eq(feedback.channel, "investment"));
    const overrideEntries = journal.filter((row) =>
      (row.notes ?? "").includes("great business, blocked"),
    );
    expect(overrideEntries.length).toBeGreaterThanOrEqual(1);
    expect(overrideEntries[0]!.action).toBe("hold");
  });

  it("filters candidates by effective tier fully in SQL", async () => {
    const db = getDatabase();
    const watchlistPage = await queryCandidates(db, {
      page: 1,
      pageSize: 100,
      tier: "watchlist",
    });
    expect(watchlistPage.total).toBeGreaterThanOrEqual(1);
    expect(
      watchlistPage.records.every((record) => record.effectiveTier === "watchlist"),
    ).toBe(true);

    // The overridden candidate is NOT under its engine-routed tier anymore.
    const needsResearchPage = await queryCandidates(db, {
      page: 1,
      pageSize: 100,
      tier: "needs_research",
    });
    expect(
      needsResearchPage.records.some(
        (record) => record.effectiveTier === "watchlist",
      ),
    ).toBe(false);
  });
});
