/**
 * DB-gated migration coverage for durable source signals.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/source-signals-migration.db.test.ts
 *
 * Restores the production backup into scratch Postgres, then proves migration
 * 0005 is additive and source observations remain structurally quarantined.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@asi/database";

import { closeDatabase as closeSourceDatabase } from "../packages/database/src/client.js";
import { runMigrations } from "../packages/database/src/migrate.js";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const DUMP_PATH = path.join(
  process.cwd(),
  "backups/prod-20260822T234724Z/database.dump",
);
const CONTAINER = "asi-mig-0005-scratch";
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
      // A real container startup has no deterministic clock to drive.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`scratch postgres did not become ready (${CONTAINER})`);
}

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

async function expectRejected(statement: SQL): Promise<void> {
  await expect(getDatabase().execute(statement)).rejects.toBeDefined();
}

describe.skipIf(!DB_TESTS_ENABLED)("migration 0005 on restored prod copy (DB)", () => {
  beforeAll(async () => {
    if (!existsSync(DUMP_PATH)) {
      throw new Error(`prod backup dump not found at ${DUMP_PATH}`);
    }
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
    const mapping = await docker(["port", CONTAINER, "5432"]);
    const assigned = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(mapping);
    if (assigned?.[1] === undefined) {
      throw new Error(`could not parse docker port mapping: ${mapping}`);
    }
    process.env.DATABASE_URL = `postgres://asi:test@127.0.0.1:${assigned[1]}/asi_app`;
    await waitForPostgres();
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
      await docker(["stop", "-t", "10", CONTAINER]).catch(() => undefined);
      await execFileAsync("docker", ["rm", "-f", CONTAINER]).catch(() => undefined);
    }
  });

  it("migrates 0001–0005 without changing pre-existing counts", async () => {
    const db = getDatabase();
    const ledgerBefore = await db.execute<{ migration_name: string }>(
      sql`SELECT migration_name FROM public."_asi_migrations" ORDER BY migration_name`,
    );
    expect(ledgerBefore.rows.map((row) => row.migration_name)).toEqual(["0000_initial.sql"]);

    const countsBefore = await snapshotTableCounts();
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
      if (table !== "_asi_migrations") {
        expect(countsAfter.get(table), `table ${table}`).toBe(count);
      }
    }
    expect(countsAfter.get("source_signals")).toBe(0);
  }, 120_000);

  it("exposes qualification enums and is idempotent", async () => {
    const db = getDatabase();
    const statuses = await db.execute<{ status: string }>(sql`
      SELECT unnest(enum_range(NULL::source_signal_status))::text AS status
    `);
    expect(statuses.rows.map((row) => row.status)).toEqual([
      "queued_qualification",
      "qualifying",
      "qualified",
      "rejected",
      "quarantined",
    ]);
    const agentTypes = await db.execute<{ type: string }>(sql`
      SELECT unnest(enum_range(NULL::agent_type))::text AS type
    `);
    expect(agentTypes.rows.map((row) => row.type)).toContain("qualify_award_lead");

    const summary = await runMigrations();
    expect(summary.applied).toEqual([]);
    expect(summary.skipped).toContain("0005_source_signals.sql");
  });

  it("deduplicates fingerprints and enforces source signal constraints", async () => {
    const db = getDatabase();
    const [agent] = await db.execute<{ id: string }>(sql`
      INSERT INTO research_agents (key, name, agent_type, goal)
      VALUES ('qualify-award-migration-test', 'Qualification test', 'qualify_award_lead', 'test')
      RETURNING id
    `).then((result) => result.rows);
    const agentId = agent?.id;
    expect(agentId).toBeDefined();

    await db.execute(sql`
      INSERT INTO source_signals (
        source_key, source_locator, source_fingerprint, agent_id, raw_name,
        award_count, award_value
      ) VALUES (
        'usaspending', 'recipient:dedupe', 'usaspending:dedupe', ${agentId}, 'Dedupe Corp',
        1, 100.00
      )
    `);
    await expectRejected(sql`
      INSERT INTO source_signals (source_key, source_locator, source_fingerprint, raw_name)
      VALUES ('usaspending', 'recipient:dedupe-again', 'usaspending:dedupe', 'Dedupe Corp')
    `);
    await expectRejected(sql`
      INSERT INTO source_signals (source_key, source_locator, source_fingerprint, raw_name, award_count)
      VALUES ('usaspending', 'recipient:negative-count', 'usaspending:negative-count', 'Bad Count', -1)
    `);
    await expectRejected(sql`
      INSERT INTO source_signals (source_key, source_locator, source_fingerprint, raw_name, award_value)
      VALUES ('usaspending', 'recipient:negative-value', 'usaspending:negative-value', 'Bad Value', -1)
    `);
    await expectRejected(sql`
      INSERT INTO source_signals (source_key, source_locator, source_fingerprint, raw_name, agent_id)
      VALUES ('usaspending', 'recipient:bad-agent', 'usaspending:bad-agent', 'Bad Agent', gen_random_uuid())
    `);
    await expectRejected(sql`
      INSERT INTO source_signals (source_key, source_locator, source_fingerprint, raw_name, lead_id)
      VALUES ('usaspending', 'recipient:bad-lead', 'usaspending:bad-lead', 'Bad Lead', gen_random_uuid())
    `);
    await expectRejected(sql`
      INSERT INTO source_signals (source_key, source_locator, source_fingerprint, raw_name, company_id)
      VALUES ('usaspending', 'recipient:bad-company', 'usaspending:bad-company', 'Bad Company', gen_random_uuid())
    `);


    await db.execute(sql`DELETE FROM research_agents WHERE id = ${agentId}`);
    const signal = await db.execute<{ agent_id: string | null; status: string }>(sql`
      SELECT agent_id, status::text FROM source_signals
      WHERE source_fingerprint = 'usaspending:dedupe'
    `);
    expect(signal.rows[0]).toEqual({ agent_id: null, status: "queued_qualification" });
  });
});
