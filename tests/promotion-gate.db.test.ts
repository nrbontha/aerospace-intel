/**
 * DB-gated integration suite for F2: the promotion gate over the journal.
 * Exercises exactly the decision core of the promote route:
 *   - a run that does NOT qualify → gate rejected with reasons (route maps
 *     this to 409 code "conflict")
 *   - a qualifying run → champion flipped + audit event carries gated:true,
 *     experimentRunId and the metric snapshot
 *
 *   ASI_DB_TESTS=1 DATABASE_URL=postgres://... npx vitest run tests/promotion-gate.db.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditEvents,
  closeDatabase,
  getDatabase,
} from "@asi/database";
import { DEFAULT_FIT_PROGRAM } from "@asi/research/scoring-axial";
import {
  evaluatePromotionGate,
  getChampionProgram,
  promoteProgram,
  recordExperimentRun,
  upsertProgram,
} from "../packages/database/src/experiments/journal.js";
import { runMigrations } from "../packages/database/src/migrate.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const repoPath = (suffix: string) => path.join(process.cwd(), suffix);

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "") return;
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

const RUN_TAG = randomUUID().slice(0, 8);

interface GateEntry {
  programId: string | null;
  name: string;
  role: "champion" | "challenger";
  axis: string;
  rank: number | null;
  strongVsNegativeSeparation: number | null;
  vetoAudit: { passed: boolean; checked: number; failures: unknown[] };
  leakedFields: string[];
}

function entry(
  programId: string | null,
  role: "champion" | "challenger",
  separation: number,
): GateEntry {
  return {
    programId,
    name: `${role}-${programId ?? "default"}`,
    role,
    axis: "fit",
    rank: null,
    strongVsNegativeSeparation: separation,
    vetoAudit: { passed: true, checked: 3, failures: [] },
    leakedFields: [],
  };
}

describe.skipIf(!DB_TESTS_ENABLED)("promotion gate (DB)", () => {
  let priorFitChampionIds: string[] = [];

  beforeAll(async () => {
    loadDatabaseUrl();
    await runMigrations();
    const db = getDatabase();
    priorFitChampionIds = (
      await db.execute<{ id: string }>(
        sql`SELECT id FROM scoring_programs WHERE axis='fit' AND status='champion'`,
      )
    ).rows.map((row) => row.id);
  });

  afterAll(async () => {
    const db = getDatabase();
    const priorIds = new Set(priorFitChampionIds);
    const currentChampions = (
      await db.execute<{ id: string }>(
        sql`SELECT id FROM scoring_programs WHERE axis='fit' AND status='champion'`,
      )
    ).rows.map((row) => row.id);
    // Demote this run's winners before restoring the prior champions.
    for (const id of currentChampions) {
      if (!priorIds.has(id)) {
        await db.execute(
          sql`UPDATE scoring_programs SET status='challenger' WHERE id=${id}`,
        );
      }
    }
    for (const id of priorFitChampionIds) {
      const still = await db.execute(sql`SELECT 1 FROM scoring_programs WHERE id=${id}`);
      if (still.rows.length > 0) {
        await db.execute(
          sql`UPDATE scoring_programs SET status='champion' WHERE id=${id}`,
        );
      }
    }
    await closeDatabase();
  });
  it("rejects promotion when the cited run does not qualify (route 409 path)", async () => {
    const db = getDatabase();
    const registered = await upsertProgram(db, {
      name: `dbtest-gate-loser-${RUN_TAG}`,
      version: 1,
      axis: "fit",
      program: DEFAULT_FIT_PROGRAM as unknown as Record<string, unknown>,
    });

    // Run where the challenger REGRESSES against the champion baseline.
    const run = await recordExperimentRun(
      db,
      {
        kind: "scorer",
        label: `dbtest gate fail ${RUN_TAG}`,
        primaryMetricName: "strongVsNegativeSeparation",
        result: {
          entries: [
            entry(null, "champion", 0.9),
            entry(registered.id, "challenger", 0.85),
          ],
        },
      },
      null,
    );

    // This is the exact branch the route turns into 409 "conflict".
    const gate = evaluatePromotionGate(run, registered.id);
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.length).toBeGreaterThan(0);
    expect(gate.reasons.join(" ")).toMatch(/epsilon|metric/u);

    // A run that never evaluated the program also fails closed.
    const stranger = evaluatePromotionGate(run, randomUUID());
    expect(stranger.allowed).toBe(false);
    expect(stranger.reasons.join(" ")).toMatch(/not a challenger evaluated by this run/u);
  });

  it("promotes with a passing run and journals gated:true + metric snapshot", async () => {
    const db = getDatabase();
    const registered = await upsertProgram(db, {
      name: `dbtest-gate-winner-${RUN_TAG}`,
      version: 1,
      axis: "fit",
      program: DEFAULT_FIT_PROGRAM as unknown as Record<string, unknown>,
    });

    const run = await recordExperimentRun(
      db,
      {
        kind: "scorer",
        label: `dbtest gate pass ${RUN_TAG}`,
        primaryMetricName: "strongVsNegativeSeparation",
        result: {
          entries: [
            entry(null, "champion", 0.7),
            entry(registered.id, "challenger", 0.85),
          ],
        },
      },
      null,
    );

    const gate = evaluatePromotionGate(run, registered.id);
    expect(gate.allowed).toBe(true);
    expect(gate.metricSnapshot).toEqual({
      challengerMetric: 0.85,
      championMetric: 0.7,
      gain: expect.closeTo(0.15, 5),
    });

    // Route continuation on success: flip the champion with gate evidence.
    const promoted = await promoteProgram(
      db,
      registered.id,
      `keep decision on run ${run.id}`,
      null,
      {
        gated: true,
        experimentRunId: run.id,
        metricSnapshot: gate.metricSnapshot,
      },
    );
    expect(promoted.status).toBe("champion");
    expect((await getChampionProgram(db, "fit"))?.id).toBe(registered.id);

    const [audit] = await db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "scoring_program"), eq(auditEvents.entityId, registered.id), eq(auditEvents.action, "promote")))
      .limit(1);
    expect(audit?.metadata).toMatchObject({
      gated: true,
      experimentRunId: run.id,
      metricSnapshot: { gain: expect.closeTo(0.15, 5) },
    });
  });
});
