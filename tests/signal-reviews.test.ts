import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  closeDatabase,
  getDatabase,
  getPool,
} from "../packages/database/src/client.js";
import { runMigrations } from "../packages/database/src/migrate.js";
import {
  faaEnsembleEvaluations,
  signalReviewState,
  sourceSignals,
} from "../packages/database/src/schema.js";
import {
  bootstrapSignalReviewStates,
  claimSignalReviews,
  commitSignalReview,
  completeSignalResearch,
  ensureSignalReviewState,
  failSignalReview,
  hashSignalReviewInput,
  reconcileChangedSignalReviews,
  updateClaimedSignalReviewInput,
} from "../packages/database/src/signal-reviews.js";
import {
  CurrentReviewInputDrainIncompleteError,
  currentFaaReviewInputContract,
  drainCurrentReviewInputs,
  reconcileCurrentReviewInputs,
  resolveEnsembleConfig,
} from "../packages/research/src/faa-ensemble/runner.js";

const DB_TESTS_ENABLED = process.env.ASI_DB_TESTS === "1";
const createdSignalIds: string[] = [];

async function createSignal(label: string): Promise<string> {
  const id = randomUUID();
  const db = getDatabase();
  await db.insert(sourceSignals).values({
    id,
    sourceKey: "faa_pma_database",
    sourceLocator: `https://example.test/reviews/${label}`,
    sourceFingerprint: `signal-review-test:${label}:${id}`,
    rawName: `Signal Review ${label}`,
  });
  createdSignalIds.push(id);
  return id;
}

async function claimOnly(phase: "research" | "jev" | "muse" | "settled") {
  const claims = await claimSignalReviews(getDatabase(), {
    phase,
    limit: 1,
    leaseSeconds: 60,
  });
  const claim = claims[0];
  if (claim === undefined) throw new Error(`expected one ${phase} claim`);
  return claim;
}

describe("signal review stable input hashing", () => {
  it("ignores retrieval metadata, persistence IDs, duplicate ordering, and object order", () => {
    const first = {
      identity: { domain: "acme.example", legalName: "Acme Aerospace" },
      sources: [
        {
          id: randomUUID(),
          evidenceId: randomUUID(),
          url: "https://acme.example/products",
          quote: "FAA-approved fuel pumps",
          retrievedAt: "2026-09-26T10:00:00.000Z",
        },
        { url: "https://acme.example/about", quote: "Privately held" },
      ],
    };
    const refreshed = {
      sources: [
        { quote: "Privately held", url: "https://acme.example/about" },
        {
          retrievedAt: "2026-09-27T14:30:00.000Z",
          quote: "FAA-approved fuel pumps",
          url: "https://acme.example/products",
          evidenceId: randomUUID(),
          id: randomUUID(),
        },
        { quote: "Privately held", url: "https://acme.example/about" },
      ],
      identity: { legalName: "Acme Aerospace", domain: "acme.example" },
    };

    expect(hashSignalReviewInput(refreshed)).toBe(hashSignalReviewInput(first));
    expect(
      hashSignalReviewInput({
        ...refreshed,
        identity: { ...refreshed.identity, domain: "other.example" },
      }),
    ).not.toBe(hashSignalReviewInput(first));
    expect(
      hashSignalReviewInput({
        identity: { id: "CAGE-A", domain: "acme.example" },
      }),
    ).not.toBe(
      hashSignalReviewInput({
        identity: { id: "CAGE-B", domain: "acme.example" },
      }),
    );
  });
});

describe.skipIf(!DB_TESTS_ENABLED)(
  "durable signal review lifecycle (DB)",
  () => {
    beforeAll(async () => {
      await runMigrations();
    });

    afterAll(async () => {
      await closeDatabase();
    });

    afterEach(async () => {
      const db = getDatabase();
      for (const signalId of createdSignalIds.splice(0)) {
        await db.delete(sourceSignals).where(eq(sourceSignals.id, signalId));
      }
    });

    it("reopens only machine-failed FAA signals without changing ingestion decisions", async () => {
      const db = getDatabase();
      const candidates = [
        {
          id: randomUUID(),
          sourceKey: "faa_pma_database",
          status: "rejected" as const,
          qualification: { reason: "official_identity_not_verified" },
        },
        {
          id: randomUUID(),
          sourceKey: "faa_drs_pma",
          status: "quarantined" as const,
          qualification: { error: "qualification_error" },
        },
        {
          id: randomUUID(),
          sourceKey: "faa_pma_database",
          status: "rejected" as const,
          qualification: {
            reason: "official_identity_not_verified",
            reviewedByUserId: randomUUID(),
          },
        },
        {
          id: randomUUID(),
          sourceKey: "sam_entity",
          status: "rejected" as const,
          qualification: { reason: "qualification_error" },
        },
      ];
      for (const [index, candidate] of candidates.entries()) {
        await db.insert(sourceSignals).values({
          createdAt: new Date(`1900-01-01T00:00:0${index}.000Z`),
          ...candidate,
          sourceLocator: `https://example.test/bootstrap/${index}`,
          sourceFingerprint: `signal-review-bootstrap:${candidate.id}`,
          rawName: `Bootstrap Candidate ${index}`,
        });
        createdSignalIds.push(candidate.id);
      }

      await bootstrapSignalReviewStates(db, { limit: 1_000 });
      await bootstrapSignalReviewStates(db, { limit: 1_000 });

      const states = await db
        .select({ signalId: signalReviewState.signalId })
        .from(signalReviewState)
        .where(
          inArray(
            signalReviewState.signalId,
            candidates.map(({ id }) => id),
          ),
        );
      expect(states.map(({ signalId }) => signalId).sort()).toEqual(
        candidates
          .slice(0, 2)
          .map(({ id }) => id)
          .sort(),
      );
      const preserved = await db
        .select({ id: sourceSignals.id, status: sourceSignals.status })
        .from(sourceSignals)
        .where(
          inArray(
            sourceSignals.id,
            candidates.map(({ id }) => id),
          ),
        );
      expect(
        Object.fromEntries(
          preserved.map(({ id, status }) => [id, status] as const),
        ),
      ).toMatchObject(
        Object.fromEntries(
          candidates.map(({ id, status }) => [id, status] as const),
        ),
      );
    });

    it("bounds bootstrap, revision reconciliation, and claims to explicit source IDs", async () => {
      const selectedSignalId = await createSignal("scope-selected");
      const excludedSignalId = await createSignal("scope-excluded");
      const unbootstrappedSignalId = await createSignal("scope-empty");

      expect(
        await bootstrapSignalReviewStates(getDatabase(), {
          limit: 10,
          sourceSignalIds: [selectedSignalId],
        }),
      ).toBe(1);
      expect(
        await bootstrapSignalReviewStates(getDatabase(), {
          limit: 10,
          sourceSignalIds: [],
        }),
      ).toBe(0);
      await ensureSignalReviewState(getDatabase(), excludedSignalId);

      const bootstrapped = await getDatabase()
        .select({ signalId: signalReviewState.signalId })
        .from(signalReviewState)
        .where(
          inArray(signalReviewState.signalId, [
            selectedSignalId,
            excludedSignalId,
            unbootstrappedSignalId,
          ]),
        );
      expect(bootstrapped.map(({ signalId }) => signalId).sort()).toEqual(
        [selectedSignalId, excludedSignalId].sort(),
      );

      await getDatabase()
        .update(sourceSignals)
        .set({ rawName: "Changed scoped source" })
        .where(inArray(sourceSignals.id, [selectedSignalId, excludedSignalId]));
      expect(
        await reconcileChangedSignalReviews(getDatabase(), {
          limit: 10,
          sourceSignalIds: [selectedSignalId],
        }),
      ).toBe(1);
      expect(
        await reconcileChangedSignalReviews(getDatabase(), {
          limit: 10,
          sourceSignalIds: [],
        }),
      ).toBe(0);

      const revisions = await getDatabase()
        .select({
          signalId: signalReviewState.signalId,
          sourceRevision: signalReviewState.sourceRevision,
        })
        .from(signalReviewState)
        .where(
          inArray(signalReviewState.signalId, [
            selectedSignalId,
            excludedSignalId,
          ]),
        );
      expect(
        Object.fromEntries(
          revisions.map(({ signalId, sourceRevision }) => [
            signalId,
            sourceRevision,
          ]),
        ),
      ).toEqual({
        [selectedSignalId]: 1,
        [excludedSignalId]: 0,
      });

      const claims = await claimSignalReviews(getDatabase(), {
        phase: "research",
        limit: 10,
        sourceSignalIds: [selectedSignalId],
      });
      expect(claims.map(({ signalId }) => signalId)).toEqual([selectedSignalId]);
      await expect(
        claimSignalReviews(getDatabase(), {
          phase: "research",
          limit: 10,
          sourceSignalIds: [],
        }),
      ).resolves.toEqual([]);
    });

    it("claims current Muse work in canonical score order rather than Jev tier order", async () => {
      const labels = ["low", "high", "stale", "future"] as const;
      const ids = Object.fromEntries(
        await Promise.all(
          labels.map(async (label) => [label, await createSignal(`priority-${label}`)]),
        ),
      ) as Record<(typeof labels)[number], string>;
      const expectedReviewInputContract = currentFaaReviewInputContract(
        resolveEnsembleConfig({}),
      );
      const fullEvidence = {
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
      const unknownEvidence = {
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
      const now = Date.now();
      for (const [label, researchPriority] of [
        ["low", 1],
        ["high", 3],
        ["stale", 1],
        ["future", 1],
      ] as const) {
        const evidence = label === "high" || label === "future"
          ? fullEvidence
          : unknownEvidence;
        const inputManifest = {
          ...expectedReviewInputContract,
          sourceRevision: 0,
          evidence,
        };
        const inputHash = hashSignalReviewInput(inputManifest);
        const evaluationInputHash =
          label === "stale"
            ? hashSignalReviewInput({ label, stale: true })
            : inputHash;
        const evaluationId = randomUUID();
        await ensureSignalReviewState(getDatabase(), ids[label], "muse");
        await getDatabase().insert(faaEnsembleEvaluations).values({
          id: evaluationId,
          signalId: ids[label],
          modelId: expectedReviewInputContract.policy.jevModel,
          promptVersion: "jev-priority-test-v1",
          inputHash: evaluationInputHash,
          inputManifest,
          parsed: {
            version: "jev-triage-v1",
            decision: label === "high" || label === "future" ? "high_priority" : "research",
            confidence: 70,
            productFit:
              label === "high" || label === "future"
                ? "supported_product"
                : "plausible_supplier",
            acquisitionReadiness:
              label === "high" || label === "future" ? "ready" : "needs_research",
            researchPriority,
            reasonCodes: [],
            explanation: "canonical Muse ordering fixture",
            observations: [],
            gaps: [],
          },
          decision: label === "high" || label === "future" ? "high_priority" : "research",
          confidence: 70,
        });
        await getDatabase()
          .update(signalReviewState)
          .set({
            phase: "muse",
            inputHash,
            inputManifest,
            jevEvaluationId: evaluationId,
            nextAttemptAt:
              label === "future"
                ? new Date(now + 60_000)
                : new Date(now - (label === "low" ? 5_000 : 1_000)),
          })
          .where(eq(signalReviewState.signalId, ids[label]));
      }

      const claims = await claimSignalReviews(getDatabase(), {
        phase: "muse",
        limit: 4,
        expectedReviewInputContract,
      });
      expect(claims.map((claim) => claim.signalId)).toEqual([
        ids.high,
        ids.low,
      ]);
    });

    it("claims a signal once and rejects a reclaimed worker's publication", async () => {
      const signalId = await createSignal("fence");
      await ensureSignalReviewState(getDatabase(), signalId);

      const [left, right] = await Promise.all([
        claimSignalReviews(getDatabase(), { phase: "research", limit: 1 }),
        claimSignalReviews(getDatabase(), { phase: "research", limit: 1 }),
      ]);
      expect([...left, ...right]).toHaveLength(1);
      const staleClaim = [...left, ...right][0]!;

      await getDatabase()
        .update(signalReviewState)
        .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(signalReviewState.signalId, signalId));
      const replacement = await claimOnly("research");
      expect(replacement.leaseToken).not.toBe(staleClaim.leaseToken);

      let stalePersistenceCalls = 0;
      const staleResult = await commitSignalReview(
        getDatabase(),
        staleClaim,
        { phase: "settled", nextAttemptAt: new Date() },
        async () => {
          stalePersistenceCalls += 1;
        },
      );
      expect(staleResult).toEqual({ accepted: false });
      expect(stalePersistenceCalls).toBe(0);

      const accepted = await commitSignalReview(
        getDatabase(),
        replacement,
        { phase: "settled", nextAttemptAt: new Date("9999-12-31T00:00:00Z") },
        async () => "published",
      );
      expect(accepted).toMatchObject({ accepted: true, value: "published" });
    });

    it("rejects publication after a material source edit and requeues research", async () => {
      const signalId = await createSignal("source-edit-fence");
      await ensureSignalReviewState(getDatabase(), signalId);
      const claim = await claimOnly("research");

      await getDatabase()
        .update(sourceSignals)
        .set({ rawName: "Corrected Source Name" })
        .where(eq(sourceSignals.id, signalId));

      let persistenceCalls = 0;
      const result = await commitSignalReview(
        getDatabase(),
        claim,
        { phase: "settled" },
        async () => {
          persistenceCalls += 1;
        },
      );
      expect(result).toEqual({ accepted: false });
      expect(persistenceCalls).toBe(0);

      const [state] = await getDatabase()
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(state).toMatchObject({
        phase: "research",
        sourceRevision: claim.sourceRevision + 1,
        inputHash: null,
        inputManifest: null,
        jevEvaluationId: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
    });

    it("rolls back callback writes when the lease expires during persistence", async () => {
      const signalId = await createSignal("callback-expiry");
      await ensureSignalReviewState(getDatabase(), signalId);
      const claim = (
        await claimSignalReviews(getDatabase(), {
          phase: "research",
          limit: 1,
          leaseSeconds: 1,
        })
      )[0]!;
      const evaluationId = randomUUID();
      const result = await commitSignalReview(
        getDatabase(),
        claim,
        { phase: "settled" },
        async (tx) => {
          await tx.insert(faaEnsembleEvaluations).values({
            id: evaluationId,
            signalId,
            modelId: "expired-callback-model",
            promptVersion: "expired-callback-v1",
            inputHash: hashSignalReviewInput({ signalId }),
            inputManifest: { signalId },
            decision: "research",
            confidence: 50,
          });
          await tx.execute(sql`SELECT pg_sleep(1.1)`);
        },
      );
      expect(result).toEqual({ accepted: false });

      const evaluations = await getDatabase()
        .select({ id: faaEnsembleEvaluations.id })
        .from(faaEnsembleEvaluations)
        .where(eq(faaEnsembleEvaluations.id, evaluationId));
      expect(evaluations).toEqual([]);
      const replacement = await claimOnly("research");
      expect(replacement.leaseToken).not.toBe(claim.leaseToken);
    });

    it("returns settled human-edited sources to research without deleting history", async () => {
      const signalId = await createSignal("human-edit-after-settlement");
      await ensureSignalReviewState(getDatabase(), signalId);
      const claim = await claimOnly("research");
      const manifest = {
        sourceRevision: claim.sourceRevision,
        evidence: { name: "Signal Review" },
        policy: { version: "test-v1" },
      };
      const inputHash = hashSignalReviewInput(manifest);
      const installed = await updateClaimedSignalReviewInput(
        getDatabase(),
        claim,
        { inputHash, inputManifest: manifest },
      );
      const evaluationId = randomUUID();
      const settled = await commitSignalReview(
        getDatabase(),
        installed!,
        {
          phase: "settled",
          inputHash,
          inputManifest: manifest,
          jevEvaluationId: evaluationId,
        },
        async (tx) => {
          await tx.insert(faaEnsembleEvaluations).values({
            id: evaluationId,
            signalId,
            modelId: "settled-history-model",
            promptVersion: "settled-history-v1",
            inputHash,
            inputManifest: manifest,
            decision: "research",
            confidence: 80,
          });
        },
      );
      expect(settled).toMatchObject({ accepted: true });

      await getDatabase()
        .update(sourceSignals)
        .set({
          qualification: {
            humanDecision: "hold",
            decisionSource: "human",
            reviewedByUserId: randomUUID(),
          },
        })
        .where(eq(sourceSignals.id, signalId));
      expect(
        await reconcileChangedSignalReviews(getDatabase(), { limit: 10 }),
      ).toBe(1);

      const [state] = await getDatabase()
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      const [source] = await getDatabase()
        .select({
          reviewRevision: sourceSignals.reviewRevision,
          qualification: sourceSignals.qualification,
        })
        .from(sourceSignals)
        .where(eq(sourceSignals.id, signalId));
      const history = await getDatabase()
        .select({ id: faaEnsembleEvaluations.id })
        .from(faaEnsembleEvaluations)
        .where(eq(faaEnsembleEvaluations.id, evaluationId));
      expect(state).toMatchObject({
        phase: "research",
        sourceRevision: claim.sourceRevision + 1,
        inputHash: null,
        inputManifest: null,
        researchEvidence: {},
        jevEvaluationId: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(source).toMatchObject({
        reviewRevision: claim.sourceRevision + 1,
        qualification: {
          humanDecision: "hold",
          decisionSource: "human",
        },
      });
      expect(history).toEqual([{ id: evaluationId }]);
    });

    it("reconciles stale prompt/model policy without provider work", async () => {
      const signalId = await createSignal("contract-reconciliation");
      const state = await ensureSignalReviewState(getDatabase(), signalId);
      await getDatabase()
        .update(signalReviewState)
        .set({
          phase: "settled",
          sourceRevision: state.sourceRevision,
          inputHash: hashSignalReviewInput({ old: true }),
          inputManifest: {
            version: "old-review-contract",
            sourceRevision: state.sourceRevision,
            evidence: { identity: "still-current" },
            policy: {
              ladder: "old-ladder",
              jevModel: "old-jev",
              museModel: "old-muse",
              evaluatorPrompt: "old-prompt",
              jevAuditSampleRate: 0,
            },
          },
          researchEvidence: { identity: { legalName: "Preserved Research" } },
          nextAttemptAt: new Date("9999-12-31T00:00:00Z"),
        })
        .where(eq(signalReviewState.signalId, signalId));

      const result = await reconcileCurrentReviewInputs(getDatabase(), {
        sourceLimit: 10,
        config: resolveEnsembleConfig({}),
      });
      expect(result).toEqual({
        sourceRevisionChanges: 0,
        inputContractChanges: 1,
      });
      const [reconciled] = await getDatabase()
        .select()
        .from(signalReviewState)
        .where(eq(signalReviewState.signalId, signalId));
      expect(reconciled).toMatchObject({
        phase: "jev",
        sourceRevision: state.sourceRevision,
        inputHash: null,
        inputManifest: null,
        researchEvidence: { identity: { legalName: "Preserved Research" } },
        jevEvaluationId: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
    });

    it("drains more than one bounded source-revision batch", async () => {
      const signalIds = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const signalId = await createSignal(`multi-batch-${index}`);
          await ensureSignalReviewState(getDatabase(), signalId);
          return signalId;
        }),
      );
      await getDatabase()
        .update(sourceSignals)
        .set({ rawName: "Corrected Multi-batch Source" })
        .where(inArray(sourceSignals.id, signalIds));

      const result = await drainCurrentReviewInputs(getDatabase(), {
        sourceLimit: 2,
        config: resolveEnsembleConfig({}),
      });
      expect(result).toMatchObject({
        sourceRevisionChanges: 5,
        reconciliationPasses: 3,
      });

      const states = await getDatabase()
        .select({
          signalId: signalReviewState.signalId,
          sourceRevision: signalReviewState.sourceRevision,
          phase: signalReviewState.phase,
        })
        .from(signalReviewState)
        .where(inArray(signalReviewState.signalId, signalIds));
      expect(states).toHaveLength(5);
      expect(states).toEqual(
        expect.arrayContaining(
          signalIds.map((signalId) =>
            expect.objectContaining({
              signalId,
              sourceRevision: 1,
              phase: "jev",
            }),
          ),
        ),
      );
    });

    it("fails closed at the configured pass boundary", async () => {
      const signalIds = await Promise.all(
        Array.from({ length: 3 }, async (_, index) => {
          const signalId = await createSignal(`pass-boundary-${index}`);
          await ensureSignalReviewState(getDatabase(), signalId);
          return signalId;
        }),
      );
      await getDatabase()
        .update(sourceSignals)
        .set({ rawName: "Corrected Pass-boundary Source" })
        .where(inArray(sourceSignals.id, signalIds));

      let failure: unknown;
      try {
        await drainCurrentReviewInputs(getDatabase(), {
          sourceLimit: 1,
          maxPasses: 1,
          config: resolveEnsembleConfig({}),
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(CurrentReviewInputDrainIncompleteError);
      expect(failure).toMatchObject({
        partialResult: {
          sourceRevisionChanges: 1,
          reconciliationPasses: 1,
        },
        remainingSourceRevisionChanges: 2,
        reason: "pass_limit",
      });
    });

    it("fails closed when a locked stale research row blocks the drain", async () => {
      const unlockedSignalId = await createSignal("drain-unlocked");
      const lockedSignalId = await createSignal("drain-locked");
      await ensureSignalReviewState(getDatabase(), unlockedSignalId);
      await ensureSignalReviewState(getDatabase(), lockedSignalId);
      await getDatabase()
        .update(sourceSignals)
        .set({ rawName: "Corrected Locked Source" })
        .where(inArray(sourceSignals.id, [unlockedSignalId, lockedSignalId]));

      const lockingClient = await getPool().connect();
      let failure: unknown;
      let states: Array<{
        signalId: string;
        sourceRevision: number;
      }>;
      try {
        await lockingClient.query("BEGIN");
        await lockingClient.query(
          "SELECT signal_id FROM signal_review_state WHERE signal_id = $1 FOR UPDATE",
          [lockedSignalId],
        );
        try {
          await drainCurrentReviewInputs(getDatabase(), {
            sourceLimit: 10,
            config: resolveEnsembleConfig({}),
          });
        } catch (error) {
          failure = error;
        }
        states = await getDatabase()
          .select({
            signalId: signalReviewState.signalId,
            sourceRevision: signalReviewState.sourceRevision,
          })
          .from(signalReviewState)
          .where(
            inArray(signalReviewState.signalId, [
              unlockedSignalId,
              lockedSignalId,
            ]),
          );
      } finally {
        await lockingClient.query("ROLLBACK");
        lockingClient.release();
      }

      expect(failure).toBeInstanceOf(CurrentReviewInputDrainIncompleteError);
      expect(failure).toMatchObject({
        partialResult: {
          sourceRevisionChanges: 1,
          inputContractChanges: 0,
          reconciliationPasses: 2,
        },
        remainingSourceRevisionChanges: 1,
        reason: "no_progress",
      });
      expect(
        Object.fromEntries(
          states.map(({ signalId, sourceRevision }) => [
            signalId,
            sourceRevision,
          ]),
        ),
      ).toEqual({
        [unlockedSignalId]: 1,
        [lockedSignalId]: 0,
      });
    });

    it("defers dependency failures without consuming candidate attempts", async () => {
      const signalId = await createSignal("backoff");
      await ensureSignalReviewState(getDatabase(), signalId);
      const initial = await claimOnly("research");

      const deferred = await failSignalReview(
        getDatabase(),
        initial,
        new Error("provider budget unavailable"),
        { deferred: true, retryAfterMs: 0 },
      );
      expect(deferred?.attemptCount).toBe(0);

      const retried = await claimOnly("research");
      const failed = await failSignalReview(
        getDatabase(),
        retried,
        new Error("transport timeout"),
        { retryAfterMs: 0 },
      );
      expect(failed?.attemptCount).toBe(1);
      expect(failed?.phase).toBe("research");
      const cappedClaim = await claimOnly("research");
      const beforeCappedFailure = Date.now();
      const capped = await failSignalReview(
        getDatabase(),
        cappedClaim,
        new Error("repeated transport timeout"),
        { retryAfterMs: 7 * 24 * 60 * 60_000 },
      );
      expect(capped?.attemptCount).toBe(2);
      expect(capped?.nextAttemptAt.getTime()).toBeLessThanOrEqual(
        beforeCappedFailure + 6 * 60 * 60_000 + 1_000,
      );
    });

    it("cannot restore an obsolete-policy verdict while research holds the lease", async () => {
      const signalId = await createSignal("policy-change-during-research");
      await ensureSignalReviewState(getDatabase(), signalId);
      const firstResearch = await claimOnly("research");
      const researchEvidence = {
        identity: { domain: "acme.example", legalName: "Acme Aerospace" },
        products: [{ name: "Fuel pump", url: "https://acme.example/pumps" }],
      };
      const outcome = { status: "checked", missingFacts: ["revenue"] };
      const expectedReviewInputContract = currentFaaReviewInputContract(
        resolveEnsembleConfig({}),
      );
      const obsoleteReviewInputContract = {
        ...expectedReviewInputContract,
        policy: {
          ...expectedReviewInputContract.policy,
          evaluatorPrompt: "obsolete-evaluator-prompt",
        },
      };
      const researched = await completeSignalResearch(
        getDatabase(),
        firstResearch,
        {
          researchEvidence,
          outcome,
          researchDueAt: new Date("2000-01-01T00:00:00Z"),
          expectedReviewInputContract: obsoleteReviewInputContract,
        },
      );
      expect(researched).toMatchObject({ phase: "jev", inputHash: null });

      const jevClaim = await claimOnly("jev");
      const obsoleteManifest = {
        ...obsoleteReviewInputContract,
        sourceRevision: jevClaim.sourceRevision,
        evidence: { researchEvidence },
      };
      const obsoleteInputHash = hashSignalReviewInput(obsoleteManifest);
      const installed = await updateClaimedSignalReviewInput(
        getDatabase(),
        jevClaim,
        {
          inputHash: obsoleteInputHash,
          inputManifest: obsoleteManifest,
        },
      );
      const obsoleteEvaluationId = randomUUID();
      const researchDueAt = new Date("2000-01-01T00:00:00Z");
      const settled = await commitSignalReview(
        getDatabase(),
        installed!,
        {
          phase: "settled",
          jevEvaluationId: obsoleteEvaluationId,
          nextAttemptAt: researchDueAt,
          researchDueAt,
        },
        async (tx) => {
          await tx.insert(faaEnsembleEvaluations).values({
            id: obsoleteEvaluationId,
            signalId,
            modelId: obsoleteReviewInputContract.policy.jevModel,
            promptVersion: obsoleteReviewInputContract.policy.evaluatorPrompt,
            inputHash: obsoleteInputHash,
            inputManifest: obsoleteManifest,
            decision: "research",
            confidence: 70,
          });
        },
      );
      expect(settled).toMatchObject({ accepted: true });

      const refreshClaim = await claimOnly("research");
      expect(refreshClaim).toMatchObject({
        phase: "research",
        inputHash: obsoleteInputHash,
        jevEvaluationId: obsoleteEvaluationId,
      });
      expect(
        await reconcileCurrentReviewInputs(getDatabase(), {
          sourceLimit: 10,
          config: resolveEnsembleConfig({}),
        }),
      ).toEqual({
        sourceRevisionChanges: 0,
        inputContractChanges: 0,
      });

      const completed = await completeSignalResearch(
        getDatabase(),
        refreshClaim,
        {
          researchEvidence,
          outcome,
          researchDueAt: new Date(Date.now() + 24 * 60 * 60_000),
          expectedReviewInputContract,
        },
      );
      expect(completed).toMatchObject({
        phase: "jev",
        inputHash: null,
        inputManifest: null,
        jevEvaluationId: null,
      });
    });

    it("preserves same-input verdicts and invalidates them on substantive evidence change", async () => {
      const signalId = await createSignal("input-change");
      await ensureSignalReviewState(getDatabase(), signalId);
      const firstResearch = await claimOnly("research");
      const researchEvidence = {
        identity: { domain: "acme.example", legalName: "Acme Aerospace" },
        products: [{ name: "Fuel pump", url: "https://acme.example/pumps" }],
      };
      const outcome = { status: "checked", missingFacts: ["revenue"] };
      const expectedReviewInputContract = currentFaaReviewInputContract(
        resolveEnsembleConfig({}),
      );
      const researched = await completeSignalResearch(
        getDatabase(),
        firstResearch,
        {
          researchEvidence,
          outcome,
          researchDueAt: new Date(Date.now() + 24 * 60 * 60_000),
          expectedReviewInputContract,
        },
      );
      expect(researched).toMatchObject({ phase: "jev", inputHash: null });

      const jevClaim = await claimOnly("jev");
      const manifest = {
        ...expectedReviewInputContract,
        sourceRevision: jevClaim.sourceRevision,
        evidence: { researchEvidence },
      };
      const inputHash = hashSignalReviewInput(manifest);
      const installed = await updateClaimedSignalReviewInput(
        getDatabase(),
        jevClaim,
        { inputHash, inputManifest: manifest },
      );
      expect(installed?.inputHash).toBe(inputHash);

      const jevEvaluationId = randomUUID();
      const settled = await commitSignalReview(
        getDatabase(),
        installed!,
        {
          phase: "settled",
          jevEvaluationId,
          nextAttemptAt: new Date(),
          researchDueAt: new Date(Date.now() + 24 * 60 * 60_000),
        },
        async (tx) => {
          await tx.insert(faaEnsembleEvaluations).values({
            id: jevEvaluationId,
            signalId,
            modelId: "jev-test-model",
            promptVersion: "jev-test-v1",
            inputHash,
            inputManifest: manifest,
            decision: "research",
            confidence: 70,
          });
        },
      );
      expect(settled).toMatchObject({ accepted: true });

      const settledClaim = await claimOnly("settled");
      await commitSignalReview(
        getDatabase(),
        settledClaim,
        { phase: "research", nextAttemptAt: new Date() },
        async () => undefined,
      );
      const refreshClaim = await claimOnly("research");
      const unchanged = await completeSignalResearch(
        getDatabase(),
        refreshClaim,
        {
          researchEvidence: {
            products: [
              {
                evidenceId: randomUUID(),
                retrievedAt: "2026-09-27T12:00:00Z",
                url: "https://acme.example/pumps",
                name: "Fuel pump",
              },
            ],
            identity: { legalName: "Acme Aerospace", domain: "acme.example" },
          },
          outcome: { missingFacts: ["revenue"], status: "checked" },
          researchDueAt: new Date(),
          expectedReviewInputContract,
        },
      );
      expect(unchanged).toMatchObject({
        phase: "settled",
        inputHash,
        jevEvaluationId,
      });

      const changedClaim = await claimOnly("research");
      expect(changedClaim.phase).toBe("research");
      const changed = await completeSignalResearch(
        getDatabase(),
        changedClaim,
        {
          researchEvidence: {
            ...researchEvidence,
            identity: {
              ...researchEvidence.identity,
              domain: "corrected.example",
            },
          },
          outcome,
          researchDueAt: new Date(Date.now() + 24 * 60 * 60_000),
          expectedReviewInputContract,
        },
      );
      expect(changed).toMatchObject({
        phase: "jev",
        inputHash: null,
        inputManifest: null,
        jevEvaluationId: null,
      });
    });
  },
);
