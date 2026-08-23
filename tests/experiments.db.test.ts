/**
 * DB-gated integration suite for the experiment journal + golden-set run
 * loop.
 *
 *   ASI_DB_TESTS=1 npx vitest run tests/experiments.db.test.ts
 *
 * Requires the docker compose database with migrations applied. Covers:
 *   - program registration versioning (name+version bump on collision)
 *   - transactional promotion flips (old champion → archived)
 *   - the full register→run→decide→champion-flipped loop over the FROZEN
 *     GOLDEN_DATASET_V1 fixtures, with audit_events rows asserted
 *   - the append-only journal contract (UPDATE/DELETE denied by trigger)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_FIT_PROGRAM } from "../packages/research/src/scoring-axial/index.js";
import { runGoldenSetEvaluation } from "../apps/web/src/app/api/v1/experiments/_lib/run-scorer.js";
import {
  closeDatabase,
  getDatabase,
  getPool,
} from "../packages/database/src/client.js";
import {
  getChampionProgram,
  listExperimentRuns,
  promoteProgram,
  recordExperimentRun,
  upsertProgram,
} from "../packages/database/src/experiments/journal.js";
import { experimentRuns } from "../packages/database/src/schema.js";
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

async function countAuditEvents(
  entityType: string,
  entityId: string,
  action: string,
): Promise<number> {
  const result = await getDatabase().execute<{ c: number }>(sql`
    select count(*)::int as c from audit_events
    where entity_type = ${entityType}
      and entity_id = ${entityId}
      and action = ${action}
  `);
  return result.rows[0]?.c ?? 0;
}

const priorChampions: Array<{ axis: "fit" | "actionability"; id: string }> = [];

async function snapshotChampion(axis: "fit" | "actionability"): Promise<void> {
  const champion = await getChampionProgram(getDatabase(), axis);
  if (champion !== null) priorChampions.push({ axis, id: champion.id });
}

describe.skipIf(!DB_TESTS_ENABLED)("experiment journal", () => {
  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    await snapshotChampion("fit");
    await snapshotChampion("actionability");
  });

  afterAll(async () => {
    // Restore whichever champions were live before the test flipped them.
    const db = getDatabase();
    for (const { axis, id } of priorChampions) {
      await promoteProgram(db, id, "restore after experiments.db.test", null);
      void axis;
    }
    await closeDatabase();
  });

  it("versions registrations per name and keeps status challenger", async () => {
    const db = getDatabase();
    const name = `dbtest-prog-${randomUUID().slice(0, 8)}`;
    const program = structuredClone(DEFAULT_FIT_PROGRAM);

    const first = await upsertProgram(db, {
      name,
      version: 1,
      axis: "fit",
      program: program as unknown as Record<string, unknown>,
    });
    expect(first.version).toBe(1);
    expect(first.status).toBe("challenger");

    // Same name+version again → bumped to the next free version.
    const second = await upsertProgram(db, {
      name,
      version: 1,
      axis: "fit",
      program: program as unknown as Record<string, unknown>,
    });
    expect(second.version).toBe(2);
    expect(await countAuditEvents("scoring_program", first.id, "create")).toBe(1);
  });

  it("runs the full loop: register → run → decide keep → champion flipped", async () => {
    const db = getDatabase();
    const suffix = randomUUID().slice(0, 8);

    const challengerName = `dbtest-challenger-${suffix}`;

    const outcome = await runGoldenSetEvaluation(
      db,
      {
        label: `dbtest loop ${suffix}`,
        programs: [
          {
            name: challengerName,
            program: structuredClone(DEFAULT_FIT_PROGRAM) as unknown as Record<
              string,
              unknown
            >,
          },
        ],
        primaryMetric: "strongVsNegativeSeparation",
      },
      null,
    );

    // The frozen dataset was evaluated server-side with champion baselines.
    const entries = outcome.result["entries"] as Array<{
      role: string;
      programId: string | null;
    }>;
    expect(outcome.summary.datasetName).toContain("golden");
    expect(entries.some((entry) => entry.role === "champion")).toBe(true);
    const challengerEntry = entries.find(
      (entry) => entry.role === "challenger",
    );
    expect(challengerEntry?.programId).toBeTruthy();

    // Journal the run (append-only insert).
    const run = await recordExperimentRun(
      db,
      {
        kind: "scorer",
        label: `dbtest run ${suffix}`,
        primaryMetricName: outcome.primaryMetricName,
        primaryMetricValue: outcome.primaryMetricValue ?? undefined,
        result: outcome.result,
      },
      null,
    );
    expect(run.id).toBeTruthy();
    expect(
      await countAuditEvents("experiment_run", run.id, "create"),
    ).toBe(1);

    // Decide keep → promote best challenger (route semantics).
    const challengerId = challengerEntry!.programId!;
    await promoteProgram(
      db,
      challengerId,
      `keep decision on run ${run.id}`,
      null,
    );

    const champion = await getChampionProgram(db, "fit");
    expect(champion?.id).toBe(challengerId);

    // Decision journaled as a lineage child of the decided run.
    const decision = await recordExperimentRun(
      db,
      {
        kind: "scorer",
        label: `${run.label} — decision`,
        result: { decidedRunId: run.id, keep: true, promotedProgramId: challengerId },
        keep: true,
        decision: "dbtest keep",
        lineageParentId: run.id,
      },
      null,
    );
    expect(decision.lineageParentId).toBe(run.id);
    const children = await listExperimentRuns(db, {
      lineageParentId: run.id,
    });
    expect(children.records.map((child) => child.id)).toContain(decision.id);

    // Promotion was audit-evented.
    expect(await countAuditEvents("scoring_program", challengerId, "promote")).toBeGreaterThan(0);
  });

  it("denies UPDATE and DELETE on the append-only journal", async () => {
    const db = getDatabase();
    const runs = await listExperimentRuns(db, { kind: "scorer", limit: 1 });
    expect(runs.records.length).toBeGreaterThan(0);
    const target = runs.records[0]!;

    await expect(
      db
        .update(experimentRuns)
        .set({ decision: "mutated" })
        .where(eq(experimentRuns.id, target.id)),
    ).rejects.toThrow();

    await expect(
      db.delete(experimentRuns).where(eq(experimentRuns.id, target.id)),
    ).rejects.toThrow();
  });

  it("filters the journal by kind, keep, and label substring", async () => {
    const db = getDatabase();
    const marker = randomUUID().slice(0, 8);
    await recordExperimentRun(
      db,
      { kind: "efficiency", label: `filter probe ${marker}`, keep: true },
      null,
    );
    const filtered = await listExperimentRuns(db, {
      kind: "efficiency",
      keep: true,
      label: `probe ${marker}`,
    });
    expect(filtered.total).toBe(1);
    expect(filtered.records[0]!.label).toContain(marker);
  });

});
