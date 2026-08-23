/**
 * DB-gated integration suite for golden-set → Targets seeding.
 *
 *   ASI_DB_TESTS=1 DATABASE_URL=... npx vitest run tests/golden-seed.db.test.ts
 *
 * Builds a FRESH scratch database on the same Postgres instance, applies all
 * migrations, imports the real datasets via the CLI, then runs the seeder:
 * 18 candidates at tier_override='high_interest' + audit rows, and a second
 * run that writes nothing new.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "pg";
import { sql } from "drizzle-orm";
import { closeDatabase, getDatabase } from "@asi/database";
import { runMigrations } from "../packages/database/src/migrate.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);
const SCRATCH_DB = "asi_golden_seed_scratch";

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") {
    return process.env.DATABASE_URL;
  }
  for (const candidate of [repoPath(".env.local"), repoPath(".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return process.env.DATABASE_URL;
      }
    }
  }
  throw new Error("DATABASE_URL not set and not found in .env.local");
}

function scratchUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
}

/** CREATE/DROP the scratch database over a one-shot admin connection. */
async function adminExec(statement: string): Promise<void> {
  const baseUrl = loadDatabaseUrl();
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

async function runSeederCli(envUrl: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "npx",
    ["tsx", "scripts/seed-golden-candidates.ts"],
    { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024, env: { ...process.env, DATABASE_URL: envUrl } },
  );
  return stdout;
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const result = await getDatabase().execute<{ c: number }>(query);
  return Number(result.rows[0]?.c ?? 0);
}

describe.skipIf(!DB_TESTS_ENABLED)("golden seed → Targets (DB)", () => {
  let databaseUrl: string;

  beforeAll(async () => {
    const baseUrl = loadDatabaseUrl();
    databaseUrl = scratchUrl(baseUrl);
    // Fresh scratch: drop any leftover, recreate empty, migrate to HEAD.
    await adminExec(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await adminExec(`CREATE DATABASE ${SCRATCH_DB}`);
    process.env.DATABASE_URL = databaseUrl;
    await runMigrations();

    // The CLI needs the datasets; import them into the scratch DB only.
    await execFileAsync("npx", ["tsx", "scripts/import-datasets.ts"], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });

    // Seeder needs an actor for investment feedback (NOT NULL users.id FK).
    await getDatabase().execute(sql`
      INSERT INTO users (email, display_name, password_hash, role)
      VALUES ('golden-seed@test.local', 'Golden Seed Test', 'x', 'admin')
    `);
  }, 240_000);

  afterAll(async () => {
    try {
      await closeDatabase();
    } finally {
      await adminExec(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`).catch(() => undefined);
    }
  });

  it("seeds 18 High-interest candidates with audit rows; second run writes nothing", async () => {
    const firstRun = await runSeederCli(databaseUrl);
    console.log("--- seeder run 1 ---\n" + firstRun.trimEnd());
    expect(firstRun).toContain("candidates_seeded=18");
    expect(firstRun).toMatch(/skipped_existing=0/);

    const db = getDatabase();
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM candidates
        WHERE tier_override = 'high_interest' AND tier_source = 'human'
      `),
    ).toBe(18);
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM audit_events
        WHERE action = 'golden.candidate_seeded' AND entity_type = 'candidate'
      `),
    ).toBe(18);
    // setHumanTier journal: one investment feedback row per seeded candidate.
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM feedback
        WHERE channel = 'investment' AND payload->>'tierOverride' = 'high_interest'
      `),
    ).toBe(18);
    // Every example is now linked to a canonical company with a domain.
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM golden_examples WHERE company_id IS NOT NULL
      `),
    ).toBe(18);

    // Idempotent re-run: zero new companies/candidates/audit rows.
    const beforeSecond = {
      companies: await countRows(sql`SELECT count(*)::int AS c FROM companies`),
      audits: await countRows(sql`
        SELECT count(*)::int AS c FROM audit_events WHERE action = 'golden.candidate_seeded'
      `),
    };
    const secondRun = await runSeederCli(databaseUrl);
    console.log("--- seeder run 2 (idempotent) ---\n" + secondRun.trimEnd());
    expect(secondRun).toContain("companies_created=0");
    expect(secondRun).toContain("candidates_seeded=0");
    expect(secondRun).toMatch(/skipped_existing=18/);
    expect(await countRows(sql`SELECT count(*)::int AS c FROM companies`)).toBe(
      beforeSecond.companies,
    );
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM audit_events WHERE action = 'golden.candidate_seeded'
      `),
    ).toBe(beforeSecond.audits);
  });

  it("keeps the public-subsidiary caveat visible and provenance on created companies", async () => {
    const db = getDatabase();

    // Public-subsidiary members keep their ideal_archetype_but_unactionable
    // annotation visible through the carried-over rationale.
    const rosen = await db.execute<{ why: unknown }>(sql`
      SELECT c.rationale->'whyInteresting' AS why
      FROM candidates c
      JOIN golden_examples ge ON ge.company_id = c.company_id
      WHERE ge.name = 'Rosen Aviation'
    `);
    const whyText = JSON.stringify(rosen.rows[0]?.why ?? "");
    expect(whyText).toContain("unactionable");
    expect(whyText).toContain("public");

    // Every seeded rationale carries the mutual-interest caveat risk.
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM candidates
        WHERE rationale->'risks' ? 'reference example — interest not known mutual'
          AND company_id IN (SELECT company_id FROM golden_examples)
      `),
    ).toBe(18);

    // Created companies carry the reference-import provenance link.
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c
        FROM company_source_links l
        JOIN data_sources s ON s.id = l.data_source_id
        WHERE lower(s.name) = 'golden set reference import'
          AND l.relationship = 'golden-set reference import'
      `),
    ).toBeGreaterThan(0);
  });
});
