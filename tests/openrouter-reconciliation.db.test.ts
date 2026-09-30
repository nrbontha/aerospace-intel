import { createHash, randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  createResearchProviderBudgetScope,
  reconcileResearchProviderUsage,
  reserveResearchProviderUsage,
  setResearchProviderBudgetPermit,
  settleResearchProviderUsage,
} from "../packages/database/src/provider-accounting.js";
import {
  faaReviewModelUsage,
  investorPicks,
  researchProviderUsage,
  signalAnalystCases,
  signalAnalystSteps,
  signalReviewState,
  sourceSignals,
} from "../packages/database/src/schema.js";

const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" &&
  process.env.ASI_TEST_DATABASE_ADMIN_URL !== undefined;
const SAFE_SCRATCH_DATABASE = /^asi_openrouter_reconciliation_[0-9a-f]{32}$/u;
const KEY_FINGERPRINT = createHash("sha256")
  .update("native-test-key")
  .digest("hex");
const INPUT_HASH = createHash("sha256").update("native-input").digest("hex");
const STALE_INPUT_HASH = createHash("sha256")
  .update("stale-native-input")
  .digest("hex");
const REQUEST_HASH = createHash("sha256")
  .update("native-request")
  .digest("hex");
const BLOCKED_UNTIL = new Date("9999-12-31T23:59:59.999Z");

function nativeDatabaseUrls(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): { adminDatabaseUrl: string; scratchDatabaseUrl: string } {
  const adminUrl = new URL(adminDatabaseUrl);
  if (
    adminUrl.protocol !== "postgres:" &&
    adminUrl.protocol !== "postgresql:"
  ) {
    throw new Error("ASI_TEST_DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }
  const hostname = adminUrl.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error("ASI_TEST_DATABASE_ADMIN_URL must use a loopback host");
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

function quoteScratchDatabase(scratchDatabase: string): string {
  if (!SAFE_SCRATCH_DATABASE.test(scratchDatabase)) {
    throw new Error(
      `refusing unsafe scratch database name: ${scratchDatabase}`,
    );
  }
  return `"${scratchDatabase}"`;
}

async function createScratchDatabase(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): Promise<string> {
  const urls = nativeDatabaseUrls(adminDatabaseUrl, scratchDatabase);
  const admin = new Pool({ connectionString: urls.adminDatabaseUrl });
  try {
    await admin.query(
      `CREATE DATABASE ${quoteScratchDatabase(scratchDatabase)}`,
    );
  } finally {
    await admin.end();
  }
  return urls.scratchDatabaseUrl;
}

async function dropScratchDatabase(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): Promise<void> {
  const urls = nativeDatabaseUrls(adminDatabaseUrl, scratchDatabase);
  const admin = new Pool({ connectionString: urls.adminDatabaseUrl });
  try {
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteScratchDatabase(scratchDatabase)} WITH (FORCE)`,
    );
  } finally {
    await admin.end();
  }
}

function requireRow<T>(row: T | undefined, description: string): T {
  if (row === undefined) throw new Error(`expected ${description}`);
  return row;
}

describe.skipIf(!DB_TESTS_ENABLED)(
  "OpenRouter generation reconciliation (native DB)",
  () => {
    const adminDatabaseUrl = process.env.ASI_TEST_DATABASE_ADMIN_URL!;
    const scratchDatabase = `asi_openrouter_reconciliation_${randomUUID().replaceAll("-", "")}`;
    let originalDatabaseUrl: string | undefined;
    let hadOriginalDatabaseUrl = false;
    let signalId = "";
    let scopeId = "";

    async function createSignal(
      label: string,
      reviewRevision = 0,
    ): Promise<string> {
      const id = randomUUID();
      await getDatabase()
        .insert(sourceSignals)
        .values({
          id,
          reviewRevision,
          sourceKey: "faa_pma_database",
          sourceLocator: `reconciliation:${label}:${id}`,
          sourceFingerprint: `reconciliation:${label}:${id}`,
          rawName: `Reconciliation ${label}`,
        });
      return id;
    }

    async function createScope(
      allowlistedSourceSignalIds: readonly string[],
      totalCapUsd = "5",
    ): Promise<void> {
      scopeId = `native-openrouter:${randomUUID()}`;
      await createResearchProviderBudgetScope(getDatabase(), {
        id: scopeId,
        provider: "openrouter",
        startsAt: new Date("2026-09-30T00:00:00.000Z"),
        totalCapUsd,
        permitStatus: "active",
        allowlistedSourceSignalIds,
      });
    }

    async function createAnalystStep(sourceSignalId: string): Promise<{
      caseId: string;
      stepId: string;
    }> {
      const caseId = randomUUID();
      const stepId = randomUUID();
      const leaseToken = randomUUID();
      await getDatabase()
        .insert(signalReviewState)
        .values({
          signalId: sourceSignalId,
          sourceRevision: 0,
          phase: "muse",
          inputHash: INPUT_HASH,
          inputManifest: { policy: { analyst: "native-analyst-policy" } },
          nextAttemptAt: new Date("2026-09-30T01:00:00.000Z"),
          leaseToken,
          leaseExpiresAt: new Date("9999-01-01T00:00:00.000Z"),
        });
      await getDatabase()
        .insert(signalAnalystCases)
        .values({
          id: caseId,
          signalId: sourceSignalId,
          sourceRevision: 0,
          policyVersion: "native-analyst-policy",
          inputHash: INPUT_HASH,
          status: "active",
          limits: { maxSteps: 4 },
          checkpoint: { openQuestions: ["ownership"] },
          memo: { retained: "receipt history" },
          nextAttemptAt: null,
          nextStepSequence: 2,
        });
      await getDatabase()
        .insert(signalAnalystSteps)
        .values({
          id: stepId,
          caseId,
          sequence: 1,
          kind: "openrouter_muse_structured",
          request: { prompt: "native reconciliation fixture" },
          requestHash: REQUEST_HASH,
          status: "in_progress",
          claimPhase: "muse",
          claimLeaseToken: leaseToken,
          claimInputHash: INPUT_HASH,
          costKnown: false,
          startedAt: new Date("2026-09-30T01:00:00.000Z"),
        });
      return { caseId, stepId };
    }

    async function unknownReceipt(
      options: {
        sourceSignalId?: string;
        budgetScopeId?: string;
        generationId?: string;
        withAnalystStep?: boolean;
        dailyCapUsd?: string;
        persistMirrors?: boolean;
      } = {},
    ) {
      const sourceSignalId = options.sourceSignalId ?? signalId;
      const budgetScopeId = options.budgetScopeId ?? scopeId;
      const generationId = options.generationId ?? "gen-native-attributable";
      const analyst =
        options.withAnalystStep === true
          ? await createAnalystStep(sourceSignalId)
          : undefined;
      const reserved = await reserveResearchProviderUsage(getDatabase(), {
        provider: "openrouter",
        operation: "openrouter_muse_structured",
        sourceSignalId,
        ...(analyst === undefined ? {} : { analystStepId: analyst.stepId }),
        budgetScopeId,
        requestHash: REQUEST_HASH,
        estimatedCostUsd: "0.106",
        dailyCapUsd: options.dailyCapUsd ?? "5",
        now: new Date("2026-09-30T01:00:00.000Z"),
      });
      if (reserved.outcome !== "reserved")
        throw new Error("expected reservation");
      const settled = await settleResearchProviderUsage(
        getDatabase(),
        reserved.reservation.id,
        {
          status: "failed",
          actualCostUsd: null,
          observedAt: new Date("2026-09-30T01:00:01.000Z"),
          providerReceipt: {
            providerGenerationId: generationId,
            providerKeyFingerprint: KEY_FINGERPRINT,
            providerHttpStatus: 503,
          },
        },
      );
      if (options.persistMirrors !== false) {
        await getDatabase().insert(faaReviewModelUsage).values({
          id: settled.id,
          sourceSignalId,
          configuredModel: "test/muse",
          promptVersion: "native",
          costUsd: null,
        });
      }
      if (analyst !== undefined) {
        await getDatabase()
          .update(signalAnalystSteps)
          .set({
            ...(options.persistMirrors === false
              ? {}
              : { modelUsageReceiptId: settled.id }),
            status: "retryable_failure",
            finishedAt: new Date("2026-09-30T01:00:01.000Z"),
          })
          .where(eq(signalAnalystSteps.id, analyst.stepId));
        await getDatabase()
          .update(signalAnalystCases)
          .set({
            status: "deferred",
            checkpoint: {
              blockedCapability: {
                kind: "resource",
                fingerprint: "native-resource-block",
              },
            },
            nextAttemptAt: null,
          })
          .where(eq(signalAnalystCases.id, analyst.caseId));
        await getDatabase()
          .update(signalReviewState)
          .set({
            nextAttemptAt: BLOCKED_UNTIL,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(eq(signalReviewState.signalId, sourceSignalId));
      }
      return { receipt: settled, analyst };
    }

    async function ledgerSnapshot(
      receiptId: string,
      analyst?: { caseId: string; stepId: string },
    ) {
      const db = getDatabase();
      const receipt = requireRow(
        (
          await db
            .select()
            .from(researchProviderUsage)
            .where(eq(researchProviderUsage.id, receiptId))
        )[0],
        "provider receipt",
      );
      const modelUsage = requireRow(
        (
          await db
            .select()
            .from(faaReviewModelUsage)
            .where(eq(faaReviewModelUsage.id, receiptId))
        )[0],
        "model receipt",
      );
      const step =
        analyst === undefined
          ? null
          : requireRow(
              (
                await db
                  .select()
                  .from(signalAnalystSteps)
                  .where(eq(signalAnalystSteps.id, analyst.stepId))
              )[0],
              "analyst step",
            );
      const analystCase =
        analyst === undefined
          ? null
          : requireRow(
              (
                await db
                  .select()
                  .from(signalAnalystCases)
                  .where(eq(signalAnalystCases.id, analyst.caseId))
              )[0],
              "analyst case",
            );
      return { receipt, modelUsage, step, analystCase };
    }

    async function createBlockedReview(
      label: string,
      options: {
        caseInputHash?: string;
        casePolicyVersion?: string;
        caseRevision?: number;
        checkpointKind?: "model" | "resource";
        admission?: {
          budgetScopeId: string;
          estimatedCostUsd: string;
          dailyCapUsd: string;
        };
        sourceRevision?: number;
        sourceSignalId?: string;
        stateInputHash?: string;
        statePolicyVersion?: string;
        stateRevision?: number;
        status?: "deferred" | "completed";
        liveLease?: boolean;
      } = {},
    ): Promise<{ signalId: string; caseId: string }> {
      const sourceRevision = options.sourceRevision ?? 0;
      const stateInputHash = options.stateInputHash ?? INPUT_HASH;
      const statePolicyVersion =
        options.statePolicyVersion ?? "native-analyst-policy";
      const signalId =
        options.sourceSignalId ?? (await createSignal(label, sourceRevision));
      const caseId = randomUUID();
      await getDatabase()
        .insert(signalReviewState)
        .values({
          signalId,
          sourceRevision: options.stateRevision ?? sourceRevision,
          phase: "muse",
          inputHash: stateInputHash,
          inputManifest: { policy: { analyst: statePolicyVersion } },
          nextAttemptAt: BLOCKED_UNTIL,
          attemptCount: 7,
          lastError: "waiting for provider capacity",
          ...(options.liveLease === true
            ? {
                leaseToken: randomUUID(),
                leaseExpiresAt: new Date("9999-01-01T00:00:00.000Z"),
              }
            : {}),
        });
      await getDatabase()
        .insert(signalAnalystCases)
        .values({
          id: caseId,
          signalId,
          sourceRevision: options.caseRevision ?? sourceRevision,
          policyVersion: options.casePolicyVersion ?? statePolicyVersion,
          inputHash: options.caseInputHash ?? stateInputHash,
          status: options.status ?? "deferred",
          limits: { maxSteps: 4 },
          checkpoint: {
            blockedCapability: {
              kind: options.checkpointKind ?? "model",
              fingerprint: "previous-model-capability",
              ...(options.admission === undefined
                ? {}
                : { admission: options.admission }),
            },
          },
          memo: { retained: label },
          nextAttemptAt: null,
          nextStepSequence: 3,
        });
      return { signalId, caseId };
    }

    beforeAll(async () => {
      hadOriginalDatabaseUrl = Object.prototype.hasOwnProperty.call(
        process.env,
        "DATABASE_URL",
      );
      originalDatabaseUrl = process.env.DATABASE_URL;
      await closeDatabase();
      process.env.DATABASE_URL = await createScratchDatabase(
        adminDatabaseUrl,
        scratchDatabase,
      );
      await runMigrations();
    }, 180_000);

    beforeEach(async () => {
      await getDatabase().execute(sql`
      TRUNCATE TABLE
        research_provider_cooldowns,
        research_provider_usage,
        research_provider_budget_scope_signals,
        research_provider_budget_scopes,
        faa_review_model_usage,
        signal_analyst_steps,
        signal_analyst_cases,
        signal_review_state,
        investor_picks,
        source_signals
      CASCADE
    `);
      signalId = await createSignal("receipt");
    });

    afterAll(async () => {
      await closeDatabase();
      try {
        await dropScratchDatabase(adminDatabaseUrl, scratchDatabase);
      } finally {
        if (hadOriginalDatabaseUrl) {
          process.env.DATABASE_URL = originalDatabaseUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    }, 120_000);

    it("reconciles one attributable unknown with exact NUMERIC receipt and analyst-step mirrors", async () => {
      await createScope([signalId]);
      const { receipt, analyst } = await unknownReceipt({
        withAnalystStep: true,
      });
      if (analyst === undefined) throw new Error("expected analyst step");
      const before = await ledgerSnapshot(receipt.id, analyst);
      const sourceBefore = requireRow(
        (
          await getDatabase()
            .select()
            .from(sourceSignals)
            .where(eq(sourceSignals.id, signalId))
        )[0],
        "source signal",
      );
      const input = {
        reservationId: receipt.id,
        providerGenerationId: "gen-native-attributable",
        providerKeyFingerprint: KEY_FINGERPRINT,
        actualCostUsd: "0.001234567891",
        reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
      };

      await expect(
        reconcileResearchProviderUsage(getDatabase(), input),
      ).resolves.toMatchObject({
        outcome: "reconciled",
        receipt: {
          actualCostUsd: input.actualCostUsd,
          providerCostVerifiedAt: input.reconciledAt,
        },
      });

      const reconciled = await ledgerSnapshot(receipt.id, analyst);
      expect(reconciled.receipt).toMatchObject({
        status: "failed",
        actualCostUsd: input.actualCostUsd,
        providerCostVerifiedAt: input.reconciledAt,
        observedAt: before.receipt.observedAt,
      });
      expect(reconciled.modelUsage).toMatchObject({
        costUsd: input.actualCostUsd,
      });
      expect(reconciled.step).toMatchObject({
        costKnown: true,
        costUsd: input.actualCostUsd,
        modelUsageReceiptId: receipt.id,
        claimInputHash: INPUT_HASH,
      });
      expect(reconciled.analystCase).toEqual(before.analystCase);
      await expect(
        reconcileResearchProviderUsage(getDatabase(), input),
      ).resolves.toMatchObject({
        outcome: "existing",
      });
      await expect(ledgerSnapshot(receipt.id, analyst)).resolves.toEqual(
        reconciled,
      );
      await expect(
        getDatabase()
          .select()
          .from(sourceSignals)
          .where(eq(sourceSignals.id, signalId)),
      ).resolves.toEqual([sourceBefore]);
    });

    it("converges late unknown FAA and step mirrors on exact verified replay", async () => {
      await createScope([signalId]);
      const { receipt, analyst } = await unknownReceipt({
        withAnalystStep: true,
        persistMirrors: false,
      });
      if (analyst === undefined) throw new Error("expected analyst step");
      const input = {
        reservationId: receipt.id,
        providerGenerationId: "gen-native-attributable",
        providerKeyFingerprint: KEY_FINGERPRINT,
        actualCostUsd: "0.001234567891",
        reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
      };
      await expect(
        reconcileResearchProviderUsage(getDatabase(), input),
      ).resolves.toMatchObject({
        outcome: "reconciled",
      });
      const receiptBeforeReplay = requireRow(
        (
          await getDatabase()
            .select()
            .from(researchProviderUsage)
            .where(eq(researchProviderUsage.id, receipt.id))
        )[0],
        "verified provider receipt",
      );
      const caseBeforeReplay = requireRow(
        (
          await getDatabase()
            .select()
            .from(signalAnalystCases)
            .where(eq(signalAnalystCases.id, analyst.caseId))
        )[0],
        "deferred analyst case",
      );
      await getDatabase().insert(faaReviewModelUsage).values({
        id: receipt.id,
        sourceSignalId: signalId,
        configuredModel: "test/muse",
        promptVersion: "native",
        costUsd: null,
      });
      await getDatabase()
        .update(signalAnalystSteps)
        .set({ modelUsageReceiptId: receipt.id })
        .where(eq(signalAnalystSteps.id, analyst.stepId));

      await expect(
        reconcileResearchProviderUsage(getDatabase(), input),
      ).resolves.toMatchObject({
        outcome: "existing",
      });
      const converged = await ledgerSnapshot(receipt.id, analyst);
      expect(converged.receipt).toEqual(receiptBeforeReplay);
      expect(converged.modelUsage.costUsd).toBe(input.actualCostUsd);
      expect(converged.step).toMatchObject({
        modelUsageReceiptId: receipt.id,
        costKnown: true,
        costUsd: input.actualCostUsd,
      });
      expect(converged.analystCase).toEqual(caseBeforeReplay);
    });

    it("holds a late known mirror conflict on exact verified replay without changing the receipt", async () => {
      await createScope([signalId]);
      const { receipt } = await unknownReceipt({ persistMirrors: false });
      const input = {
        reservationId: receipt.id,
        providerGenerationId: "gen-native-attributable",
        providerKeyFingerprint: KEY_FINGERPRINT,
        actualCostUsd: "0.001",
        reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
      };
      await expect(
        reconcileResearchProviderUsage(getDatabase(), input),
      ).resolves.toMatchObject({
        outcome: "reconciled",
      });
      await getDatabase().insert(faaReviewModelUsage).values({
        id: receipt.id,
        sourceSignalId: signalId,
        configuredModel: "test/muse",
        promptVersion: "native",
        costUsd: "0.005",
      });
      const receiptBeforeReplay = requireRow(
        (
          await getDatabase()
            .select()
            .from(researchProviderUsage)
            .where(eq(researchProviderUsage.id, receipt.id))
        )[0],
        "verified provider receipt",
      );
      const mirrorBeforeReplay = requireRow(
        (
          await getDatabase()
            .select()
            .from(faaReviewModelUsage)
            .where(eq(faaReviewModelUsage.id, receipt.id))
        )[0],
        "conflicting model mirror",
      );
      await expect(
        reconcileResearchProviderUsage(getDatabase(), input),
      ).resolves.toMatchObject({
        outcome: "held",
        reason: "model_usage_cost_conflict",
      });
      await expect(
        getDatabase()
          .select()
          .from(researchProviderUsage)
          .where(eq(researchProviderUsage.id, receipt.id)),
      ).resolves.toEqual([receiptBeforeReplay]);
      await expect(
        getDatabase()
          .select()
          .from(faaReviewModelUsage)
          .where(eq(faaReviewModelUsage.id, receipt.id)),
      ).resolves.toEqual([mirrorBeforeReplay]);
    });

    it("holds known model or analyst-step mirror conflicts without changing any linked row", async () => {
      const stepSignalId = await createSignal("step-conflict");
      await createScope([signalId, stepSignalId]);
      const modelConflict = await unknownReceipt({ withAnalystStep: true });
      if (modelConflict.analyst === undefined)
        throw new Error("expected analyst step");
      await getDatabase()
        .update(faaReviewModelUsage)
        .set({ costUsd: "0.005" })
        .where(eq(faaReviewModelUsage.id, modelConflict.receipt.id));
      const modelBefore = await ledgerSnapshot(
        modelConflict.receipt.id,
        modelConflict.analyst,
      );

      await expect(
        reconcileResearchProviderUsage(getDatabase(), {
          reservationId: modelConflict.receipt.id,
          providerGenerationId: "gen-native-attributable",
          providerKeyFingerprint: KEY_FINGERPRINT,
          actualCostUsd: "0.001",
          reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        outcome: "held",
        reason: "model_usage_cost_conflict",
      });
      await expect(
        ledgerSnapshot(modelConflict.receipt.id, modelConflict.analyst),
      ).resolves.toEqual(modelBefore);

      const stepConflict = await unknownReceipt({
        sourceSignalId: stepSignalId,
        generationId: "gen-native-step-conflict",
        withAnalystStep: true,
      });
      if (stepConflict.analyst === undefined)
        throw new Error("expected analyst step");
      await getDatabase()
        .update(signalAnalystSteps)
        .set({ costKnown: true, costUsd: "0.005" })
        .where(eq(signalAnalystSteps.id, stepConflict.analyst.stepId));
      const stepBefore = await ledgerSnapshot(
        stepConflict.receipt.id,
        stepConflict.analyst,
      );

      await expect(
        reconcileResearchProviderUsage(getDatabase(), {
          reservationId: stepConflict.receipt.id,
          providerGenerationId: "gen-native-step-conflict",
          providerKeyFingerprint: KEY_FINGERPRINT,
          actualCostUsd: "0.001",
          reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        outcome: "held",
        reason: "analyst_step_cost_conflict",
      });
      await expect(
        ledgerSnapshot(stepConflict.receipt.id, stepConflict.analyst),
      ).resolves.toEqual(stepBefore);
    });

    it("holds missing or mismatched receipt identity without associating an external cost", async () => {
      await createScope([signalId]);
      const mismatched = await unknownReceipt();
      const mismatchBefore = await ledgerSnapshot(mismatched.receipt.id);
      await expect(
        reconcileResearchProviderUsage(getDatabase(), {
          reservationId: mismatched.receipt.id,
          providerGenerationId: "gen-mismatched",
          providerKeyFingerprint: KEY_FINGERPRINT,
          actualCostUsd: "0.001",
          reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        outcome: "held",
        reason: "provider_identity_conflict",
      });
      await expect(ledgerSnapshot(mismatched.receipt.id)).resolves.toEqual(
        mismatchBefore,
      );

      const legacy = await unknownReceipt({ generationId: "gen-legacy" });
      await getDatabase()
        .update(researchProviderUsage)
        .set({ providerGenerationId: null, providerKeyFingerprint: null })
        .where(eq(researchProviderUsage.id, legacy.receipt.id));
      const legacyBefore = await ledgerSnapshot(legacy.receipt.id);
      await expect(
        reconcileResearchProviderUsage(getDatabase(), {
          reservationId: legacy.receipt.id,
          providerGenerationId: "gen-legacy",
          providerKeyFingerprint: KEY_FINGERPRINT,
          actualCostUsd: "0.001",
          reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        outcome: "held",
        reason: "missing_provider_identity",
      });
      await expect(ledgerSnapshot(legacy.receipt.id)).resolves.toEqual(
        legacyBefore,
      );
      expect(legacyBefore.receipt.providerGenerationId).toBeNull();
      expect(legacyBefore.receipt.providerKeyFingerprint).toBeNull();
    });

    it("keeps released capacity blocked until its active OpenRouter permit wakes the matching review", async () => {
      const eligibleSignalId = await createSignal("permit-eligible");
      await createScope([signalId, eligibleSignalId]);
      const trigger = await unknownReceipt();
      const eligible = await createBlockedReview("permit-eligible", {
        sourceSignalId: eligibleSignalId,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const caseBefore = requireRow(
        (
          await getDatabase()
            .select()
            .from(signalAnalystCases)
            .where(eq(signalAnalystCases.id, eligible.caseId))
        )[0],
        "permit-eligible analyst case",
      );
      const observedAt = new Date("9999-01-01T00:00:00.000Z");
      await setResearchProviderBudgetPermit(getDatabase(), scopeId, {
        status: "paused",
        observedAt,
      });

      await expect(
        reconcileResearchProviderUsage(getDatabase(), {
          reservationId: trigger.receipt.id,
          providerGenerationId: "gen-native-attributable",
          providerKeyFingerprint: KEY_FINGERPRINT,
          actualCostUsd: "0.001",
          reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
        }),
      ).resolves.toMatchObject({ outcome: "reconciled" });
      const pausedState = requireRow(
        (
          await getDatabase()
            .select()
            .from(signalReviewState)
            .where(eq(signalReviewState.signalId, eligible.signalId))
        )[0],
        "paused permit review state",
      );
      expect(pausedState.nextAttemptAt.getTime()).toBe(BLOCKED_UNTIL.getTime());

      await setResearchProviderBudgetPermit(getDatabase(), scopeId, {
        status: "active",
        observedAt,
      });
      const activeState = requireRow(
        (
          await getDatabase()
            .select()
            .from(signalReviewState)
            .where(eq(signalReviewState.signalId, eligible.signalId))
        )[0],
        "active permit review state",
      );
      expect(activeState.nextAttemptAt.getTime()).not.toBe(
        BLOCKED_UNTIL.getTime(),
      );
      await expect(
        getDatabase()
          .select()
          .from(signalAnalystCases)
          .where(eq(signalAnalystCases.id, eligible.caseId)),
      ).resolves.toEqual([caseBefore]);
    });

    it("wakes only current eligible model-blocked reviews when reconciliation releases active scope capacity", async () => {
      const reviewSignalIds = {
        eligible: await createSignal("eligible"),
        resourceBlocked: await createSignal("resource-blocked"),
        stalePolicy: await createSignal("stale-policy"),
        staleHash: await createSignal("stale-hash"),
        staleRevision: await createSignal("stale-revision", 1),
        terminal: await createSignal("terminal"),
        golden: await createSignal("golden"),
        liveLease: await createSignal("live-lease"),
        missingAdmission: await createSignal("missing-admission"),
        malformedAdmission: await createSignal("malformed-admission"),
        malformedDailyAdmission: await createSignal(
          "malformed-daily-admission",
        ),
        wrongScopeAdmission: await createSignal("wrong-scope-admission"),
        outOfCohort: await createSignal("out-of-cohort"),
      };
      await createScope([
        signalId,
        reviewSignalIds.eligible,
        reviewSignalIds.resourceBlocked,
        reviewSignalIds.stalePolicy,
        reviewSignalIds.staleHash,
        reviewSignalIds.staleRevision,
        reviewSignalIds.terminal,
        reviewSignalIds.golden,
        reviewSignalIds.liveLease,
        reviewSignalIds.missingAdmission,
        reviewSignalIds.malformedAdmission,
        reviewSignalIds.malformedDailyAdmission,
        reviewSignalIds.wrongScopeAdmission,
      ]);
      const eligible = await createBlockedReview("eligible", {
        sourceSignalId: reviewSignalIds.eligible,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const resourceBlocked = await createBlockedReview("resource-blocked", {
        sourceSignalId: reviewSignalIds.resourceBlocked,
        checkpointKind: "resource",
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const stalePolicy = await createBlockedReview("stale-policy", {
        sourceSignalId: reviewSignalIds.stalePolicy,
        casePolicyVersion: "stale-analyst-policy",
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const staleHash = await createBlockedReview("stale-hash", {
        sourceSignalId: reviewSignalIds.staleHash,
        caseInputHash: STALE_INPUT_HASH,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const staleRevision = await createBlockedReview("stale-revision", {
        sourceSignalId: reviewSignalIds.staleRevision,
        sourceRevision: 1,
        stateRevision: 0,
        caseRevision: 1,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const terminal = await createBlockedReview("terminal", {
        sourceSignalId: reviewSignalIds.terminal,
        status: "completed",
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const golden = await createBlockedReview("golden", {
        sourceSignalId: reviewSignalIds.golden,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const liveLease = await createBlockedReview("live-lease", {
        sourceSignalId: reviewSignalIds.liveLease,
        liveLease: true,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const missingAdmission = await createBlockedReview("missing-admission", {
        sourceSignalId: reviewSignalIds.missingAdmission,
      });
      const malformedAdmission = await createBlockedReview(
        "malformed-admission",
        {
          sourceSignalId: reviewSignalIds.malformedAdmission,
          admission: {
            budgetScopeId: scopeId,
            estimatedCostUsd: "0x1",
            dailyCapUsd: "5",
          },
        },
      );
      const malformedDailyAdmission = await createBlockedReview(
        "malformed-daily-admission",
        {
          sourceSignalId: reviewSignalIds.malformedDailyAdmission,
          admission: {
            budgetScopeId: scopeId,
            estimatedCostUsd: "0.106",
            dailyCapUsd: "0x5",
          },
        },
      );
      const wrongScopeAdmission = await createBlockedReview(
        "wrong-scope-admission",
        {
          sourceSignalId: reviewSignalIds.wrongScopeAdmission,
          admission: {
            budgetScopeId: `native-openrouter:wrong:${randomUUID()}`,
            estimatedCostUsd: "0.106",
            dailyCapUsd: "5",
          },
        },
      );
      const outOfCohort = await createBlockedReview("out-of-cohort", {
        sourceSignalId: reviewSignalIds.outOfCohort,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const cohort = [
        eligible,
        resourceBlocked,
        stalePolicy,
        staleHash,
        staleRevision,
        terminal,
        golden,
        liveLease,
        missingAdmission,
        malformedAdmission,
        malformedDailyAdmission,
        wrongScopeAdmission,
      ];
      await getDatabase()
        .insert(investorPicks)
        .values({ sourceSignalId: golden.signalId });

      const before = new Map(
        await Promise.all(
          [...cohort, outOfCohort].map(async (review) => {
            const state = requireRow(
              (
                await getDatabase()
                  .select()
                  .from(signalReviewState)
                  .where(eq(signalReviewState.signalId, review.signalId))
              )[0],
              `${review.signalId} review state`,
            );
            const analystCase = requireRow(
              (
                await getDatabase()
                  .select()
                  .from(signalAnalystCases)
                  .where(eq(signalAnalystCases.id, review.caseId))
              )[0],
              `${review.signalId} analyst case`,
            );
            const source = requireRow(
              (
                await getDatabase()
                  .select()
                  .from(sourceSignals)
                  .where(eq(sourceSignals.id, review.signalId))
              )[0],
              `${review.signalId} source signal`,
            );
            return [review.signalId, { state, analystCase, source }] as const;
          }),
        ),
      );

      const trigger = await unknownReceipt();
      await expect(
        reconcileResearchProviderUsage(getDatabase(), {
          reservationId: trigger.receipt.id,
          providerGenerationId: "gen-native-attributable",
          providerKeyFingerprint: KEY_FINGERPRINT,
          actualCostUsd: "0.001",
          reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
        }),
      ).resolves.toMatchObject({
        outcome: "reconciled",
        receipt: { actualCostUsd: "0.001" },
      });

      const eligibleAfter = requireRow(
        (
          await getDatabase()
            .select()
            .from(signalReviewState)
            .where(eq(signalReviewState.signalId, eligible.signalId))
        )[0],
        "eligible review state",
      );
      expect(eligibleAfter.nextAttemptAt.getTime()).not.toBe(
        BLOCKED_UNTIL.getTime(),
      );
      expect(eligibleAfter.attemptCount).toBe(
        before.get(eligible.signalId)?.state.attemptCount,
      );
      expect(eligibleAfter.inputHash).toBe(INPUT_HASH);

      for (const blocked of [
        resourceBlocked,
        stalePolicy,
        staleHash,
        staleRevision,
        terminal,
        golden,
        liveLease,
        missingAdmission,
        malformedAdmission,
        malformedDailyAdmission,
        wrongScopeAdmission,
        outOfCohort,
      ]) {
        const previous = requireRow(
          before.get(blocked.signalId),
          `${blocked.signalId} snapshot`,
        );
        await expect(
          getDatabase()
            .select()
            .from(signalReviewState)
            .where(eq(signalReviewState.signalId, blocked.signalId)),
        ).resolves.toEqual([previous.state]);
      }
      for (const review of [...cohort, outOfCohort]) {
        const previous = requireRow(
          before.get(review.signalId),
          `${review.signalId} snapshot`,
        );
        await expect(
          getDatabase()
            .select()
            .from(signalAnalystCases)
            .where(eq(signalAnalystCases.id, review.caseId)),
        ).resolves.toEqual([previous.analystCase]);
        await expect(
          getDatabase()
            .select()
            .from(sourceSignals)
            .where(eq(sourceSignals.id, review.signalId)),
        ).resolves.toEqual([previous.source]);
      }
    });
    it("does not wake a model request when released scope remainder is below its estimate", async () => {
      const blockedSignalId = await createSignal("scope-remainder");
      await createScope([signalId, blockedSignalId], "0.106");
      const trigger = await unknownReceipt();
      const blocked = await createBlockedReview("scope-remainder", {
        sourceSignalId: blockedSignalId,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const stateBefore = requireRow(
        (
          await getDatabase()
            .select()
            .from(signalReviewState)
            .where(eq(signalReviewState.signalId, blocked.signalId))
        )[0],
        "scope-remainder review",
      );
      await expect(
        reconcileResearchProviderUsage(getDatabase(), {
          reservationId: trigger.receipt.id,
          providerGenerationId: "gen-native-attributable",
          providerKeyFingerprint: KEY_FINGERPRINT,
          actualCostUsd: "0.105",
          reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
        }),
      ).resolves.toMatchObject({ outcome: "reconciled" });
      await expect(
        getDatabase()
          .select()
          .from(signalReviewState)
          .where(eq(signalReviewState.signalId, blocked.signalId)),
      ).resolves.toEqual([stateBefore]);
    });

    it("does not wake a model request when its shared UTC-day cap remains exhausted", async () => {
      const blockedSignalId = await createSignal("daily-exhausted");
      await createScope([signalId, blockedSignalId]);
      const trigger = await unknownReceipt();
      const priorScopeId = `native-openrouter:prior-day-hold:${randomUUID()}`;
      await createResearchProviderBudgetScope(getDatabase(), {
        id: priorScopeId,
        provider: "openrouter",
        startsAt: new Date("2000-01-01T00:00:00.000Z"),
        totalCapUsd: "1",
        permitStatus: "active",
        allowlistedSourceSignalIds: [signalId],
      });
      await unknownReceipt({
        budgetScopeId: priorScopeId,
        generationId: "gen-prior-scope-unknown",
      });
      await setResearchProviderBudgetPermit(getDatabase(), priorScopeId, {
        status: "closed",
        observedAt: new Date("2099-04-05T10:00:00.000Z"),
      });
      const blocked = await createBlockedReview("daily-exhausted", {
        sourceSignalId: blockedSignalId,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "0.212",
        },
      });
      const stateBefore = requireRow(
        (
          await getDatabase()
            .select()
            .from(signalReviewState)
            .where(eq(signalReviewState.signalId, blocked.signalId))
        )[0],
        "daily-exhausted review",
      );
      await expect(
        reconcileResearchProviderUsage(getDatabase(), {
          reservationId: trigger.receipt.id,
          providerGenerationId: "gen-native-attributable",
          providerKeyFingerprint: KEY_FINGERPRINT,
          actualCostUsd: "0.001",
          reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
        }),
      ).resolves.toMatchObject({ outcome: "reconciled" });
      await expect(
        getDatabase()
          .select()
          .from(signalReviewState)
          .where(eq(signalReviewState.signalId, blocked.signalId)),
      ).resolves.toEqual([stateBefore]);
    });

    it("does not issue a second capacity wake when exact replay follows a reblock", async () => {
      const blockedSignalId = await createSignal("reblocked-replay");
      await createScope([signalId, blockedSignalId]);
      const trigger = await unknownReceipt();
      const blocked = await createBlockedReview("reblocked-replay", {
        sourceSignalId: blockedSignalId,
        admission: {
          budgetScopeId: scopeId,
          estimatedCostUsd: "0.106",
          dailyCapUsd: "5",
        },
      });
      const input = {
        reservationId: trigger.receipt.id,
        providerGenerationId: "gen-native-attributable",
        providerKeyFingerprint: KEY_FINGERPRINT,
        actualCostUsd: "0.001",
        reconciledAt: new Date("2026-09-30T02:00:00.000Z"),
      };
      await expect(
        reconcileResearchProviderUsage(getDatabase(), input),
      ).resolves.toMatchObject({
        outcome: "reconciled",
      });
      await getDatabase()
        .update(signalReviewState)
        .set({ nextAttemptAt: BLOCKED_UNTIL })
        .where(eq(signalReviewState.signalId, blocked.signalId));
      const stateBeforeReplay = requireRow(
        (
          await getDatabase()
            .select()
            .from(signalReviewState)
            .where(eq(signalReviewState.signalId, blocked.signalId))
        )[0],
        "reblocked review",
      );
      await expect(
        reconcileResearchProviderUsage(getDatabase(), input),
      ).resolves.toMatchObject({
        outcome: "existing",
      });
      await expect(
        getDatabase()
          .select()
          .from(signalReviewState)
          .where(eq(signalReviewState.signalId, blocked.signalId)),
      ).resolves.toEqual([stateBeforeReplay]);
    });
  },
);
