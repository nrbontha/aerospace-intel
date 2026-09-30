import { createHash } from "node:crypto";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Database } from "./client.js";
import { investorApprovedSql } from "./investor-approval.js";
import { investorRankingSql } from "./investor-ranking.js";
import {
  signalReviewState,
  sourceSignalEvidenceLinks,
  sourceSignals,
  type NewSignalReviewState,
  type SignalReviewPhase,
  type SignalReviewState,
  type SourceSignalEvidenceLink,
} from "./schema.js";
import {
  matchesExpectedReviewInputContract,
  type ExpectedFaaReviewInputContract,
} from "./unified-targets/records.js";

export type SignalReviewJson = Record<string, unknown>;
export type SignalReviewTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type SignalReviewExecutor = Database | SignalReviewTransaction;
type SignalReviewStateRow = typeof signalReviewState.$inferSelect;

export type SignalReviewClaim = Omit<
  SignalReviewState,
  "leaseToken" | "leaseExpiresAt"
> & {
  leaseToken: string;
  leaseExpiresAt: Date;
};

export interface ClaimSignalReviewsOptions {
  phase: SignalReviewPhase;
  limit: number;
  leaseSeconds?: number;
  sourceSignalIds?: readonly string[];
  /**
   * Required only for Muse: seals claims to the current review/policy proof
   * before applying canonical investor ranking.
   */
  expectedReviewInputContract?: ExpectedFaaReviewInputContract;
}

export interface BootstrapSignalReviewStatesOptions {
  limit?: number;
  sourceSignalIds?: readonly string[];
}

export interface ReconcileChangedSignalReviewsOptions {
  limit?: number;
  sourceSignalIds?: readonly string[];
}

export interface FailSignalReviewOptions {
  /** Dependency/configuration/budget deferrals do not consume a candidate attempt. */
  deferred?: boolean;
  retryAfterMs?: number;
  /**
   * Preserve an externally supplied retry boundary exactly. Null means that
   * only a meaningful capability change can make this review claimable again.
   */
  retryAt?: Date | null;
}

export interface WakeBlockedSignalAnalystReviewsOptions {
  sourceSignalIds?: readonly string[];
  budgetScopeId?: string;
  capabilityDomain: "resource" | "model";
  capabilityFingerprint: string;
  /**
   * When a provider settlement releases capacity, require each blocked model
   * request's recorded admission to pass against the exact current totals.
   * Missing or malformed legacy metadata deliberately cannot wake a review.
   */
  modelAdmission?: {
    budgetScopeId: string;
    scopeCommittedCostUsd: string;
    totalCapUsd: string;
    providerCommittedCostUsd: string;
  };
}

export interface SignalAnalystCapabilityFingerprintInput {
  mode: "free_only" | "bounded_paid";
  scopeId: string;
  permitStatus: string;
  operationalStatus: string;
  cooldownRetryAt: string | null;
}

export function signalAnalystCapabilityFingerprint(
  input: SignalAnalystCapabilityFingerprintInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mode: input.mode,
        id: input.scopeId,
        permit: input.permitStatus,
        status: input.operationalStatus,
        cooldown: input.cooldownRetryAt,
      }),
    )
    .digest("hex");
}

export interface CompleteSignalResearchInput {
  researchEvidence: SignalReviewJson;
  outcome: SignalReviewJson;
  researchDueAt: Date | null;
  expectedReviewInputContract: ExpectedFaaReviewInputContract;
}

export interface UpdateClaimedSignalReviewInput {
  inputHash: string;
  inputManifest: SignalReviewJson;
}

export interface SignalReviewTransition {
  phase: SignalReviewPhase;
  inputHash?: string | null;
  inputManifest?: SignalReviewJson | null;
  researchEvidence?: SignalReviewJson;
  jevEvaluationId?: string | null;
  nextAttemptAt?: Date;
  researchDueAt?: Date | null;
  lastResearchOutcome?: SignalReviewJson | null;
  inputsCheckedAt?: Date | null;
}

export type SignalReviewCommitResult<T> =
  { accepted: true; value: T; state: SignalReviewState } | { accepted: false };

export type SignalReviewFenceResult<T> =
  | { accepted: true; value: T }
  | { accepted: false };

export type SourceSignalEvidenceStage =
  "domain" | "website" | "ownership" | "size";

export interface LinkSourceSignalEvidenceInput {
  signalId: string;
  evidenceId: string;
  stage: SourceSignalEvidenceStage;
  researchRevision: string;
}

const DEFAULT_LEASE_SECONDS = 15 * 60;
const MAX_LEASE_SECONDS = 60 * 60;
const DEFAULT_BOOTSTRAP_LIMIT = 250;
const MAX_BOOTSTRAP_LIMIT = 1_000;
const DEFAULT_DEFERRED_RETRY_MS = 15 * 60_000;
const FAILURE_BACKOFF_BASE_MS = 60_000;
const DEFAULT_RECONCILE_LIMIT = 250;
const MAX_RECONCILE_LIMIT = 1_000;
const FAILURE_BACKOFF_CAP_MS = 6 * 60 * 60_000;
const MAX_TIMESTAMP = new Date("9999-12-31T23:59:59.999Z");
const VOLATILE_HASH_KEYS: Readonly<Record<string, true>> = {
  evidenceId: true,
  documentId: true,
  sourceDocumentId: true,
  linkId: true,
  databaseId: true,
  retrievedAt: true,
  fetchedAt: true,
  checkedAt: true,
  recordedAt: true,
  createdAt: true,
  updatedAt: true,
  lastSeenAt: true,
  firstSeenAt: true,
  evidence_id: true,
  document_id: true,
  source_document_id: true,
  retrieved_at: true,
  fetched_at: true,
  checked_at: true,
  created_at: true,
  updated_at: true,
  proofEvidenceIds: true,
  namedProductEvidenceIds: true,
  supportEvidenceIds: true,
};

export class SignalReviewFenceRejected extends Error {
  constructor() {
    super("signal review claim is stale or expired");
    this.name = "SignalReviewFenceRejected";
  }
}

function asState(row: SignalReviewStateRow): SignalReviewState {
  return row as SignalReviewState;
}

function asClaim(row: SignalReviewStateRow): SignalReviewClaim {
  if (row.leaseToken === null || row.leaseExpiresAt === null) {
    throw new Error(
      `signal review ${row.signalId} was returned without a lease`,
    );
  }
  return row as SignalReviewClaim;
}

function requireJsonObject(value: SignalReviewJson, name: string): void {
  if (value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalHashValue(value: unknown, key?: string): unknown {
  if (key !== undefined && VOLATILE_HASH_KEYS[key] === true) return undefined;
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("review input must contain finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => canonicalHashValue(entry))
      .filter((entry) => entry !== undefined)
      .map((entry) => {
        const serialized = JSON.stringify(entry);
        if (serialized === undefined) {
          throw new TypeError("review input contains a non-JSON array value");
        }
        return serialized;
      });
    return [...new Set(values)]
      .sort()
      .map((entry) => JSON.parse(entry) as unknown);
  }
  if (typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    const artifactRecord = value as Record<string, unknown>;
    const persistenceArtifact =
      "evidenceId" in artifactRecord ||
      "documentId" in artifactRecord ||
      "sourceDocumentId" in artifactRecord ||
      "retrievedAt" in artifactRecord ||
      ("url" in artifactRecord &&
        ("quote" in artifactRecord ||
          "contentHash" in artifactRecord ||
          "contentSha256" in artifactRecord));
    for (const [entryKey, entryValue] of Object.entries(value).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      if (entryKey === "id" && persistenceArtifact) continue;
      const canonical = canonicalHashValue(entryValue, entryKey);
      if (canonical !== undefined) normalized[entryKey] = canonical;
    }
    return normalized;
  }
  throw new TypeError(
    `review input contains unsupported ${typeof value} value`,
  );
}

/**
 * Hash substantive review input deterministically. Object key order, set-like
 * array order, retrieval timestamps, and persistence-only IDs do not affect the
 * result. Callers must still omit other operational metadata from the input.
 */
export function hashSignalReviewInput(value: unknown): string {
  const canonical = JSON.stringify(canonicalHashValue(value));
  if (canonical === undefined) {
    throw new TypeError("review input must have a JSON value");
  }
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Seed a bounded FIFO slice of raw signals without changing ingestion status or
 * treating legacy evaluation rows as current review proof.
 */
export async function bootstrapSignalReviewStates(
  db: Database,
  options: BootstrapSignalReviewStatesOptions = {},
): Promise<number> {
  if (options.limit !== undefined && !Number.isFinite(options.limit)) {
    throw new TypeError("bootstrap limit must be finite");
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_BOOTSTRAP_LIMIT)),
    MAX_BOOTSTRAP_LIMIT,
  );
  if (options.sourceSignalIds?.length === 0) return 0;
  const sourceFilter =
    options.sourceSignalIds === undefined
      ? sql`TRUE`
      : inArray(sql`ss.id`, options.sourceSignalIds);
  await reconcileChangedSignalReviews(db, {
    limit,
    ...(options.sourceSignalIds === undefined
      ? {}
      : { sourceSignalIds: options.sourceSignalIds }),
  });
  const inserted = await db.execute<{ signal_id: string }>(sql`
    INSERT INTO signal_review_state (
      signal_id,
      source_revision,
      phase,
      next_attempt_at
    )
    SELECT candidate.id,
           candidate.review_revision,
           'research',
           candidate.created_at - CASE
             WHEN candidate.prior_jev_hp THEN interval '200 years'
             WHEN candidate.faa_priority THEN interval '100 years'
             ELSE interval '0 years'
           END
    FROM (
      SELECT ss.id,
             ss.review_revision,
             ss.created_at,
             COALESCE((
               SELECT evaluation.decision = 'high_priority'
               FROM faa_ensemble_evaluations evaluation
               WHERE evaluation.signal_id = ss.id
                 AND evaluation.prompt_version LIKE 'jev-ladder-%'
                 AND evaluation.decision IS NOT NULL
                 AND evaluation.error IS NULL
               ORDER BY evaluation.updated_at DESC,
                        evaluation.created_at DESC,
                        evaluation.id DESC
               LIMIT 1
             ), false) AS prior_jev_hp,
             (ss.source_key IN (
               'faa_pma_database',
               'faa_drs_pma',
               'faa_drs_pma_search'
             )) AS faa_priority
      FROM source_signals ss
      LEFT JOIN signal_review_state srs ON srs.signal_id = ss.id
      WHERE srs.signal_id IS NULL
        AND ${sourceFilter}
        AND (
          ss.status IN ('queued_qualification', 'qualifying', 'qualified')
          OR (
            ss.status IN ('rejected', 'quarantined')
            AND ss.source_key IN (
              'faa_pma_database',
              'faa_drs_pma',
              'faa_drs_pma_search'
            )
            AND (
              ss.qualification->>'reason' IN (
                'qualification_error',
                'official_identity_not_verified',
                'identity_not_verified'
              )
              OR ss.qualification->>'error' IN (
                'qualification_error',
                'official_identity_not_verified',
                'identity_not_verified'
              )
              OR ss.qualification->'reasons' ?| ARRAY[
                'qualification_error',
                'official_identity_not_verified',
                'identity_not_verified'
              ]
            )
            AND NOT COALESCE(
              ss.qualification ?| ARRAY[
                'humanDecision',
                'humanOverride',
                'reviewedByUserId',
                'reviewedBy',
                'reviewedAt',
                'decidedByUserId'
              ]
              OR ss.qualification->>'decisionSource' = 'human'
              OR ss.qualification->>'reviewSource' = 'human',
              false
            )
          )
        )
      ORDER BY prior_jev_hp DESC,
               faa_priority DESC,
               ss.created_at ASC,
               ss.id ASC
      LIMIT ${limit}
    ) candidate
    ON CONFLICT (signal_id) DO NOTHING
    RETURNING signal_id
  `);
  return inserted.rows.length;
}

/** Idempotently initialize one signal without resetting any existing review. */
export async function ensureSignalReviewState(
  db: Database,
  signalId: string,
  phase: SignalReviewPhase = "research",
): Promise<SignalReviewState> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO signal_review_state (signal_id, source_revision, phase)
      SELECT id, review_revision, ${phase}
      FROM source_signals
      WHERE id = ${signalId}
      ON CONFLICT (signal_id) DO NOTHING
    `);
    const existing = await tx
      .select()
      .from(signalReviewState)
      .where(eq(signalReviewState.signalId, signalId))
      .limit(1);
    if (existing[0] === undefined) {
      throw new Error(`source signal ${signalId} does not exist`);
    }
    return asState(existing[0]);
  });
}

/**
 * Requeue a bounded slice of reviews whose material source revision changed.
 * State rows are locked before their source rows are read, preserving the
 * state-then-source lock order used by publication and promotion.
 */
export async function reconcileChangedSignalReviews(
  db: Database,
  options: ReconcileChangedSignalReviewsOptions = {},
): Promise<number> {
  if (options.limit !== undefined && !Number.isFinite(options.limit)) {
    throw new TypeError("reconciliation limit must be finite");
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_RECONCILE_LIMIT)),
    MAX_RECONCILE_LIMIT,
  );
  if (options.sourceSignalIds?.length === 0) return 0;
  const sourceFilter =
    options.sourceSignalIds === undefined
      ? sql`TRUE`
      : inArray(sql`state.signal_id`, options.sourceSignalIds);
  const reconciled = await db.execute<{ signal_id: string }>(sql`
    WITH changed AS (
      SELECT state.signal_id, source.review_revision
      FROM signal_review_state state
      JOIN source_signals source ON source.id = state.signal_id
      WHERE state.source_revision <> source.review_revision
        AND ${sourceFilter}
      ORDER BY state.updated_at ASC, state.signal_id ASC
      LIMIT ${limit}
      FOR UPDATE OF state SKIP LOCKED
    )
    UPDATE signal_review_state state
    SET source_revision = changed.review_revision,
        phase = 'research',
        input_hash = NULL,
        input_manifest = NULL,
        research_evidence = '{}',
        jev_evaluation_id = NULL,
        next_attempt_at = clock_timestamp(),
        attempt_count = 0,
        last_error = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        research_due_at = NULL,
        last_research_outcome = NULL,
        inputs_checked_at = NULL,
        updated_at = clock_timestamp()
    FROM changed
    WHERE state.signal_id = changed.signal_id
      AND ${sourceFilter}
    RETURNING state.signal_id
  `);
  return reconciled.rows.length;
}
/**
 * Make an unscheduled capability-blocked Muse review claimable when its
 * available capability has materially changed. This deliberately changes only
 * the review scheduler: the deferred case, its checkpoint, and its history
 * remain intact until a worker holds the resulting claim.
 */
export async function wakeBlockedSignalAnalystReviews(
  db: SignalReviewExecutor,
  options: WakeBlockedSignalAnalystReviewsOptions,
): Promise<number> {
  const sourceSignalIds = options.sourceSignalIds;
  const budgetScopeId = options.budgetScopeId?.trim();
  if (
    (sourceSignalIds === undefined) === (budgetScopeId === undefined || budgetScopeId === "")
  ) {
    throw new TypeError(
      "wakeBlockedSignalAnalystReviews requires exactly one source or scope selector",
    );
  }
  if (sourceSignalIds?.length === 0) return 0;
  const scopeFilter =
    sourceSignalIds === undefined
      ? sql`EXISTS (
          SELECT 1
          FROM research_provider_budget_scope_signals scope_signal
          WHERE scope_signal.budget_scope_id = ${budgetScopeId}
            AND scope_signal.source_signal_id = state.signal_id
        )`
      : sql`state.signal_id IN (${sql.join(
          sourceSignalIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const modelAdmission = options.modelAdmission;
  if (modelAdmission !== undefined) {
    if (options.capabilityDomain !== "model") {
      throw new TypeError("modelAdmission requires model capabilityDomain");
    }
    if (
      modelAdmission.budgetScopeId.trim().length === 0 ||
      ![
        modelAdmission.scopeCommittedCostUsd,
        modelAdmission.totalCapUsd,
        modelAdmission.providerCommittedCostUsd,
      ].every((value) => /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value))
    ) {
      throw new TypeError("modelAdmission must contain plain decimal accounting values");
    }
  }
  const modelAdmissionFilter =
    modelAdmission === undefined
      ? sql`TRUE`
      : sql`CASE
          WHEN jsonb_typeof(
            analyst.checkpoint->'blockedCapability'->'admission'
          ) = 'object'
            AND analyst.checkpoint->'blockedCapability'->'admission'
              ->>'budgetScopeId' = ${modelAdmission.budgetScopeId}
            AND analyst.checkpoint->'blockedCapability'->'admission'
              ->>'estimatedCostUsd' ~ '^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$'
            AND analyst.checkpoint->'blockedCapability'->'admission'
              ->>'dailyCapUsd' ~ '^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?$'
          THEN (
            ${modelAdmission.scopeCommittedCostUsd}::numeric
              + (
                analyst.checkpoint->'blockedCapability'->'admission'
                  ->>'estimatedCostUsd'
              )::numeric
              <= ${modelAdmission.totalCapUsd}::numeric
            AND ${modelAdmission.providerCommittedCostUsd}::numeric
              + (
                analyst.checkpoint->'blockedCapability'->'admission'
                  ->>'estimatedCostUsd'
              )::numeric
              <= (
                analyst.checkpoint->'blockedCapability'->'admission'
                  ->>'dailyCapUsd'
              )::numeric
          )
          ELSE FALSE
        END`;
  const woken = await db.execute<{ signal_id: string }>(sql`
    UPDATE signal_review_state state
    SET next_attempt_at = clock_timestamp(),
        updated_at = clock_timestamp()
    FROM source_signals source,
         signal_analyst_cases analyst
    WHERE state.signal_id = source.id
      AND analyst.signal_id = state.signal_id
      AND analyst.source_revision = source.review_revision
      AND analyst.input_hash = state.input_hash
      AND analyst.policy_version =
        NULLIF(state.input_manifest->'policy'->>'analyst', '')
      AND analyst.status = 'deferred'
      AND analyst.next_attempt_at IS NULL
      AND ${scopeFilter}
      AND state.source_revision = source.review_revision
      AND state.phase = 'muse'
      AND state.input_hash IS NOT NULL
      AND state.next_attempt_at = ${MAX_TIMESTAMP}
      AND (
        state.lease_expires_at IS NULL
        OR state.lease_expires_at <= clock_timestamp()
      )
      AND jsonb_typeof(analyst.checkpoint->'blockedCapability') = 'object'
      AND COALESCE(
        analyst.checkpoint->'blockedCapability'->>'kind',
        'resource'
      ) = ${options.capabilityDomain}
      AND ${modelAdmissionFilter}
      AND analyst.checkpoint->'blockedCapability'->>'fingerprint'
        IS DISTINCT FROM ${options.capabilityFingerprint}
      AND NOT ${investorApprovedSql(sql`state.signal_id`)}
    RETURNING state.signal_id
  `);
  return woken.rows.length;
}


/**
 * Lock the material source revision after the caller has locked review state.
 * Holding this share lock through commit prevents source/human edits from
 * crossing a successful publication or promotion boundary.
 */
export async function lockCurrentSignalReviewSource(
  tx: SignalReviewTransaction,
  signalId: string,
  expectedRevision: number,
): Promise<boolean> {
  const rows = await tx
    .select({ reviewRevision: sourceSignals.reviewRevision })
    .from(sourceSignals)
    .where(eq(sourceSignals.id, signalId))
    .limit(1)
    .for("share");
  return rows[0]?.reviewRevision === expectedRevision;
}

/**
 * Atomically lease due work. Non-Muse phases preserve FIFO semantics; Muse
 * ranks the full sealed eligible cohort before limiting. Expired leases are
 * reclaimable, and SKIP LOCKED lets workers claim disjoint slices.
 */
export async function claimSignalReviews(
  db: Database,
  options: ClaimSignalReviewsOptions,
): Promise<SignalReviewClaim[]> {
  if (!Number.isFinite(options.limit)) {
    throw new TypeError("claim limit must be finite");
  }
  if (
    options.leaseSeconds !== undefined &&
    !Number.isFinite(options.leaseSeconds)
  ) {
    throw new TypeError("leaseSeconds must be finite");
  }
  if (
    options.phase === "muse" &&
    options.expectedReviewInputContract === undefined
  ) {
    throw new TypeError(
      "expectedReviewInputContract is required for Muse review claims",
    );
  }
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), 500);
  const leaseSeconds = Math.min(
    Math.max(1, Math.trunc(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS)),
    MAX_LEASE_SECONDS,
  );
  if (options.sourceSignalIds?.length === 0) return [];
  await reconcileChangedSignalReviews(db, {
    limit: Math.max(DEFAULT_RECONCILE_LIMIT, limit),
    ...(options.sourceSignalIds === undefined
      ? {}
      : { sourceSignalIds: options.sourceSignalIds }),
  });
  const leaseDuration = sql`${leaseSeconds} * interval '1 second'`;
  const eligiblePhase =
    options.phase === "research"
      ? or(
          eq(signalReviewState.phase, "research"),
          and(
            eq(signalReviewState.phase, "settled"),
            sql`${signalReviewState.researchDueAt} IS NOT NULL`,
            sql`${signalReviewState.researchDueAt} <= clock_timestamp()`,
          ),
        )
      : eq(signalReviewState.phase, options.phase);
  const sourceFilter =
    options.sourceSignalIds === undefined
      ? undefined
      : inArray(signalReviewState.signalId, options.sourceSignalIds);

  return db.transaction(async (tx) => {
    let due: { signalId: string }[];
    if (options.phase === "muse") {
      const expected = options.expectedReviewInputContract;
      if (expected === undefined) {
        throw new Error("Muse claim input contract was not validated");
      }
      const canonicalRanking = investorRankingSql({
        expectedReviewInputContract: expected,
        ...(options.sourceSignalIds === undefined
          ? {}
          : { sourceSignalIds: options.sourceSignalIds }),
      });
      const museSourceFilter =
        options.sourceSignalIds === undefined
          ? sql`TRUE`
          : inArray(sql`state.signal_id`, options.sourceSignalIds);
      const ranked = await tx.execute<{ signal_id: string }>(sql`
        WITH ranked AS MATERIALIZED (${canonicalRanking}),
        due AS (
          SELECT state.signal_id
          FROM signal_review_state state
          JOIN source_signals source
            ON source.id = state.signal_id
            AND source.review_revision = state.source_revision
          JOIN ranked
            ON ranked.signal_id = state.signal_id
          WHERE state.phase = 'muse'
            AND state.next_attempt_at <= clock_timestamp()
            AND (
              state.lease_expires_at IS NULL
              OR state.lease_expires_at <= clock_timestamp()
            )
            AND ranked.ranking_status = 'ranked'
            AND ranked.ranking_score IS NOT NULL
            AND NOT ${investorApprovedSql(sql`state.signal_id`)}
            AND NOT EXISTS (
              SELECT 1
              FROM signal_analyst_cases current_case
              WHERE current_case.signal_id = state.signal_id
                AND current_case.source_revision = source.review_revision
                AND current_case.policy_version = ${expected.policy.analyst}
                AND current_case.input_hash = state.input_hash
                AND current_case.status IN ('completed', 'exhausted')
            )
            AND ${museSourceFilter}
          ORDER BY
            ranked.ranking_score DESC,
            state.next_attempt_at ASC,
            state.created_at ASC,
            state.signal_id ASC
          LIMIT ${limit}
          FOR UPDATE OF state SKIP LOCKED
        )
        SELECT signal_id FROM due
      `);
      due = ranked.rows.map((row) => ({ signalId: row.signal_id }));
    } else {
      due = await tx
        .select({ signalId: signalReviewState.signalId })
        .from(signalReviewState)
        .innerJoin(
          sourceSignals,
          and(
            eq(sourceSignals.id, signalReviewState.signalId),
            eq(sourceSignals.reviewRevision, signalReviewState.sourceRevision),
          ),
        )
        .where(
          and(
            eligiblePhase,
            sourceFilter,
            sql`${signalReviewState.nextAttemptAt} <= clock_timestamp()`,
            or(
              isNull(signalReviewState.leaseExpiresAt),
              sql`${signalReviewState.leaseExpiresAt} <= clock_timestamp()`,
            ),
          ),
        )
        .orderBy(
          asc(signalReviewState.nextAttemptAt),
          asc(signalReviewState.createdAt),
          asc(signalReviewState.signalId),
        )
        .limit(limit)
        .for("update", { of: signalReviewState, skipLocked: true });
    }
    if (due.length === 0) return [];

    const rows = await tx
      .update(signalReviewState)
      .set({
        phase: options.phase,
        leaseToken: sql`gen_random_uuid()`,
        leaseExpiresAt: sql`clock_timestamp() + ${leaseDuration}`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          inArray(
            signalReviewState.signalId,
            due.map((row) => row.signalId),
          ),
          sourceFilter,
        ),
      )
      .returning();
    const order = new Map(due.map((row, index) => [row.signalId, index]));
    return rows
      .map(asClaim)
      .sort(
        (a, b) =>
          (order.get(a.signalId) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.signalId) ?? Number.MAX_SAFE_INTEGER),
      );
  });
}

function liveClaimWhere(claim: SignalReviewClaim) {
  return and(
    eq(signalReviewState.signalId, claim.signalId),
    eq(signalReviewState.sourceRevision, claim.sourceRevision),
    eq(signalReviewState.phase, claim.phase),
    eq(signalReviewState.leaseToken, claim.leaseToken),
    sql`${signalReviewState.leaseExpiresAt} > clock_timestamp()`,
    sql`${signalReviewState.inputHash} IS NOT DISTINCT FROM ${claim.inputHash}`,
  );
}

async function requeueChangedClaim(
  tx: SignalReviewTransaction,
  claim: SignalReviewClaim,
): Promise<void> {
  const source = await tx
    .select({ reviewRevision: sourceSignals.reviewRevision })
    .from(sourceSignals)
    .where(eq(sourceSignals.id, claim.signalId))
    .limit(1);
  if (source[0] === undefined) return;
  await tx
    .update(signalReviewState)
    .set({
      sourceRevision: source[0].reviewRevision,
      phase: "research",
      inputHash: null,
      inputManifest: null,
      researchEvidence: {},
      jevEvaluationId: null,
      nextAttemptAt: sql`clock_timestamp()`,
      attemptCount: 0,
      lastError: null,
      leaseToken: null,
      leaseExpiresAt: null,
      researchDueAt: null,
      lastResearchOutcome: null,
      inputsCheckedAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(signalReviewState.signalId, claim.signalId),
        eq(signalReviewState.leaseToken, claim.leaseToken),
      ),
    );
}

/**
 * Run durable preparation and publication behind the exact signal-review
 * revision/phase/hash/lease fence. Preparation may write journal/receipt rows;
 * it is rolled back when the lease expires before publication. Callers whose
 * final callback intentionally transitions the claim must opt out of the final
 * post-publication check and enforce the same live predicate in that update.
 */
export async function withSignalReviewClaimTransaction<TPrepared, TPublished>(
  db: Database,
  claim: SignalReviewClaim,
  prepare: (tx: SignalReviewTransaction) => Promise<TPrepared>,
  publish: (
    tx: SignalReviewTransaction,
    prepared: TPrepared,
  ) => Promise<TPublished>,
  options: { claimTransitionedByPublish?: boolean } = {},
): Promise<SignalReviewFenceResult<TPublished>> {
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx
        .select({ signalId: signalReviewState.signalId })
        .from(signalReviewState)
        .where(liveClaimWhere(claim))
        .limit(1)
        .for("update");
      if (locked[0] === undefined) throw new SignalReviewFenceRejected();
      if (
        !(await lockCurrentSignalReviewSource(
          tx,
          claim.signalId,
          claim.sourceRevision,
        ))
      ) {
        await requeueChangedClaim(tx, claim);
        return { accepted: false } as const;
      }

      const prepared = await prepare(tx);
      const stillLive = await tx
        .select({ signalId: signalReviewState.signalId })
        .from(signalReviewState)
        .where(liveClaimWhere(claim))
        .limit(1);
      if (stillLive[0] === undefined) throw new SignalReviewFenceRejected();
      const value = await publish(tx, prepared);
      if (options.claimTransitionedByPublish !== true) {
        const liveAfterPublication = await tx
          .select({ signalId: signalReviewState.signalId })
          .from(signalReviewState)
          .where(liveClaimWhere(claim))
          .limit(1);
        if (liveAfterPublication[0] === undefined) {
          throw new SignalReviewFenceRejected();
        }
      }
      return { accepted: true, value } as const;
    });
  } catch (error) {
    if (error instanceof SignalReviewFenceRejected) return { accepted: false };
    throw error;
  }
}

/**
 * Install the canonical manifest under the current lease. A changed hash clears
 * the old Jev pointer. The returned claim is the only valid fence for commit.
 */
export async function updateClaimedSignalReviewInput(
  db: Database,
  claim: SignalReviewClaim,
  input: UpdateClaimedSignalReviewInput,
): Promise<SignalReviewClaim | null> {
  requireJsonObject(input.inputManifest, "inputManifest");
  if (!/^[a-f\d]{64}$/u.test(input.inputHash)) {
    throw new TypeError("inputHash must be a lowercase SHA-256 digest");
  }
  const changed = input.inputHash !== claim.inputHash;
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ signalId: signalReviewState.signalId })
      .from(signalReviewState)
      .where(liveClaimWhere(claim))
      .limit(1)
      .for("update");
    if (locked[0] === undefined) return null;
    if (
      !(await lockCurrentSignalReviewSource(
        tx,
        claim.signalId,
        claim.sourceRevision,
      ))
    ) {
      await requeueChangedClaim(tx, claim);
      return null;
    }
    const rows = await tx
      .update(signalReviewState)
      .set({
        inputHash: input.inputHash,
        inputManifest: input.inputManifest,
        jevEvaluationId: changed ? null : claim.jevEvaluationId,
        inputsCheckedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(liveClaimWhere(claim))
      .returning();
    return rows[0] === undefined ? null : asClaim(rows[0]);
  });
}

function transitionSet(
  transition: SignalReviewTransition,
): Partial<NewSignalReviewState> {
  const set: Partial<NewSignalReviewState> = {
    phase: transition.phase,
    attemptCount: 0,
    lastError: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  };
  if (hasOwn(transition, "inputHash"))
    set.inputHash = transition.inputHash ?? null;
  if (hasOwn(transition, "inputManifest")) {
    set.inputManifest = transition.inputManifest ?? null;
  }
  if (hasOwn(transition, "researchEvidence")) {
    set.researchEvidence = transition.researchEvidence;
  }
  if (hasOwn(transition, "jevEvaluationId")) {
    set.jevEvaluationId = transition.jevEvaluationId ?? null;
  }
  if (hasOwn(transition, "nextAttemptAt")) {
    set.nextAttemptAt = transition.nextAttemptAt;
  }
  if (hasOwn(transition, "researchDueAt")) {
    set.researchDueAt = transition.researchDueAt ?? null;
  }
  if (hasOwn(transition, "lastResearchOutcome")) {
    set.lastResearchOutcome = transition.lastResearchOutcome ?? null;
  }
  if (hasOwn(transition, "inputsCheckedAt")) {
    set.inputsCheckedAt = transition.inputsCheckedAt ?? null;
  }
  return set;
}

/**
 * Persist a model result and transition its review state in one transaction.
 * The callback is never called for an already-stale claim. If the lease expires
 * during callback persistence, the transaction rolls back all callback writes.
 */
export async function commitSignalReview<T>(
  db: Database,
  claim: SignalReviewClaim,
  transition: SignalReviewTransition,
  persistCallback: (tx: SignalReviewTransaction) => Promise<T>,
): Promise<SignalReviewCommitResult<T>> {
  const effectiveTransition: SignalReviewTransition = hasOwn(
    transition,
    "nextAttemptAt",
  )
    ? transition
    : {
        ...transition,
        nextAttemptAt:
          transition.phase === "settled"
            ? (transition.researchDueAt ?? claim.researchDueAt ?? MAX_TIMESTAMP)
            : new Date(),
      };
  const committed = await withSignalReviewClaimTransaction(
    db,
    claim,
    persistCallback,
    async (tx, value) => {
      const rows = await tx
        .update(signalReviewState)
        .set(transitionSet(effectiveTransition))
        .where(liveClaimWhere(claim))
        .returning();
      if (rows[0] === undefined) throw new SignalReviewFenceRejected();
      return { value, state: asState(rows[0]) };
    },
    { claimTransitionedByPublish: true },
  );
  return committed.accepted
    ? {
        accepted: true,
        value: committed.value.value,
        state: committed.value.state,
      }
    : { accepted: false };
}

/**
 * Release a failed claim with capped exponential backoff. Deferred dependency
 * failures retain the candidate attempt counter.
 */
export async function failSignalReview(
  db: Database,
  claim: SignalReviewClaim,
  error: unknown,
  options: FailSignalReviewOptions = {},
): Promise<SignalReviewState | null> {
  const deferred = options.deferred === true;
  const nextAttemptCount = deferred
    ? claim.attemptCount
    : claim.attemptCount + 1;
  const computedBackoff = deferred
    ? DEFAULT_DEFERRED_RETRY_MS
    : Math.min(
        FAILURE_BACKOFF_CAP_MS,
        FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(claim.attemptCount, 8),
      );
  const requestedRetryAfterMs = options.retryAfterMs ?? computedBackoff;
  if (!Number.isFinite(requestedRetryAfterMs)) {
    throw new TypeError("retryAfterMs must be finite");
  }
  const retryAfterMs = Math.min(
    FAILURE_BACKOFF_CAP_MS,
    Math.max(0, requestedRetryAfterMs),
  );

  const retryAt =
    options.retryAt === undefined
      ? new Date(Date.now() + retryAfterMs)
      : options.retryAt;
  if (retryAt !== null && Number.isNaN(retryAt.getTime())) {
    throw new TypeError("retryAt must be a valid date or null");
  }
  const message = error instanceof Error ? error.message : String(error);
  const rows = await db
    .update(signalReviewState)
    .set({
      attemptCount: nextAttemptCount,
      lastError: message.slice(0, 10_000),
      nextAttemptAt: retryAt ?? MAX_TIMESTAMP,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(liveClaimWhere(claim))
    .returning();
  return rows[0] === undefined ? null : asState(rows[0]);
}

/**
 * Complete sourced research. Substantive evidence/outcome changes invalidate
 * the frozen input. Identical evidence may reuse a verdict only when its
 * manifest proves both the same database source revision and the caller's
 * expected model/prompt/policy contract.
 */
export async function completeSignalResearch(
  db: Database,
  claim: SignalReviewClaim,
  input: CompleteSignalResearchInput,
): Promise<SignalReviewState | null> {
  requireJsonObject(input.researchEvidence, "researchEvidence");
  requireJsonObject(input.outcome, "outcome");
  const previousHash = hashSignalReviewInput({
    researchEvidence: claim.researchEvidence,
    outcome: claim.lastResearchOutcome,
  });
  const nextHash = hashSignalReviewInput({
    researchEvidence: input.researchEvidence,
    outcome: input.outcome,
  });
  const changed = previousHash !== nextHash;
  const revisionManifestCurrent =
    claim.inputManifest?.["sourceRevision"] === claim.sourceRevision;
  const canReuse =
    !changed &&
    revisionManifestCurrent &&
    matchesExpectedReviewInputContract(
      claim.inputManifest,
      input.expectedReviewInputContract,
    ) &&
    claim.inputHash !== null &&
    claim.jevEvaluationId !== null;
  const phase: SignalReviewPhase = canReuse ? "settled" : "jev";
  const nextAttemptAt =
    phase === "jev" ? new Date() : (input.researchDueAt ?? MAX_TIMESTAMP);

  const committed = await commitSignalReview(
    db,
    claim,
    {
      phase,
      inputHash: canReuse ? claim.inputHash : null,
      inputManifest: canReuse ? claim.inputManifest : null,
      researchEvidence: input.researchEvidence,
      jevEvaluationId: canReuse ? claim.jevEvaluationId : null,
      nextAttemptAt,
      researchDueAt: input.researchDueAt,
      lastResearchOutcome: input.outcome,
      inputsCheckedAt: new Date(),
    },
    async () => undefined,
  );
  return committed.accepted ? committed.state : null;
}

/** Idempotently attach primary evidence to a raw signal without creating an entity. */
export async function linkSourceSignalEvidence(
  db: SignalReviewExecutor,
  input: LinkSourceSignalEvidenceInput,
): Promise<SourceSignalEvidenceLink> {
  if (input.researchRevision.trim().length === 0) {
    throw new TypeError("researchRevision must not be empty");
  }
  const inserted = await db
    .insert(sourceSignalEvidenceLinks)
    .values(input)
    .onConflictDoNothing({
      target: [
        sourceSignalEvidenceLinks.signalId,
        sourceSignalEvidenceLinks.evidenceId,
      ],
    })
    .returning();
  if (inserted[0] !== undefined) return inserted[0];

  const existing = await db
    .select()
    .from(sourceSignalEvidenceLinks)
    .where(
      and(
        eq(sourceSignalEvidenceLinks.signalId, input.signalId),
        eq(sourceSignalEvidenceLinks.evidenceId, input.evidenceId),
      ),
    )
    .limit(1);
  if (existing[0] === undefined) {
    throw new Error(
      `source signal evidence link disappeared for ${input.signalId}/${input.evidenceId}`,
    );
  }
  return existing[0];
}
