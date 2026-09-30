import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { closeDatabase, getDatabase } from "../packages/database/src/client.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  faaEnsembleEvaluations,
  faaEnsembleResults,
  faaReviewModelUsage,
  researchProviderBudgetScopes,
  researchProviderUsage,
  signalAnalystCases,
  signalAnalystSteps,
  sourceSignals,
} from "../packages/database/src/schema.js";
import {
  readSourceSignalTimeline,
  type SignalTimelineEvent,
} from "../packages/database/src/signal-timeline.js";

const DB_TESTS_ENABLED =
  process.env.ASI_DB_TESTS === "1" &&
  process.env.ASI_TEST_DATABASE_ADMIN_URL !== undefined;
const SAFE_SCRATCH_DATABASE = /^asi_signal_timeline_[0-9a-f]{32}$/u;
const AT = new Date("2026-09-30T12:00:00.000Z");
const HASH = "a".repeat(64);

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

async function createSignal(label: string): Promise<string> {
  const id = randomUUID();
  await getDatabase()
    .insert(sourceSignals)
    .values({
      id,
      sourceKey: "faa_pma_database",
      sourceLocator: `https://example.test/source/${label}`,
      sourceFingerprint: `signal-timeline:${label}:${id}`,
      rawName: `Timeline ${label}`,
      sourcePayload: {
        url: `https://example.test/source/${label}`,
        title: `Timeline source ${label}`,
        quote: "A retained source observation.",
      },
      createdAt: AT,
      updatedAt: AT,
    });
  return id;
}

async function collectTimeline(signalId: string, limit: number) {
  const items: SignalTimelineEvent[] = [];
  let after: string | undefined;
  do {
    const page = await readSourceSignalTimeline(getDatabase(), signalId, {
      limit,
      ...(after === undefined ? {} : { after }),
    });
    items.push(...page.items);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined);
  return items;
}

describe.skipIf(!DB_TESTS_ENABLED)(
  "source-signal timeline (isolated PostgreSQL)",
  () => {
    const adminDatabaseUrl = process.env.ASI_TEST_DATABASE_ADMIN_URL!;
    const scratchDatabase = `asi_signal_timeline_${randomUUID().replaceAll("-", "")}`;
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
      await getDatabase().execute(sql`TRUNCATE TABLE source_signals CASCADE`);
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

    it("pages microsecond-distinct history, folds shared receipts, and retains every judgment", async () => {
      const signalId = await createSignal("full-history");
      const evaluationRows = Array.from({ length: 105 }, (_, index) => ({
        id: randomUUID(),
        signalId,
        modelId: index === 0 ? "muse-final" : `jev-${index}`,
        promptVersion: "timeline-jev-v1",
        inputHash: index < 2 ? null : index.toString(16).padStart(64, "0"),
        rawResponse: "{}",
        parsed: { source: { url: "https://example.test/evaluation" } },
        decision: index % 2 === 0 ? "research" : "reject",
        createdAt: AT,
        updatedAt: AT,
      }));
      await getDatabase().insert(faaEnsembleEvaluations).values(evaluationRows);
      await Promise.all(
        evaluationRows.map((evaluation, index) =>
          getDatabase().execute(sql`
            UPDATE faa_ensemble_evaluations
            SET created_at = ${`2026-09-30T12:00:00.${String(index + 1).padStart(6, "0")}Z`}::timestamptz
            WHERE id = ${evaluation.id}::uuid
          `),
        ),
      );
      const diagnosticJevEvaluationId = randomUUID();
      await getDatabase().insert(faaEnsembleEvaluations).values({
        id: diagnosticJevEvaluationId,
        signalId,
        modelId: "jev-aggregate-diagnostic",
        promptVersion: "timeline-jev-v1",
        inputHash: HASH,
        decision: "research",
        costUsd: "0.125",
        reason: "Retained Jev aggregate judgment.",
        createdAt: AT,
        updatedAt: AT,
      });

      const linkedReceiptId = randomUUID();
      const orphanReceiptId = randomUUID();
      const jevR1ReceiptId = randomUUID();
      const jevR2ReceiptId = randomUUID();
      await getDatabase()
        .insert(faaReviewModelUsage)
        .values([
          {
            id: linkedReceiptId,
            sourceSignalId: signalId,
            configuredModel: "muse-model",
            returnedModel: "muse-model",
            phase: "muse",
            rung: "r2",
            promptVersion: "muse-v1",
            inputHash: HASH,
            costUsd: "0.004",
            legacyEvaluationId: evaluationRows[0]!.id,
            observedAt: AT,
          },
          {
            id: orphanReceiptId,
            sourceSignalId: signalId,
            configuredModel: "legacy-model",
            returnedModel: null,
            phase: null,
            rung: null,
            promptVersion: "legacy-v1",
            inputHash: null,
            costUsd: null,
            observedAt: AT,
          },
          {
            id: jevR1ReceiptId,
            sourceSignalId: signalId,
            configuredModel: "jev-model",
            returnedModel: "jev-model",
            phase: "jev",
            rung: "r1",
            promptVersion: "timeline-jev-v1",
            inputHash: HASH,
            costUsd: "0.010",
            observedAt: AT,
          },
          {
            id: jevR2ReceiptId,
            sourceSignalId: signalId,
            configuredModel: "jev-model",
            returnedModel: "jev-model",
            phase: "jev",
            rung: "r2",
            promptVersion: "timeline-jev-v1",
            inputHash: HASH,
            costUsd: "0.020",
            observedAt: AT,
          },
        ]);

      const completedCaseId = randomUUID();
      const deferredCaseId = randomUUID();
      await getDatabase()
        .insert(signalAnalystCases)
        .values([
          {
            id: completedCaseId,
            signalId,
            sourceRevision: 0,
            policyVersion: "muse-v1",
            inputHash: HASH,
            status: "completed",
            limits: { maxSteps: 3 },
            checkpoint: { retained: true },
            memo: { source: { url: "https://example.test/memo" } },
            stopReason:
              "Bounded research completed with explicit unresolved questions",
            completedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
          {
            id: deferredCaseId,
            signalId,
            sourceRevision: 1,
            policyVersion: "muse-v2",
            inputHash: "b".repeat(64),
            status: "deferred",
            limits: { maxSteps: 2 },
            checkpoint: { blocked: "provider cooldown" },
            nextAttemptAt: new Date("2026-10-01T12:00:00.000Z"),
            stopReason: "Provider cooldown",
            createdAt: AT,
            updatedAt: AT,
          },
        ]);

      const completedStepId = randomUUID();
      await getDatabase()
        .insert(signalAnalystSteps)
        .values([
          {
            id: completedStepId,
            caseId: completedCaseId,
            sequence: 1,
            kind: "final_verifier",
            request: { url: "https://example.test/search" },
            requestHash: "c".repeat(64),
            status: "completed",
            response: { results: [{ url: "https://example.test/result" }] },
            claimPhase: "muse",
            claimLeaseToken: randomUUID(),
            claimInputHash: HASH,
            modelUsageReceiptId: linkedReceiptId,
            costKnown: true,
            costUsd: "0.004",
            startedAt: AT,
            finishedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
          {
            id: randomUUID(),
            caseId: completedCaseId,
            sequence: 2,
            kind: "exa_contents",
            request: { url: "https://example.test/late" },
            requestHash: "d".repeat(64),
            status: "late_result",
            observedStatus: "completed",
            response: { result: "late" },
            claimPhase: "muse",
            claimLeaseToken: randomUUID(),
            claimInputHash: HASH,
            costKnown: false,
            startedAt: AT,
            finishedAt: AT,
            lateObservedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
          {
            id: randomUUID(),
            caseId: deferredCaseId,
            sequence: 1,
            kind: "public_fetch",
            request: { url: "https://example.test/failure" },
            requestHash: "e".repeat(64),
            status: "retryable_failure",
            error: "network timeout",
            claimPhase: "muse",
            claimLeaseToken: randomUUID(),
            claimInputHash: "b".repeat(64),
            costKnown: false,
            startedAt: AT,
            finishedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
        ]);

      await getDatabase()
        .insert(researchProviderBudgetScopes)
        .values([
          {
            id: "timeline-openrouter-scope",
            provider: "openrouter",
            startsAt: AT,
            totalCapUsd: "10",
            permitStatus: "active",
            permitUpdatedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
          {
            id: "timeline-exa-scope",
            provider: "exa",
            startsAt: AT,
            totalCapUsd: "10",
            permitStatus: "active",
            permitUpdatedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
        ]);
      const openRouterUsageId = linkedReceiptId;
      await getDatabase()
        .insert(researchProviderUsage)
        .values([
          {
            id: openRouterUsageId,
            provider: "openrouter",
            operation: "muse_generation",
            sourceSignalId: signalId,
            analystStepId: completedStepId,
            budgetScopeId: "timeline-openrouter-scope",
            requestHash: "f".repeat(64),
            usageDay: "2026-09-30",
            estimatedCostUsd: "0.005",
            status: "succeeded",
            actualCostUsd: "0.004",
            observedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
          {
            id: randomUUID(),
            provider: "exa",
            operation: "search",
            sourceSignalId: signalId,
            analystStepId: null,
            budgetScopeId: "timeline-exa-scope",
            requestHash: "f".repeat(63) + "0",
            usageDay: "2026-09-30",
            estimatedCostUsd: "0.005",
            status: "succeeded",
            actualCostUsd: "0.004",
            observedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
        ]);
      const finalResultId = randomUUID();
      await getDatabase().insert(faaEnsembleResults).values({
        id: finalResultId,
        signalId,
        promptVersion: "timeline-jev-v1",
        adjudicatorPromptVersion: "timeline-adjudicator-v1",
        inputHash: HASH,
        museEvaluationId: evaluationRows[0]!.id,
        finalDecision: "research",
        reason: "retained final result",
        createdAt: AT,
        updatedAt: AT,
      });

      const expectedEvaluationIds = evaluationRows
        .toReversed()
        .map((evaluation) => `faa_evaluation:${evaluation.id}`);
      const expectedEvaluationIdSet = new Set(expectedEvaluationIds);
      const events: SignalTimelineEvent[] = [];
      let after: string | undefined;
      let evaluationOffset = 0;
      let pageIndex = 0;
      do {
        const page = await readSourceSignalTimeline(getDatabase(), signalId, {
          limit: 17,
          ...(after === undefined ? {} : { after }),
        });
        const pageEvaluationIds = page.items
          .filter((event) => expectedEvaluationIdSet.has(event.id))
          .map((event) => event.id);
        if (pageIndex < 6) expect(pageEvaluationIds).toHaveLength(17);
        expect(pageEvaluationIds).toEqual(
          expectedEvaluationIds.slice(
            evaluationOffset,
            evaluationOffset + pageEvaluationIds.length,
          ),
        );
        if (pageIndex === 0) {
          expect(
            JSON.parse(
              Buffer.from(page.nextCursor!, "base64url").toString("utf8"),
            ),
          ).toMatchObject({ t: "2026-09-30T12:00:00.000089Z" });
        }
        evaluationOffset += pageEvaluationIds.length;
        events.push(...page.items);
        after = page.nextCursor ?? undefined;
        pageIndex += 1;
      } while (after !== undefined);
      expect(evaluationOffset).toBe(expectedEvaluationIds.length);
      expect(events).toHaveLength(117);
      expect(
        events
          .filter((event) => expectedEvaluationIdSet.has(event.id))
          .map((event) => event.occurredAt),
      ).toEqual(
        evaluationRows
          .toReversed()
          .map(
            (_, index) =>
              `2026-09-30T12:00:00.${String(105 - index).padStart(6, "0")}Z`,
          ),
      );
      expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
      expect(
        events.some(
          (event) => event.id === `provider_usage:${openRouterUsageId}`,
        ),
      ).toBe(false);
      expect(
        events.some((event) => event.id === `model_receipt:${linkedReceiptId}`),
      ).toBe(false);
      expect(
        events.filter((event) => event.kind === "faa_evaluation"),
      ).toHaveLength(106);
      expect(
        events.filter(
          (event) =>
            event.kind === "faa_evaluation" && event.inputHash === null,
        ),
      ).toHaveLength(2);
      expect(
        events.filter((event) => event.kind === "muse_episode"),
      ).toHaveLength(2);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `model_receipt:${orphanReceiptId}`,
            inputHash: null,
            caseId: null,
            costUsd: null,
            costKnown: false,
          }),
          expect.objectContaining({
            kind: "muse_step",
            details: expect.objectContaining({
              receipt: expect.objectContaining({ id: linkedReceiptId }),
              providerUsage: expect.objectContaining({ id: openRouterUsageId }),
            }),
          }),
          expect.objectContaining({
            kind: "provider_usage",
            status: "succeeded",
            details: expect.objectContaining({ stage: "resource" }),
          }),
          expect.objectContaining({ kind: "muse_step", status: "late_result" }),
          expect.objectContaining({
            kind: "muse_step",
            status: "retryable_failure",
          }),
        ]),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `faa_evaluation:${evaluationRows[0]!.id}`,
            costUsd: null,
            costKnown: null,
            details: expect.objectContaining({
              receipt: expect.objectContaining({
                id: linkedReceiptId,
                billedByMuseStep: true,
              }),
              providerUsage: expect.objectContaining({ id: linkedReceiptId }),
            }),
          }),
          expect.objectContaining({
            id: `muse_step:${completedStepId}`,
            costUsd: "0.004",
            costKnown: true,
            details: expect.objectContaining({
              receipt: expect.objectContaining({ id: linkedReceiptId }),
              providerUsage: expect.objectContaining({ id: linkedReceiptId }),
            }),
          }),
          expect.objectContaining({
            id: `faa_result:${finalResultId}`,
            status: "research",
            details: expect.objectContaining({
              museEvaluationId: evaluationRows[0]!.id,
            }),
          }),
          expect.objectContaining({
            id: `faa_evaluation:${diagnosticJevEvaluationId}`,
            status: "research",
            costUsd: null,
            costKnown: null,
            details: expect.objectContaining({
              diagnosticEvaluationCostUsd: "0.125",
              receipt: null,
            }),
          }),
          expect.objectContaining({
            id: `model_receipt:${jevR1ReceiptId}`,
            costUsd: "0.010",
            costKnown: true,
            details: expect.objectContaining({ rung: "r1" }),
          }),
          expect.objectContaining({
            id: `model_receipt:${jevR2ReceiptId}`,
            costUsd: "0.020",
            costKnown: true,
            details: expect.objectContaining({ rung: "r2" }),
          }),
        ]),
      );
      for (let index = 1; index < events.length; index += 1) {
        const newer = events[index - 1]!;
        const older = events[index]!;
        expect(
          newer.occurredAt > older.occurredAt ||
            (newer.occurredAt === older.occurredAt && newer.id > older.id),
        ).toBe(true);
      }
    });

    it("renders only recorded Jev and analyst provenance with truthful roles", async () => {
      const signalId = await createSignal("structured-provenance");
      const caseId = randomUUID();
      const supportedStepId = randomUUID();
      const discoveryStepId = randomUUID();
      const checkedStepId = randomUUID();
      const jevEvaluationId = randomUUID();
      await getDatabase().insert(signalAnalystCases).values({
        id: caseId,
        signalId,
        sourceRevision: 0,
        policyVersion: "muse-provenance-v1",
        inputHash: HASH,
        status: "completed",
        limits: {},
        checkpoint: {},
        createdAt: AT,
        updatedAt: AT,
      });
      await getDatabase()
        .insert(signalAnalystSteps)
        .values([
          {
            id: supportedStepId,
            caseId,
            sequence: 1,
            kind: "exa_contents",
            request: {
              urls: ["https://support.example/page?tab=products#specs"],
            },
            requestHash: "1".repeat(64),
            status: "completed",
            response: {
              tool: "exa_contents",
              supportRole: "candidate_evidence",
              sourceReferences: [
                {
                  locator: "https://support.example/request",
                  finalUrl: "https://support.example/page?tab=products#specs",
                  representation: "provider_extracted_text",
                },
                {
                  locator:
                    "https://credential.example/private?token=should-not-appear",
                  finalUrl: null,
                  representation: "provider_extracted_text",
                },
                {
                  locator:
                    "https://credential.example/private?access_token=access-token-secret",
                  finalUrl: null,
                  representation: "provider_extracted_text",
                },
                {
                  locator:
                    "https://credential.example/private?api_key=api-key-secret",
                  finalUrl: null,
                  representation: "provider_extracted_text",
                },
                {
                  locator:
                    "https://credential.example/private?auth=auth-secret",
                  finalUrl: null,
                  representation: "provider_extracted_text",
                },
                {
                  locator:
                    "https://credential.example/private?X-Amz-Credential=signed-credential&X-Amz-Signature=signed-signature",
                  finalUrl: null,
                  representation: "provider_extracted_text",
                },
              ],
              pages: [
                {
                  url: "https://support.example/page?tab=products#specs",
                  title: "Supported product page",
                  extractedText: "Named product evidence.",
                },
              ],
              failure: null,
              accessLimit: null,
            },
            claimPhase: "muse",
            claimLeaseToken: randomUUID(),
            claimInputHash: HASH,
            costKnown: false,
            startedAt: AT,
            finishedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
          {
            id: discoveryStepId,
            caseId,
            sequence: 2,
            kind: "exa_search",
            request: { query: "supplier product" },
            requestHash: "2".repeat(64),
            status: "completed",
            response: {
              tool: "exa_search",
              supportRole: "discovery_only",
              sourceReferences: [
                {
                  locator: "https://discovery.example/search?q=supplier#result",
                  finalUrl:
                    "https://discovery.example/search?q=supplier#result",
                  representation: "provider_extracted_snippet",
                },
              ],
              results: [
                {
                  url: "https://discovery.example/search?q=supplier#result",
                  title: "Discovery result",
                  textSnippet: "Lead only; this is not evidence.",
                },
              ],
              failure: null,
              accessLimit: null,
            },
            claimPhase: "muse",
            claimLeaseToken: randomUUID(),
            claimInputHash: HASH,
            costKnown: false,
            startedAt: AT,
            finishedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
          {
            id: checkedStepId,
            caseId,
            sequence: 3,
            kind: "public_page",
            request: { url: "https://checked.example/unavailable" },
            requestHash: "3".repeat(64),
            status: "retryable_failure",
            response: {
              tool: "public_page",
              supportRole: "checked_only",
              sourceReferences: [
                {
                  locator: "https://checked.example/unavailable",
                  finalUrl: null,
                  representation: "checked_failure",
                },
              ],
              failure: {
                code: "timeout",
                message: "Timed out",
                retryable: true,
              },
              accessLimit: null,
            },
            error: "Timed out",
            claimPhase: "muse",
            claimLeaseToken: randomUUID(),
            claimInputHash: HASH,
            costKnown: false,
            startedAt: AT,
            finishedAt: AT,
            createdAt: AT,
            updatedAt: AT,
          },
        ]);
      await getDatabase()
        .insert(faaEnsembleEvaluations)
        .values({
          id: jevEvaluationId,
          signalId,
          modelId: "jev-provenance",
          promptVersion: "jev-triage-v1",
          inputHash: HASH,
          parsed: {
            version: "jev-triage-v1",
            observations: [
              {
                sourceReferences: [
                  {
                    kind: "source_document",
                    url: "https://jev.example/support?section=products#proof",
                    title: "Jev support",
                    quote: "Jev grounded support.",
                    role: "support",
                    sourceKind: "publisher_site",
                  },
                  {
                    kind: "source_signal",
                    sourceLocator: "https://jev.example/intake?record=1#row",
                  },
                ],
              },
            ],
            gaps: [
              {
                supportingSources: [],
                conflictingSources: [
                  {
                    kind: "source_document",
                    url: "https://jev.example/checked?attempt=1#result",
                    title: "Checked source",
                    quote: "The page was checked but did not supply support.",
                    role: "checked_only",
                    sourceKind: "publisher_site",
                  },
                ],
              },
            ],
          },
          decision: "research",
          createdAt: AT,
          updatedAt: AT,
        });

      const events = await collectTimeline(signalId, 1);
      const supported = events.find(
        (event) => event.id === `muse_step:${supportedStepId}`,
      );
      const discovery = events.find(
        (event) => event.id === `muse_step:${discoveryStepId}`,
      );
      const checked = events.find(
        (event) => event.id === `muse_step:${checkedStepId}`,
      );
      const jev = events.find(
        (event) => event.id === `faa_evaluation:${jevEvaluationId}`,
      );
      expect(supported?.sources).toEqual([
        expect.objectContaining({
          url: "https://support.example/page?tab=products#specs",
          title: "Supported product page",
          role: "support",
          representation: "provider_extracted_text",
        }),
      ]);
      expect(discovery?.sources).toEqual([
        expect.objectContaining({
          url: "https://discovery.example/search?q=supplier#result",
          title: "Discovery result",
          role: "discovery_only",
          representation: "provider_extracted_snippet",
        }),
      ]);
      expect(checked?.sources).toEqual([
        expect.objectContaining({
          url: "https://checked.example/unavailable",
          role: "checked_failure",
          representation: "checked_failure",
        }),
      ]);
      expect(jev?.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            url: "https://jev.example/support?section=products#proof",
            role: "support",
            representation: "publisher_site",
          }),
          expect.objectContaining({
            url: "https://jev.example/intake?record=1#row",
            role: "discovery_only",
            representation: "source_signal",
          }),
          expect.objectContaining({
            url: "https://jev.example/checked?attempt=1#result",
            role: "checked_failure",
            representation: "publisher_site",
          }),
        ]),
      );
      const renderedSourceUrls = events
        .flatMap((event) => event.sources)
        .map((source) => source.url);
      const serializedDetails = JSON.stringify(
        events.map((event) => event.details),
      );
      for (const secret of [
        "should-not-appear",
        "access-token-secret",
        "api-key-secret",
        "auth-secret",
        "signed-credential",
        "signed-signature",
      ]) {
        expect(renderedSourceUrls.join("\n")).not.toContain(secret);
        expect(serializedDetails).not.toContain(secret);
      }
      expect(supported?.details).toEqual(
        expect.objectContaining({
          response: expect.objectContaining({
            redacted: true,
          }),
        }),
      );
    });

    it("rejects malformed and cross-source opaque cursors", async () => {
      const left = await createSignal("cursor-left");
      await getDatabase().insert(faaEnsembleEvaluations).values({
        id: randomUUID(),
        signalId: left,
        modelId: "cursor-model",
        promptVersion: "cursor-v1",
        inputHash: null,
      });
      const right = await createSignal("cursor-right");
      const page = await readSourceSignalTimeline(getDatabase(), left, {
        limit: 1,
      });
      expect(page.nextCursor).not.toBeNull();
      const malformedCalendarCursor = Buffer.from(
        JSON.stringify({
          v: 1,
          s: left,
          t: "2026-02-29T12:00:00.000000Z",
          i: "faa_evaluation:malformed-calendar",
        }),
        "utf8",
      ).toString("base64url");
      await expect(
        readSourceSignalTimeline(getDatabase(), left, {
          limit: 1,
          after: malformedCalendarCursor,
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        readSourceSignalTimeline(getDatabase(), left, {
          limit: 1,
          after: "not-a-cursor",
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        readSourceSignalTimeline(getDatabase(), right, {
          limit: 1,
          after: page.nextCursor!,
        }),
      ).rejects.toThrow(TypeError);
    });
  },
);
