import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { closeDatabase as closePackageDatabase } from "@asi/database";
import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import { insertFaaReviewModelUsageReceipt } from "../packages/database/src/faa-ensemble/records.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  faaEnsembleEvaluations,
  faaEnsembleResults,
  faaReviewModelUsage,
  modelUsage,
  researchRuns,
  signalReviewState,
  sourceSignals,
} from "../packages/database/src/schema.js";
import { claimSignalReviews } from "../packages/database/src/signal-reviews.js";
import { getDailySpendUsd } from "../packages/research/src/campaigns/budget.js";
import {
  reconcileCurrentReviewInputs,
  resolveEnsembleConfig,
  runJevReviews,
  type JevLadderCaller,
} from "../packages/research/src/faa-ensemble/runner.js";

const execFileAsync = promisify(execFile);
const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const CONTAINER = "asi-faa-review-spend-scratch";
const IMAGE = "postgres:18-alpine";
const MIGRATIONS_DIRECTORY = path.join(process.cwd(), "migrations");

const SAFE_SCRATCH_DATABASE = /^asi_faa_review_spend_[0-9a-f]{32}$/u;

function nativeDatabaseUrls(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): { adminDatabaseUrl: string; scratchDatabaseUrl: string } {
  let adminUrl: URL;
  try {
    adminUrl = new URL(adminDatabaseUrl);
  } catch {
    throw new Error(
      "ASI_TEST_DATABASE_ADMIN_URL must be a valid PostgreSQL URL",
    );
  }
  if (
    adminUrl.protocol !== "postgres:" &&
    adminUrl.protocol !== "postgresql:"
  ) {
    throw new Error(
      "ASI_TEST_DATABASE_ADMIN_URL must use postgres: or postgresql:",
    );
  }
  const hostname = adminUrl.hostname.toLowerCase();
  if (
    hostname !== "127.0.0.1" &&
    hostname !== "localhost" &&
    hostname !== "::1" &&
    hostname !== "[::1]"
  ) {
    throw new Error(
      "ASI_TEST_DATABASE_ADMIN_URL must point to a loopback PostgreSQL host",
    );
  }
  if (!SAFE_SCRATCH_DATABASE.test(scratchDatabase)) {
    throw new Error(
      `refusing unsafe scratch database name: ${scratchDatabase}`,
    );
  }

  const scratchUrl = new URL(adminUrl);
  scratchUrl.pathname = `/${scratchDatabase}`;
  return {
    adminDatabaseUrl: adminUrl.toString(),
    scratchDatabaseUrl: scratchUrl.toString(),
  };
}

function quotedScratchDatabase(scratchDatabase: string): string {
  if (!SAFE_SCRATCH_DATABASE.test(scratchDatabase)) {
    throw new Error(
      `refusing unsafe scratch database name: ${scratchDatabase}`,
    );
  }
  return `"${scratchDatabase}"`;
}

async function createNativeScratchDatabase(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): Promise<string> {
  const urls = nativeDatabaseUrls(adminDatabaseUrl, scratchDatabase);
  const pool = new Pool({ connectionString: urls.adminDatabaseUrl });
  try {
    await pool.query(
      `CREATE DATABASE ${quotedScratchDatabase(scratchDatabase)}`,
    );
  } finally {
    await pool.end();
  }
  return urls.scratchDatabaseUrl;
}

async function dropNativeScratchDatabase(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): Promise<void> {
  const urls = nativeDatabaseUrls(adminDatabaseUrl, scratchDatabase);
  const pool = new Pool({ connectionString: urls.adminDatabaseUrl });
  try {
    await pool.query(
      `DROP DATABASE IF EXISTS ${quotedScratchDatabase(scratchDatabase)} WITH (FORCE)`,
    );
  } finally {
    await pool.end();
  }
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout.trim();
}

async function waitForPostgres(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await docker([
        "exec",
        CONTAINER,
        "pg_isready",
        "-U",
        "asi",
        "-d",
        "asi_app",
      ]);
      return;
    } catch {
      // PostgreSQL is an external process; readiness has no deterministic clock.
      await delay(500);
    }
  }
  throw new Error("scratch postgres never became ready");
}

async function installLegacySchema(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public."_asi_migrations" (
        migration_name text PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const names = (await readdir(MIGRATIONS_DIRECTORY))
      .filter((name) => /^00(?:0[0-9]|1[0-3])_.*\.sql$/u.test(name))
      .sort();
    for (const name of names) {
      const migration = await readFile(
        path.join(MIGRATIONS_DIRECTORY, name),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(
        'INSERT INTO public."_asi_migrations" (migration_name, checksum) VALUES ($1, $2)',
        [name, createHash("sha256").update(migration).digest("hex")],
      );
    }
  } finally {
    await pool.end();
  }
}

function reviewEvidence() {
  return {
    version: "signal_research_v1",
    identity: {
      status: "verified",
      verifiedDomain: "acme.example",
      legalName: "Acme Aero LLC",
      proofEvidenceIds: ["domain-evidence"],
    },
    website: {
      status: "supported",
      offering: "products_menu",
      excerpts: "Acme manufactures the AX-10 actuator.",
      productHints: ["AX-10 actuator"],
      namedProductEvidenceIds: ["product-evidence"],
    },
    ownership: {
      status: "unknown",
      conflicting: false,
      currentness: "unknown",
      owner: null,
      year: null,
      supportEvidenceIds: [],
    },
    size: {
      status: "unknown",
      assessment: "unknown",
      conflicting: false,
      indicators: [],
    },
    headquarters: {
      status: "unknown",
      city: null,
      state: null,
      country: null,
      supportEvidenceIds: [],
    },
    missingFacts: ["ownership", "size", "headquarters"],
    checkedSources: [],
    evidenceRefs: [
      {
        evidenceId: "domain-evidence",
        stage: "domain",
        url: "https://acme.example",
        title: "Acme",
        quote: "Acme Aero LLC",
        contentSha256: "domain-sha",
        retrievedAt: "2026-09-28T00:00:00Z",
        sourceKind: "official_site",
        firstParty: true,
        role: "support",
      },
      {
        evidenceId: "product-evidence",
        stage: "website",
        url: "https://acme.example/products",
        title: "Products",
        quote: "Acme manufactures the AX-10 actuator.",
        contentSha256: "product-sha",
        retrievedAt: "2026-09-28T00:00:00Z",
        sourceKind: "official_site",
        firstParty: true,
        role: "support",
      },
    ],
  };
}

async function createReviewSignal(label: string): Promise<string> {
  const id = randomUUID();
  const db = getDatabase();
  await db.insert(sourceSignals).values({
    id,
    sourceKey: "faa_pma_database",
    sourceLocator: `faa-review-spend:${label}`,
    sourceFingerprint: `faa-review-spend:${label}:${id}`,
    rawName: `Acme Aero ${label}`,
    rawDomain: "acme.example",
    country: "US",
  });
  await db.insert(signalReviewState).values({
    signalId: id,
    sourceRevision: 0,
    phase: "jev",
    researchEvidence: reviewEvidence(),
    nextAttemptAt: new Date(0),
  });
  return id;
}

function completeResearchLadder(costUsd: number): JevLadderCaller {
  return async (request) => {
    if (request.rung === "r1") {
      return {
        answers: { manufacturer: { type: "noul", noul: 0.9 } },
        costUsd,
        model: "typesafe/jev-returned",
      };
    }
    if (request.rung === "r2") {
      return {
        answers: {
          product_vs_process: {
            type: "choice",
            choice: "product",
            confidence: 0.8,
          },
        },
        costUsd: null,
        model: "typesafe/jev-returned",
      };
    }
    if (request.rung === "r3") {
      return {
        answers: { oversize: { type: "noul", noul: 0.1 } },
        costUsd: null,
        model: "typesafe/jev-returned",
      };
    }
    return {
      answers: {
        disposition: {
          type: "choice",
          choice: "research",
          confidence: 0.8,
        },
      },
      costUsd: null,
      model: "typesafe/jev-returned",
    };
  };
}

describe.skipIf(!DB_TESTS_ENABLED)(
  "FAA review observed-spend ledger (isolated DB)",
  () => {
    const legacySignalId = randomUUID();
    const legacyEvaluations = [
      {
        id: randomUUID(),
        configuredModel: "typesafe/jev-legacy-precise",
        inputHash: "legacy-precise-input",
        costUsd: "0.123456789123456789",
      },
      {
        id: randomUUID(),
        configuredModel: "typesafe/jev-legacy-tiny",
        inputHash: "legacy-tiny-input",
        costUsd: "0.000000000000000001",
      },
    ] as const;
    const legacyObservedAt = new Date("2039-12-31T12:00:00.000Z");
    let legacyReceiptMetadataBeforeRepair: Record<string, unknown>[] = [];
    let databaseUrl = "";
    let nativeAdminUrl: string | undefined;
    let nativeScratchDatabase: string | undefined;
    let originalDatabaseUrl: string | undefined;
    let hadOriginalDatabaseUrl = false;

    beforeAll(async () => {
      hadOriginalDatabaseUrl = Object.prototype.hasOwnProperty.call(
        process.env,
        "DATABASE_URL",
      );
      originalDatabaseUrl = process.env.DATABASE_URL;
      await Promise.allSettled([closeDatabase(), closePackageDatabase()]);

      nativeAdminUrl = process.env.ASI_TEST_DATABASE_ADMIN_URL;
      if (nativeAdminUrl !== undefined) {
        nativeScratchDatabase = `asi_faa_review_spend_${randomUUID().replaceAll("-", "")}`;
        databaseUrl = await createNativeScratchDatabase(
          nativeAdminUrl,
          nativeScratchDatabase,
        );
        process.env.DATABASE_URL = databaseUrl;
      } else {
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
        const assigned = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/u.exec(portMapping);
        if (assigned?.[1] === undefined) {
          throw new Error(
            `could not parse docker port mapping: ${portMapping}`,
          );
        }
        databaseUrl = `postgres://asi:test@127.0.0.1:${assigned[1]}/asi_app`;
        process.env.DATABASE_URL = databaseUrl;
        await waitForPostgres();
      }

      await installLegacySchema(databaseUrl);

      const pool = new Pool({ connectionString: databaseUrl });
      try {
        await pool.query(
          `INSERT INTO source_signals
             (id, source_key, source_locator, source_fingerprint, raw_name)
           VALUES ($1, 'faa_pma_database', 'legacy-cost', $2, 'Legacy Cost')`,
          [legacySignalId, `legacy-cost:${legacySignalId}`],
        );
        for (const evaluation of legacyEvaluations) {
          await pool.query(
            `INSERT INTO faa_ensemble_evaluations
               (id, signal_id, model_id, prompt_version, input_hash, cost_usd,
                created_at, updated_at)
             VALUES ($1, $2, $3, 'jev-ladder-r1', $4, $5::numeric, $6, $6)`,
            [
              evaluation.id,
              legacySignalId,
              evaluation.configuredModel,
              evaluation.inputHash,
              evaluation.costUsd,
              legacyObservedAt,
            ],
          );
        }

        // Apply 0014 separately so provenance can be compared across the
        // precision repair; the migration runner still advances the scratch
        // database from the legacy 0000..0013 baseline.
        const legacyMigrationName = "0014_review_model_usage.sql";
        const legacyMigration = await readFile(
          path.join(MIGRATIONS_DIRECTORY, legacyMigrationName),
          "utf8",
        );
        await pool.query(legacyMigration);
        await pool.query(
          'INSERT INTO public."_asi_migrations" (migration_name, checksum) VALUES ($1, $2)',
          [
            legacyMigrationName,
            createHash("sha256").update(legacyMigration).digest("hex"),
          ],
        );

        const roundedReceipts = await pool.query<{
          metadata: Record<string, unknown>;
          exact_cost: boolean;
        }>(`
          SELECT to_jsonb(receipt) - 'cost_usd' AS metadata,
                 receipt.cost_usd IS NOT DISTINCT FROM evaluation.cost_usd
                   AS exact_cost
          FROM faa_review_model_usage AS receipt
          JOIN faa_ensemble_evaluations AS evaluation
            ON evaluation.id = receipt.legacy_evaluation_id
          ORDER BY receipt.legacy_evaluation_id
        `);
        expect(roundedReceipts.rows).toHaveLength(legacyEvaluations.length);
        expect(
          roundedReceipts.rows.map(({ exact_cost }) => exact_cost),
        ).toEqual(legacyEvaluations.map(() => false));
        legacyReceiptMetadataBeforeRepair = roundedReceipts.rows.map(
          ({ metadata }) => metadata,
        );
      } finally {
        await pool.end();
      }

      await runMigrations();
    }, 180_000);

    beforeEach(async () => {
      const db = getDatabase();
      // Generic usage is immutable; spend assertions compare per-case deltas.
      await db
        .delete(faaReviewModelUsage)
        .where(sql`${faaReviewModelUsage.legacyEvaluationId} IS NULL`);
      await db
        .delete(sourceSignals)
        .where(sql`${sourceSignals.id} <> ${legacySignalId}`);
      await db
        .update(sourceSignals)
        .set({
          status: "quarantined",
          qualification: { reason: "legacy_spend_fixture" },
        })
        .where(eq(sourceSignals.id, legacySignalId));
    });

    afterAll(async () => {
      try {
        await Promise.allSettled([closeDatabase(), closePackageDatabase()]);
        if (
          nativeAdminUrl !== undefined &&
          nativeScratchDatabase !== undefined
        ) {
          await dropNativeScratchDatabase(
            nativeAdminUrl,
            nativeScratchDatabase,
          );
        } else if (nativeAdminUrl === undefined) {
          await docker(["rm", "-f", CONTAINER]).catch(() => undefined);
        }
      } finally {
        if (hadOriginalDatabaseUrl && originalDatabaseUrl !== undefined) {
          process.env.DATABASE_URL = originalDatabaseUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    });

    it("restores exact legacy costs without changing provenance or duplicating receipts", async () => {
      const repairedReceiptQuery = sql`
        SELECT to_jsonb(receipt) - 'cost_usd' AS metadata,
               receipt.cost_usd IS NOT DISTINCT FROM evaluation.cost_usd
                 AS "exactCost",
               receipt.cost_usd > 0 AS "nonzeroCost"
        FROM faa_review_model_usage AS receipt
        JOIN faa_ensemble_evaluations AS evaluation
          ON evaluation.id = receipt.legacy_evaluation_id
        ORDER BY receipt.legacy_evaluation_id
      `;
      const repairedReceipts = await getDatabase().execute<{
        metadata: Record<string, unknown>;
        exactCost: boolean;
        nonzeroCost: boolean;
      }>(repairedReceiptQuery);
      const sourceCosts = await getDatabase().execute<{
        complete: boolean;
        exact: boolean;
        nonzero: boolean;
      }>(sql`
        SELECT count(*) = ${legacyEvaluations.length} AS complete,
               bool_and(cost_usd > 0) AS nonzero,
               bool_and(
                 (
                   id = CAST(${legacyEvaluations[0].id} AS uuid)
                   AND cost_usd = CAST(${legacyEvaluations[0].costUsd} AS numeric)
                 )
                 OR (
                   id = CAST(${legacyEvaluations[1].id} AS uuid)
                   AND cost_usd = CAST(${legacyEvaluations[1].costUsd} AS numeric)
                 )
               ) AS exact
        FROM faa_ensemble_evaluations
        WHERE id IN (
          CAST(${legacyEvaluations[0].id} AS uuid),
          CAST(${legacyEvaluations[1].id} AS uuid)
        )
      `);
      expect(sourceCosts.rows).toEqual([
        { complete: true, exact: true, nonzero: true },
      ]);

      expect(repairedReceipts.rows).toHaveLength(legacyEvaluations.length);
      expect(repairedReceipts.rows.map(({ metadata }) => metadata)).toEqual(
        legacyReceiptMetadataBeforeRepair,
      );
      expect(
        repairedReceipts.rows.map(({ exactCost, nonzeroCost }) => ({
          exactCost,
          nonzeroCost,
        })),
      ).toEqual(
        legacyEvaluations.map(() => ({ exactCost: true, nonzeroCost: true })),
      );
      expect(repairedReceipts.rows.map(({ metadata }) => metadata)).toEqual(
        expect.arrayContaining(
          legacyEvaluations.map((evaluation) =>
            expect.objectContaining({
              source_signal_id: legacySignalId,
              configured_model: evaluation.configuredModel,
              returned_model: null,
              phase: "jev",
              rung: "r1",
              prompt_version: "jev-ladder-r1",
              input_hash: evaluation.inputHash,
              legacy_evaluation_id: evaluation.id,
            }),
          ),
        ),
      );
      expect(
        await getDailySpendUsd(legacyObservedAt, getDatabase()),
      ).toBeGreaterThan(0);

      const precisionMigration = await readFile(
        path.join(MIGRATIONS_DIRECTORY, "0015_review_usage_precision.sql"),
        "utf8",
      );
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        await pool.query(precisionMigration);
      } finally {
        await pool.end();
      }
      const repeatedRepair = await getDatabase().execute<{
        metadata: Record<string, unknown>;
        exactCost: boolean;
        nonzeroCost: boolean;
      }>(repairedReceiptQuery);
      expect(repeatedRepair.rows).toEqual(repairedReceipts.rows);
    });

    it("retains a first-rung receipt when a later rung fails and counts retries", async () => {
      const signalId = await createReviewSignal("partial");
      let calls = 0;
      const first = await runJevReviews(
        getDatabase(),
        { limit: 1, concurrency: 1 },
        {
          config: {
            ...resolveEnsembleConfig({}),
            concurrency: 1,
            requestDelayMs: 0,
          },
          callJev: async (request) => {
            calls += 1;
            if (calls === 1) {
              expect(request.rung).toBe("r1");
              return {
                answers: { manufacturer: { type: "noul", noul: 0.9 } },
                costUsd: 0.1234,
                model: "typesafe/jev-returned",
              };
            }
            throw new Error("controlled later-rung failure");
          },
          getDailySpendUsd: async () => 0,
          dailyBudgetCapUsd: () => 1,
        },
      );
      expect(first).toMatchObject({
        screened: 0,
        errors: 1,
        stale: 0,
        costUsd: 0.1234,
      });

      const [failedState] = await getDatabase()
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(failedState).toMatchObject({
        phase: "jev",
        lastError: "controlled later-rung failure",
        inputManifest: {
          evidence: { sourceResearchStatus: "complete" },
        },
      });
      if (failedState?.inputHash == null) {
        throw new Error("Failed JEv attempt did not retain current input");
      }

      await getDatabase()
        .update(signalReviewState)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(signalReviewState.signalId, signalId));
      calls = 0;
      const retry = await runJevReviews(
        getDatabase(),
        { limit: 1, concurrency: 1 },
        {
          config: {
            ...resolveEnsembleConfig({}),
            concurrency: 1,
            requestDelayMs: 0,
          },
          callJev: async () => {
            calls += 1;
            if (calls === 1) {
              return {
                answers: { manufacturer: { type: "noul", noul: 0.9 } },
                costUsd: 0.05,
                model: "typesafe/jev-returned",
              };
            }
            throw new Error("controlled retry failure");
          },
          getDailySpendUsd: async () => 0,
          dailyBudgetCapUsd: () => 1,
        },
      );
      expect(retry.costUsd).toBeCloseTo(0.05, 8);
      const [retriedState] = await getDatabase()
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(retriedState).toMatchObject({
        phase: "jev",
        lastError: "controlled retry failure",
        inputHash: failedState.inputHash,
        inputManifest: {
          evidence: { sourceResearchStatus: "complete" },
        },
      });

      const receipts = await getDatabase()
        .select({ costUsd: faaReviewModelUsage.costUsd })
        .from(faaReviewModelUsage)
        .where(eq(faaReviewModelUsage.sourceSignalId, signalId));
      const evaluations = await getDatabase()
        .select({ id: faaEnsembleEvaluations.id })
        .from(faaEnsembleEvaluations)
        .where(eq(faaEnsembleEvaluations.signalId, signalId));
      expect(receipts.map(({ costUsd }) => Number(costUsd)).sort()).toEqual([
        0.05, 0.1234,
      ]);
      expect(evaluations).toEqual([]);
    });

    it("defers a real-client JEv quota response without consuming an attempt or verdict", async () => {
      const db = getDatabase();
      const signalId = await createReviewSignal("jev-quota");
      const config = {
        ...resolveEnsembleConfig({}),
        concurrency: 1,
        requestDelayMs: 0,
      };
      let providerResponses = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        expect(String(input)).toBe("https://openrouter.ai/api/alpha/decisions");
        providerResponses += 1;
        if (providerResponses === 1) {
          return new Response(
            JSON.stringify({
              model: "typesafe/jev-returned",
              answers: { manufacturer: { type: "noul", noul: 0.9 } },
              usage: { cost: 0.1234 },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              code: 403,
            },
          }),
          { status: 403 },
        );
      };

      let summary;
      try {
        summary = await runJevReviews(
          db,
          { limit: 1, concurrency: 1 },
          {
            config,
            apiKey: "controlled-test-key",
            getDailySpendUsd: async () => 0,
            dailyBudgetCapUsd: () => 1,
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(providerResponses).toBe(2);
      expect(summary).toMatchObject({
        screened: 0,
        costUsd: 0.1234,
        deferred: 1,
        errors: 0,
        stale: 0,
      });
      const [state] = await db
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(state).toMatchObject({
        phase: "jev",
        attemptCount: 0,
        jevEvaluationId: null,
      });
      const receipts = await db
        .select()
        .from(faaReviewModelUsage)
        .where(eq(faaReviewModelUsage.sourceSignalId, signalId));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        returnedModel: "typesafe/jev-returned",
        phase: "jev",
        rung: "r1",
      });
      expect(Number(receipts[0]!.costUsd)).toBeCloseTo(0.1234, 12);
      expect(
        await db
          .select({ id: faaEnsembleEvaluations.id })
          .from(faaEnsembleEvaluations)
          .where(eq(faaEnsembleEvaluations.signalId, signalId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: faaEnsembleResults.id })
          .from(faaEnsembleResults)
          .where(eq(faaEnsembleResults.signalId, signalId)),
      ).toEqual([]);
    });

    it("does not preempt live source research before provisional JEv", async () => {
      const db = getDatabase();
      const signalId = randomUUID();
      await db.insert(sourceSignals).values({
        id: signalId,
        sourceKey: "faa_pma_database",
        sourceLocator: `faa-review-spend:leased-research:${signalId}`,
        sourceFingerprint: `faa-review-spend:leased-research:${signalId}`,
        rawName: "Leased Primary Record",
        country: "US",
      });
      await db.insert(signalReviewState).values({
        signalId,
        sourceRevision: 0,
        phase: "research",
        researchEvidence: {},
        nextAttemptAt: new Date(0),
        lastError: "domain_provider_error: credits limit reached",
      });
      const [claim] = await claimSignalReviews(db, {
        phase: "research",
        limit: 1,
        leaseSeconds: 600,
      });
      if (claim === undefined) {
        throw new Error("Research claim was not leased");
      }

      const whileLive = await reconcileCurrentReviewInputs(db, {
        sourceLimit: 10,
      });
      expect(whileLive.inputContractChanges).toBe(0);
      const [liveState] = await db
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(liveState).toMatchObject({
        phase: "research",
        leaseToken: claim.leaseToken,
      });

      await db
        .update(signalReviewState)
        .set({ leaseExpiresAt: new Date(0) })
        .where(eq(signalReviewState.signalId, signalId));
      const afterExpiry = await reconcileCurrentReviewInputs(db, {
        sourceLimit: 10,
      });
      expect(afterExpiry.inputContractChanges).toBe(1);
      const [expiredState] = await db
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(expiredState).toMatchObject({
        phase: "jev",
        leaseToken: null,
        leaseExpiresAt: null,
        lastResearchOutcome: {
          status: "unavailable",
          reason: "domain_provider_error: credits limit reached",
        },
      });
    });

    it("screens a provider-blocked primary record while preserving its research retry", async () => {
      const db = getDatabase();
      const signalId = randomUUID();
      const retryAt = new Date(Date.now() + 60 * 60_000);
      await db.insert(sourceSignals).values({
        id: signalId,
        sourceKey: "faa_pma_database",
        sourceLocator: `faa-review-spend:provider-blocked:${signalId}`,
        sourceFingerprint: `faa-review-spend:provider-blocked:${signalId}`,
        rawName: "Precision Devices Laboratory Inc",
        country: "US",
      });
      await db.insert(signalReviewState).values({
        signalId,
        sourceRevision: 0,
        phase: "research",
        researchEvidence: {},
        nextAttemptAt: retryAt,
        lastError: "domain_provider_error: credits limit reached",
      });

      const summary = await runJevReviews(
        db,
        { limit: 1, concurrency: 1 },
        {
          config: {
            ...resolveEnsembleConfig({}),
            concurrency: 1,
            requestDelayMs: 0,
          },
          callJev: completeResearchLadder(0.01),
          getDailySpendUsd: async () => 0,
          dailyBudgetCapUsd: () => 1,
        },
      );

      expect(summary).toMatchObject({
        screened: 1,
        research: 1,
        errors: 0,
      });
      const [state] = await db
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(state).toMatchObject({
        phase: "muse",
        researchDueAt: retryAt,
        lastResearchOutcome: {
          status: "unavailable",
          reason: "domain_provider_error: credits limit reached",
        },
        inputManifest: {
          evidence: {
            sourceResearchStatus: "unavailable",
          },
        },
      });
      if (state?.jevEvaluationId == null) {
        throw new Error("Provisional review did not publish terminal triage");
      }
      const [terminal] = await db
        .select({ parsed: faaEnsembleEvaluations.parsed })
        .from(faaEnsembleEvaluations)
        .where(eq(faaEnsembleEvaluations.id, state.jevEvaluationId));
      expect(terminal?.parsed).toMatchObject({
        decision: "research",
        researchPriority: 2,
        reasonCodes: expect.arrayContaining([
          "name_heuristic_unsubstantiated",
          "source_research_unavailable",
        ]),
        gaps: expect.arrayContaining([
          expect.objectContaining({ id: "source_access.resume" }),
        ]),
      });
    });
    it("provisionally screens unverified intake context without bypassing review guards", async () => {
      const db = getDatabase();
      const intakeId = randomUUID();
      const humanId = randomUUID();
      const restrictedId = randomUUID();
      await db.insert(sourceSignals).values([
        {
          id: intakeId,
          sourceKey: "investor_reference_intake",
          sourceLocator: `investor-intake://${intakeId}`,
          sourceFingerprint: `faa-review-spend:intake:${intakeId}`,
          rawName: "Unverified Intake Components",
          rawDomain: "unverified-intake.example",
          country: "US",
        },
        {
          id: humanId,
          sourceKey: "investor_reference_intake",
          sourceLocator: `investor-intake://${humanId}`,
          sourceFingerprint: `faa-review-spend:human-intake:${humanId}`,
          rawName: "Human Reviewed Intake",
          qualification: { humanDecision: "reject" },
        },
        {
          id: restrictedId,
          sourceKey: "investor_reference_intake",
          sourceLocator: `investor-intake://${restrictedId}`,
          sourceFingerprint: `faa-review-spend:restricted-intake:${restrictedId}`,
          rawName: "Restricted Intake",
          status: "quarantined",
          qualification: { reason: "restricted_access" },
        },
      ]);

      const baseLadder = completeResearchLadder(0.01);
      const processOnlyLadder: JevLadderCaller = async (request) =>
        request.rung === "r2"
          ? {
              answers: {
                product_vs_process: {
                  type: "choice",
                  choice: "process",
                  confidence: 0.8,
                },
              },
              costUsd: null,
              model: "typesafe/jev-test",
            }
          : baseLadder(request);

      const summary = await runJevReviews(
        db,
        { limit: 1, concurrency: 1 },
        {
          config: {
            ...resolveEnsembleConfig({}),
            concurrency: 1,
            requestDelayMs: 0,
          },
          callJev: processOnlyLadder,
          getDailySpendUsd: async () => 0,
          dailyBudgetCapUsd: () => 1,
        },
      );
      expect(summary).toMatchObject({ screened: 1, research: 1, errors: 0 });

      const [intakeState] = await db
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, intakeId));
      expect(intakeState).toMatchObject({
        phase: "muse",
        inputManifest: {
          evidence: {
            sourceKey: "investor_reference_intake",
            sourceRecordKind: "source_records",
            sourceResearchStatus: "incomplete",
            sourcedSupport: {
              identity: false,
              product: false,
              ownership: false,
              size: false,
              headquarters: false,
            },
          },
        },
      });
      if (intakeState?.jevEvaluationId == null) {
        throw new Error("Intake screening did not publish terminal triage");
      }
      const [terminal] = await db
        .select({ parsed: faaEnsembleEvaluations.parsed })
        .from(faaEnsembleEvaluations)
        .where(eq(faaEnsembleEvaluations.id, intakeState.jevEvaluationId));
      expect(terminal?.parsed).toMatchObject({
        decision: "research",
        acquisitionReadiness: "needs_research",
        productFit: "unknown",
        researchPriority: 3,
        observations: expect.arrayContaining([
          expect.objectContaining({
            kind: "source_context",
            reasonCode: "unverified_source_context_not_proof",
          }),
        ]),
        gaps: expect.arrayContaining([
          expect.objectContaining({ id: "identity.verification" }),
          expect.objectContaining({ id: "product_fit.named_products" }),
          expect.objectContaining({ id: "ownership.current_control" }),
        ]),
      });
      expect(terminal?.parsed).not.toMatchObject({
        observations: expect.arrayContaining([
          expect.objectContaining({ kind: "source_supported_fact" }),
        ]),
      });

      expect(
        await db
          .select({ signalId: signalReviewState.signalId })
          .from(signalReviewState)
          .where(eq(signalReviewState.signalId, humanId)),
      ).toEqual([]);
      expect(
        await db
          .select({ signalId: signalReviewState.signalId })
          .from(signalReviewState)
          .where(eq(signalReviewState.signalId, restrictedId)),
      ).toEqual([]);
    });

    it("keeps a fenced charge without publishing an evaluation", async () => {
      const signalId = await createReviewSignal("fenced");
      const db = getDatabase();
      const summary = await runJevReviews(
        db,
        { limit: 1, concurrency: 1 },
        {
          config: {
            ...resolveEnsembleConfig({}),
            concurrency: 1,
            requestDelayMs: 0,
          },
          callJev: async (request) => {
            await db
              .update(signalReviewState)
              .set({
                leaseToken: randomUUID(),
                leaseExpiresAt: new Date(Date.now() + 60_000),
              })
              .where(eq(signalReviewState.signalId, signalId));
            return completeResearchLadder(0.2)(request);
          },
          getDailySpendUsd: async () => 0,
          dailyBudgetCapUsd: () => 1,
        },
      );

      expect(summary).toMatchObject({
        screened: 0,
        stale: 1,
        errors: 0,
        costUsd: 0.2,
      });
      expect(
        await db
          .select({ id: faaReviewModelUsage.id })
          .from(faaReviewModelUsage)
          .where(eq(faaReviewModelUsage.sourceSignalId, signalId)),
      ).toHaveLength(4);
      expect(
        await db
          .select({ id: faaEnsembleEvaluations.id })
          .from(faaEnsembleEvaluations)
          .where(eq(faaEnsembleEvaluations.signalId, signalId)),
      ).toEqual([]);
    });


    it("does not count a successful evaluation again and uses exact UTC bounds", async () => {
      const db = getDatabase();
      const spendBefore = await getDailySpendUsd(new Date(), db);
      const successSignalId = await createReviewSignal("success");
      const summary = await runJevReviews(
        db,
        { limit: 1, concurrency: 1 },
        {
          config: {
            ...resolveEnsembleConfig({}),
            concurrency: 1,
            requestDelayMs: 0,
          },
          callJev: completeResearchLadder(0.2),
          getDailySpendUsd: async () => 0,
          dailyBudgetCapUsd: () => 1,
        },
      );
      expect(summary).toMatchObject({ screened: 1, costUsd: 0.2 });

      const [run] = await db
        .insert(researchRuns)
        .values({
          targetType: "company",
          objective: "FAA spend test",
          promptVersion: "faa-spend-test",
        })
        .returning({ id: researchRuns.id });
      await db.insert(modelUsage).values({
        researchRunId: run!.id,
        sequence: 0,
        provider: "test",
        model: "generic-test-model",
        status: "succeeded",
        promptSha256: "a".repeat(64),
        request: {},
        costUsd: "0.30000000",
      });

      const now = new Date();
      const recorded = await getDailySpendUsd(now, db);
      // The successful evaluation is diagnostic, not a second charge.
      expect(recorded - spendBefore).toBeCloseTo(0.2 + 0.3, 8);
      const successfulEvaluationCost = await db.execute<{ total: string }>(sql`
        SELECT COALESCE(sum(cost_usd), 0)::text AS total
        FROM faa_ensemble_evaluations
        WHERE signal_id = ${successSignalId}
      `);
      expect(Number(successfulEvaluationCost.rows[0]!.total)).toBeCloseTo(
        0.2,
        8,
      );

      const utcSignalId = await createReviewSignal("utc");
      const dayStart = new Date("2040-01-02T00:00:00.000Z");
      await insertFaaReviewModelUsageReceipt(db, {
        id: randomUUID(),
        sourceSignalId: utcSignalId,
        configuredModel: "utc-test",
        returnedModel: "utc-test",
        phase: "jev",
        rung: "r1",
        promptVersion: "utc-start",
        inputHash: "utc-input",
        costUsd: "0.11",
        observedAt: dayStart,
      });
      await insertFaaReviewModelUsageReceipt(db, {
        id: randomUUID(),
        sourceSignalId: utcSignalId,
        configuredModel: "utc-test",
        returnedModel: "utc-test",
        phase: "jev",
        rung: "r1",
        promptVersion: "utc-end",
        inputHash: "utc-input",
        costUsd: "0.22",
        observedAt: new Date("2040-01-03T00:00:00.000Z"),
      });
      expect(await getDailySpendUsd(dayStart, db)).toBeCloseTo(0.11, 8);
    });

    it("persists an exact high-precision charge once when retried", async () => {
      const signalId = await createReviewSignal("idempotent");
      const id = randomUUID();
      const costUsd = "0.000000000123456789";
      const observedAt = new Date("2040-01-04T05:06:07.890Z");
      const input = {
        id,
        sourceSignalId: signalId,
        configuredModel: "typesafe/jev-idempotent",
        returnedModel: "typesafe/jev-idempotent",
        phase: "jev" as const,
        rung: "r1",
        promptVersion: "jev-ladder-r1",
        inputHash: "idempotent-input",
        costUsd,
        observedAt,
      };
      await insertFaaReviewModelUsageReceipt(getDatabase(), input);
      await insertFaaReviewModelUsageReceipt(getDatabase(), input);

      const rows = await getDatabase()
        .select({
          id: faaReviewModelUsage.id,
          sourceSignalId: faaReviewModelUsage.sourceSignalId,
          configuredModel: faaReviewModelUsage.configuredModel,
          returnedModel: faaReviewModelUsage.returnedModel,
          phase: faaReviewModelUsage.phase,
          rung: faaReviewModelUsage.rung,
          promptVersion: faaReviewModelUsage.promptVersion,
          inputHash: faaReviewModelUsage.inputHash,
          legacyEvaluationId: faaReviewModelUsage.legacyEvaluationId,
          observedAt: faaReviewModelUsage.observedAt,
        })
        .from(faaReviewModelUsage)
        .where(eq(faaReviewModelUsage.id, id));
      expect(rows).toEqual([
        {
          id,
          sourceSignalId: signalId,
          configuredModel: input.configuredModel,
          returnedModel: input.returnedModel,
          phase: input.phase,
          rung: input.rung,
          promptVersion: input.promptVersion,
          inputHash: input.inputHash,
          legacyEvaluationId: null,
          observedAt,
        },
      ]);
      const exactCost = await getDatabase().execute<{
        exactCost: boolean;
        nonzeroCost: boolean;
      }>(sql`
        SELECT cost_usd = CAST(${costUsd} AS numeric) AS "exactCost",
               cost_usd > 0 AS "nonzeroCost"
        FROM faa_review_model_usage
        WHERE id = ${id}
      `);
      expect(exactCost.rows).toEqual([{ exactCost: true, nonzeroCost: true }]);
    });

    it("retains an observed receipt when its source is deleted", async () => {
      const db = getDatabase();
      const signalId = await createReviewSignal("source-deletion");
      const receiptId = randomUUID();
      await insertFaaReviewModelUsageReceipt(db, {
        id: receiptId,
        sourceSignalId: signalId,
        configuredModel: "typesafe/jev-retained",
        returnedModel: "typesafe/jev-retained",
        phase: "jev",
        rung: "r1",
        promptVersion: "jev-ladder-r1",
        inputHash: "retained-input",
        costUsd: "0.09",
      });

      await db.delete(sourceSignals).where(eq(sourceSignals.id, signalId));

      const rows = await db
        .select({
          id: faaReviewModelUsage.id,
          sourceSignalId: faaReviewModelUsage.sourceSignalId,
          costUsd: faaReviewModelUsage.costUsd,
        })
        .from(faaReviewModelUsage)
        .where(eq(faaReviewModelUsage.id, receiptId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: receiptId,
        sourceSignalId: null,
      });
      expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.09, 12);
    });
  },
);
