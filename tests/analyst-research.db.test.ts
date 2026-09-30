import { createHash, randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  faaEnsembleResults,
  faaEnsembleEvaluations,
  faaReviewModelUsage,
  researchProviderLegacyEstimates,
  researchProviderBudgetScopes,
  researchProviderBudgetScopeSignals,
  researchProviderUsage,
  signalAnalystCases,
  signalAnalystSteps,
  signalReviewState,
  sourceSignals,
} from "../packages/database/src/schema.js";
import {
  beginSignalAnalystStep,
  checkpointSignalAnalystCase,
  completeSignalAnalystCase,
  ensureSignalAnalystCase,
  finishSignalAnalystStep,
  listSourceSignalAnalystOverviews,
  listSourceSignalAnalystOverviewsInSnapshot,
  publishSignalAnalystEvidence,
  readCurrentSignalAnalystCase,
  readSignalAnalystCaseHistory,
} from "../packages/database/src/analyst-research.js";
import type { SourceSignalAnalystOverviewCursor } from "../packages/database/src/investor-ranking.js";
import {
  createResearchProviderBudgetScope,
  cutoverResearchProviderBudgetScope,
  importLegacyResearchProviderEstimate,
  readResearchProviderBudgetScope,
  reserveResearchProviderUsage,
  settleResearchProviderUsage,
  setResearchProviderBudgetPermit,
} from "../packages/database/src/provider-accounting.js";
import {
  claimSignalReviews,
  commitSignalReview,
  type SignalReviewClaim,
} from "../packages/database/src/signal-reviews.js";

const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" &&
  process.env.ASI_TEST_DATABASE_ADMIN_URL !== undefined;
const SAFE_SCRATCH_DATABASE = /^asi_analyst_research_[0-9a-f]{32}$/u;
const INPUT_HASH = createHash("sha256").update("analyst-input-v1").digest("hex");
const REQUEST_HASH = createHash("sha256").update("analyst-request-v1").digest("hex");
const EXPECTED_REVIEW_CONTRACT = {
  version: "test-input-v1",
  policy: {
    ladder: "test-ladder-v1",
    analyst: "analyst-policy-v1",
    jevModel: "test-jev-model",
    museModel: "test-muse-model",
    evaluatorPrompt: "test-evaluator-prompt-v1",
  },
} as const;

function nativeDatabaseUrls(
  adminDatabaseUrl: string,
  scratchDatabase: string,
): { adminDatabaseUrl: string; scratchDatabaseUrl: string } {
  const adminUrl = new URL(adminDatabaseUrl);
  if (adminUrl.protocol !== "postgres:" && adminUrl.protocol !== "postgresql:") {
    throw new Error("ASI_TEST_DATABASE_ADMIN_URL must be a PostgreSQL URL");
  }
  const hostname = adminUrl.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error("ASI_TEST_DATABASE_ADMIN_URL must use a loopback host");
  }
  if (!SAFE_SCRATCH_DATABASE.test(scratchDatabase)) {
    throw new Error(`refusing unsafe scratch database name: ${scratchDatabase}`);
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
    throw new Error(`refusing unsafe scratch database name: ${scratchDatabase}`);
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
    await admin.query(`CREATE DATABASE ${quoteScratchDatabase(scratchDatabase)}`);
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

async function createMuseSignal(label: string): Promise<string> {
  const id = randomUUID();
  const db = getDatabase();
  const inputManifest = {
    version: EXPECTED_REVIEW_CONTRACT.version,
    sourceRevision: 0,
    policy: EXPECTED_REVIEW_CONTRACT.policy,
    evidence: {
      identityStatus: "not_found",
      namedProductProofs: [],
      headquarters: { status: "unknown", country: null },
      ownershipStatus: "unknown",
      revenueAssessment: "unknown",
      sourcedSupport: {
        identity: false,
        product: false,
        ownership: false,
        size: false,
        headquarters: false,
      },
    },
  };
  await db.insert(sourceSignals).values({
    id,
    sourceKey: "faa_pma_database",
    sourceLocator: `analyst-research:${label}`,
    sourceFingerprint: `analyst-research:${label}:${id}`,
    rawName: `Analyst Research ${label}`,
  });
  const [jevEvaluation] = await db
    .insert(faaEnsembleEvaluations)
    .values({
      signalId: id,
      modelId: EXPECTED_REVIEW_CONTRACT.policy.jevModel,
      promptVersion: "analyst-research-fixture-jev-v1",
      inputHash: INPUT_HASH,
      inputManifest,
      rawResponse: "{}",
      parsed: {
        version: "jev-triage-v1",
        decision: "research",
        confidence: null,
        productFit: "plausible_supplier",
        acquisitionReadiness: "needs_research",
        researchPriority: 2,
        reasonCodes: [],
        explanation: "Muse claim fixture",
        observations: [],
        gaps: [],
      },
      decision: "research",
      error: null,
    })
    .returning({ id: faaEnsembleEvaluations.id });
  if (jevEvaluation === undefined) {
    throw new Error("expected Muse fixture Jev evaluation");
  }
  await db.insert(signalReviewState).values({
    signalId: id,
    phase: "muse",
    inputHash: INPUT_HASH,
    inputManifest,
    jevEvaluationId: jevEvaluation.id,
    nextAttemptAt: new Date(0),
  });
  return id;
}

type RankingEvidence = {
  identityStatus: "verified" | "ambiguous" | "not_found";
  namedProductProofs: readonly Record<string, unknown>[];
  headquarters: {
    status: "supported" | "unknown" | "conflicting";
    country: string | null;
  };
  ownershipStatus:
    | "independent"
    | "acquired"
    | "pe_owned"
    | "public_parent"
    | "dead"
    | "unknown";
  revenueAssessment: "under_50m" | "over_50m" | "unknown";
  sourcedSupport: {
    identity: boolean;
    product: boolean;
    ownership: boolean;
    size: boolean;
    headquarters: boolean;
  };
};

const UNKNOWN_RANKING_EVIDENCE: RankingEvidence = {
  identityStatus: "not_found",
  namedProductProofs: [],
  headquarters: { status: "unknown", country: null },
  ownershipStatus: "unknown",
  revenueAssessment: "unknown",
  sourcedSupport: {
    identity: false,
    product: false,
    ownership: false,
    size: false,
    headquarters: false,
  },
};

const FULL_RANKING_EVIDENCE: RankingEvidence = {
  identityStatus: "verified",
  namedProductProofs: [{ quote: "Named aerospace component" }],
  headquarters: { status: "supported", country: "US" },
  ownershipStatus: "independent",
  revenueAssessment: "under_50m",
  sourcedSupport: {
    identity: true,
    product: true,
    ownership: true,
    size: true,
    headquarters: true,
  },
};

async function createRankingSignal(
  label: string,
  options: {
    createdAt?: string;
    evidence?: RankingEvidence;
    productFit?: "supported_product" | "plausible_supplier" | "unknown";
    manifestPolicy?: Partial<
      Record<keyof (typeof EXPECTED_REVIEW_CONTRACT)["policy"], string>
    >;
    acquisitionReadiness?: "ready" | "needs_research" | "blocked";
    jevDecision?: "reject" | "research" | "high_priority";
    jevModel?: string;
    evaluationInputHash?: string;
    signalRevision?: number;
    stateRevision?: number;
    completedCase?: boolean;
    alignedFinal?: boolean;
    rawName?: string;
    rawDomain?: string | null;
    sourcePayload?: Record<string, unknown>;
    city?: string | null;
    state?: string | null;
    country?: string | null;
  } = {},
): Promise<string> {
  const db = getDatabase();
  const id = randomUUID();
  const inputHash = createHash("sha256").update(`ranking:${label}`).digest("hex");
  const evaluationInputHash = options.evaluationInputHash ?? inputHash;
  const evidence = options.evidence ?? UNKNOWN_RANKING_EVIDENCE;
  const manifest = {
    version: EXPECTED_REVIEW_CONTRACT.version,
    sourceRevision: options.stateRevision ?? 0,
    evidence,
    policy: {
      ...EXPECTED_REVIEW_CONTRACT.policy,
      ...options.manifestPolicy,
    },
  };
  const createdAt = options.createdAt ?? "2049-01-01T00:00:00.000001Z";
  await db.execute(sql`
    INSERT INTO source_signals (
      id,
      review_revision,
      source_key,
      source_locator,
      source_fingerprint,
      raw_name,
      raw_domain,
      city,
      state,
      country,
      source_payload,
      created_at,
      updated_at
    ) VALUES (
      ${id}::uuid,
      ${options.signalRevision ?? 0},
      'faa_pma_database',
      ${`ranking:${label}`},
      ${`ranking:${label}:${id}`},
      ${options.rawName ?? `Ranking ${label}`},
      ${options.rawDomain ?? null},
      ${options.city ?? null},
      ${options.state ?? null},
      ${options.country ?? null},
      ${JSON.stringify(options.sourcePayload ?? {})}::jsonb,
      ${createdAt}::timestamptz,
      ${createdAt}::timestamptz
    )
  `);
  const jevEvaluationId = randomUUID();
  const jevDecision = options.jevDecision ?? "research";
  await db.insert(faaEnsembleEvaluations).values({
    id: jevEvaluationId,
    signalId: id,
    modelId: options.jevModel ?? EXPECTED_REVIEW_CONTRACT.policy.jevModel,
    promptVersion: "jev-ladder-rung-prompt",
    inputHash: evaluationInputHash,
    inputManifest: manifest,
    rawResponse: "{}",
    parsed: {
      version: "jev-triage-v1",
      decision: jevDecision,
      confidence: null,
      productFit: options.productFit ?? "unknown",
      acquisitionReadiness: options.acquisitionReadiness ?? "needs_research",
      researchPriority: 2,
      reasonCodes: [],
      explanation: "ranking fixture",
      observations: [],
      gaps: [],
    },
    decision: jevDecision,
    error: null,
  });
  await db.insert(signalReviewState).values({
    signalId: id,
    sourceRevision: options.stateRevision ?? 0,
    phase: options.alignedFinal ? "settled" : "muse",
    inputHash,
    inputManifest: manifest,
    jevEvaluationId,
    nextAttemptAt: new Date(0),
  });
  let analystCaseId: string | null = null;
  if (options.completedCase || options.alignedFinal) {
    const [analystCase] = await db
      .insert(signalAnalystCases)
      .values({
        signalId: id,
        sourceRevision: options.stateRevision ?? 0,
        policyVersion: EXPECTED_REVIEW_CONTRACT.policy.analyst,
        inputHash,
        status: "completed",
        limits: {},
        checkpoint: {},
        memo: {
          version: "signal-analyst-memo-v1",
          inputHash,
          createdAt: "2049-01-01T00:00:01.000Z",
          summary: {
            label: "model_analysis",
            text: options.alignedFinal ? "Final verification" : "Draft only",
          },
          answers: [],
          nextActions: [],
        },
        completedAt: new Date("2049-01-01T00:00:01.000Z"),
      })
      .returning({ id: signalAnalystCases.id });
    analystCaseId = analystCase?.id ?? null;
  }
  if (options.alignedFinal) {
    if (analystCaseId === null) throw new Error("expected ranking analyst case");
    const promptVersion = "signal-analyst-final-v2";
    const verification = { decision: "high_priority" };
    const modelUsageReceiptId = randomUUID();
    await db.insert(faaReviewModelUsage).values({
      id: modelUsageReceiptId,
      sourceSignalId: id,
      configuredModel: EXPECTED_REVIEW_CONTRACT.policy.museModel,
      returnedModel: EXPECTED_REVIEW_CONTRACT.policy.museModel,
      phase: "muse",
      promptVersion,
      inputHash,
      costUsd: "0",
    });
    await db.insert(signalAnalystSteps).values({
      caseId: analystCaseId,
      sequence: 1,
      kind: "final_verifier",
      request: {
        inputHash,
        promptVersion,
        promptSha256: createHash("sha256")
          .update(`ranking-final:${label}`)
          .digest("hex"),
      },
      requestHash: createHash("sha256")
        .update(`ranking-final-request:${label}`)
        .digest("hex"),
      status: "completed",
      response: { kind: "final", verification },
      claimPhase: "muse",
      claimLeaseToken: randomUUID(),
      claimInputHash: inputHash,
      modelUsageReceiptId,
      costKnown: true,
      costUsd: "0",
      finishedAt: new Date("2049-01-01T00:00:01.000Z"),
    });
    const museEvaluationId = randomUUID();
    await db.insert(faaEnsembleEvaluations).values({
      id: museEvaluationId,
      signalId: id,
      modelId: EXPECTED_REVIEW_CONTRACT.policy.museModel,
      promptVersion,
      inputHash,
      inputManifest: manifest,
      rawResponse: "{}",
      parsed: verification,
      decision: "high_priority",
      error: null,
    });
    await db.insert(faaEnsembleResults).values({
      signalId: id,
      promptVersion: EXPECTED_REVIEW_CONTRACT.policy.evaluatorPrompt,
      inputHash,
      jevEvaluationId,
      museEvaluationId,
      modelAId: EXPECTED_REVIEW_CONTRACT.policy.jevModel,
      modelBId: EXPECTED_REVIEW_CONTRACT.policy.museModel,
      modelADecision: "high_priority",
      modelBDecision: "high_priority",
      agreed: true,
      adjudicationRequired: false,
      finalDecision: "high_priority",
    });
  }
  return id;
}

async function createProviderScope(
  label: string,
  options: {
    sourceSignalIds?: string[];
    totalCapUsd?: string;
    permitStatus?: "paused" | "active";
    startsAt?: Date;
  } = {},
): Promise<{ budgetScopeId: string; sourceSignalId: string }> {
  let sourceSignalIds = options.sourceSignalIds;
  if (sourceSignalIds === undefined) {
    const sourceSignalId = randomUUID();
    await getDatabase().insert(sourceSignals).values({
      id: sourceSignalId,
      sourceKey: "faa_pma_database",
      sourceLocator: `provider-scope:${label}:${sourceSignalId}`,
      sourceFingerprint: `provider-scope:${label}:${sourceSignalId}`,
      rawName: `Provider Scope ${label}`,
    });
    sourceSignalIds = [sourceSignalId];
  }
  const budgetScopeId = `analyst-test:${label}`;
  await createResearchProviderBudgetScope(getDatabase(), {
    id: budgetScopeId,
    provider: "exa",
    startsAt: options.startsAt ?? new Date("2000-01-01T00:00:00.000Z"),
    totalCapUsd: options.totalCapUsd ?? "10",
    permitStatus: options.permitStatus ?? "active",
    allowlistedSourceSignalIds: sourceSignalIds,
  });
  return { budgetScopeId, sourceSignalId: sourceSignalIds[0]! };
}

async function claimMuse(): Promise<SignalReviewClaim> {
  const claims = await claimSignalReviews(getDatabase(), {
    phase: "muse",
    limit: 1,
    leaseSeconds: 60,
    expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
  });
  if (claims[0] === undefined) throw new Error("expected one Muse claim");
  return claims[0];
}

async function ensureCase(claim: SignalReviewClaim) {
  const result = await ensureSignalAnalystCase(getDatabase(), claim, {
    policyVersion: "analyst-policy-v1",
    inputHash: INPUT_HASH,
    limits: { maxSteps: 4 },
    initialCheckpoint: { openQuestions: ["ownership"] },
  });
  if (!result.accepted) throw new Error("expected analyst case acceptance");
  return result.value;
}

describe.skipIf(!DB_TESTS_ENABLED)(
  "durable source-signal analyst research (isolated PostgreSQL)",
  () => {
    const adminDatabaseUrl = process.env.ASI_TEST_DATABASE_ADMIN_URL!;
    const scratchDatabase = `asi_analyst_research_${randomUUID().replaceAll("-", "")}`;
    let originalDatabaseUrl: string | undefined;
    let hadOriginalDatabaseUrl = false;

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
    }, 120_000);

    beforeEach(async () => {
      await getDatabase().execute(sql`
        TRUNCATE TABLE
          research_provider_cooldowns,
          research_provider_usage,
          research_provider_legacy_estimates,
          research_provider_budget_scope_signals,
          research_provider_budget_scopes,
          faa_review_model_usage,
          source_signals
        CASCADE
      `);
    });

    afterAll(async () => {
      await closeDatabase();
      await dropScratchDatabase(adminDatabaseUrl, scratchDatabase);
      if (hadOriginalDatabaseUrl) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      } else {
        delete process.env.DATABASE_URL;
      }
    }, 120_000);

    it("serializes case creation and allocates unique action sequences", async () => {
      await createMuseSignal("concurrent-case");
      const claim = await claimMuse();
      const [left, right] = await Promise.all([
        ensureSignalAnalystCase(getDatabase(), claim, {
          policyVersion: "analyst-policy-v1",
          inputHash: INPUT_HASH,
          limits: { maxSteps: 4 },
          initialCheckpoint: {},
        }),
        ensureSignalAnalystCase(getDatabase(), claim, {
          policyVersion: "analyst-policy-v1",
          inputHash: INPUT_HASH,
          limits: { maxSteps: 4 },
          initialCheckpoint: {},
        }),
      ]);
      expect(left.accepted).toBe(true);
      expect(right.accepted).toBe(true);
      const analystCase = left.accepted ? left.value : undefined;
      expect(analystCase).toBeDefined();

      const first = await beginSignalAnalystStep(
        getDatabase(),
        claim,
        analystCase!.id,
        { kind: "exa_search", request: { q: "ownership" }, requestHash: REQUEST_HASH },
      );
      const secondHash = createHash("sha256").update("second-request").digest("hex");
      const second = await beginSignalAnalystStep(
        getDatabase(),
        claim,
        analystCase!.id,
        { kind: "public_fetch", request: { url: "https://example.test" }, requestHash: secondHash },
      );
      expect(first.accepted && first.value.step.sequence).toBe(1);
      expect(second.accepted && second.value.step.sequence).toBe(2);
    });

    it("reuses completed actions after restart and retains the first late interrupted result", async () => {
      const signalId = await createMuseSignal("resume");
      const originalClaim = await claimMuse();
      const analystCase = await ensureCase(originalClaim);
      const completed = await beginSignalAnalystStep(
        getDatabase(),
        originalClaim,
        analystCase.id,
        { kind: "exa_search", request: { q: "products" }, requestHash: REQUEST_HASH },
      );
      if (!completed.accepted) throw new Error("expected completed step start");
      await finishSignalAnalystStep(getDatabase(), completed.value.step.id, {
        status: "completed",
        response: { results: ["evidence"] },
        costKnown: true,
        costUsd: "0",
      });
      const ambiguousHash = createHash("sha256").update("ambiguous-call").digest("hex");
      const ambiguous = await beginSignalAnalystStep(
        getDatabase(),
        originalClaim,
        analystCase.id,
        { kind: "exa_contents", request: { urls: ["https://example.test"] }, requestHash: ambiguousHash },
      );
      expect(ambiguous.accepted).toBe(true);
      if (!ambiguous.accepted) throw new Error("expected ambiguous step start");

      await getDatabase()
        .update(signalReviewState)
        .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(signalReviewState.signalId, originalClaim.signalId));
      const replacement = await claimMuse();
      await ensureCase(replacement);

      const reused = await beginSignalAnalystStep(
        getDatabase(),
        replacement,
        analystCase.id,
        { kind: "exa_search", request: { q: "products" }, requestHash: REQUEST_HASH },
      );
      expect(reused.accepted && reused.value.outcome).toBe("reused");
      expect(reused.accepted && reused.value.step.costUsd).toBe("0");

      const interrupted = await beginSignalAnalystStep(
        getDatabase(),
        replacement,
        analystCase.id,
        { kind: "exa_contents", request: { urls: ["https://example.test"] }, requestHash: ambiguousHash },
      );
      expect(interrupted.accepted && interrupted.value.outcome).toBe("interrupted");
      expect(interrupted.accepted && interrupted.value.step.costKnown).toBe(false);
      const retry = await beginSignalAnalystStep(
        getDatabase(),
        replacement,
        analystCase.id,
        { kind: "exa_contents", request: { urls: ["https://example.test"] }, requestHash: ambiguousHash },
      );
      expect(retry.accepted && retry.value.outcome).toBe("started");
      expect(retry.accepted && retry.value.step.sequence).toBe(3);
      if (!retry.accepted || retry.value.outcome !== "started") {
        throw new Error("expected replacement step");
      }
      await finishSignalAnalystStep(getDatabase(), retry.value.step.id, {
        status: "completed",
        response: { results: ["replacement"] },
        costKnown: false,
      });
      const modelUsageReceiptId = randomUUID();
      await getDatabase().insert(faaReviewModelUsage).values({
        id: modelUsageReceiptId,
        sourceSignalId: signalId,
        configuredModel: EXPECTED_REVIEW_CONTRACT.policy.museModel,
        returnedModel: EXPECTED_REVIEW_CONTRACT.policy.museModel,
        phase: "muse",
        promptVersion: "muse-agent-v1",
        inputHash: INPUT_HASH,
        costUsd: "0.007",
      });
      const late = await finishSignalAnalystStep(
        getDatabase(),
        ambiguous.value.step.id,
        {
          status: "completed",
          response: { results: ["late-original"] },
          modelUsageReceiptId,
          costKnown: true,
          costUsd: "0.007",
        },
      );
      expect(late).toMatchObject({
        outcome: "late_recorded",
        claimCurrent: false,
        step: {
          status: "late_result",
          observedStatus: "completed",
          response: { results: ["late-original"] },
          modelUsageReceiptId,
          costKnown: true,
          costUsd: "0.007",
        },
      });
      const duplicateLate = await finishSignalAnalystStep(
        getDatabase(),
        ambiguous.value.step.id,
        {
          status: "retryable_failure",
          error: "must not overwrite first late result",
          costKnown: true,
          costUsd: "99",
        },
      );
      expect(duplicateLate).toMatchObject({
        outcome: "already_finished",
        claimCurrent: false,
        step: {
          status: "late_result",
          response: { results: ["late-original"] },
          error: null,
          costUsd: "0.007",
        },
      });
    });

    it("keeps exhausted cases terminal for the same revision, policy, and input", async () => {
      await createMuseSignal("exhausted");
      const claim = await claimMuse();
      const analystCase = await ensureCase(claim);
      const exhausted = await checkpointSignalAnalystCase(
        getDatabase(),
        claim,
        analystCase.id,
        {
          checkpoint: { completedSteps: 4 },
          status: "exhausted",
          inputHash: INPUT_HASH,
          stopReason: "max_steps",
        },
      );
      expect(exhausted.accepted && exhausted.value.status).toBe("exhausted");

      const resumed = await ensureCase(claim);
      expect(resumed.status).toBe("exhausted");
      await expect(
        beginSignalAnalystStep(getDatabase(), claim, analystCase.id, {
          kind: "exa_search",
          request: { q: "must not run" },
          requestHash: createHash("sha256")
            .update("exhausted-request")
            .digest("hex"),
        }),
      ).rejects.toThrow();
      expect(
        await getDatabase()
          .select()
          .from(signalAnalystSteps)
          .where(eq(signalAnalystSteps.caseId, analystCase.id)),
      ).toHaveLength(0);
    });

    it("commits the terminal case memo only with the final review transition", async () => {
      const signalId = await createMuseSignal("atomic-completion");
      const claim = await claimMuse();
      const analystCase = await ensureCase(claim);
      const transition = {
        phase: "settled" as const,
        inputHash: INPUT_HASH,
        inputManifest: {
          version: EXPECTED_REVIEW_CONTRACT.version,
          sourceRevision: 0,
          policy: EXPECTED_REVIEW_CONTRACT.policy,
        },
      };
      await expect(
        commitSignalReview(getDatabase(), claim, transition, async (tx) => {
          await completeSignalAnalystCase(tx, claim, analystCase.id, {
            checkpoint: { final: true },
            memo: { summary: "must roll back" },
          });
          throw new Error("synthetic final publication failure");
        }),
      ).rejects.toThrow();
      const [afterFailure] = await getDatabase()
        .select()
        .from(signalAnalystCases)
        .where(eq(signalAnalystCases.id, analystCase.id));
      expect(afterFailure).toMatchObject({
        status: "active",
        memo: null,
      });

      const committed = await commitSignalReview(
        getDatabase(),
        claim,
        transition,
        (tx) =>
          completeSignalAnalystCase(tx, claim, analystCase.id, {
            checkpoint: { final: true },
            memo: { summary: "durable final memo" },
          }),
      );
      expect(committed.accepted).toBe(true);
      if (!committed.accepted) throw new Error("expected final review commit");
      expect(committed.value).toMatchObject({
        status: "completed",
        memo: { summary: "durable final memo" },
      });
      expect(committed.state).toMatchObject({
        signalId,
        phase: "settled",
      });
    });

    it("rejects stale checkpoints and evidence publication while retaining external receipts", async () => {
      const signalId = await createMuseSignal("stale-publication");
      const staleClaim = await claimMuse();
      const analystCase = await ensureCase(staleClaim);
      const { budgetScopeId } = await createProviderScope(
        "stale-publication",
        { sourceSignalIds: [signalId] },
      );
      const reservation = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId: signalId,
        budgetScopeId,
        requestHash: REQUEST_HASH,
        estimatedCostUsd: "0.01",
        dailyCapUsd: "1",
      });
      if (reservation.outcome !== "reserved") throw new Error("expected reservation");
      await settleResearchProviderUsage(
        getDatabase(),
        reservation.reservation.id,
        { status: "ambiguous", actualCostUsd: null, observedAt: new Date() },
      );

      await getDatabase()
        .update(sourceSignals)
        .set({ rawName: "Edited after claim" })
        .where(eq(sourceSignals.id, signalId));
      const checkpoint = await checkpointSignalAnalystCase(
        getDatabase(),
        staleClaim,
        analystCase.id,
        { checkpoint: { step: 1 }, status: "active", inputHash: INPUT_HASH },
      );
      expect(checkpoint).toEqual({ accepted: false });
      let callbackCalls = 0;
      const publication = await publishSignalAnalystEvidence(
        getDatabase(),
        staleClaim,
        analystCase.id,
        async () => {
          callbackCalls += 1;
          return {
            researchEvidence: { facts: ["new"] },
            outcome: { status: "checked" },
            checkpoint: { step: 2 },
            value: "persisted",
          };
        },
      );
      expect(publication).toEqual({ accepted: false });
      expect(callbackCalls).toBe(0);
      const receipts = await getDatabase().select().from(researchProviderUsage);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ status: "ambiguous", actualCostUsd: null });
      const [state] = await getDatabase()
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(state).toMatchObject({ phase: "research", sourceRevision: 1 });
    });

    it("publishes evidence and requeues Jev atomically under the current source fence", async () => {
      const signalId = await createMuseSignal("publication");
      const claim = await claimMuse();
      const analystCase = await ensureCase(claim);
      const published = await publishSignalAnalystEvidence(
        getDatabase(),
        claim,
        analystCase.id,
        async (tx) => {
          await tx
            .update(sourceSignals)
            .set({ updatedAt: new Date() })
            .where(eq(sourceSignals.id, signalId));
          return {
            researchEvidence: { admittedFacts: [{ field: "ownership" }] },
            outcome: { status: "new_evidence" },
            checkpoint: { completedQuestions: ["ownership"] },
            memo: { summary: "Ownership evidence found" },
            value: { evidenceIds: ["evidence-1"] },
          };
        },
      );
      expect(published.accepted).toBe(true);
      if (!published.accepted) return;
      expect(published.value.case.status).toBe("awaiting_review");
      expect(published.value.state).toMatchObject({
        phase: "jev",
        inputHash: null,
        inputManifest: null,
        jevEvaluationId: null,
        researchEvidence: { admittedFacts: [{ field: "ownership" }] },
      });
      expect(published.value.value).toEqual({ evidenceIds: ["evidence-1"] });
      expect(
        await readCurrentSignalAnalystCase(getDatabase(), signalId, {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        }),
      ).toMatchObject({
        case: {
          status: "awaiting_review",
          memo: { summary: "Ownership evidence found" },
        },
        current: false,
        episodeCurrent: true,
        superseded: false,
        currentTriage: null,
      });
    });

    it("binds new provider reservations to an executable step and reuses a prior reservation across UTC days", async () => {
      const caseSignalId = await createMuseSignal("reservation-binding");
      const otherSignalId = randomUUID();
      await getDatabase().insert(sourceSignals).values({
        id: otherSignalId,
        sourceKey: "faa_pma_database",
        sourceLocator: `reservation-binding:other:${otherSignalId}`,
        sourceFingerprint: `reservation-binding:other:${otherSignalId}`,
        rawName: "Reservation Binding Other",
      });
      const claim = await claimMuse();
      const analystCase = await ensureCase(claim);
      const first = await beginSignalAnalystStep(
        getDatabase(),
        claim,
        analystCase.id,
        {
          kind: "exa_search",
          request: { q: "binding" },
          requestHash: REQUEST_HASH,
        },
      );
      const staleRequestHash = createHash("sha256")
        .update("stale-provider-step")
        .digest("hex");
      const stale = await beginSignalAnalystStep(
        getDatabase(),
        claim,
        analystCase.id,
        {
          kind: "exa_contents",
          request: { urls: ["https://example.test/stale"] },
          requestHash: staleRequestHash,
        },
      );
      const completedRequestHash = createHash("sha256")
        .update("completed-provider-step")
        .digest("hex");
      const completed = await beginSignalAnalystStep(
        getDatabase(),
        claim,
        analystCase.id,
        {
          kind: "exa_search",
          request: { q: "already completed" },
          requestHash: completedRequestHash,
        },
      );
      if (!first.accepted || !stale.accepted || !completed.accepted) {
        throw new Error("expected provider action steps");
      }
      await finishSignalAnalystStep(getDatabase(), completed.value.step.id, {
        status: "completed",
        response: { results: [] },
        costKnown: false,
      });
      const { budgetScopeId } = await createProviderScope("step-binding", {
        sourceSignalIds: [caseSignalId, otherSignalId],
      });
      await expect(
        reserveResearchProviderUsage(getDatabase(), {
          provider: "exa",
          operation: "search",
          sourceSignalId: otherSignalId,
          analystStepId: first.value.step.id,
          budgetScopeId,
          requestHash: REQUEST_HASH,
          estimatedCostUsd: "0.1",
          dailyCapUsd: "10",
          now: new Date("2040-05-01T12:00:00.000Z"),
        }),
      ).rejects.toThrow();
      expect(await getDatabase().select().from(researchProviderUsage)).toHaveLength(0);
      await expect(
        reserveResearchProviderUsage(getDatabase(), {
          provider: "exa",
          operation: "search",
          sourceSignalId: caseSignalId,
          analystStepId: completed.value.step.id,
          budgetScopeId,
          requestHash: completedRequestHash,
          estimatedCostUsd: "0.1",
          dailyCapUsd: "10",
          now: new Date("2040-05-01T12:00:00.000Z"),
        }),
      ).rejects.toThrow();
      expect(await getDatabase().select().from(researchProviderUsage)).toHaveLength(0);

      const wireRequestHash = createHash("sha256")
        .update("wire-provider-request")
        .digest("hex");
      const reserved = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId: caseSignalId,
        analystStepId: first.value.step.id,
        budgetScopeId,
        analystRequestHash: REQUEST_HASH,
        requestHash: wireRequestHash,
        estimatedCostUsd: "0.1",
        dailyCapUsd: "10",
        now: new Date("2040-05-01T12:00:00.000Z"),
      });
      if (reserved.outcome !== "reserved") throw new Error("expected reservation");
      await getDatabase()
        .update(signalReviewState)
        .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(signalReviewState.signalId, caseSignalId));
      const reused = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId: caseSignalId,
        analystStepId: first.value.step.id,
        budgetScopeId,
        analystRequestHash: REQUEST_HASH,
        requestHash: wireRequestHash,
        estimatedCostUsd: "0.1",
        dailyCapUsd: "10",
        now: new Date("2040-05-02T12:00:00.000Z"),
      });
      expect(reused).toMatchObject({
        outcome: "reserved",
        reused: true,
        reservation: {
          id: reserved.reservation.id,
          requestHash: wireRequestHash,
          usageDay: "2040-05-01",
        },
      });
      const replacement = await claimMuse();
      await ensureCase(replacement);
      const interrupted = await beginSignalAnalystStep(
        getDatabase(),
        replacement,
        analystCase.id,
        {
          kind: "exa_contents",
          request: { urls: ["https://example.test/stale"] },
          requestHash: staleRequestHash,
        },
      );
      expect(interrupted.accepted && interrupted.value.outcome).toBe(
        "interrupted",
      );
      await expect(
        reserveResearchProviderUsage(getDatabase(), {
          provider: "exa",
          operation: "contents",
          sourceSignalId: caseSignalId,
          analystStepId: stale.value.step.id,
          budgetScopeId,
          requestHash: staleRequestHash,
          estimatedCostUsd: "0.1",
          dailyCapUsd: "10",
          now: new Date("2040-05-02T12:00:00.000Z"),
        }),
      ).rejects.toThrow();
      expect(await getDatabase().select().from(researchProviderUsage)).toHaveLength(1);
    });

    it("serializes reservations, defers over-budget work, and counts unknown actuals conservatively", async () => {
      const now = new Date("2040-04-05T12:00:00.000Z");
      const { budgetScopeId, sourceSignalId } =
        await createProviderScope("concurrent-budget");
      const [left, right] = await Promise.all([
        reserveResearchProviderUsage(getDatabase(), {
          provider: "exa",
          operation: "search",
          sourceSignalId,
          budgetScopeId,
          requestHash: createHash("sha256").update("left").digest("hex"),
          estimatedCostUsd: "0.6",
          dailyCapUsd: "1",
          now,
        }),
        reserveResearchProviderUsage(getDatabase(), {
          provider: "exa",
          operation: "search",
          sourceSignalId,
          budgetScopeId,
          requestHash: createHash("sha256").update("right").digest("hex"),
          estimatedCostUsd: "0.6",
          dailyCapUsd: "1",
          now,
        }),
      ]);
      expect([left.outcome, right.outcome].sort()).toEqual(["deferred", "reserved"]);
      const admitted = left.outcome === "reserved" ? left : right;
      if (admitted.outcome !== "reserved") throw new Error("expected one reservation");
      await settleResearchProviderUsage(getDatabase(), admitted.reservation.id, {
        status: "failed",
        actualCostUsd: null,
        observedAt: now,
        error: "provider outcome unknown",
      });
      const deferred = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "contents",
        sourceSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("third").digest("hex"),
        estimatedCostUsd: "0.5",
        dailyCapUsd: "1",
        now,
      });
      expect(deferred).toMatchObject({
        outcome: "deferred",
        committedCostUsd: "0.6",
        retryAt: new Date("2040-04-06T00:00:00.000Z"),
      });
    });

    it("enforces an immutable aggregate scope and exact source allowlist across UTC days", async () => {
      const allowedSignalId = randomUUID();
      const deniedSignalId = randomUUID();
      for (const [id, label] of [
        [allowedSignalId, "allowed"],
        [deniedSignalId, "denied"],
      ] as const) {
        await getDatabase().insert(sourceSignals).values({
          id,
          sourceKey: "faa_pma_database",
          sourceLocator: `aggregate-scope:${label}:${id}`,
          sourceFingerprint: `aggregate-scope:${label}:${id}`,
          rawName: `Aggregate Scope ${label}`,
        });
      }
      const { budgetScopeId } = await createProviderScope("aggregate", {
        sourceSignalIds: [allowedSignalId],
        totalCapUsd: "1",
      });
      await expect(
        getDatabase()
          .update(researchProviderBudgetScopes)
          .set({ totalCapUsd: "2" })
          .where(eq(researchProviderBudgetScopes.id, budgetScopeId)),
      ).rejects.toThrow();
      await expect(
        getDatabase().insert(researchProviderBudgetScopeSignals).values({
          budgetScopeId,
          sourceSignalId: deniedSignalId,
        }),
      ).rejects.toThrow();
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          budgetScopeId,
          new Date("2042-02-01T12:00:00.000Z"),
        ),
      ).toMatchObject({
        scope: { totalCapUsd: "1", permitStatus: "active" },
        allowlistedSourceSignalIds: [allowedSignalId],
      });
      const denied = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId: deniedSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("denied").digest("hex"),
        estimatedCostUsd: "0.1",
        dailyCapUsd: "10",
        now: new Date("2042-02-01T12:00:00.000Z"),
      });
      expect(denied).toMatchObject({
        outcome: "deferred",
        reason: "source_not_permitted",
        retryAt: null,
      });

      const first = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId: allowedSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("aggregate-first").digest("hex"),
        estimatedCostUsd: "0.6",
        dailyCapUsd: "10",
        now: new Date("2042-02-01T12:00:00.000Z"),
      });
      if (first.outcome !== "reserved") throw new Error("expected first reservation");
      await settleResearchProviderUsage(getDatabase(), first.reservation.id, {
        status: "ambiguous",
        actualCostUsd: null,
        observedAt: new Date("2042-02-01T12:01:00.000Z"),
      });
      const overScope = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "contents",
        sourceSignalId: allowedSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("aggregate-next-day").digest("hex"),
        estimatedCostUsd: "0.5",
        dailyCapUsd: "10",
        now: new Date("2042-02-02T12:00:00.000Z"),
      });
      expect(overScope).toMatchObject({
        outcome: "deferred",
        reason: "scope_cap_exceeded",
        committedCostUsd: "0.6",
        totalCapUsd: "1",
      });
      const view = await readResearchProviderBudgetScope(
        getDatabase(),
        budgetScopeId,
        new Date("2042-02-02T12:00:00.000Z"),
      );
      expect(view).toMatchObject({
        status: "active",
        allowlistedSourceSignalIds: [allowedSignalId],
        knownActualCostUsd: "0",
        unknownEstimatedCostUsd: "0.6",
        committedCostUsd: "0.6",
        remainingCostUsd: "0.4",
        receiptCount: 1,
      });

      const zeroScope = await createProviderScope("zero-allowance", {
        sourceSignalIds: [allowedSignalId],
        totalCapUsd: "0",
      });
      const zeroDenied = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId: allowedSignalId,
        budgetScopeId: zeroScope.budgetScopeId,
        requestHash: createHash("sha256").update("zero-allowance").digest("hex"),
        estimatedCostUsd: "0.0001",
        dailyCapUsd: "10",
        now: new Date("2042-02-02T12:00:00.000Z"),
      });
      expect(zeroDenied).toMatchObject({
        outcome: "deferred",
        reason: "scope_cap_exceeded",
        totalCapUsd: "0",
      });
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          zeroScope.budgetScopeId,
          new Date("2042-02-02T12:00:00.000Z"),
        ),
      ).toMatchObject({ status: "exhausted", remainingCostUsd: "0" });

      await setResearchProviderBudgetPermit(getDatabase(), budgetScopeId, {
        status: "closed",
        observedAt: new Date("2042-02-02T12:01:00.000Z"),
      });
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          budgetScopeId,
          new Date("2042-02-02T12:01:00.000Z"),
        ),
      ).toMatchObject({ status: "closed" });
      await expect(
        setResearchProviderBudgetPermit(getDatabase(), budgetScopeId, {
          status: "active",
          observedAt: new Date("2042-02-02T12:02:00.000Z"),
        }),
      ).rejects.toThrow();
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          budgetScopeId,
          new Date("2042-02-02T12:02:00.000Z"),
        ),
      ).toMatchObject({ status: "closed" });
    });

    it("seals 1,001 source memberships atomically and keeps a matching retry idempotent", async () => {
      const sourceSignalIds = Array.from({ length: 1_001 }, () => randomUUID());
      for (let index = 0; index < sourceSignalIds.length; index += 250) {
        const chunk = sourceSignalIds.slice(index, index + 250);
        await getDatabase()
          .insert(sourceSignals)
          .values(
            chunk.map((id) => ({
              id,
              sourceKey: "faa_pma_database",
              sourceLocator: `membership-boundary:${id}`,
              sourceFingerprint: `membership-boundary:${id}`,
              rawName: "Membership Boundary",
            })),
          );
      }
      const scope = {
        id: "analyst-test:membership-boundary",
        provider: "exa",
        startsAt: new Date("2042-03-01T00:00:00.000Z"),
        totalCapUsd: "1",
        permitStatus: "paused" as const,
        allowlistedSourceSignalIds: sourceSignalIds,
      };
      await createResearchProviderBudgetScope(getDatabase(), scope);
      await expect(
        createResearchProviderBudgetScope(getDatabase(), scope),
      ).resolves.toMatchObject({ id: scope.id });
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          scope.id,
          new Date("2042-03-01T00:00:00.000Z"),
        ),
      ).toMatchObject({
        allowlistedSourceSignalIds: [...sourceSignalIds].sort(),
      });

      const missingSourceScope = {
        ...scope,
        id: "analyst-test:membership-boundary-rollback",
        allowlistedSourceSignalIds: [
          ...sourceSignalIds.slice(0, 1_000),
          randomUUID(),
        ],
      };
      await expect(
        createResearchProviderBudgetScope(getDatabase(), missingSourceScope),
      ).rejects.toThrow(/does not exist/iu);
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          missingSourceScope.id,
          new Date("2042-03-01T00:00:00.000Z"),
        ),
      ).toBeNull();
    });

    it("pauses a scope when an actual exceeds its reservation bound below the total cap", async () => {
      const { budgetScopeId, sourceSignalId } = await createProviderScope(
        "observed-overage",
        { totalCapUsd: "2" },
      );
      const reserved = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("observed-overage").digest("hex"),
        estimatedCostUsd: "0.6",
        dailyCapUsd: "10",
        now: new Date("2042-03-02T00:00:00.000Z"),
      });
      if (reserved.outcome !== "reserved") throw new Error("expected reservation");
      await settleResearchProviderUsage(getDatabase(), reserved.reservation.id, {
        status: "succeeded",
        actualCostUsd: "1.2",
        observedAt: new Date("2042-03-02T00:01:00.000Z"),
      });
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          budgetScopeId,
          new Date("2042-03-02T00:02:00.000Z"),
        ),
      ).toMatchObject({
        scope: { permitStatus: "paused" },
        knownActualCostUsd: "1.2",
        unknownEstimatedCostUsd: "0",
        committedCostUsd: "1.2",
        remainingBeforeFloorUsd: "0.8",
        remainingCostUsd: "0.8",
      });
      expect(
        await getDatabase()
          .select()
          .from(researchProviderUsage)
          .where(eq(researchProviderUsage.id, reserved.reservation.id)),
      ).toMatchObject([{ actualCostUsd: "1.2", estimatedCostUsd: "0.6" }]);
    });

    it("closes a scope and creates only its floored $5 remainder", async () => {
      const oldSourceSignalId = randomUUID();
      const newSourceSignalId = randomUUID();
      await getDatabase().insert(sourceSignals).values([
        {
          id: oldSourceSignalId,
          sourceKey: "faa_pma_database",
          sourceLocator: `cutover-old:${oldSourceSignalId}`,
          sourceFingerprint: `cutover-old:${oldSourceSignalId}`,
          rawName: "Cutover Old",
        },
        {
          id: newSourceSignalId,
          sourceKey: "faa_pma_database",
          sourceLocator: `cutover-new:${newSourceSignalId}`,
          sourceFingerprint: `cutover-new:${newSourceSignalId}`,
          rawName: "Cutover New",
        },
      ]);
      await createResearchProviderBudgetScope(getDatabase(), {
        id: "analyst-test:cutover-old",
        provider: "exa",
        startsAt: new Date("2042-03-03T00:00:00.000Z"),
        totalCapUsd: "5",
        permitStatus: "active",
        allowlistedSourceSignalIds: [oldSourceSignalId],
      });
      const reservation = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId: oldSourceSignalId,
        budgetScopeId: "analyst-test:cutover-old",
        requestHash: createHash("sha256").update("cutover-known").digest("hex"),
        estimatedCostUsd: "1",
        dailyCapUsd: "10",
        now: new Date("2042-03-03T00:01:00.000Z"),
      });
      if (reservation.outcome !== "reserved") throw new Error("expected reservation");
      await settleResearchProviderUsage(getDatabase(), reservation.reservation.id, {
        status: "succeeded",
        actualCostUsd: "1.25",
        observedAt: new Date("2042-03-03T00:02:00.000Z"),
      });
      const cutover = await cutoverResearchProviderBudgetScope(getDatabase(), {
        oldBudgetScopeId: "analyst-test:cutover-old",
        authorizedCapUsd: "5",
        observedAt: new Date("2042-03-03T00:03:00.000Z"),
        newScope: {
          id: "analyst-test:cutover-new",
          provider: "exa",
          startsAt: new Date("2042-03-03T00:04:00.000Z"),
          allowlistedSourceSignalIds: [newSourceSignalId],
        },
      });
      expect(cutover).toMatchObject({
        closedScope: { permitStatus: "closed" },
        newScope: { permitStatus: "paused", totalCapUsd: "3.75" },
        knownActualCostUsd: "1.25",
        unknownEstimatedCostUsd: "0",
        remainingCapUsd: "3.75",
      });
      expect(
        await getDatabase()
          .select()
          .from(researchProviderUsage)
          .where(eq(researchProviderUsage.budgetScopeId, "analyst-test:cutover-new")),
      ).toEqual([]);
      await expect(
        cutoverResearchProviderBudgetScope(getDatabase(), {
          oldBudgetScopeId: "analyst-test:cutover-old",
          authorizedCapUsd: "5",
          observedAt: new Date("2042-03-03T00:05:00.000Z"),
          newScope: {
            id: "analyst-test:cutover-minted",
            provider: "exa",
            startsAt: new Date("2042-03-03T00:06:00.000Z"),
            allowlistedSourceSignalIds: [newSourceSignalId],
          },
        }),
      ).rejects.toThrow(/closed provider budget scope/iu);
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          "analyst-test:cutover-minted",
          new Date("2042-03-03T00:06:00.000Z"),
        ),
      ).toBeNull();
    });

    it("persists provider-wide quota cooldown independently of app caps", async () => {
      const { budgetScopeId, sourceSignalId } =
        await createProviderScope("cooldown");
      const observedAt = new Date("2043-03-04T10:00:00.000Z");
      const retryAt = new Date("2043-03-04T12:00:00.000Z");
      const first = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("cooldown-first").digest("hex"),
        estimatedCostUsd: "0.1",
        dailyCapUsd: "10",
        now: observedAt,
      });
      if (first.outcome !== "reserved") throw new Error("expected cooldown reservation");
      await settleResearchProviderUsage(getDatabase(), first.reservation.id, {
        status: "failed",
        actualCostUsd: null,
        observedAt,
        error: "HTTP 402 credits exhausted",
        providerCooldown: { reason: "credits_exhausted", retryAt },
      });
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          budgetScopeId,
          new Date("2043-03-04T11:00:00.000Z"),
        ),
      ).toMatchObject({
        providerCooldown: {
          reason: "credits_exhausted",
          retryAt,
        },
      });
      expect(
        await readResearchProviderBudgetScope(
          getDatabase(),
          budgetScopeId,
          new Date("2043-03-04T12:00:01.000Z"),
        ),
      ).toMatchObject({ providerCooldown: null });
      const blocked = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "contents",
        sourceSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("cooldown-blocked").digest("hex"),
        estimatedCostUsd: "0.1",
        dailyCapUsd: "10",
        now: new Date("2043-03-04T11:00:00.000Z"),
      });
      expect(blocked).toMatchObject({
        outcome: "deferred",
        reason: "provider_cooldown",
        cooldownReason: "credits_exhausted",
        retryAt,
      });
      const resumed = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "contents",
        sourceSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("cooldown-resumed").digest("hex"),
        estimatedCostUsd: "0.1",
        dailyCapUsd: "10",
        now: new Date("2043-03-04T12:00:01.000Z"),
      });
      expect(resumed.outcome).toBe("reserved");
    });

    it("preserves known zero, unknown cost, and idempotent legacy estimate baselines", async () => {
      const now = new Date("2041-01-02T03:00:00.000Z");
      const { budgetScopeId, sourceSignalId } =
        await createProviderScope("known-zero");
      const imported = await importLegacyResearchProviderEstimate(getDatabase(), {
        provider: "exa",
        utcDay: "2041-01-02",
        estimatedCostUsd: "0.25",
        idempotencyKey: "exa-file-ledger:2041-01-02",
        importedAt: now,
      });
      const replayed = await importLegacyResearchProviderEstimate(getDatabase(), {
        provider: "exa",
        utcDay: "2041-01-02",
        estimatedCostUsd: "0.2500",
        idempotencyKey: "exa-file-ledger:2041-01-02",
        importedAt: new Date("2041-01-03T00:00:00.000Z"),
      });
      expect(imported.outcome).toBe("imported");
      expect(replayed.outcome).toBe("existing");
      expect(await getDatabase().select().from(researchProviderLegacyEstimates)).toHaveLength(1);

      const zeroReservation = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "search",
        sourceSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("known-zero").digest("hex"),
        estimatedCostUsd: "0.1",
        dailyCapUsd: "1",
        now,
      });
      if (zeroReservation.outcome !== "reserved") throw new Error("expected reservation");
      const knownZero = await settleResearchProviderUsage(
        getDatabase(),
        zeroReservation.reservation.id,
        { status: "failed", actualCostUsd: "0", observedAt: now },
      );
      expect(knownZero.actualCostUsd).toBe("0");
      const afterZero = await reserveResearchProviderUsage(getDatabase(), {
        provider: "exa",
        operation: "contents",
        sourceSignalId,
        budgetScopeId,
        requestHash: createHash("sha256").update("after-zero").digest("hex"),
        estimatedCostUsd: "0.75",
        dailyCapUsd: "1",
        now,
      });
      expect(afterZero.outcome).toBe("reserved");
    });

    it("requires a complete expected-contract Jev proof before marking a case current", async () => {
      const signalId = await createMuseSignal("current-proof");
      const claim = await claimMuse();
      await ensureCase(claim);
      const evaluationId = randomUUID();
      const inputManifest = {
        version: EXPECTED_REVIEW_CONTRACT.version,
        sourceRevision: 0,
        policy: EXPECTED_REVIEW_CONTRACT.policy,
      };
      await getDatabase().insert(faaEnsembleEvaluations).values({
        id: evaluationId,
        signalId,
        modelId: EXPECTED_REVIEW_CONTRACT.policy.jevModel,
        promptVersion: "jev-ladder-rung-prompt",
        inputHash: INPUT_HASH,
        inputManifest,
        rawResponse: "{}",
        parsed: {
          version: "jev-triage-v1",
          decision: "research",
          confidence: null,
          productFit: "unknown",
          acquisitionReadiness: "needs_research",
          researchPriority: 2,
          reasonCodes: [],
          explanation: "current proof fixture",
          observations: [],
          gaps: [],
        },
        decision: "research",
        error: null,
      });
      await getDatabase()
        .update(signalReviewState)
        .set({
          phase: "muse",
          inputHash: INPUT_HASH,
          inputManifest,
          jevEvaluationId: evaluationId,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(signalReviewState.signalId, signalId));
      const read = () =>
        readCurrentSignalAnalystCase(getDatabase(), signalId, {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        });
      expect(await read()).toMatchObject({
        current: true,
        episodeCurrent: true,
        currentTriage: { id: evaluationId },
      });

      await getDatabase()
        .update(faaEnsembleEvaluations)
        .set({ error: "parse failed" })
        .where(eq(faaEnsembleEvaluations.id, evaluationId));
      expect(await read()).toMatchObject({
        current: false,
        episodeCurrent: true,
        currentTriage: null,
      });
      await getDatabase()
        .update(faaEnsembleEvaluations)
        .set({
          error: null,
          modelId: "wrong-jev-model",
        })
        .where(eq(faaEnsembleEvaluations.id, evaluationId));
      expect(await read()).toMatchObject({ current: false, currentTriage: null });
      await getDatabase()
        .update(faaEnsembleEvaluations)
        .set({
          modelId: EXPECTED_REVIEW_CONTRACT.policy.jevModel,
          decision: null,
        })
        .where(eq(faaEnsembleEvaluations.id, evaluationId));
      expect(await read()).toMatchObject({ current: false, currentTriage: null });
      await getDatabase()
        .update(faaEnsembleEvaluations)
        .set({ decision: "research" })
        .where(eq(faaEnsembleEvaluations.id, evaluationId));
      await getDatabase()
        .update(signalReviewState)
        .set({ inputHash: null, inputManifest: null })
        .where(eq(signalReviewState.signalId, signalId));
      expect(await read()).toMatchObject({
        current: false,
        episodeCurrent: true,
        superseded: false,
        currentTriage: null,
      });
      const changedHash = createHash("sha256")
        .update("changed-review-policy")
        .digest("hex");
      await getDatabase()
        .update(signalReviewState)
        .set({
          inputHash: changedHash,
          inputManifest: {
            ...inputManifest,
            policy: {
              ...EXPECTED_REVIEW_CONTRACT.policy,
              analyst: "analyst-policy-v2",
            },
          },
        })
        .where(eq(signalReviewState.signalId, signalId));
      expect(await read()).toMatchObject({
        current: false,
        episodeCurrent: true,
        currentTriage: null,
      });
    });

    it("returns bounded current/history views and raw signals with no company or case", async () => {
      const signalId = await createMuseSignal("read-model");
      const claim = await claimMuse();
      const analystCase = await ensureCase(claim);
      const { budgetScopeId } = await createProviderScope("case-spend", {
        sourceSignalIds: [signalId],
      });
      for (let index = 0; index < 3; index += 1) {
        const requestHash = createHash("sha256").update(`history-${index}`).digest("hex");
        const started = await beginSignalAnalystStep(
          getDatabase(),
          claim,
          analystCase.id,
          { kind: "safe_fetch", request: { index }, requestHash },
        );
        if (!started.accepted) throw new Error("expected history step");
        let modelUsageReceiptId: string | null = null;
        if (index < 2) {
          modelUsageReceiptId = randomUUID();
          await getDatabase().insert(faaReviewModelUsage).values({
            id: modelUsageReceiptId,
            sourceSignalId: signalId,
            configuredModel: EXPECTED_REVIEW_CONTRACT.policy.museModel,
            returnedModel: EXPECTED_REVIEW_CONTRACT.policy.museModel,
            phase: "muse",
            promptVersion: "muse-agent-v1",
            inputHash: INPUT_HASH,
            costUsd: index === 0 ? "0.011" : null,
          });
        }
        if (index < 2) {
          const provider = await reserveResearchProviderUsage(getDatabase(), {
            provider: "exa",
            operation: "contents",
            sourceSignalId: signalId,
            analystStepId: started.value.step.id,
            budgetScopeId,
            requestHash,
            estimatedCostUsd: index === 0 ? "0.02" : "0.013",
            dailyCapUsd: "1",
            now: new Date("2044-01-01T00:00:00.000Z"),
          });
          if (provider.outcome !== "reserved") {
            throw new Error("expected case provider reservation");
          }
          await settleResearchProviderUsage(
            getDatabase(),
            provider.reservation.id,
            {
              status: index === 0 ? "succeeded" : "ambiguous",
              actualCostUsd: index === 0 ? "0.007" : null,
              observedAt: new Date("2044-01-01T00:00:01.000Z"),
            },
          );
        }
        await finishSignalAnalystStep(getDatabase(), started.value.step.id, {
          status: "retryable_failure",
          error: "temporary",
          modelUsageReceiptId,
          costKnown: false,
        });
      }
      const current = await readCurrentSignalAnalystCase(getDatabase(), signalId, {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        stepLimit: 2,
      });
      expect(current).toMatchObject({
        episodeCurrent: true,
        superseded: false,
        hasMoreSteps: true,
      });
      expect(current?.steps.map((step) => step.sequence)).toEqual([3, 2]);
      expect(current?.providerUsage).toHaveLength(1);
      expect(current?.providerSpend).toEqual({
        knownActualCostUsd: "0.007",
        unknownEstimatedCostUsd: "0.013",
        receiptCount: 2,
        unknownReceiptCount: 1,
      });
      expect(current?.modelUsage).toHaveLength(1);
      expect(current?.modelSpend).toEqual({
        knownActualCostUsd: "0.011",
        receiptCount: 2,
        unknownReceiptCount: 1,
      });
      const history = await readSignalAnalystCaseHistory(getDatabase(), signalId, {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        caseLimit: 1,
        stepLimitPerCase: 1,
      });
      expect(history).toHaveLength(1);
      expect(history[0]?.steps).toHaveLength(1);

      const noCaseId = randomUUID();
      await getDatabase().insert(sourceSignals).values({
        id: noCaseId,
        sourceKey: "sam_entity",
        sourceLocator: `analyst-read:${noCaseId}`,
        sourceFingerprint: `analyst-read:${noCaseId}`,
        rawName: "Unreviewed raw signal",
      });
      const overview = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        limit: 10,
      });
      expect(overview.items.map((item) => item.signal.id)).toContain(noCaseId);
      expect(overview.items.find((item) => item.signal.id === noCaseId)).toMatchObject({
        review: null,
        currentTriage: null,
        currentCase: null,
      });
    });

    it("paginates every signal sharing a sub-millisecond import timestamp", async () => {
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const createdAt = "2050-06-07T08:09:10.123456Z";
      for (const [index, id] of ids.entries()) {
        await getDatabase().execute(sql`
          INSERT INTO source_signals (
            id,
            source_key,
            source_locator,
            source_fingerprint,
            raw_name,
            created_at,
            updated_at
          ) VALUES (
            ${id}::uuid,
            'faa_pma_database',
            ${`microsecond-page:${index}`},
            ${`microsecond-page:${id}`},
            ${`Microsecond Page ${index}`},
            ${createdAt}::timestamptz,
            ${createdAt}::timestamptz
          )
        `);
      }

      const seen: string[] = [];
      let after: SourceSignalAnalystOverviewCursor | undefined;
      let firstCursor: SourceSignalAnalystOverviewCursor | undefined;
      do {
        const page = await listSourceSignalAnalystOverviews(getDatabase(), {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
          limit: 1,
          ...(after === undefined ? {} : { after }),
        });
        expect(page.items).toHaveLength(1);
        seen.push(page.items[0]!.signal.id);
        after = page.nextCursor ?? undefined;
        firstCursor ??= after;
        if (after !== undefined) {
          expect(after.createdAt).toBe(createdAt);
        }
      } while (after !== undefined);

      expect(new Set(seen)).toEqual(new Set(ids));
      expect(seen).toHaveLength(ids.length);
      await expect(
        listSourceSignalAnalystOverviews(getDatabase(), {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
          sort: "newest",
          limit: 1,
          after: firstCursor!,
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        listSourceSignalAnalystOverviews(getDatabase(), {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
          q: "different query",
          limit: 1,
          after: firstCursor!,
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        listSourceSignalAnalystOverviews(getDatabase(), {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
          limit: 1,
          after: {
            ...firstCursor!,
            createdAt: "0000-01-01T00:00:00.000000Z",
          },
        }),
      ).rejects.toThrow(TypeError);
    });

    it("ranks the whole matching dataset before limiting and applies literal filters and explicit scopes", async () => {
      const newestUnknown = await createRankingSignal("newest-unknown", {
        createdAt: "2051-01-01T00:00:00.000003Z",
        rawName: "Newest Unknown",
      });
      await createRankingSignal("newer-unknown", {
        createdAt: "2051-01-01T00:00:00.000002Z",
      });
      const olderPriority = await createRankingSignal("older-priority", {
        createdAt: "2001-01-01T00:00:00.000001Z",
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
        acquisitionReadiness: "ready",
        jevDecision: "high_priority",
        rawName: "Older % Priority",
        rawDomain: "older-priority.example",
      });

      const priority = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        limit: 1,
      });
      expect(priority.items.map((item) => item.signal.id)).toEqual([
        olderPriority,
      ]);
      expect(priority.items[0]?.ranking).toMatchObject({
        policyVersion: "investor-research-priority-v1",
        status: "ranked",
        score: 90,
      });
      const newestPage = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        sort: "newest",
        limit: 1,
      });
      expect(newestPage.items[0]?.signal.id).toBe(newestUnknown);
      const literalSearch = await listSourceSignalAnalystOverviews(
        getDatabase(),
        {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
          q: "%",
          readiness: "ready",
          limit: 10,
        },
      );
      expect(literalSearch.items.map((item) => item.signal.id)).toEqual([
        olderPriority,
      ]);
      expect(
        await listSourceSignalAnalystOverviews(getDatabase(), {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
          sourceSignalIds: [],
        }),
      ).toEqual({ items: [], nextCursor: null });
      expect(
        (
          await listSourceSignalAnalystOverviews(getDatabase(), {
            expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
            sourceSignalIds: [newestUnknown, olderPriority],
            readiness: "needs_research",
          })
        ).items.map((item) => item.signal.id),
      ).toEqual([newestUnknown]);
    });

    it("keeps unknown facts ranked without raw-field points and reserves exclusion for current source blockers", async () => {
      const unknown = await createRankingSignal("unknown-facts", {
        rawName: "Unknown Facts",
        city: "Wichita",
        state: "KS",
        country: "US",
        sourcePayload: {
          employeeCount: 12,
          facilitySquareFeet: 8_000,
          annualAwardValue: 1_000_000,
        },
      });
      const provisional = await createRankingSignal("provisional-fit", {
        productFit: "plausible_supplier",
      });
      const excludedEvidence: RankingEvidence = {
        ...FULL_RANKING_EVIDENCE,
        ownershipStatus: "acquired",
      };
      const excluded = await createRankingSignal("source-excluded", {
        evidence: excludedEvidence,
        productFit: "supported_product",
        acquisitionReadiness: "blocked",
      });
      const page = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        sourceSignalIds: [unknown, provisional, excluded],
      });
      const unknownRanking = page.items.find(
        (item) => item.signal.id === unknown,
      )?.ranking;
      expect(unknownRanking).toMatchObject({ status: "ranked", score: 0 });
      expect(
        unknownRanking?.breakdown
          .filter((item) =>
            ["headquarters", "ownership", "revenue"].includes(item.key),
          )
          .map((item) => item.points),
      ).toEqual([0, 0, 0]);
      const provisionalRanking = page.items.find(
        (item) => item.signal.id === provisional,
      )?.ranking;
      expect(provisionalRanking).toMatchObject({ status: "ranked", score: 15 });
      expect(
        provisionalRanking?.breakdown.find(
          (item) => item.key === "product_fit",
        ),
      ).toMatchObject({ points: 15, basis: "hypothesis" });
      const excludedRanking = page.items.find(
        (item) => item.signal.id === excluded,
      )?.ranking;
      expect(excludedRanking).toMatchObject({
        status: "excluded",
        score: 0,
      });
      expect(
        excludedRanking?.breakdown.reduce(
          (total, item) => total + item.points,
          0,
        ),
      ).toBe(80);
    });

    it("unscored stale proofs and malformed triage without changing decisions", async () => {
      const changedHash = createHash("sha256")
        .update("ranking-stale-hash")
        .digest("hex");
      const sourceStale = await createRankingSignal("source-stale", {
        signalRevision: 1,
        stateRevision: 0,
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
      });
      const modelStale = await createRankingSignal("model-stale", {
        jevModel: "wrong-model",
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
      });
      const policyStale = await createRankingSignal("policy-stale", {
        manifestPolicy: { ladder: "wrong-policy" },
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
      });
      const hashStale = await createRankingSignal("hash-stale", {
        evaluationInputHash: changedHash,
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
      });
      const malformedProof = await createRankingSignal("malformed-proof", {
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
      });
      const incompleteManifest = {
        version: EXPECTED_REVIEW_CONTRACT.version,
        sourceRevision: 0,
      };
      await getDatabase()
        .update(signalReviewState)
        .set({ inputManifest: incompleteManifest })
        .where(eq(signalReviewState.signalId, malformedProof));
      await getDatabase()
        .update(faaEnsembleEvaluations)
        .set({ inputManifest: incompleteManifest })
        .where(eq(faaEnsembleEvaluations.signalId, malformedProof));
      const missingConfidence = await createRankingSignal(
        "missing-triage-confidence",
        {
          evidence: FULL_RANKING_EVIDENCE,
          productFit: "supported_product",
        },
      );
      await getDatabase()
        .update(faaEnsembleEvaluations)
        .set({
          parsed: {
            version: "jev-triage-v1",
            decision: "research",
            productFit: "supported_product",
            acquisitionReadiness: "needs_research",
            researchPriority: 2,
            reasonCodes: [],
            explanation: "confidence is absent",
            observations: [],
            gaps: [],
          },
        })
        .where(eq(faaEnsembleEvaluations.signalId, missingConfidence));
      const nonStringReasonCode = await createRankingSignal(
        "non-string-reason-code",
        {
          evidence: FULL_RANKING_EVIDENCE,
          productFit: "supported_product",
        },
      );
      await getDatabase()
        .update(faaEnsembleEvaluations)
        .set({
          parsed: {
            version: "jev-triage-v1",
            decision: "research",
            confidence: null,
            productFit: "supported_product",
            acquisitionReadiness: "needs_research",
            researchPriority: 2,
            reasonCodes: ["source_supported", 7],
            explanation: "one reason code is not a string",
            observations: [],
            gaps: [],
          },
        })
        .where(eq(faaEnsembleEvaluations.signalId, nonStringReasonCode));
      const nonFiniteConfidence = await createRankingSignal(
        "non-finite-confidence",
        {
          evidence: FULL_RANKING_EVIDENCE,
          productFit: "supported_product",
        },
      );
      await getDatabase().execute(sql`
        UPDATE faa_ensemble_evaluations
        SET parsed = jsonb_set(parsed, '{confidence}', '1e1000'::jsonb)
        WHERE signal_id = ${nonFiniteConfidence}::uuid
      `);
      const ids = [
        sourceStale,
        modelStale,
        policyStale,
        hashStale,
        malformedProof,
        missingConfidence,
        nonStringReasonCode,
        nonFiniteConfidence,
      ];
      const page = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        sourceSignalIds: ids,
      });
      expect(page.items).toHaveLength(ids.length);
      for (const item of page.items) {
        expect(item.ranking).toMatchObject({
          status: "unscored",
          score: null,
          blockers: [],
        });
        expect(item.currentTriage).toBeNull();
      }
    });

    it("preserves final-review proof and priority pagination", async () => {
      const completedDraft = await createRankingSignal("completed-draft", {
        createdAt: "2050-01-01T00:00:00.000001Z",
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
        acquisitionReadiness: "ready",
        jevDecision: "high_priority",
        completedCase: true,
      });
      const alignedFinal = await createRankingSignal("aligned-final", {
        createdAt: "2000-01-01T00:00:00.000001Z",
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
        acquisitionReadiness: "ready",
        jevDecision: "high_priority",
        alignedFinal: true,
      });
      const firstPage = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        sourceSignalIds: [completedDraft, alignedFinal],
        limit: 1,
      });
      expect(firstPage.items[0]).toMatchObject({
        signal: { id: alignedFinal },
        ranking: { status: "ranked", score: 100 },
      });
      expect(
        firstPage.items[0]?.ranking.breakdown.find(
          (item) => item.key === "final_review",
        ),
      ).toMatchObject({ points: 10, basis: "verified_review" });
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await listSourceSignalAnalystOverviews(getDatabase(), {
        expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
        sourceSignalIds: [completedDraft, alignedFinal],
        limit: 1,
        after: firstPage.nextCursor!,
      });
      expect(secondPage.items[0]).toMatchObject({
        signal: { id: completedDraft },
        ranking: { status: "ranked", score: 90 },
      });
      expect(
        secondPage.items[0]?.ranking.breakdown.find(
          (item) => item.key === "final_review",
        ),
      ).toMatchObject({ points: 0, basis: "unresolved" });
    });

    it("keeps ranking and hydrated proof on one snapshot across a concurrent source revision", async () => {
      const signalId = await createRankingSignal("snapshot-race", {
        evidence: FULL_RANKING_EVIDENCE,
        productFit: "supported_product",
        acquisitionReadiness: "ready",
        jevDecision: "high_priority",
      });
      const writer = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const page = await getDatabase().transaction(
          async (tx) => {
            await tx.execute(sql`
              SELECT review_revision
              FROM source_signals
              WHERE id = ${signalId}::uuid
            `);
            await writer.query(
              "UPDATE source_signals SET raw_name = $1 WHERE id = $2::uuid",
              ["Changed During Read", signalId],
            );
            return listSourceSignalAnalystOverviewsInSnapshot(tx, {
              expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
              sourceSignalIds: [signalId],
            });
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        );
        expect(page.items[0]).toMatchObject({
          signal: { rawName: "Ranking snapshot-race", reviewRevision: 0 },
          currentTriage: { decision: "high_priority" },
          ranking: { status: "ranked", score: 90 },
        });
      } finally {
        await writer.end();
      }

      const afterCommit = await listSourceSignalAnalystOverviews(
        getDatabase(),
        {
          expectedReviewInputContract: EXPECTED_REVIEW_CONTRACT,
          sourceSignalIds: [signalId],
        },
      );
      expect(afterCommit.items[0]).toMatchObject({
        signal: { rawName: "Changed During Read", reviewRevision: 1 },
        currentTriage: null,
        ranking: { status: "unscored", score: null },
      });
    });
  },
);
