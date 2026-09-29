import { createHash, randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Pool } from "pg";

import { closeDatabase as closePackageDatabase } from "@asi/database";
import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import {
  readCurrentSignalAnalystCase,
  readSignalAnalystCaseHistory,
} from "../packages/database/src/analyst-research.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  createResearchProviderBudgetScope,
  reserveResearchProviderUsage,
  settleResearchProviderUsage,
} from "../packages/database/src/provider-accounting.js";
import {
  faaEnsembleResults,
  signalReviewState,
  sourceSignals,
} from "../packages/database/src/schema.js";
import {
  analystResourceRequestHash,
  type AnalystResourceContext,
  type AnalystResourceExecutor,
  type AnalystResourceObservation,
  type AnalystResourceRequest,
} from "../packages/research/src/analyst-resources.js";
import {
  currentFaaReviewInputContract,
  reconcileCurrentReviewInputs,
  resolveEnsembleConfig,
  runJevReviews,
  runMuseReviews,
  type AnalystModelCallResult,
  type FaaEnsembleConfig,
  type JevLadderCaller,
  type SignalAnalystLimits,
} from "../packages/research/src/faa-ensemble/runner.js";
import type { SignalAnalystTurn } from "../packages/research/src/faa-ensemble/analyst-protocol.js";
import {
  OpenRouterClientError,
  type OpenRouterAttemptTelemetry,
  type OpenRouterErrorCode,
} from "../packages/research/src/openrouter.js";

const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" &&
  process.env.ASI_TEST_DATABASE_ADMIN_URL !== undefined;
const SAFE_SCRATCH_DATABASE = /^asi_signal_analyst_engine_[0-9a-f]{32}$/u;
const EPOCH = new Date(0);

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

function testConfig(): FaaEnsembleConfig {
  return {
    ...resolveEnsembleConfig({}),
    modelA: "test/muse-signal-analyst",
    jevModel: "test/jev-signal-analyst",
    concurrency: 1,
    requestDelayMs: 0,
  };
}

const config = testConfig();
const expectedReviewInputContract = currentFaaReviewInputContract(config);

const researchLadder: JevLadderCaller = async (request) => {
  if (request.rung === "r1") {
    return {
      answers: { manufacturer: { type: "noul", noul: 0.95 } },
      costUsd: null,
      model: config.jevModel,
    };
  }
  if (request.rung === "r2") {
    return {
      answers: {
        product_vs_process: {
          type: "choice",
          choice: "product",
          confidence: 0.9,
        },
      },
      costUsd: null,
      model: config.jevModel,
    };
  }
  if (request.rung === "r3") {
    return {
      answers: { oversize: { type: "noul", noul: 0.05 } },
      costUsd: null,
      model: config.jevModel,
    };
  }
  return {
    answers: {
      disposition: {
        type: "choice",
        choice: "research",
        confidence: 0.9,
      },
    },
    costUsd: null,
    model: config.jevModel,
  };
};

function finalTurn(
  summary = "Research remains bounded and incomplete.",
): SignalAnalystTurn {
  return {
    version: "signal-analyst-turn-v1",
    kind: "final",
    analysisSummary: summary,
    unresolvedQuestions: [
      "Current ownership and annual revenue remain unresolved.",
    ],
    nextActions: [
      "Retrieve attributable current ownership and revenue evidence.",
    ],
    verification: {
      decision: "research",
      confidence: 73,
      company_type: "Aerospace supplier candidate",
      aerospace_defense_relevance:
        "The FAA source establishes aerospace applicability.",
      manufacturing_evidence:
        "The current evidence does not yet prove manufacturing scope.",
      thesis_signals: ["FAA applicability"],
      disqualifiers: [],
      missing_evidence: ["Current ownership", "Annual revenue"],
      false_negative_risk: "medium",
      reason: "The candidate requires source-backed mandate research.",
      proprietary_product_evidence: "weak",
      proprietary_process_only: false,
      website_products_menu: null,
      size_indicators: [],
      likely_oversize: false,
      suggested_priority: 2,
    },
  };
}

function actionTurn(
  request: AnalystResourceRequest,
  summary = "One bounded resource can address a current gap.",
): SignalAnalystTurn {
  return {
    version: "signal-analyst-turn-v1",
    kind: "action",
    analysisSummary: summary,
    purpose: "Resolve one current mandate gap with attributable evidence.",
    gapIds: ["identity"],
    request,
  };
}

function unresolvedPrimaryObservation(
  request: Extract<AnalystResourceRequest, { tool: "primary_records" }>,
  context: AnalystResourceContext,
): AnalystResourceObservation {
  return {
    tool: "primary_records",
    requestHash: analystResourceRequestHash(request),
    observedAt: (
      context.now ?? new Date("2050-01-01T00:00:00.000Z")
    ).toISOString(),
    outcome: "unresolved",
    supportRole: "checked_only",
    matchBasis: null,
    ambiguous: false,
    records: [],
    sourceReferences: [],
    failure: null,
    accessLimit: null,
    providerReceiptId: null,
    providerCostUsd: null,
    providerCostKnown: false,
  };
}

function successfulSearchObservation(
  request: Extract<AnalystResourceRequest, { tool: "exa_search" }>,
  context: AnalystResourceContext,
): AnalystResourceObservation {
  const observedAt = (
    context.now ?? new Date("2050-01-01T00:00:00.000Z")
  ).toISOString();
  return {
    tool: "exa_search",
    requestHash: analystResourceRequestHash(request),
    observedAt,
    outcome: "success",
    supportRole: "discovery_only",
    results: [
      {
        title: "Candidate official site",
        url: "https://candidate.example/about",
        textSnippet: "Candidate company result",
        score: 0.9,
      },
    ],
    sourceReferences: [
      {
        locator: "https://candidate.example/about",
        finalUrl: "https://candidate.example/about",
        contentSha256: createHash("sha256")
          .update("Candidate company result")
          .digest("hex"),
        retrievedAt: observedAt,
        representation: "provider_extracted_snippet",
        replayCaveat:
          "Controlled discovery result; publisher bytes were not retrieved.",
      },
    ],
    failure: null,
    accessLimit: null,
    providerReceiptId: null,
    providerCostUsd: null,
    providerCostKnown: false,
  };
}

function successfulPublicPageObservation(
  request: Extract<AnalystResourceRequest, { tool: "public_page" }>,
  context: AnalystResourceContext,
  body: string,
): AnalystResourceObservation {
  const observedAt = (context.now ?? new Date()).toISOString();
  return {
    tool: "public_page",
    requestHash: analystResourceRequestHash(request),
    observedAt,
    outcome: "success",
    supportRole: "candidate_evidence",
    body,
    contentType: "text/html",
    originalByteLength: body.length,
    retainedCharacters: body.length,
    truncated: false,
    redirects: [],
    linkedUrls: [],
    sourceReferences: [
      {
        locator: request.url,
        finalUrl: request.url,
        contentSha256: createHash("sha256").update(body).digest("hex"),
        retrievedAt: observedAt,
        representation: "normalized_publisher_text",
        replayCaveat: "Controlled publisher text retained for this regression.",
      },
    ],
    failure: null,
    accessLimit: null,
    providerReceiptId: null,
    providerCostUsd: null,
    providerCostKnown: false,
  };
}

async function createRawSignal(
  label: string,
  values: Partial<typeof sourceSignals.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await getDatabase()
    .insert(sourceSignals)
    .values({
      id,
      sourceKey: "faa_pma_database",
      sourceLocator: `signal-analyst-engine:${label}`,
      sourceFingerprint: `signal-analyst-engine:${label}:${id}`,
      rawName: `Signal Analyst ${label}`,
      rawDomain: "candidate.example",
      city: "Wichita",
      state: "KS",
      country: "US",
      sourcePayload: {},
      ...values,
    });
  return id;
}

async function runJev(signalId: string) {
  const result = await runJevReviews(
    getDatabase(),
    { limit: 1, concurrency: 1, sourceSignalIds: [signalId] },
    {
      config,
      callJev: researchLadder,
      getDailySpendUsd: async () => 0,
      dailyBudgetCapUsd: () => 100,
    },
  );
  expect(result).toMatchObject({
    screened: 1,
    research: 1,
    deferred: 0,
    errors: 0,
    stale: 0,
  });
  return currentReviewState(signalId);
}

async function createScope(signalId: string, label: string): Promise<string> {
  const id = `signal-analyst-engine:${label}:${randomUUID()}`;
  await createResearchProviderBudgetScope(getDatabase(), {
    id,
    provider: "exa",
    startsAt: new Date("2000-01-01T00:00:00.000Z"),
    totalCapUsd: "10",
    permitStatus: "active",
    allowlistedSourceSignalIds: [signalId],
  });
  return id;
}

async function currentReviewState(signalId: string) {
  const [state] = await getDatabase()
    .select()
    .from(signalReviewState)
    .where(eq(signalReviewState.signalId, signalId))
    .limit(1);
  if (state === undefined) {
    throw new Error(`missing review state for ${signalId}`);
  }
  return state;
}

async function currentCase(signalId: string) {
  const view = await readCurrentSignalAnalystCase(getDatabase(), signalId, {
    expectedReviewInputContract,
    stepLimit: 100,
  });
  if (view === null) {
    throw new Error(`missing analyst case for ${signalId}`);
  }
  return view;
}

async function forceReviewDue(signalId: string): Promise<void> {
  await getDatabase()
    .update(signalReviewState)
    .set({ nextAttemptAt: EPOCH, leaseToken: null, leaseExpiresAt: null })
    .where(eq(signalReviewState.signalId, signalId));
}

async function invalidateCurrentLease(signalId: string): Promise<void> {
  await getDatabase()
    .update(signalReviewState)
    .set({
      nextAttemptAt: EPOCH,
      leaseToken: randomUUID(),
      leaseExpiresAt: EPOCH,
    })
    .where(eq(signalReviewState.signalId, signalId));
}

function museDependencies(
  callAnalystModel: (request: {
    readonly modelId: string;
    readonly prompt: string;
    readonly mustFinalize: boolean;
  }) => Promise<AnalystModelCallResult>,
  resourceExecutor: AnalystResourceExecutor,
  now?: () => Date,
) {
  return {
    config,
    callAnalystModel,
    resourceExecutor,
    getDailySpendUsd: async () => 0,
    dailyBudgetCapUsd: () => 100,
    ...(now === undefined ? {} : { now }),
  };
}

function museOptions(
  scopeId: string,
  limits: Partial<SignalAnalystLimits> = {},
) {
  return {
    analystMode: "bounded_paid" as const,
    exaBudgetScopeId: scopeId,
    limit: 1,
    concurrency: 1,
    limits,
  };
}

function billedError(
  code: Extract<
    OpenRouterErrorCode,
    "invalid_structured_output" | "quota_exhausted"
  >,
  costUsd: number,
): OpenRouterClientError {
  const attempt: OpenRouterAttemptTelemetry = {
    attempt: 1,
    model: config.modelA,
    provider: "controlled-provider",
    status: code === "invalid_structured_output" ? "schema_error" : "failed",
    httpStatus: code === "quota_exhausted" ? 402 : 200,
    promptSha256: createHash("sha256").update(code).digest("hex"),
    responseSha256: createHash("sha256")
      .update(`${code}:response`)
      .digest("hex"),
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costUsd,
    latencyMs: 1,
    retryDelayMs: null,
    errorCode: code,
  };
  return new OpenRouterClientError(code, false, [attempt]);
}

const unusedResourceExecutor: AnalystResourceExecutor = {
  execute: async () => {
    throw new Error("resource execution was not expected");
  },
};

const forbiddenFetch = vi.fn(async (): Promise<Response> => {
  throw new Error("native analyst regression attempted global fetch");
});

describe.skipIf(!DB_TESTS_ENABLED)(
  "signal analyst engine consumer regressions (isolated PostgreSQL)",
  () => {
    const adminDatabaseUrl = process.env.ASI_TEST_DATABASE_ADMIN_URL!;
    const scratchDatabase = `asi_signal_analyst_engine_${randomUUID().replaceAll("-", "")}`;
    let originalDatabaseUrl: string | undefined;
    let hadOriginalDatabaseUrl = false;
    let originalFetch = globalThis.fetch;

    beforeAll(async () => {
      hadOriginalDatabaseUrl = Object.prototype.hasOwnProperty.call(
        process.env,
        "DATABASE_URL",
      );
      originalDatabaseUrl = process.env.DATABASE_URL;
      originalFetch = globalThis.fetch;
      globalThis.fetch = forbiddenFetch;
      await Promise.allSettled([closeDatabase(), closePackageDatabase()]);
      process.env.DATABASE_URL = await createScratchDatabase(
        adminDatabaseUrl,
        scratchDatabase,
      );
      await runMigrations();
    }, 120_000);

    beforeEach(async () => {
      forbiddenFetch.mockClear();
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

    afterEach(() => {
      expect(forbiddenFetch).not.toHaveBeenCalled();
    });

    afterAll(async () => {
      await Promise.allSettled([closeDatabase(), closePackageDatabase()]);
      await dropScratchDatabase(adminDatabaseUrl, scratchDatabase);
      globalThis.fetch = originalFetch;
      if (hadOriginalDatabaseUrl) {
        process.env.DATABASE_URL = originalDatabaseUrl;
      } else {
        delete process.env.DATABASE_URL;
      }
    }, 120_000);

    it("starts Muse from the same canonical input Jev used for raw empty research", async () => {
      const signalId = await createRawSignal("raw-empty");
      const jevState = await runJev(signalId);
      expect(jevState.researchEvidence).toEqual({});
      const scopeId = await createScope(signalId, "raw-empty");
      let modelCalls = 0;

      const summary = await runMuseReviews(
        getDatabase(),
        museOptions(scopeId, {
          maxModelCalls: 2,
          maxResourceActions: 1,
          maxActiveWorkMs: 30_000,
        }),
        museDependencies(async () => {
          modelCalls += 1;
          return {
            turn: finalTurn(),
            returnedModel: config.modelA,
            costUsd: 0,
          };
        }, unusedResourceExecutor),
      );

      expect(summary).toMatchObject({
        verified: 1,
        stale: 0,
        errors: 0,
        deferred: 0,
      });
      expect(modelCalls).toBe(1);
      const state = await currentReviewState(signalId);
      expect(state.phase).toBe("settled");
      expect(state.jevEvaluationId).toBe(jevState.jevEvaluationId);
      const view = await currentCase(signalId);
      expect(view.current).toBe(true);
      expect(view.case.status).toBe("completed");
      expect(view.case.inputHash).toBe(state.inputHash);
      expect(
        view.steps.filter((step) => step.kind.startsWith("resource:")),
      ).toHaveLength(0);
    });

    it("grounds published named products in their retained quote instead of unrelated website hints", async () => {
      const namedProductQuote =
        "Our most recent product updates include a redesign to our Mega Bore Valve system, and our IN-95 Inflator Adaptor.";
      const unrelatedProductHint =
        "We provide precision machining services and value-added assembly services for demanding programs.";
      const publisherBody = [
        "We are Beacon Grounding LLC.",
        "Beacon Grounding LLC designs and manufactures industrial valves and adapters.",
        namedProductQuote,
        unrelatedProductHint,
        "Contact us in Wichita, KS 67202.",
      ].join("\n");
      const signalId = await createRawSignal("product-grounding", {
        rawName: "Beacon Grounding LLC",
        rawDomain: "beacon-grounding.test",
      });
      await runJev(signalId);
      const scopeId = await createScope(signalId, "product-grounding");
      const request = {
        tool: "public_page" as const,
        url: "https://beacon-grounding.test/products",
      };
      let modelCalls = 0;
      let resourceCalls = 0;
      const callAnalystModel = async (): Promise<AnalystModelCallResult> => {
        modelCalls += 1;
        return {
          turn: modelCalls === 1 ? actionTurn(request) : finalTurn(),
          returnedModel: config.modelA,
          costUsd: 0,
        };
      };
      const resourceExecutor: AnalystResourceExecutor = {
        execute: async (context, actualRequest) => {
          resourceCalls += 1;
          if (
            actualRequest.tool !== "public_page" ||
            actualRequest.url !== request.url
          ) {
            throw new Error("unexpected controlled resource request");
          }
          return successfulPublicPageObservation(
            actualRequest,
            context,
            publisherBody,
          );
        },
      };
      const options = museOptions(scopeId, {
        maxModelCalls: 4,
        maxResourceActions: 2,
        maxActiveWorkMs: 30_000,
      });
      const dependencies = museDependencies(callAnalystModel, resourceExecutor);

      const admitted = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(admitted).toMatchObject({
        evidenceRequeued: 1,
        verified: 0,
        stale: 0,
      });
      expect(modelCalls).toBe(1);
      expect(resourceCalls).toBe(1);

      const freshJev = await runJev(signalId);
      const researchEvidence = freshJev.researchEvidence as {
        website?: {
          productHints?: string[];
          namedProductEvidenceIds?: string[];
        };
        evidenceRefs?: Array<{
          evidenceId: string;
          role: string;
          stage: string;
          quote: string;
        }>;
      };
      expect(
        researchEvidence.website?.productHints?.some((hint) =>
          hint.includes(unrelatedProductHint),
        ),
        JSON.stringify(researchEvidence),
      ).toBe(true);
      const admittedNamedProductProofs =
        researchEvidence.evidenceRefs?.filter(
          (reference) =>
            reference.role === "support" &&
            reference.stage === "website" &&
            reference.quote.trim() !== "" &&
            researchEvidence.website?.namedProductEvidenceIds?.includes(
              reference.evidenceId,
            ),
        ) ?? [];
      expect(
        admittedNamedProductProofs.some(
          (reference) => reference.quote === namedProductQuote,
        ),
      ).toBe(true);
      const admittedNamedProductEvidenceIds = [
        ...new Set(
          admittedNamedProductProofs.map((reference) => reference.evidenceId),
        ),
      ].sort();

      const finalized = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(finalized).toMatchObject({ verified: 1, stale: 0, errors: 0 });
      expect(modelCalls).toBe(2);
      expect(resourceCalls).toBe(1);
      const view = await currentCase(signalId);
      const memo = view.case.memo as
        | {
            answers?: Array<{
              gapId: string;
              status: string;
              answer: string | null;
              evidenceIds: string[];
            }>;
          }
        | null;
      const productAnswer = memo?.answers?.find(
        (answer) => answer.gapId === "product_fit.named_products",
      );
      expect(productAnswer).toMatchObject({
        status: "answered",
        evidenceIds: admittedNamedProductEvidenceIds,
      });
      expect(productAnswer?.answer).toContain(namedProductQuote);
      expect(productAnswer?.answer).not.toContain(unrelatedProductHint);
    });

    it("keeps product fit unresolved when website hints have no retained named-product proof", async () => {
      const unsupportedProductHint =
        "We provide precision machining services and value-added assembly services for demanding programs.";
      const signalId = await createRawSignal("product-hints-only", {
        rawName: "Beacon Context LLC",
        rawDomain: "beacon-context.test",
      });
      await runJev(signalId);
      const scopeId = await createScope(signalId, "product-hints-only");
      const request = {
        tool: "public_page" as const,
        url: "https://beacon-context.test/capabilities",
      };
      let modelCalls = 0;
      const dependencies = museDependencies(
        async () => {
          modelCalls += 1;
          return {
            turn: modelCalls === 1 ? actionTurn(request) : finalTurn(),
            returnedModel: config.modelA,
            costUsd: 0,
          };
        },
        {
          execute: async (context, actualRequest) => {
            if (
              actualRequest.tool !== "public_page" ||
              actualRequest.url !== request.url
            ) {
              throw new Error("unexpected controlled resource request");
            }
            return successfulPublicPageObservation(
              actualRequest,
              context,
              [
                "We are Beacon Context LLC.",
                unsupportedProductHint,
                "Contact us in Wichita, KS 67202.",
              ].join("\n"),
            );
          },
        },
      );
      const options = museOptions(scopeId, {
        maxModelCalls: 4,
        maxResourceActions: 2,
        maxActiveWorkMs: 30_000,
      });

      const admitted = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(admitted).toMatchObject({ evidenceRequeued: 1, stale: 0 });
      const freshJev = await runJev(signalId);
      const researchEvidence = freshJev.researchEvidence as {
        website?: {
          productHints?: string[];
          namedProductEvidenceIds?: string[];
        };
      };
      const website = researchEvidence.website;
      expect(
        website?.productHints?.some((hint) =>
          hint.includes(unsupportedProductHint),
        ),
        JSON.stringify(researchEvidence),
      ).toBe(true);
      expect(website?.namedProductEvidenceIds).toEqual([]);

      const finalized = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(finalized).toMatchObject({ verified: 1, stale: 0, errors: 0 });
      const view = await currentCase(signalId);
      const memo = view.case.memo as
        | {
            answers?: Array<{
              gapId: string;
              status: string;
              answer: string | null;
              evidenceIds: string[];
            }>;
          }
        | null;
      const productAnswer = memo?.answers?.find(
        (answer) => answer.gapId === "product_fit.named_products",
      );
      expect(productAnswer).toMatchObject({
        status: "unresolved",
        evidenceIds: [],
      });
      expect(productAnswer?.answer).not.toContain(unsupportedProductHint);
    });

    it("enforces cumulative model and resource limits and does not replenish stored limits on restart", async () => {
      const signalId = await createRawSignal("hard-limits");
      await runJev(signalId);
      const scopeId = await createScope(signalId, "hard-limits");
      const request: AnalystResourceRequest = {
        tool: "primary_records",
        identity: { legalName: "Signal Analyst hard-limits" },
        excludeSignalId: signalId,
      };
      let modelCalls = 0;
      let resourceCalls = 0;
      const resourceExecutor: AnalystResourceExecutor = {
        execute: async (context, actualRequest) => {
          resourceCalls += 1;
          if (actualRequest.tool !== "primary_records") {
            throw new Error("unexpected controlled resource request");
          }
          return unresolvedPrimaryObservation(actualRequest, context);
        },
      };
      const callAnalystModel = async (input: { mustFinalize: boolean }) => {
        modelCalls += 1;
        return {
          turn: actionTurn(
            request,
            `Ignored finalization request: ${input.mustFinalize}`,
          ),
          returnedModel: config.modelA,
          costUsd: 0.125,
        };
      };

      await runMuseReviews(
        getDatabase(),
        museOptions(scopeId, {
          maxModelCalls: 2,
          maxResourceActions: 1,
          maxActiveWorkMs: 30_000,
        }),
        museDependencies(callAnalystModel, resourceExecutor),
      );

      expect(modelCalls).toBe(2);
      expect(resourceCalls).toBe(1);
      let view = await currentCase(signalId);
      expect(view.case.status).toBe("exhausted");
      expect(view.case.limits).toEqual({
        maxModelCalls: 2,
        maxResourceActions: 1,
        maxActiveWorkMs: 30_000,
      });
      expect(view.steps.filter((step) => step.kind === "planner")).toHaveLength(
        1,
      );
      expect(
        view.steps.filter((step) => step.kind === "final_verifier"),
      ).toHaveLength(1);
      expect(
        view.steps.filter((step) => step.kind.startsWith("resource:")),
      ).toHaveLength(1);
      expect(view.modelSpend).toMatchObject({
        receiptCount: 2,
        unknownReceiptCount: 0,
      });
      expect(Number(view.modelSpend.knownActualCostUsd)).toBe(0.25);
      expect(
        await getDatabase()
          .select({ id: faaEnsembleResults.id })
          .from(faaEnsembleResults)
          .where(eq(faaEnsembleResults.signalId, signalId)),
      ).toHaveLength(0);

      await forceReviewDue(signalId);
      await runMuseReviews(
        getDatabase(),
        museOptions(scopeId, {
          maxModelCalls: 12,
          maxResourceActions: 12,
          maxActiveWorkMs: 300_000,
        }),
        museDependencies(callAnalystModel, resourceExecutor),
      );

      expect(modelCalls).toBe(2);
      expect(resourceCalls).toBe(1);
      view = await currentCase(signalId);
      expect(view.case.limits).toEqual({
        maxModelCalls: 2,
        maxResourceActions: 1,
        maxActiveWorkMs: 30_000,
      });
      expect(Number(view.modelSpend.knownActualCostUsd)).toBe(0.25);
    });

    it("reuses paid planner and verifier results recorded after lease loss", async () => {
      const signalId = await createRawSignal("late-model-reuse");
      await runJev(signalId);
      const scopeId = await createScope(signalId, "late-model-reuse");
      const request: AnalystResourceRequest = {
        tool: "primary_records",
        identity: { legalName: "Signal Analyst late-model-reuse" },
        excludeSignalId: signalId,
      };
      let modelCalls = 0;
      let resourceCalls = 0;
      const callAnalystModel = async (): Promise<AnalystModelCallResult> => {
        modelCalls += 1;
        await invalidateCurrentLease(signalId);
        return modelCalls === 1
          ? {
              turn: actionTurn(request),
              returnedModel: config.modelA,
              costUsd: 0.125,
            }
          : {
              turn: finalTurn("Final verifier result survived lease loss."),
              returnedModel: config.modelA,
              costUsd: 0.25,
            };
      };
      const resourceExecutor: AnalystResourceExecutor = {
        execute: async (context, actualRequest) => {
          resourceCalls += 1;
          if (actualRequest.tool !== "primary_records") {
            throw new Error("unexpected controlled resource request");
          }
          return unresolvedPrimaryObservation(actualRequest, context);
        },
      };
      const options = museOptions(scopeId, {
        maxModelCalls: 3,
        maxResourceActions: 1,
        maxActiveWorkMs: 30_000,
      });
      const dependencies = museDependencies(callAnalystModel, resourceExecutor);

      const plannerLeaseLoss = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(plannerLeaseLoss.stale).toBe(1);
      expect(modelCalls).toBe(1);
      expect(resourceCalls).toBe(0);

      await forceReviewDue(signalId);
      const verifierLeaseLoss = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(verifierLeaseLoss.stale).toBe(1);
      expect(modelCalls).toBe(2);
      expect(resourceCalls).toBe(1);

      await forceReviewDue(signalId);
      const resumed = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(resumed).toMatchObject({ verified: 1, stale: 0, errors: 0 });
      expect(modelCalls).toBe(2);
      expect(resourceCalls).toBe(1);
      const view = await currentCase(signalId);
      expect(view.case.status).toBe("completed");
      expect(view.steps.filter((step) => step.kind === "planner")).toHaveLength(
        1,
      );
      expect(
        view.steps.filter((step) => step.kind === "final_verifier"),
      ).toHaveLength(1);
      expect(
        view.steps.filter((step) => step.kind.startsWith("resource:")),
      ).toHaveLength(1);
      expect(view.modelSpend).toEqual({
        knownActualCostUsd: "0.375",
        receiptCount: 2,
        unknownReceiptCount: 0,
      });
    });

    it("retains the exact pending paid action through quota cooldown without planner spin", async () => {
      const signalId = await createRawSignal("quota-resume");
      await runJev(signalId);
      const scopeId = await createScope(signalId, "quota-resume");
      const request = {
        tool: "exa_search" as const,
        query: "Signal Analyst quota-resume ownership revenue",
      };
      let now = new Date("2099-04-05T10:00:00.000Z");
      const retryAt = new Date("2099-04-05T11:00:00.000Z");
      let modelCalls = 0;
      let resourceCalls = 0;
      const callAnalystModel = async (): Promise<AnalystModelCallResult> => {
        modelCalls += 1;
        return {
          turn: modelCalls === 1 ? actionTurn(request) : finalTurn(),
          returnedModel: config.modelA,
          costUsd: 0,
        };
      };
      const resourceExecutor: AnalystResourceExecutor = {
        execute: async (context, actualRequest) => {
          resourceCalls += 1;
          if (actualRequest.tool !== "exa_search") {
            throw new Error("unexpected controlled resource request");
          }
          if (resourceCalls > 1) {
            return successfulSearchObservation(actualRequest, context);
          }
          const reserved = await reserveResearchProviderUsage(getDatabase(), {
            provider: "exa",
            operation: "search",
            sourceSignalId: signalId,
            analystStepId: context.analystStepId,
            budgetScopeId: scopeId,
            requestHash: analystResourceRequestHash(actualRequest),
            estimatedCostUsd: "0.1",
            dailyCapUsd: "10",
            now,
          });
          if (reserved.outcome !== "reserved") {
            throw new Error("expected controlled provider reservation");
          }
          await settleResearchProviderUsage(
            getDatabase(),
            reserved.reservation.id,
            {
              status: "failed",
              actualCostUsd: null,
              observedAt: now,
              error: "HTTP 402 controlled quota exhaustion",
              providerCooldown: {
                retryAt,
                reason: "controlled_credits_exhausted",
              },
            },
          );
          return {
            tool: "exa_search",
            requestHash: analystResourceRequestHash(actualRequest),
            observedAt: now.toISOString(),
            outcome: "deferred",
            supportRole: "discovery_only",
            results: [],
            sourceReferences: [],
            failure: null,
            accessLimit: `provider cooldown until ${retryAt.toISOString()}`,
            providerReceiptId: reserved.reservation.id,
            providerCostUsd: null,
            providerCostKnown: false,
          };
        },
      };
      const options = museOptions(scopeId, {
        maxModelCalls: 3,
        maxResourceActions: 2,
        maxActiveWorkMs: 30_000,
      });
      const dependencies = museDependencies(
        callAnalystModel,
        resourceExecutor,
        () => now,
      );

      const quota = await runMuseReviews(getDatabase(), options, dependencies);
      expect(quota.deferred).toBe(1);
      expect(modelCalls).toBe(1);
      expect(resourceCalls).toBe(1);
      let view = await currentCase(signalId);
      expect(view.case.status).toBe("deferred");
      expect(
        (
          view.case.checkpoint["pendingAction"] as
            { request?: unknown } | undefined
        )?.request,
      ).toEqual(request);
      expect(
        view.steps.find((step) => step.kind === "resource:exa_search"),
      ).toMatchObject({ status: "quota_deferred" });

      await forceReviewDue(signalId);
      const blocked = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(blocked.deferred).toBe(1);
      expect(modelCalls).toBe(1);
      expect(resourceCalls).toBe(1);
      view = await currentCase(signalId);
      expect(
        (
          view.case.checkpoint["pendingAction"] as
            { request?: unknown } | undefined
        )?.request,
      ).toEqual(request);
      expect(view.steps.filter((step) => step.kind === "planner")).toHaveLength(
        1,
      );

      now = new Date("2099-04-05T11:00:01.000Z");
      await forceReviewDue(signalId);
      const resumed = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(resumed.verified).toBe(1);
      expect(modelCalls).toBe(2);
      expect(resourceCalls).toBe(2);
      view = await currentCase(signalId);
      expect(view.case.status).toBe("completed");
      expect(view.steps.filter((step) => step.kind === "planner")).toHaveLength(
        1,
      );
      expect(
        view.steps
          .filter((step) => step.kind.startsWith("resource:"))
          .map((step) => step.status),
      ).toEqual(["completed", "quota_deferred"]);
    });

    it("requeues admitted evidence through fresh Jev proof before allowing a final", async () => {
      const uei = "TESTUEI12345";
      const signalId = await createRawSignal("evidence-requeue", { uei });
      const corroboratingFingerprint = `sam:${uei}:${randomUUID()}`;
      const corroboratingSignalId = await createRawSignal(
        "evidence-corroboration",
        {
          sourceKey: "sam_entity",
          sourceLocator: `sam:${uei}`,
          sourceFingerprint: corroboratingFingerprint,
          rawName: "Signal Analyst evidence-requeue",
          uei,
        },
      );
      const firstJev = await runJev(signalId);
      const firstInputHash = firstJev.inputHash;
      const scopeId = await createScope(signalId, "evidence-requeue");
      const request = {
        tool: "primary_records" as const,
        identity: {
          legalName: "Signal Analyst evidence-requeue",
          uei,
          city: "Wichita",
          state: "KS",
        },
        excludeSignalId: signalId,
      };
      let modelCalls = 0;
      let resourceCalls = 0;
      const callAnalystModel = async (): Promise<AnalystModelCallResult> => {
        modelCalls += 1;
        return {
          turn: modelCalls === 1 ? actionTurn(request) : finalTurn(),
          returnedModel: config.modelA,
          costUsd: 0,
        };
      };
      const resourceExecutor: AnalystResourceExecutor = {
        execute: async (context, actualRequest) => {
          resourceCalls += 1;
          if (actualRequest.tool !== "primary_records") {
            throw new Error("unexpected controlled resource request");
          }
          const observedAt = (context.now ?? new Date()).toISOString();
          const payloadJson = JSON.stringify({
            legalName: "Signal Analyst evidence-requeue",
            uei,
            city: "Wichita",
            state: "KS",
          });
          return {
            tool: "primary_records",
            requestHash: analystResourceRequestHash(actualRequest),
            observedAt,
            outcome: "success",
            supportRole: "candidate_evidence",
            matchBasis: "uei",
            ambiguous: false,
            records: [
              {
                signalId: corroboratingSignalId,
                sourceKey: "sam_entity",
                sourceLocator: `sam:${uei}`,
                sourceFingerprint: corroboratingFingerprint,
                legalName: "Signal Analyst evidence-requeue",
                domain: "candidate.example",
                uei,
                cage: null,
                city: "Wichita",
                state: "KS",
                country: "US",
                awardCount: null,
                payloadJson,
                payloadTruncated: false,
                issuer: "U.S. General Services Administration",
                recordAccess: "reused_imported_record",
                observedAt,
              },
            ],
            sourceReferences: [
              {
                locator: `sam:${uei}`,
                finalUrl: null,
                contentSha256: createHash("sha256")
                  .update(payloadJson)
                  .digest("hex"),
                retrievedAt: observedAt,
                representation: "structured_primary_record",
                replayCaveat: "Controlled reuse of an imported primary record.",
              },
            ],
            failure: null,
            accessLimit: null,
            providerReceiptId: null,
            providerCostUsd: null,
            providerCostKnown: false,
          };
        },
      };
      const options = museOptions(scopeId, {
        maxModelCalls: 4,
        maxResourceActions: 2,
        maxActiveWorkMs: 30_000,
      });
      const dependencies = museDependencies(callAnalystModel, resourceExecutor);

      const admitted = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(admitted).toMatchObject({
        evidenceRequeued: 1,
        verified: 0,
        stale: 0,
      });
      expect(modelCalls).toBe(1);
      expect(resourceCalls).toBe(1);
      let state = await currentReviewState(signalId);
      expect(state).toMatchObject({ phase: "jev", jevEvaluationId: null });
      expect(state.inputHash).toBeNull();
      let view = await currentCase(signalId);
      expect(view.case.status).toBe("awaiting_review");

      const freshJev = await runJev(signalId);
      expect(freshJev.inputHash).not.toBe(firstInputHash);
      expect(freshJev.jevEvaluationId).not.toBe(firstJev.jevEvaluationId);
      const finalized = await runMuseReviews(
        getDatabase(),
        options,
        dependencies,
      );
      expect(finalized).toMatchObject({ verified: 1, stale: 0, errors: 0 });
      expect(modelCalls).toBe(2);
      expect(resourceCalls).toBe(1);
      state = await currentReviewState(signalId);
      view = await currentCase(signalId);
      expect(state.phase).toBe("settled");
      expect(view.current).toBe(true);
      expect(view.case.status).toBe("completed");
      expect(view.case.inputHash).toBe(freshJev.inputHash);
      expect(view.case.memo).toMatchObject({ inputHash: freshJev.inputHash });
    });

    it("fences a billed final when the source revision changes before publication", async () => {
      const signalId = await createRawSignal("stale-final");
      const jevState = await runJev(signalId);
      const scopeId = await createScope(signalId, "stale-final");
      let modelCalls = 0;

      const summary = await runMuseReviews(
        getDatabase(),
        museOptions(scopeId, {
          maxModelCalls: 1,
          maxResourceActions: 1,
          maxActiveWorkMs: 30_000,
        }),
        museDependencies(async () => {
          modelCalls += 1;
          await getDatabase()
            .update(sourceSignals)
            .set({
              rawName: "Signal Analyst stale-final revised",
              reviewRevision: sql`${sourceSignals.reviewRevision} + 1`,
            })
            .where(eq(sourceSignals.id, signalId));
          return {
            turn: finalTurn(
              "This final belongs only to the old source revision.",
            ),
            returnedModel: config.modelA,
            costUsd: 0.5,
          };
        }, unusedResourceExecutor),
      );

      expect(summary).toMatchObject({ verified: 0, stale: 1 });
      expect(modelCalls).toBe(1);
      expect(
        await getDatabase()
          .select({ id: faaEnsembleResults.id })
          .from(faaEnsembleResults)
          .where(eq(faaEnsembleResults.signalId, signalId)),
      ).toHaveLength(0);

      await reconcileCurrentReviewInputs(getDatabase(), {
        sourceLimit: 1,
        sourceSignalIds: [signalId],
        config,
      });
      const state = await currentReviewState(signalId);
      expect(state).toMatchObject({
        phase: "jev",
        sourceRevision: jevState.sourceRevision + 1,
        inputHash: null,
        jevEvaluationId: null,
      });
      const history = await readSignalAnalystCaseHistory(
        getDatabase(),
        signalId,
        {
          expectedReviewInputContract,
          caseLimit: 5,
          stepLimitPerCase: 100,
        },
      );
      expect(history).toHaveLength(1);
      expect(history[0]!.case.status).not.toBe("completed");
      expect(history[0]!.modelSpend).toEqual({
        knownActualCostUsd: "0.5",
        receiptCount: 1,
        unknownReceiptCount: 0,
      });
    });

    it("retains billed invalid output through the real structured client", async () => {
      const signalId = await createRawSignal("real-client-invalid");
      const jevState = await runJev(signalId);
      const scopeId = await createScope(signalId, "real-client-invalid");
      const previousFetch = globalThis.fetch;
      let providerResponses = 0;
      globalThis.fetch = async (input, init) => {
        if (String(input) !== "https://openrouter.ai/api/v1/chat/completions") {
          return forbiddenFetch();
        }
        providerResponses += 1;
        const request = JSON.parse(String(init?.body)) as {
          response_format?: {
            json_schema?: { schema?: Record<string, unknown> };
          };
        };
        const schema = request.response_format?.json_schema?.schema;
        if (
          schema === undefined ||
          schema["type"] !== "object" ||
          JSON.stringify(schema).includes('"oneOf":') ||
          ["oneOf", "anyOf", "allOf", "enum", "not"].some((key) =>
            Object.hasOwn(schema, key),
          )
        ) {
          return new Response(
            JSON.stringify({ error: { message: "Unsupported root schema" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            model: config.modelA,
            provider: "controlled",
            choices: [{ message: { content: '{"kind":"invalid"}' } }],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
              cost: 0.125,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      try {
        const summary = await runMuseReviews(
          getDatabase(),
          museOptions(scopeId, {
            maxModelCalls: 1,
            maxResourceActions: 1,
            maxActiveWorkMs: 30_000,
          }),
          {
            config,
            apiKey: "controlled-key-no-live-provider",
            resourceExecutor: unusedResourceExecutor,
            getDailySpendUsd: async () => 0,
            dailyBudgetCapUsd: () => 100,
          },
        );
        expect(summary.verified).toBe(0);
      } finally {
        globalThis.fetch = previousFetch;
      }
      expect(providerResponses).toBe(1);
      const view = await currentCase(signalId);
      expect(view.case.status).toBe("exhausted");
      expect(view.modelSpend).toEqual({
        knownActualCostUsd: "0.125",
        receiptCount: 1,
        unknownReceiptCount: 0,
      });
      expect(
        view.steps.find((step) => step.kind === "final_verifier"),
      ).toMatchObject({
        status: "retryable_failure",
        costKnown: true,
        costUsd: "0.125",
        claimInputHash: jevState.inputHash,
      });
      expect(
        await getDatabase()
          .select({ id: faaEnsembleResults.id })
          .from(faaEnsembleResults)
          .where(eq(faaEnsembleResults.signalId, signalId)),
      ).toEqual([]);
    });

    it("retains exact billed malformed-output and quota receipts in the current Jev case", async () => {
      const scenarios = [
        {
          label: "billed-malformed",
          code: "invalid_structured_output" as const,
          costUsd: 0.125,
          stepStatus: "retryable_failure",
        },
        {
          label: "billed-quota",
          code: "quota_exhausted" as const,
          costUsd: 0.25,
          stepStatus: "quota_deferred",
        },
      ];

      for (const scenario of scenarios) {
        const signalId = await createRawSignal(scenario.label);
        const jevState = await runJev(signalId);
        const scopeId = await createScope(signalId, scenario.label);
        let modelCalls = 0;
        const callAnalystModel = async (): Promise<AnalystModelCallResult> => {
          modelCalls += 1;
          throw billedError(scenario.code, scenario.costUsd);
        };
        const options = museOptions(scopeId, {
          maxModelCalls: 1,
          maxResourceActions: 1,
          maxActiveWorkMs: 30_000,
        });
        const dependencies = museDependencies(
          callAnalystModel,
          unusedResourceExecutor,
        );

        const first = await runMuseReviews(
          getDatabase(),
          options,
          dependencies,
        );
        expect(first.verified).toBe(0);
        expect(modelCalls).toBe(1);
        let state = await currentReviewState(signalId);
        expect(state.jevEvaluationId).toBe(jevState.jevEvaluationId);
        expect(state.inputHash).toBe(jevState.inputHash);
        let view = await currentCase(signalId);
        expect(view.currentTriage?.id).toBe(jevState.jevEvaluationId);
        expect(
          view.steps.filter((step) => step.kind === "final_verifier"),
        ).toHaveLength(1);
        expect(
          view.steps.find((step) => step.kind === "final_verifier"),
        ).toMatchObject({
          status: scenario.stepStatus,
          costKnown: true,
          costUsd: scenario.costUsd.toString(),
          claimInputHash: jevState.inputHash,
        });
        expect(view.modelSpend).toEqual({
          knownActualCostUsd: scenario.costUsd.toString(),
          receiptCount: 1,
          unknownReceiptCount: 0,
        });

        await forceReviewDue(signalId);
        await runMuseReviews(
          getDatabase(),
          museOptions(scopeId, {
            maxModelCalls: 8,
            maxResourceActions: 8,
            maxActiveWorkMs: 300_000,
          }),
          dependencies,
        );
        expect(modelCalls).toBe(1);
        state = await currentReviewState(signalId);
        view = await currentCase(signalId);
        expect(state.jevEvaluationId).toBe(jevState.jevEvaluationId);
        expect(view.modelSpend).toEqual({
          knownActualCostUsd: scenario.costUsd.toString(),
          receiptCount: 1,
          unknownReceiptCount: 0,
        });
      }
    });
  },
);
