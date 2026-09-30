import {
  and,
  desc,
  eq,
  inArray,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Database } from "./client.js";
import { investorApprovedSql } from "./investor-approval.js";
import {
  faaEnsembleEvaluations,
  faaReviewModelUsage,
  researchProviderUsage,
  signalAnalystCases,
  signalAnalystSteps,
  signalReviewState,
  sourceSignals,
  type FaaEnsembleEvaluation,
  type FaaReviewModelUsage,
  type ResearchProviderUsageReceipt,
  type SignalAnalystCase,
  type SignalAnalystCaseStatus,
  type SignalAnalystStep,
  type SignalAnalystObservedStatus,
  type SignalAnalystStepStatus,
  type SignalReviewState,
  type SourceSignal,
} from "./schema.js";
import {
  investorRankingSql,
  normalizeSignalOverviewQuery,
  parseSignalOverviewCursor,
  type InvestorRanking,
  type SignalOverviewReadiness,
  type SignalOverviewSort,
  type SourceSignalAnalystOverviewCursor,
} from "./investor-ranking.js";
import {
  SignalReviewFenceRejected,
  type SignalReviewClaim,
  type SignalReviewExecutor,
  type SignalReviewFenceResult,
  type SignalReviewJson,
  type SignalReviewTransaction,
  withSignalReviewClaimTransaction,
} from "./signal-reviews.js";
import {
  matchesExpectedReviewInputContract,
  reviewInputManifestMatchesSourceRevision,
  type ExpectedFaaReviewInputContract,
} from "./unified-targets/records.js";

export interface EnsureSignalAnalystCaseInput {
  policyVersion: string;
  inputHash: string;
  limits: SignalReviewJson;
  initialCheckpoint: SignalReviewJson;
  /**
   * A deferred episode resumes only after its caller has established that a
   * useful capability is available. Defaulting to false prevents a polling
   * claim from relabelling a blocked episode as active.
   */
  resumeDeferred?: boolean;
}

export interface BeginSignalAnalystStepInput {
  kind: string;
  request: SignalReviewJson;
  requestHash: string;
}

export type BeginSignalAnalystStepResult =
  | { outcome: "started"; step: SignalAnalystStep }
  | { outcome: "active"; step: SignalAnalystStep }
  | { outcome: "reused"; step: SignalAnalystStep }
  | { outcome: "interrupted"; step: SignalAnalystStep }
  | { outcome: "exhausted"; step: SignalAnalystStep };

export type FinishedSignalAnalystStepStatus = SignalAnalystObservedStatus;

export interface FinishSignalAnalystStepInput {
  status: FinishedSignalAnalystStepStatus;
  response?: SignalReviewJson | null;
  error?: string | null;
  modelUsageReceiptId?: string | null;
  costKnown?: boolean;
  costUsd?: string | null;
}

export interface FinishSignalAnalystStepResult {
  outcome: "finished" | "late_recorded" | "already_finished";
  claimCurrent: boolean;
  step: SignalAnalystStep;
}

export interface CheckpointSignalAnalystCaseInput {
  checkpoint: SignalReviewJson;
  status: Exclude<
    SignalAnalystCaseStatus,
    "superseded" | "completed" | "awaiting_review"
  >;
  inputHash: string;
  nextAttemptAt?: Date | null;
  stopReason?: string | null;
  memo?: SignalReviewJson | null;
}

export interface CompleteSignalAnalystCaseInput {
  checkpoint: SignalReviewJson;
  memo?: SignalReviewJson | null;
  stopReason?: string | null;
}

export interface SignalAnalystEvidencePublication<T> {
  researchEvidence: SignalReviewJson;
  outcome: SignalReviewJson;
  checkpoint: SignalReviewJson;
  memo?: SignalReviewJson | null;
  value: T;
}

export interface PublishedSignalAnalystEvidence<T> {
  value: T;
  case: SignalAnalystCase;
  state: SignalReviewState;
}

export interface SignalAnalystCaseReadOptions {
  expectedReviewInputContract: ExpectedFaaReviewInputContract;
  stepLimit?: number;
}

export interface SignalAnalystHistoryReadOptions {
  expectedReviewInputContract: ExpectedFaaReviewInputContract;
  caseLimit?: number;
  stepLimitPerCase?: number;
}

export interface SignalAnalystProviderSpend {
  knownActualCostUsd: string;
  unknownEstimatedCostUsd: string;
  receiptCount: number;
  unknownReceiptCount: number;
}

export interface SignalAnalystModelSpend {
  knownActualCostUsd: string;
  receiptCount: number;
  unknownReceiptCount: number;
}
export interface SignalAnalystWorkAccounting {
  modelAttemptCount: number;
  resourceAttemptCount: number;
  activeWorkMs: number;
}


export interface SignalAnalystCaseView {
  case: SignalAnalystCase;
  current: boolean;
  episodeCurrent: boolean;
  superseded: boolean;
  currentTriage: FaaEnsembleEvaluation | null;
  steps: SignalAnalystStep[];
  hasMoreSteps: boolean;
  /** Bounded non-quota execution records retained for lifecycle decisions. */
  executionSteps: SignalAnalystStep[];
  work: SignalAnalystWorkAccounting;
  providerUsage: ResearchProviderUsageReceipt[];
  providerSpend: SignalAnalystProviderSpend;
  modelUsage: FaaReviewModelUsage[];
  modelSpend: SignalAnalystModelSpend;
}

export interface ListSourceSignalAnalystOverviewsOptions {
  expectedReviewInputContract: ExpectedFaaReviewInputContract;
  limit?: number;
  sort?: SignalOverviewSort;
  q?: string;
  readiness?: SignalOverviewReadiness;
  /** Internal exact scope. Absent means all signals; an empty list means none. */
  sourceSignalIds?: readonly string[];
  after?: SourceSignalAnalystOverviewCursor;
}

export interface SourceSignalAnalystOverview {
  signal: SourceSignal;
  review: SignalReviewState | null;
  currentTriage: FaaEnsembleEvaluation | null;
  currentCase: SignalAnalystCase | null;
  currentCaseProofCurrent: boolean;
  investorApproved: boolean;
  ranking: InvestorRanking;
}

export interface SourceSignalAnalystOverviewPage {
  items: SourceSignalAnalystOverview[];
  nextCursor: SourceSignalAnalystOverviewCursor | null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const MAX_CASE_READ = 50;
const MAX_STEP_READ = 100;
const MAX_OVERVIEW_READ = 100;

function requireHash(value: string, name: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
}

function requireJsonObject(value: SignalReviewJson, name: string): void {
  if (value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
}

function requireDate(value: Date | null, name: string): void {
  if (value !== null && Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid date or null`);
  }
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return Math.min(Math.max(1, Math.trunc(value ?? fallback)), maximum);
}

function normalizeCost(value: string, name: string): string {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a nonnegative plain decimal string`);
  }
  const [integer = "0", fraction] = value.split(".");
  const normalizedFraction = fraction?.replace(/0+$/u, "");
  return normalizedFraction === undefined || normalizedFraction.length === 0
    ? integer
    : `${integer}.${normalizedFraction}`;
}

function asCase(
  row: typeof signalAnalystCases.$inferSelect,
): SignalAnalystCase {
  return row as SignalAnalystCase;
}

function asStep(
  row: typeof signalAnalystSteps.$inferSelect,
): SignalAnalystStep {
  return row as SignalAnalystStep;
}

function isUsableJevTriage(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const triage = value as Record<string, unknown>;
  return (
    triage["version"] === "jev-triage-v1" &&
    (triage["decision"] === "reject" ||
      triage["decision"] === "research" ||
      triage["decision"] === "high_priority") &&
    (triage["confidence"] === null ||
      (typeof triage["confidence"] === "number" &&
        Number.isFinite(triage["confidence"]))) &&
    (triage["productFit"] === "supported_product" ||
      triage["productFit"] === "plausible_supplier" ||
      triage["productFit"] === "process_or_service" ||
      triage["productFit"] === "unknown" ||
      triage["productFit"] === "outside_scope") &&
    (triage["acquisitionReadiness"] === "ready" ||
      triage["acquisitionReadiness"] === "needs_research" ||
      triage["acquisitionReadiness"] === "blocked") &&
    (triage["researchPriority"] === 1 ||
      triage["researchPriority"] === 2 ||
      triage["researchPriority"] === 3) &&
    Array.isArray(triage["reasonCodes"]) &&
    triage["reasonCodes"].every((code) => typeof code === "string") &&
    typeof triage["explanation"] === "string" &&
    Array.isArray(triage["observations"]) &&
    Array.isArray(triage["gaps"])
  );
}

function currentJevTriage(
  signal: Pick<SourceSignal, "id" | "reviewRevision">,
  review: typeof signalReviewState.$inferSelect | undefined,
  evaluation: typeof faaEnsembleEvaluations.$inferSelect | undefined,
  expected: ExpectedFaaReviewInputContract,
): FaaEnsembleEvaluation | null {
  if (
    review === undefined ||
    review.sourceRevision !== signal.reviewRevision ||
    review.inputHash === null ||
    !matchesExpectedReviewInputContract(review.inputManifest, expected) ||
    !reviewInputManifestMatchesSourceRevision(
      review.inputManifest,
      signal.reviewRevision,
    ) ||
    (review.phase !== "muse" && review.phase !== "settled") ||
    evaluation === undefined ||
    evaluation.id !== review.jevEvaluationId ||
    evaluation.signalId !== signal.id ||
    evaluation.inputHash === null ||
    evaluation.inputHash !== review.inputHash ||
    evaluation.modelId !== expected.policy.jevModel ||
    !matchesExpectedReviewInputContract(evaluation.inputManifest, expected) ||
    !reviewInputManifestMatchesSourceRevision(
      evaluation.inputManifest,
      signal.reviewRevision,
    ) ||
    evaluation.error !== null ||
    !isUsableJevTriage(evaluation.parsed) ||
    evaluation.parsed["decision"] !== evaluation.decision
  ) {
    return null;
  }
  return evaluation as FaaEnsembleEvaluation;
}

function asState(row: typeof signalReviewState.$inferSelect): SignalReviewState {
  return row as SignalReviewState;
}

async function lockedCurrentCase(
  tx: SignalReviewTransaction,
  claim: SignalReviewClaim,
  caseId: string,
): Promise<typeof signalAnalystCases.$inferSelect> {
  const rows = await tx
    .select()
    .from(signalAnalystCases)
    .where(
      and(
        eq(signalAnalystCases.id, caseId),
        eq(signalAnalystCases.signalId, claim.signalId),
        eq(signalAnalystCases.sourceRevision, claim.sourceRevision),
        ne(signalAnalystCases.status, "superseded"),
      ),
    )
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`analyst case ${caseId} is not current for this claim`);
  }
  return row;
}

/** Create or resume the policy/revision case behind the live signal claim. */
export async function ensureSignalAnalystCase(
  db: Database,
  claim: SignalReviewClaim,
  input: EnsureSignalAnalystCaseInput,
): Promise<SignalReviewFenceResult<SignalAnalystCase>> {
  const policyVersion = input.policyVersion.trim();
  if (policyVersion.length === 0) {
    throw new TypeError("policyVersion must not be empty");
  }
  requireHash(input.inputHash, "inputHash");
  requireJsonObject(input.limits, "limits");
  requireJsonObject(input.initialCheckpoint, "initialCheckpoint");
  if (claim.inputHash !== input.inputHash) return { accepted: false };

  return withSignalReviewClaimTransaction(
    db,
    claim,
    async () => undefined,
    async (tx) => {
      await tx
        .update(signalAnalystCases)
        .set({
          status: "superseded",
          completedAt: sql`COALESCE(${signalAnalystCases.completedAt}, clock_timestamp())`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(signalAnalystCases.signalId, claim.signalId),
            ne(signalAnalystCases.status, "superseded"),
            or(
              ne(signalAnalystCases.sourceRevision, claim.sourceRevision),
              ne(signalAnalystCases.policyVersion, policyVersion),
            ),
          ),
        );

      await tx
        .insert(signalAnalystCases)
        .values({
          signalId: claim.signalId,
          sourceRevision: claim.sourceRevision,
          policyVersion,
          inputHash: input.inputHash,
          limits: input.limits,
          checkpoint: input.initialCheckpoint,
        })
        .onConflictDoNothing({
          target: [
            signalAnalystCases.signalId,
            signalAnalystCases.sourceRevision,
            signalAnalystCases.policyVersion,
          ],
        });

      const existingRows = await tx
        .select()
        .from(signalAnalystCases)
        .where(
          and(
            eq(signalAnalystCases.signalId, claim.signalId),
            eq(signalAnalystCases.sourceRevision, claim.sourceRevision),
            eq(signalAnalystCases.policyVersion, policyVersion),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      if (existing === undefined) throw new Error("analyst case was not persisted");
      if (
        existing.status === "superseded" ||
        existing.status === "awaiting_review" ||
        existing.inputHash !== input.inputHash ||
        (existing.status === "deferred" && input.resumeDeferred === true)
      ) {
        const resumed = await tx
          .update(signalAnalystCases)
          .set({
            inputHash: input.inputHash,
            status: "active",
            nextAttemptAt: null,
            stopReason: null,
            completedAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(signalAnalystCases.id, existing.id))
          .returning();
        if (resumed[0] === undefined) throw new Error("analyst case was not resumed");
        return asCase(resumed[0]);
      }
      return asCase(existing);
    },
  );
}

/** Journal an action before side effects, allocating its sequence under lock. */
export async function beginSignalAnalystStep(
  db: Database,
  claim: SignalReviewClaim,
  caseId: string,
  input: BeginSignalAnalystStepInput,
): Promise<SignalReviewFenceResult<BeginSignalAnalystStepResult>> {
  const kind = input.kind.trim();
  if (kind.length === 0) throw new TypeError("kind must not be empty");
  requireJsonObject(input.request, "request");
  requireHash(input.requestHash, "requestHash");

  return withSignalReviewClaimTransaction(
    db,
    claim,
    async () => undefined,
    async (tx) => {
      const analystCase = await lockedCurrentCase(tx, claim, caseId);
      if (analystCase.inputHash !== claim.inputHash) {
        throw new Error("analyst case input hash is not current for this claim");
      }
      const matching = await tx
        .select()
        .from(signalAnalystSteps)
        .where(
          and(
            eq(signalAnalystSteps.caseId, caseId),
            eq(signalAnalystSteps.requestHash, input.requestHash),
          ),
        )
        .orderBy(desc(signalAnalystSteps.sequence));
      const completed = matching.find((step) => step.status === "completed");
      if (completed !== undefined) {
        return { outcome: "reused", step: asStep(completed) } as const;
      }
      const active = matching.find((step) => step.status === "in_progress");
      if (active !== undefined) {
        if (active.claimLeaseToken === claim.leaseToken) {
          return { outcome: "active", step: asStep(active) } as const;
        }
        const interruptedRows = await tx
          .update(signalAnalystSteps)
          .set({
            status: "interrupted",
            error: "worker interrupted before a durable outcome was recorded",
            costKnown: false,
            costUsd: null,
            finishedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(signalAnalystSteps.id, active.id),
              eq(signalAnalystSteps.status, "in_progress"),
            ),
          )
          .returning();
        const interrupted = interruptedRows[0];
        if (interrupted === undefined) {
          throw new Error(`analyst step ${active.id} changed while locked`);
        }
        return {
          outcome: "interrupted",
          step: asStep(interrupted),
        } as const;
      }
      const exhausted = matching.find((step) => step.status === "exhausted");
      if (exhausted !== undefined) {
        return { outcome: "exhausted", step: asStep(exhausted) } as const;
      }
      if (analystCase.status !== "active") {
        throw new Error(
          `analyst case ${caseId} cannot start work while ${analystCase.status}`,
        );
      }

      const inserted = await tx
        .insert(signalAnalystSteps)
        .values({
          caseId,
          sequence: analystCase.nextStepSequence,
          kind,
          request: input.request,
          requestHash: input.requestHash,
          status: "in_progress",
          claimPhase: claim.phase,
          claimLeaseToken: claim.leaseToken,
          claimInputHash: claim.inputHash,
        })
        .returning();
      const step = inserted[0];
      if (step === undefined) throw new Error("analyst step was not persisted");
      await tx
        .update(signalAnalystCases)
        .set({
          nextStepSequence: analystCase.nextStepSequence + 1,
          status: "active",
          nextAttemptAt: null,
          stopReason: null,
          completedAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(signalAnalystCases.id, caseId));
      return { outcome: "started", step: asStep(step) } as const;
    },
  );
}

/**
 * Finalize an action observation independently from claim publication. The row
 * survives an expired/reclaimed lease; claimCurrent tells the engine whether it
 * may subsequently publish active progress.
 */
export async function finishSignalAnalystStep(
  db: Database,
  stepId: string,
  input: FinishSignalAnalystStepInput,
): Promise<FinishSignalAnalystStepResult> {
  if ((input.status as SignalAnalystStepStatus) === "in_progress") {
    throw new TypeError("finish status must be terminal");
  }
  if (input.response !== undefined && input.response !== null) {
    requireJsonObject(input.response, "response");
  }
  const costKnown = input.costKnown ?? input.costUsd != null;
  const costUsd =
    input.costUsd === undefined || input.costUsd === null
      ? null
      : normalizeCost(input.costUsd, "costUsd");
  if (costKnown !== (costUsd !== null)) {
    throw new TypeError("costKnown must be true exactly when costUsd is present");
  }

  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(signalAnalystSteps)
      .where(eq(signalAnalystSteps.id, stepId))
      .limit(1)
      .for("update");
    const existing = existingRows[0];
    if (existing === undefined) throw new Error(`analyst step ${stepId} does not exist`);

    let outcome: "finished" | "late_recorded" | "already_finished" =
      "already_finished";
    let step = existing;
    if (existing.status === "in_progress") {
      const updated = await tx
        .update(signalAnalystSteps)
        .set({
          status: input.status,
          response: input.response ?? null,
          error: input.error?.slice(0, 10_000) ?? null,
          modelUsageReceiptId: input.modelUsageReceiptId ?? null,
          costKnown,
          costUsd,
          finishedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(signalAnalystSteps.id, stepId),
            eq(signalAnalystSteps.status, "in_progress"),
          ),
        )
        .returning();
      if (updated[0] === undefined) {
        throw new Error(`analyst step ${stepId} changed while locked`);
      }
      outcome = "finished";
      step = updated[0];
    } else if (existing.status === "interrupted") {
      const updated = await tx
        .update(signalAnalystSteps)
        .set({
          status: "late_result",
          observedStatus: input.status,
          response: input.response ?? null,
          error: input.error?.slice(0, 10_000) ?? null,
          modelUsageReceiptId: input.modelUsageReceiptId ?? null,
          costKnown,
          costUsd,
          lateObservedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(signalAnalystSteps.id, stepId),
            eq(signalAnalystSteps.status, "interrupted"),
          ),
        )
        .returning();
      if (updated[0] === undefined) {
        throw new Error(`analyst step ${stepId} changed while locked`);
      }
      outcome = "late_recorded";
      step = updated[0];
    }

    const current = await tx.execute<{ claim_current: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM signal_analyst_cases analyst_case
        JOIN signal_review_state review
          ON review.signal_id = analyst_case.signal_id
        JOIN source_signals source
          ON source.id = analyst_case.signal_id
        WHERE analyst_case.id = ${step.caseId}
          AND analyst_case.status <> 'superseded'
          AND analyst_case.source_revision = source.review_revision
          AND review.source_revision = source.review_revision
          AND review.phase = ${step.claimPhase}
          AND review.lease_token = ${step.claimLeaseToken}::uuid
          AND review.lease_expires_at > clock_timestamp()
          AND review.input_hash IS NOT DISTINCT FROM ${step.claimInputHash}
      ) AS claim_current
    `);
    return {
      outcome,
      claimCurrent: current.rows[0]?.claim_current === true,
      step: asStep(step),
    };
  });
}

/** Persist checkpoint/memo/status only while the original claim remains live. */
export async function checkpointSignalAnalystCase(
  db: Database,
  claim: SignalReviewClaim,
  caseId: string,
  input: CheckpointSignalAnalystCaseInput,
): Promise<SignalReviewFenceResult<SignalAnalystCase>> {
  requireJsonObject(input.checkpoint, "checkpoint");
  if (
    input.status === ("completed" as SignalAnalystCaseStatus) ||
    input.status === ("awaiting_review" as SignalAnalystCaseStatus)
  ) {
    throw new TypeError(
      "awaiting-review and completed cases require their atomic publication APIs",
    );
  }
  requireHash(input.inputHash, "inputHash");
  if (input.memo !== undefined && input.memo !== null) {
    requireJsonObject(input.memo, "memo");
  }
  if (input.nextAttemptAt !== undefined) {
    requireDate(input.nextAttemptAt, "nextAttemptAt");
  }
  if (claim.inputHash !== input.inputHash) return { accepted: false };

  return withSignalReviewClaimTransaction(
    db,
    claim,
    async () => undefined,
    async (tx) => {
      const analystCase = await lockedCurrentCase(tx, claim, caseId);
      if (
        analystCase.status !== "active" ||
        analystCase.inputHash !== claim.inputHash
      ) {
        throw new SignalReviewFenceRejected();
      }
      const terminal = input.status === "exhausted";
      const rows = await tx
        .update(signalAnalystCases)
        .set({
          checkpoint: input.checkpoint,
          status: input.status,
          inputHash: input.inputHash,
          ...(input.nextAttemptAt === undefined
            ? {}
            : { nextAttemptAt: input.nextAttemptAt }),
          ...(input.stopReason === undefined
            ? {}
            : { stopReason: input.stopReason?.slice(0, 10_000) ?? null }),
          ...(input.memo === undefined ? {} : { memo: input.memo }),
          completedAt: terminal ? sql`clock_timestamp()` : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(signalAnalystCases.id, caseId))
        .returning();
      if (rows[0] === undefined) throw new Error("analyst checkpoint was not persisted");
      return asCase(rows[0]);
    },
  );
}
/**
 * Finalize the analyst case inside commitSignalReview's persistence callback so
 * its memo/checkpoint cannot commit without the linked terminal review state.
 */
export async function completeSignalAnalystCase(
  tx: SignalReviewTransaction,
  claim: SignalReviewClaim,
  caseId: string,
  input: CompleteSignalAnalystCaseInput,
): Promise<SignalAnalystCase> {
  requireJsonObject(input.checkpoint, "checkpoint");
  if (input.memo !== undefined && input.memo !== null) {
    requireJsonObject(input.memo, "memo");
  }
  const analystCase = await lockedCurrentCase(tx, claim, caseId);
  if (
    analystCase.status !== "active" ||
    analystCase.inputHash !== claim.inputHash
  ) {
    throw new SignalReviewFenceRejected();
  }
  const live = await tx.execute<{ claim_current: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM signal_review_state review
      JOIN source_signals source ON source.id = review.signal_id
      WHERE review.signal_id = ${claim.signalId}::uuid
        AND source.review_revision = ${claim.sourceRevision}
        AND review.source_revision = source.review_revision
        AND review.phase = ${claim.phase}
        AND review.lease_token = ${claim.leaseToken}::uuid
        AND review.lease_expires_at > clock_timestamp()
        AND review.input_hash IS NOT DISTINCT FROM ${claim.inputHash}
    ) AS claim_current
  `);
  if (live.rows[0]?.claim_current !== true) {
    throw new SignalReviewFenceRejected();
  }
  const rows = await tx
    .update(signalAnalystCases)
    .set({
      checkpoint: input.checkpoint,
      ...(input.memo === undefined ? {} : { memo: input.memo }),
      status: "completed",
      nextAttemptAt: null,
      stopReason: input.stopReason?.slice(0, 10_000) ?? null,
      completedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(signalAnalystCases.id, caseId),
        eq(signalAnalystCases.status, "active"),
        sql`${signalAnalystCases.inputHash} = ${claim.inputHash}`,
      ),
    )
    .returning();
  if (rows[0] === undefined) throw new SignalReviewFenceRejected();
  return asCase(rows[0]);
}

/**
 * Persist evidence artifacts and publish the rebuilt research bundle in one
 * fenced transaction. A source edit or expired lease rolls every callback write
 * back. Publication always invalidates the old Jev pointer and requeues Jev.
 */
export async function publishSignalAnalystEvidence<T>(
  db: Database,
  claim: SignalReviewClaim,
  caseId: string,
  admitEvidence: (
    tx: SignalReviewTransaction,
  ) => Promise<SignalAnalystEvidencePublication<T>>,
): Promise<SignalReviewFenceResult<PublishedSignalAnalystEvidence<T>>> {
  return withSignalReviewClaimTransaction(
    db,
    claim,
    async (tx) => {
      const analystCase = await lockedCurrentCase(tx, claim, caseId);
      if (
        analystCase.status !== "active" ||
        analystCase.inputHash !== claim.inputHash
      ) {
        throw new SignalReviewFenceRejected();
      }
      const publication = await admitEvidence(tx);
      requireJsonObject(publication.researchEvidence, "researchEvidence");
      requireJsonObject(publication.outcome, "outcome");
      requireJsonObject(publication.checkpoint, "checkpoint");
      if (publication.memo !== undefined && publication.memo !== null) {
        requireJsonObject(publication.memo, "memo");
      }
      return publication;
    },
    async (tx, publication) => {
      const cases = await tx
        .update(signalAnalystCases)
        .set({
          checkpoint: publication.checkpoint,
          ...(publication.memo === undefined
            ? {}
            : { memo: publication.memo }),
          status: "awaiting_review",
          nextAttemptAt: null,
          stopReason: null,
          completedAt: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(signalAnalystCases.id, caseId),
            eq(signalAnalystCases.status, "active"),
            sql`${signalAnalystCases.inputHash} = ${claim.inputHash}`,
          ),
        )
        .returning();
      const analystCase = cases[0];
      if (analystCase === undefined) throw new SignalReviewFenceRejected();

      const states = await tx
        .update(signalReviewState)
        .set({
          phase: "jev",
          inputHash: null,
          inputManifest: null,
          researchEvidence: publication.researchEvidence,
          jevEvaluationId: null,
          nextAttemptAt: sql`clock_timestamp()`,
          attemptCount: 0,
          lastError: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastResearchOutcome: publication.outcome,
          inputsCheckedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(signalReviewState.signalId, claim.signalId),
            eq(signalReviewState.sourceRevision, claim.sourceRevision),
            eq(signalReviewState.phase, claim.phase),
            eq(signalReviewState.leaseToken, claim.leaseToken),
            sql`${signalReviewState.leaseExpiresAt} > clock_timestamp()`,
            sql`${signalReviewState.inputHash} IS NOT DISTINCT FROM ${claim.inputHash}`,
          ),
        )
        .returning();
      const state = states[0];
      if (state === undefined) throw new SignalReviewFenceRejected();
      return {
        value: publication.value,
        case: asCase(analystCase),
        state: asState(state),
      };
    },
    { claimTransitionedByPublish: true },
  );
}

async function readCaseSteps(
  db: SignalReviewExecutor,
  caseId: string,
  limit: number,
): Promise<
  Pick<
    SignalAnalystCaseView,
    | "steps"
    | "hasMoreSteps"
    | "executionSteps"
    | "work"
    | "providerUsage"
    | "providerSpend"
    | "modelUsage"
    | "modelSpend"
  >
> {
  const rows = await db
    .select()
    .from(signalAnalystSteps)
    .where(eq(signalAnalystSteps.caseId, caseId))
    .orderBy(desc(signalAnalystSteps.sequence))
    .limit(limit + 1);
  const steps = rows.slice(0, limit).map(asStep);
  const stepIds = steps.map((step) => step.id);
  const [
    providerUsage,
    providerAccounting,
    visibleModelRows,
    modelAccounting,
    workAccounting,
  ] =
    await Promise.all([
      stepIds.length === 0
        ? Promise.resolve([] as ResearchProviderUsageReceipt[])
        : db
            .select()
            .from(researchProviderUsage)
            .where(inArray(researchProviderUsage.analystStepId, stepIds))
            .orderBy(desc(researchProviderUsage.createdAt)),
      db.execute<{
        known_actual_cost_usd: string;
        unknown_estimated_cost_usd: string;
        receipt_count: number;
        unknown_receipt_count: number;
      }>(sql`
        SELECT
          COALESCE(sum(usage.actual_cost_usd)
            FILTER (WHERE usage.actual_cost_usd IS NOT NULL), 0)::text
            AS known_actual_cost_usd,
          COALESCE(sum(usage.estimated_cost_usd)
            FILTER (WHERE usage.actual_cost_usd IS NULL), 0)::text
            AS unknown_estimated_cost_usd,
          count(*)::integer AS receipt_count,
          count(*) FILTER (WHERE usage.actual_cost_usd IS NULL)::integer
            AS unknown_receipt_count
        FROM research_provider_usage usage
        JOIN signal_analyst_steps step
          ON step.id = usage.analyst_step_id
        WHERE step.case_id = ${caseId}::uuid
      `),
      stepIds.length === 0
        ? Promise.resolve([] as { usage: FaaReviewModelUsage }[])
        : db
            .select({ usage: faaReviewModelUsage })
            .from(faaReviewModelUsage)
            .innerJoin(
              signalAnalystSteps,
              eq(signalAnalystSteps.modelUsageReceiptId, faaReviewModelUsage.id),
            )
            .where(inArray(signalAnalystSteps.id, stepIds))
            .orderBy(desc(faaReviewModelUsage.observedAt)),
      db.execute<{
        known_actual_cost_usd: string;
        receipt_count: number;
        unknown_receipt_count: number;
      }>(sql`
        WITH case_receipts AS (
          SELECT DISTINCT usage.id, usage.cost_usd
          FROM faa_review_model_usage usage
          JOIN signal_analyst_steps step
            ON step.model_usage_receipt_id = usage.id
          WHERE step.case_id = ${caseId}::uuid
        )
        SELECT
          COALESCE(sum(cost_usd)
            FILTER (WHERE cost_usd IS NOT NULL), 0)::text
            AS known_actual_cost_usd,
          count(*)::integer AS receipt_count,
          count(*) FILTER (WHERE cost_usd IS NULL)::integer
            AS unknown_receipt_count
        FROM case_receipts
      `),
      db.execute<{
        model_attempt_count: number;
        resource_attempt_count: number;
        active_work_ms: string;
      }>(sql`
        SELECT
          count(*) FILTER (
            WHERE step.kind IN ('planner', 'final_verifier')
              AND (
                step.status <> 'quota_deferred'
                OR step.model_usage_receipt_id IS NOT NULL
              )
          )::integer AS model_attempt_count,
          count(*) FILTER (
            WHERE step.kind LIKE 'resource:%'
              AND (
                step.status IN ('in_progress', 'interrupted')
                OR (
                  step.status IN ('quota_deferred', 'exhausted')
                  AND step.response->>'providerReceiptId' IS NOT NULL
                )
                OR (
                  step.status = 'late_result'
                  AND (
                    step.observed_status IS NULL
                    OR step.observed_status NOT IN ('quota_deferred', 'exhausted')
                    OR step.response->>'providerReceiptId' IS NOT NULL
                  )
                )
                OR step.status NOT IN (
                  'in_progress', 'interrupted', 'quota_deferred',
                  'exhausted', 'late_result'
                )
              )
          )::integer AS resource_attempt_count,
          COALESCE(sum(
            CASE
              WHEN step.status = 'quota_deferred'
                AND step.model_usage_receipt_id IS NULL
                AND step.response->>'providerReceiptId' IS NULL THEN 0
              WHEN step.status IN ('in_progress', 'interrupted', 'late_result')
                THEN LEAST(
                  GREATEST(
                    0,
                    extract(epoch FROM (
                      COALESCE(
                        step.finished_at,
                        step.late_observed_at,
                        clock_timestamp()
                      ) - step.started_at
                    )) * 1000
                  ),
                  CASE
                    WHEN step.kind IN ('planner', 'final_verifier') THEN 60000
                    WHEN step.kind = 'resource:primary_records' THEN 600000
                    ELSE 15000
                  END
                )
              ELSE GREATEST(
                0,
                extract(epoch FROM (
                  COALESCE(step.finished_at, step.late_observed_at, clock_timestamp())
                  - step.started_at
                )) * 1000
              )
            END
          ), 0)::bigint::text AS active_work_ms
        FROM signal_analyst_steps step
        WHERE step.case_id = ${caseId}::uuid
      `),
    ]);
  const providerTotals = providerAccounting.rows[0];
  const modelTotals = modelAccounting.rows[0];
  const workTotals = workAccounting.rows[0];
  const executionRows = await db
    .select()
    .from(signalAnalystSteps)
    .where(
      and(
        eq(signalAnalystSteps.caseId, caseId),
        sql`
          (
            ${signalAnalystSteps.status} IN ('completed', 'interrupted', 'late_result')
            OR ${signalAnalystSteps.modelUsageReceiptId} IS NOT NULL
            OR (
              ${signalAnalystSteps.kind} LIKE 'resource:%'
              AND ${signalAnalystSteps.response}->>'providerReceiptId' IS NOT NULL
            )
          )
        `,
      ),
    )
    .orderBy(desc(signalAnalystSteps.sequence))
    .limit(128);
  const executionSteps = executionRows.map(asStep);
  const modelUsage = [
    ...new Map(visibleModelRows.map(({ usage }) => [usage.id, usage])).values(),
  ];
  return {
    steps,
    hasMoreSteps: rows.length > limit,
    executionSteps,
    work: {
      modelAttemptCount: workTotals?.model_attempt_count ?? 0,
      resourceAttemptCount: workTotals?.resource_attempt_count ?? 0,
      activeWorkMs: Number(workTotals?.active_work_ms ?? "0"),
    },
    providerUsage: providerUsage as ResearchProviderUsageReceipt[],
    providerSpend: {
      knownActualCostUsd: providerTotals?.known_actual_cost_usd ?? "0",
      unknownEstimatedCostUsd:
        providerTotals?.unknown_estimated_cost_usd ?? "0",
      receiptCount: providerTotals?.receipt_count ?? 0,
      unknownReceiptCount: providerTotals?.unknown_receipt_count ?? 0,
    },
    modelUsage,
    modelSpend: {
      knownActualCostUsd: modelTotals?.known_actual_cost_usd ?? "0",
      receiptCount: modelTotals?.receipt_count ?? 0,
      unknownReceiptCount: modelTotals?.unknown_receipt_count ?? 0,
    },
  };
}

/**
 * Read the source/policy-current analyst episode. `current` is true only when
 * the episode also matches a complete Jev result under the expected contract.
 */
export async function readCurrentSignalAnalystCase(
  db: SignalReviewExecutor,
  signalId: string,
  options: SignalAnalystCaseReadOptions,
): Promise<SignalAnalystCaseView | null> {
  const expected = options.expectedReviewInputContract;
  if (expected === undefined) {
    throw new TypeError(
      "readCurrentSignalAnalystCase requires expectedReviewInputContract",
    );
  }
  const stepLimit = boundedLimit(options.stepLimit, 25, MAX_STEP_READ, "stepLimit");
  const rows = await db
    .select({ analystCase: signalAnalystCases, signal: sourceSignals })
    .from(signalAnalystCases)
    .innerJoin(sourceSignals, eq(sourceSignals.id, signalAnalystCases.signalId))
    .where(
      and(
        eq(signalAnalystCases.signalId, signalId),
        eq(signalAnalystCases.sourceRevision, sourceSignals.reviewRevision),
        eq(signalAnalystCases.policyVersion, expected.policy.analyst),
        ne(signalAnalystCases.status, "superseded"),
      ),
    )
    .orderBy(desc(signalAnalystCases.updatedAt), desc(signalAnalystCases.id))
    .limit(1);
  const selected = rows[0];
  if (selected === undefined) return null;
  const [review] = await db
    .select()
    .from(signalReviewState)
    .where(eq(signalReviewState.signalId, signalId))
    .limit(1);
  const [evaluation] =
    review?.jevEvaluationId === null || review?.jevEvaluationId === undefined
      ? []
      : await db
          .select()
          .from(faaEnsembleEvaluations)
          .where(eq(faaEnsembleEvaluations.id, review.jevEvaluationId))
          .limit(1);
  const triage = currentJevTriage(
    selected.signal,
    review,
    evaluation,
    expected,
  );
  const proofCurrent =
    triage !== null &&
    review?.inputHash !== null &&
    selected.analystCase.inputHash === review?.inputHash;
  const history = await readCaseSteps(db, selected.analystCase.id, stepLimit);
  return {
    case: asCase(selected.analystCase),
    current: proofCurrent,
    episodeCurrent: true,
    superseded: false,
    currentTriage: proofCurrent ? triage : null,
    ...history,
  };
}

/** Read bounded episode/action history, distinguishing episode and proof currentness. */
export async function readSignalAnalystCaseHistory(
  db: SignalReviewExecutor,
  signalId: string,
  options: SignalAnalystHistoryReadOptions,
): Promise<SignalAnalystCaseView[]> {
  const expected = options.expectedReviewInputContract;
  if (expected === undefined) {
    throw new TypeError(
      "readSignalAnalystCaseHistory requires expectedReviewInputContract",
    );
  }
  const caseLimit = boundedLimit(options.caseLimit, 10, MAX_CASE_READ, "caseLimit");
  const stepLimit = boundedLimit(
    options.stepLimitPerCase,
    25,
    MAX_STEP_READ,
    "stepLimitPerCase",
  );
  const [source] = await db
    .select()
    .from(sourceSignals)
    .where(eq(sourceSignals.id, signalId))
    .limit(1);
  const [review] = await db
    .select()
    .from(signalReviewState)
    .where(eq(signalReviewState.signalId, signalId))
    .limit(1);
  const [evaluation] =
    review?.jevEvaluationId === null || review?.jevEvaluationId === undefined
      ? []
      : await db
          .select()
          .from(faaEnsembleEvaluations)
          .where(eq(faaEnsembleEvaluations.id, review.jevEvaluationId))
          .limit(1);
  const triage =
    source === undefined
      ? null
      : currentJevTriage(source, review, evaluation, expected);
  const cases = await db
    .select()
    .from(signalAnalystCases)
    .where(eq(signalAnalystCases.signalId, signalId))
    .orderBy(desc(signalAnalystCases.createdAt), desc(signalAnalystCases.id))
    .limit(caseLimit);
  return Promise.all(
    cases.map(async (row) => {
      const episodeCurrent =
        source !== undefined &&
        row.sourceRevision === source.reviewRevision &&
        row.policyVersion === expected.policy.analyst &&
        row.status !== "superseded";
      const proofCurrent =
        episodeCurrent &&
        triage !== null &&
        review?.inputHash !== null &&
        row.inputHash === review?.inputHash;
      const history = await readCaseSteps(db, row.id, stepLimit);
      return {
        case: asCase(row),
        current: proofCurrent,
        episodeCurrent,
        superseded: !episodeCurrent,
        currentTriage: proofCurrent ? triage : null,
        ...history,
      };
    }),
  );
}

/**
 * Bounded raw-signal visibility hook. Ranking and DTO hydration share one
 * repeatable-read snapshot, so no response can mix review revisions.
 */
export async function listSourceSignalAnalystOverviews(
  db: Database,
  options: ListSourceSignalAnalystOverviewsOptions,
): Promise<SourceSignalAnalystOverviewPage> {
  return db.transaction(
    (tx) => listSourceSignalAnalystOverviewsInSnapshot(tx, options),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Reuse an existing snapshot when a detail read also needs case/history data.
 * The caller must provide a repeatable-read transaction.
 */
export async function listSourceSignalAnalystOverviewsInSnapshot(
  db: SignalReviewTransaction,
  options: ListSourceSignalAnalystOverviewsOptions,
): Promise<SourceSignalAnalystOverviewPage> {
  const expected = options.expectedReviewInputContract;
  if (expected === undefined) {
    throw new TypeError(
      "listSourceSignalAnalystOverviews requires expectedReviewInputContract",
    );
  }
  const limit = boundedLimit(options.limit, 50, MAX_OVERVIEW_READ, "limit");
  const query = normalizeSignalOverviewQuery({
    expectedReviewInputContract: expected,
    ...(options.sort === undefined ? {} : { sort: options.sort }),
    ...(options.q === undefined ? {} : { q: options.q }),
    ...(options.readiness === undefined
      ? {}
      : { readiness: options.readiness }),
    ...(options.sourceSignalIds === undefined
      ? {}
      : { sourceSignalIds: options.sourceSignalIds }),
  });
  const after =
    options.after === undefined
      ? null
      : parseSignalOverviewCursor(options.after);
  if (after !== null && after.sort !== query.sort) {
    throw new TypeError("cursor sort does not match the current query");
  }
  if (after !== null && after.binding !== query.binding) {
    throw new TypeError("cursor does not match the current query");
  }
  if (query.sourceSignalIds?.length === 0) {
    return { items: [], nextCursor: null };
  }

  const filters: SQL[] = [];
  if (query.q !== null) {
    const literal = query.q
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    filters.push(sql`
      (
        ranked.raw_name ILIKE '%' || ${literal} || '%' ESCAPE '\\'
        OR COALESCE(ranked.raw_domain, '') ILIKE '%' || ${literal} || '%'
          ESCAPE '\\'
      )
    `);
  }
  if (query.readiness !== null) {
    filters.push(sql`ranked.readiness = ${query.readiness}`);
  }
  if (after !== null) {
    if (query.sort === "newest") {
      filters.push(sql`
        (
          ranked.created_at < ${after.createdAt}::timestamptz
          OR (
            ranked.created_at = ${after.createdAt}::timestamptz
            AND ranked.signal_id < ${after.signalId}::uuid
          )
        )
      `);
    } else {
      const cursorBucket =
        after.status === "ranked" ? 0 : after.status === "unscored" ? 1 : 2;
      const cursorScore = after.score ?? -1;
      filters.push(sql`
        (
          ranked.ranking_bucket > ${cursorBucket}
          OR (
            ranked.ranking_bucket = ${cursorBucket}
            AND ranked.ranking_sort_score < ${cursorScore}
          )
          OR (
            ranked.ranking_bucket = ${cursorBucket}
            AND ranked.ranking_sort_score = ${cursorScore}
            AND ranked.created_at < ${after.createdAt}::timestamptz
          )
          OR (
            ranked.ranking_bucket = ${cursorBucket}
            AND ranked.ranking_sort_score = ${cursorScore}
            AND ranked.created_at = ${after.createdAt}::timestamptz
            AND ranked.signal_id < ${after.signalId}::uuid
          )
        )
      `);
    }
  }
  const where = filters.length === 0 ? sql`TRUE` : sql.join(filters, sql` AND `);
  const canonicalRanking = investorRankingSql({
    expectedReviewInputContract: expected,
    ...(query.sourceSignalIds === null
      ? {}
      : { sourceSignalIds: query.sourceSignalIds }),
  });
  type RankedPageRow = {
    signal_id: string;
    created_at_text: string;
    ranking_status: InvestorRanking["status"];
    ranking_score: number | null;
    ranking_bucket: number;
    ranking_sort_score: number;
    investor_approved: boolean;
    ranking: InvestorRanking;
  };
  const pageResult =
    query.sort === "priority"
      ? await db.execute<RankedPageRow>(sql`
          WITH ranked AS (${canonicalRanking})
          SELECT
            ranked.signal_id,
            ranked.created_at_text,
            ranked.ranking_status,
            ranked.ranking_score,
            ranked.ranking_bucket,
            ranked.ranking_sort_score,
            ${investorApprovedSql(sql`ranked.signal_id`)} AS investor_approved,
            ranked.ranking
          FROM ranked
          WHERE ${where}
          ORDER BY
            ranked.ranking_bucket ASC,
            ranked.ranking_sort_score DESC,
            ranked.created_at DESC,
            ranked.signal_id DESC
          LIMIT ${limit + 1}
        `)
      : await db.execute<RankedPageRow>(sql`
          WITH ranked AS (${canonicalRanking})
          SELECT
            ranked.signal_id,
            ranked.created_at_text,
            ranked.ranking_status,
            ranked.ranking_score,
            ranked.ranking_bucket,
            ranked.ranking_sort_score,
            ${investorApprovedSql(sql`ranked.signal_id`)} AS investor_approved,
            ranked.ranking
          FROM ranked
          WHERE ${where}
          ORDER BY ranked.created_at DESC, ranked.signal_id DESC
          LIMIT ${limit + 1}
        `);
  const visible = pageResult.rows.slice(0, limit);
  if (visible.length === 0) return { items: [], nextCursor: null };
  const signalIds = visible.map((row) => row.signal_id);
  const [signals, reviews] = await Promise.all([
    db.select().from(sourceSignals).where(inArray(sourceSignals.id, signalIds)),
    db
      .select()
      .from(signalReviewState)
      .where(inArray(signalReviewState.signalId, signalIds)),
  ]);
  const signalById = new Map(signals.map((signal) => [signal.id, signal]));
  const reviewBySignal = new Map(reviews.map((review) => [review.signalId, review]));
  const evaluationIds = reviews.flatMap((review) =>
    review.jevEvaluationId === null ? [] : [review.jevEvaluationId],
  );
  const [evaluations, cases] = await Promise.all([
    evaluationIds.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(faaEnsembleEvaluations)
          .where(inArray(faaEnsembleEvaluations.id, evaluationIds)),
    db
      .select()
      .from(signalAnalystCases)
      .where(
        and(
          inArray(signalAnalystCases.signalId, signalIds),
          eq(signalAnalystCases.policyVersion, expected.policy.analyst),
          ne(signalAnalystCases.status, "superseded"),
        ),
      )
      .orderBy(desc(signalAnalystCases.updatedAt), desc(signalAnalystCases.id)),
  ]);
  const evaluationById = new Map(evaluations.map((row) => [row.id, row]));
  const caseBySignal = new Map<string, typeof signalAnalystCases.$inferSelect>();
  for (const analystCase of cases) {
    if (!caseBySignal.has(analystCase.signalId)) {
      caseBySignal.set(analystCase.signalId, analystCase);
    }
  }

  const items = visible.map((ranked) => {
    const signal = signalById.get(ranked.signal_id);
    if (signal === undefined) {
      throw new Error(`ranked source signal ${ranked.signal_id} disappeared`);
    }
    const review = reviewBySignal.get(signal.id);
    const evaluation =
      review?.jevEvaluationId === null || review?.jevEvaluationId === undefined
        ? undefined
        : evaluationById.get(review.jevEvaluationId);
    const currentTriage = currentJevTriage(
      signal,
      review,
      evaluation,
      expected,
    );
    const analystCase = caseBySignal.get(signal.id);
    const currentCase =
      analystCase !== undefined &&
      analystCase.sourceRevision === signal.reviewRevision
        ? asCase(analystCase)
        : null;
    return {
      signal,
      review: review === undefined ? null : asState(review),
      currentTriage,
      currentCase,
      currentCaseProofCurrent:
        currentCase !== null &&
        currentTriage !== null &&
        review?.inputHash !== null &&
        currentCase.inputHash === review?.inputHash,
      investorApproved: ranked.investor_approved === true,
      ranking: ranked.ranking,
    };
  });
  const last = visible.at(-1);
  return {
    items,
    nextCursor:
      pageResult.rows.length <= limit || last === undefined
        ? null
        : {
            version: "source-signal-overview-v1",
            sort: query.sort,
            status: last.ranking_status,
            score: last.ranking_score,
            createdAt: last.created_at_text,
            signalId: last.signal_id,
            binding: query.binding,
          },
  };
}
