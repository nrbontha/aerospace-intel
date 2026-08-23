/**
 * DB-gated integration suite for the dataset imports.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/import-datasets.db.test.ts
 *
 * Requires the docker compose database (`docker compose up -d database`),
 * migrations, and the real gitignored workbooks under data/ (the CLI copies
 * them from ~/Downloads when absent).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeDatabase,
  createKnownUniverseSnapshot,
  getDatabase,
  importGoldenExamples,
  joinGoldenWithGrata,
  parseGoldenSetWorkbook,
  parseGrataData,
  reviewGoldenExample,
  sha256Hex,
  SnapshotKeyConflictError,
} from "@asi/database";
import { runMigrations } from "../packages/database/src/migrate.js";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") {
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

async function runCli(): Promise<string> {
  loadDatabaseUrl();
  const { stdout } = await execFileAsync(
    "npx",
    ["tsx", "scripts/import-datasets.ts"],
    { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

function goldenWorkbookBytes(): Uint8Array {
  return new Uint8Array(readFileSync(repoPath("data/golden-set-v01.xlsx")));
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const result = await getDatabase().execute<{ c: number }>(query);
  return result.rows[0]?.c ?? 0;
}

describe.skipIf(!DB_TESTS_ENABLED)("dataset imports (DB)", () => {
  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("imports all three snapshots, sources, and golden examples idempotently", async () => {
    const firstRun = await runCli();
    // The database may already hold the snapshots (created) or not — either
    // way the CLI reports the correct member counts and stays consistent.
    expect(firstRun).toMatch(/golden-set-v01\s+(created|skipped)\s+18\s/);
    expect(firstRun).toMatch(/grata-enrichment-v01\s+(created|skipped)\s+18\s/);
    expect(firstRun).toMatch(/preliminary-pipeline-v01\s+(created|skipped)\s+246\s/);
    expect(firstRun).toContain("data_sources: total=5");
    expect(firstRun).toContain("golden_examples: total=18");
    console.log("--- CLI summary-table output ---\n" + firstRun.trimEnd());

    const secondRun = await runCli();
    // A second consecutive run is always fully skipped: same bytes, same sha.
    expect(secondRun).toMatch(/golden-set-v01\s+skipped/);
    expect(secondRun).toMatch(/grata-enrichment-v01\s+skipped/);
    expect(secondRun).toMatch(/preliminary-pipeline-v01\s+skipped/);
    console.log("--- CLI run 2 (idempotent) ---\n" + secondRun.trimEnd());
  });

  it("holds 18 golden examples with the expected proposal split", async () => {
    const db = getDatabase();
    const split = await db.execute<{ t: string; c: number }>(sql`
      SELECT golden_example_type::text AS t, count(*)::int AS c
      FROM golden_examples GROUP BY 1
    `);
    const byType = Object.fromEntries(split.rows.map((r) => [r.t, r.c]));
    expect(byType["ideal_archetype_but_unactionable"]).toBe(4);
    expect(byType["positive_with_caveat"]).toBe(3);
    expect(byType["strong_positive"]).toBe(11);
    expect(
      await countRows(sql`SELECT count(*)::int AS c FROM golden_examples`),
    ).toBe(18);
    // Proposed rows always carry the unknown build-to-print risk; rows
    // reviewed by earlier suite runs are legitimately no longer 'proposed'.
    const reviewed = await countRows(sql`
      SELECT count(*)::int AS c FROM golden_examples WHERE review_status = 'reviewed'
    `);
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM golden_examples
        WHERE review_status = 'proposed' AND build_to_print_risk = 'unknown'
      `),
    ).toBe(18 - reviewed);
  });

  it("imports the 246 pipeline members with Priority verbatim and never as leads", async () => {
    const db = getDatabase();
    expect(
      await countRows(sql`
        SELECT count(*)::int AS c FROM known_universe_members m
        JOIN known_universe_snapshots s ON s.id = m.snapshot_id
        WHERE s.key = 'preliminary-pipeline-v01'
      `),
    ).toBe(246);

    // Exactly one member each for priorities '1', '2', '3'; the rest null.
    const priorities = await db.execute<{ p: string | null; c: number }>(sql`
      SELECT raw_payload->>'Priority' AS p, count(*)::int AS c
      FROM known_universe_members m
      JOIN known_universe_snapshots s ON s.id = m.snapshot_id
      WHERE s.key = 'preliminary-pipeline-v01'
      GROUP BY 1 ORDER BY 1 NULLS LAST
    `);
    const byPriority = Object.fromEntries(
      priorities.rows.map((r) => [r.p ?? "null", r.c]),
    );
    expect(byPriority["1"]).toBe(1);
    expect(byPriority["2"]).toBe(1);
    expect(byPriority["3"]).toBe(1);
    expect(byPriority["null"]).toBe(243);

    // Spot-check: Interface, Inc. → Priority '1', contact Cathy Caris.
    const iface = await db.execute<{ payload: Record<string, unknown> }>(sql`
      SELECT m.raw_payload AS payload
      FROM known_universe_members m
      JOIN known_universe_snapshots s ON s.id = m.snapshot_id
      WHERE s.key = 'preliminary-pipeline-v01'
        AND lower(m.normalized_name) = 'interface, inc.'
    `);
    const payload = iface.rows[0]?.payload ?? {};
    expect(payload["Priority"]).toBe("1");
    expect(JSON.stringify(payload)).toContain("Cathy Caris");

    // Pipeline rows are members only — no leads were created from them.
    expect(await countRows(sql`SELECT count(*)::int AS c FROM leads`)).toBe(0);
  });

  it("imports the five nominated database sources with honest access states", async () => {
    const db = getDatabase();
    const rows = await db.execute<{
      name: string;
      access: string;
      ingestion: string;
      notes: string | null;
    }>(sql`
      SELECT name, access::text AS access, ingestion::text AS ingestion, notes
      FROM data_sources
      WHERE name IN (
        'Online Aerospace Supplier Information System (OASIS)',
        'Performance Review Institute',
        'System for Award Management (SAM)',
        'USAspending',
        'Boeing Illustrated Parts Catalog (IPC)'
      )
    `);
    expect(rows.rows.length).toBe(5);
    const byName = new Map(rows.rows.map((r) => [r.name, r]));
    expect(byName.get("Online Aerospace Supplier Information System (OASIS)")).toMatchObject({
      access: "authorized",
      ingestion: "web_fetch",
    });
    expect(byName.get("Performance Review Institute")).toMatchObject({
      access: "restricted_metadata_only",
      ingestion: "manual",
    });
    expect(byName.get("System for Award Management (SAM)")).toMatchObject({
      access: "authorized",
      ingestion: "api",
    });
    expect(byName.get("USAspending")).toMatchObject({ access: "public" });
    expect(byName.get("Boeing Illustrated Parts Catalog (IPC)")).toMatchObject({
      access: "restricted_metadata_only",
      ingestion: "manual",
    });
    // Precise access states live in notes — the enum vocabulary gap reported.
    expect(byName.get("Online Aerospace Supplier Information System (OASIS)")?.notes).toContain(
      "public_account_required",
    );
    expect(byName.get("Performance Review Institute")?.notes).toContain(
      "paid_subscription",
    );
    expect(byName.get("System for Award Management (SAM)")?.notes).toContain(
      "api_key_required",
    );
    expect(byName.get("USAspending")?.notes).toContain("public_no_auth");
    expect(byName.get("Boeing Illustrated Parts Catalog (IPC)")?.notes).toContain(
      "disabled",
    );
  });

  it("shows at least 12 exact/probable overlaps between golden and pipeline snapshots", async () => {
    const overlap = await countRows(sql`
      SELECT count(DISTINCT g.id)::int AS c
      FROM known_universe_members g
      JOIN known_universe_snapshots gs ON gs.id = g.snapshot_id AND gs.key = 'golden-set-v01'
      JOIN known_universe_members p
        ON p.snapshot_id = (SELECT id FROM known_universe_snapshots WHERE key = 'preliminary-pipeline-v01')
       AND (
         (g.normalized_domain IS NOT NULL AND p.normalized_domain IS NOT NULL
          AND lower(g.normalized_domain) = lower(p.normalized_domain))
         OR similarity(lower(g.raw_name), lower(p.raw_name)) >= 0.72
       )
    `);
    expect(overlap).toBeGreaterThanOrEqual(12);
  });

  it("enforces snapshot key idempotency: skip on same sha, conflict on different sha", async () => {
    const db = getDatabase();
    const bytes = goldenWorkbookBytes();
    const goldenSet = parseGoldenSetWorkbook(bytes);
    const grataRows = parseGrataData(bytes);

    const skip = await createKnownUniverseSnapshot(db, {
      key: "golden-set-v01",
      name: "Golden Set v01 (ADCO workbook)",
      sourceType: "golden_set_workbook",
      contentSha256: sha256Hex(bytes),
      members: goldenSet.companies.map((company) => ({
        rawName: company.name,
        rawDomain: company.domain,
        sourceRow: company.workbookRow,
        rawPayload: company.grataPayload,
      })),
    });
    expect(skip.status).toBe("skipped");

    await expect(
      createKnownUniverseSnapshot(db, {
        key: "golden-set-v01",
        name: "Golden Set v01 (ADCO workbook)",
        sourceType: "golden_set_workbook",
        contentSha256: sha256Hex(new Uint8Array([9, 9, 9])),
        members: [],
      }),
    ).rejects.toBeInstanceOf(SnapshotKeyConflictError);

    // Golden-example re-import is upsert-safe: no duplicate rows appear.
    const before = await countRows(
      sql`SELECT count(*)::int AS c FROM golden_examples`,
    );
    await importGoldenExamples(db, joinGoldenWithGrata(goldenSet.companies, grataRows));
    expect(
      await countRows(sql`SELECT count(*)::int AS c FROM golden_examples`),
    ).toBe(before);
  });

  it("persists a golden-example review decision and writes an audit event", async () => {
    const db = getDatabase();
    const pending = await db.execute<{ id: string }>(sql`
      SELECT id FROM golden_examples
      WHERE review_status = 'proposed' ORDER BY name LIMIT 1
    `);
    const example = pending.rows[0];
    expect(example).toBeDefined();

    let reviewer = await db.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`,
    );
    if (reviewer.rows[0] === undefined) {
      await db.execute(sql`
        INSERT INTO users (email, display_name, role, password_hash)
        VALUES ('imports-test@example.invalid', 'Imports Test Reviewer', 'admin', 'x')
        ON CONFLICT DO NOTHING
      `);
      reviewer = await db.execute<{ id: string }>(
        sql`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`,
      );
    }
    const reviewerId = reviewer.rows[0]?.id as string;

    const updated = await reviewGoldenExample(db, {
      exampleId: example.id,
      reviewerId,
      rationale: "Confirmed against the golden-set qualifying parameters.",
      labels: { currentActionability: "positive" },
    });
    expect(updated?.reviewStatus).toBe("reviewed");
    expect(updated?.reviewedAt).not.toBeNull();

    const auditCount = await countRows(sql`
      SELECT count(*)::int AS c FROM audit_events
      WHERE action = 'golden_example.reviewed' AND entity_id = ${example.id}
    `);
    expect(auditCount).toBeGreaterThanOrEqual(1);

    // Reviewed rows survive re-import untouched.
    const summary = await importGoldenExamples(
      db,
      joinGoldenWithGrata(parseGoldenSetWorkbook(goldenWorkbookBytes()).companies, parseGrataData(goldenWorkbookBytes())),
    );
    expect(summary.skippedReviewed).toBeGreaterThanOrEqual(1);
  });
});
