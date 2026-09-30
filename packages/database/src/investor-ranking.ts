import { createHash } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import type { ExpectedFaaReviewInputContract } from "./unified-targets/records.js";

export const INVESTOR_RANKING_POLICY_VERSION =
  "investor-research-priority-v1";

export type InvestorRankingStatus = "ranked" | "unscored" | "excluded";
export type InvestorRankingBasis =
  | "source"
  | "hypothesis"
  | "unresolved"
  | "verified_review";

export interface InvestorRankingBreakdownItem {
  readonly key: string;
  readonly label: string;
  readonly points: number;
  readonly maxPoints: number;
  readonly basis: InvestorRankingBasis;
  readonly reason: string;
}

export interface InvestorRanking {
  readonly policyVersion: string;
  readonly score: number | null;
  readonly status: InvestorRankingStatus;
  readonly breakdown: readonly InvestorRankingBreakdownItem[];
  readonly blockers: readonly string[];
  readonly updatedAt: string | null;
}

/** Canonical fallback when no source signal/current review can be linked. */
export const UNSCORED_INVESTOR_RANKING = {
  policyVersion: INVESTOR_RANKING_POLICY_VERSION,
  score: null,
  status: "unscored",
  breakdown: [
    {
      key: "product_fit",
      label: "Own named-product fit",
      points: 0,
      maxPoints: 50,
      basis: "unresolved",
      reason: "No current named-product proof or plausible-supplier hypothesis.",
    },
    {
      key: "identity",
      label: "Verified target identity",
      points: 0,
      maxPoints: 10,
      basis: "unresolved",
      reason:
        "Target identity is not verified by current admitted source evidence.",
    },
    {
      key: "headquarters",
      label: "US headquarters",
      points: 0,
      maxPoints: 10,
      basis: "unresolved",
      reason:
        "US headquarters is not supported by current admitted source evidence.",
    },
    {
      key: "ownership",
      label: "Independent ownership",
      points: 0,
      maxPoints: 10,
      basis: "unresolved",
      reason:
        "Independent ownership is not supported by current admitted source evidence.",
    },
    {
      key: "revenue",
      label: "Annual revenue under $50m",
      points: 0,
      maxPoints: 10,
      basis: "unresolved",
      reason:
        "Current admitted annual-revenue evidence does not establish revenue under $50m.",
    },
    {
      key: "final_review",
      label: "Aligned final Jev/Muse review",
      points: 0,
      maxPoints: 10,
      basis: "unresolved",
      reason:
        "No current linked, error-free, completed high-priority Muse final is available.",
    },
  ],
  blockers: [],
  updatedAt: null,
} as const satisfies InvestorRanking;
const UNSCORED_INVESTOR_RANKING_JSON = JSON.stringify(
  UNSCORED_INVESTOR_RANKING,
);

export type SignalOverviewSort = "priority" | "newest";
export type SignalOverviewReadiness =
  | "ready"
  | "needs_research"
  | "blocked"
  | "unscored";

export interface SourceSignalAnalystOverviewCursor {
  readonly version: "source-signal-overview-v1";
  readonly sort: SignalOverviewSort;
  readonly status: InvestorRankingStatus;
  readonly score: number | null;
  readonly createdAt: string;
  readonly signalId: string;
  readonly binding: string;
}

export interface InvestorRankingSqlOptions {
  readonly expectedReviewInputContract: ExpectedFaaReviewInputContract | null;
  /** Absent means all source signals. An empty list deliberately means none. */
  readonly sourceSignalIds?: readonly string[];
}

export interface NormalizedSignalOverviewQuery {
  readonly sort: SignalOverviewSort;
  readonly q: string | null;
  readonly readiness: SignalOverviewReadiness | null;
  readonly sourceSignalIds: readonly string[] | null;
  readonly binding: string;
}

export interface NormalizeSignalOverviewQueryInput {
  readonly expectedReviewInputContract: ExpectedFaaReviewInputContract | null;
  readonly sort?: SignalOverviewSort;
  readonly q?: string;
  readonly readiness?: SignalOverviewReadiness;
  readonly sourceSignalIds?: readonly string[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EXACT_CURSOR_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const CURSOR_KEYS = [
  "binding",
  "createdAt",
  "score",
  "signalId",
  "sort",
  "status",
  "version",
] as const;


function validSort(value: unknown): value is SignalOverviewSort {
  return value === "priority" || value === "newest";
}

function validReadiness(value: unknown): value is SignalOverviewReadiness {
  return (
    value === "ready" ||
    value === "needs_research" ||
    value === "blocked" ||
    value === "unscored"
  );
}

function validStatus(value: unknown): value is InvestorRankingStatus {
  return value === "ranked" || value === "unscored" || value === "excluded";
}

function normalizeSourceSignalIds(
  value: readonly string[] | undefined,
): readonly string[] | null {
  if (value === undefined) return null;
  for (const id of value) {
    if (!UUID_PATTERN.test(id)) {
      throw new TypeError("sourceSignalIds must contain only UUIDs");
    }
  }
  return [...new Set(value)].sort();
}

function queryBinding(input: {
  readonly expectedReviewInputContract: ExpectedFaaReviewInputContract | null;
  readonly sort: SignalOverviewSort;
  readonly q: string | null;
  readonly readiness: SignalOverviewReadiness | null;
  readonly sourceSignalIds: readonly string[] | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        policyVersion: INVESTOR_RANKING_POLICY_VERSION,
        expectedReviewInputContract:
          input.expectedReviewInputContract === null
            ? null
            : {
                version: input.expectedReviewInputContract.version,
                policy: {
                  ladder: input.expectedReviewInputContract.policy.ladder,
                  analyst: input.expectedReviewInputContract.policy.analyst,
                  jevModel: input.expectedReviewInputContract.policy.jevModel,
                  museModel: input.expectedReviewInputContract.policy.museModel,
                  evaluatorPrompt:
                    input.expectedReviewInputContract.policy.evaluatorPrompt,
                },
              },
        sort: input.sort,
        q: input.q,
        readiness: input.readiness,
        sourceSignalIds: input.sourceSignalIds,
      }),
    )
    .digest("hex");
}

export function normalizeSignalOverviewQuery(
  input: NormalizeSignalOverviewQueryInput,
): NormalizedSignalOverviewQuery {
  if (input.expectedReviewInputContract === undefined) {
    throw new TypeError("expectedReviewInputContract is required");
  }
  const sort = input.sort ?? "priority";
  if (!validSort(sort)) throw new TypeError("sort must be priority or newest");
  const q = input.q?.trim() ?? "";
  if (q.length > 200) throw new TypeError("q must be at most 200 characters");
  if (input.readiness !== undefined && !validReadiness(input.readiness)) {
    throw new TypeError(
      "readiness must be ready, needs_research, blocked, or unscored",
    );
  }
  const normalized = {
    sort,
    q: q === "" ? null : q,
    readiness: input.readiness ?? null,
    sourceSignalIds: normalizeSourceSignalIds(input.sourceSignalIds),
  };
  return {
    ...normalized,
    binding: queryBinding({
      expectedReviewInputContract: input.expectedReviewInputContract,
      ...normalized,
    }),
  };
}

export function parseSignalOverviewCursor(
  value: unknown,
): SourceSignalAnalystOverviewCursor {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError("cursor must be an object");
  }
  const cursor = value as Record<string, unknown>;
  const keys = Object.keys(cursor).sort();
  if (
    keys.length !== CURSOR_KEYS.length ||
    !CURSOR_KEYS.every((key, index) => keys[index] === key)
  ) {
    throw new TypeError("cursor has an invalid shape");
  }
  if (cursor["version"] !== "source-signal-overview-v1") {
    throw new TypeError("cursor version is not supported");
  }
  if (!validSort(cursor["sort"])) {
    throw new TypeError("cursor sort is invalid");
  }
  if (!validStatus(cursor["status"])) {
    throw new TypeError("cursor status is invalid");
  }
  if (
    (cursor["status"] === "unscored" && cursor["score"] !== null) ||
    (cursor["status"] === "ranked" &&
      (!Number.isInteger(cursor["score"]) ||
        (cursor["score"] as number) < 0 ||
        (cursor["score"] as number) > 100)) ||
    (cursor["status"] === "excluded" && cursor["score"] !== 0)
  ) {
    throw new TypeError("cursor score is invalid for its status");
  }
  const createdAt =
    typeof cursor["createdAt"] === "string" ? cursor["createdAt"] : "";
  const year = Number(createdAt.slice(0, 4));
  const month = Number(createdAt.slice(5, 7));
  const day = Number(createdAt.slice(8, 10));
  const hour = Number(createdAt.slice(11, 13));
  const minute = Number(createdAt.slice(14, 16));
  const second = Number(createdAt.slice(17, 19));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    !EXACT_CURSOR_TIMESTAMP_PATTERN.test(createdAt) ||
    year < 1 ||
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new TypeError(
      "cursor createdAt must be an exact UTC timestamp with six fractional digits",
    );
  }
  if (
    typeof cursor["signalId"] !== "string" ||
    !UUID_PATTERN.test(cursor["signalId"])
  ) {
    throw new TypeError("cursor signalId must be a UUID");
  }
  if (
    typeof cursor["binding"] !== "string" ||
    !SHA256_PATTERN.test(cursor["binding"])
  ) {
    throw new TypeError("cursor binding is invalid");
  }
  return cursor as unknown as SourceSignalAnalystOverviewCursor;
}

/**
 * Canonical, versioned ranking relation. Consumers may embed this fragment as a
 * CTE or derived table and must order/filter its complete result before LIMIT.
 * It returns one row per in-scope source signal with snake_case columns:
 * signal_id, raw_name, raw_domain, created_at, created_at_text,
 * ranking_status, ranking_score, ranking_bucket (ranked=0, unscored=1,
 * excluded=2), ranking_sort_score, readiness, and ranking (JSONB). Canonical
 * priority ordering is bucket ASC, sort score DESC, created_at DESC,
 * signal_id DESC; newest ordering is created_at DESC, signal_id DESC.
 */
export function investorRankingSql(options: InvestorRankingSqlOptions): SQL {
  const expected = options.expectedReviewInputContract;
  if (expected === undefined) {
    throw new TypeError(
      "investorRankingSql requires expectedReviewInputContract (or explicit null)",
    );
  }
  const expectedVersion = expected?.version ?? "";
  const expectedLadder = expected?.policy.ladder ?? "";
  const expectedAnalyst = expected?.policy.analyst ?? "";
  const expectedJevModel = expected?.policy.jevModel ?? "";
  const expectedMuseModel = expected?.policy.museModel ?? "";
  const expectedEvaluatorPrompt = expected?.policy.evaluatorPrompt ?? "";
  const sourceSignalIds = normalizeSourceSignalIds(options.sourceSignalIds);
  const sourceScope =
    sourceSignalIds === null
      ? sql`TRUE`
      : sourceSignalIds.length === 0
        ? sql`FALSE`
        : sql`s.id IN (${sql.join(
            sourceSignalIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;

  if (expected === null) {
    return sql`
      SELECT
        s.id AS signal_id,
        s.raw_name,
        s.raw_domain,
        s.created_at,
        to_char(
          s.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS created_at_text,
        'unscored' AS ranking_status,
        NULL::integer AS ranking_score,
        1 AS ranking_bucket,
        -1 AS ranking_sort_score,
        'unscored' AS readiness,
        ${UNSCORED_INVESTOR_RANKING_JSON}::jsonb AS ranking
      FROM source_signals s
      WHERE ${sourceScope}
    `;
  }

  return sql`
    -- PostgreSQL otherwise inlines these singly referenced CTEs, re-evaluating
    -- the complete current-proof predicate and final-review EXISTS checks in
    -- downstream score and JSON projections. Materialization preserves one
    -- complete proof evaluation per source signal for those projections.
    WITH proof AS MATERIALIZED (
      SELECT
        s.id AS signal_id,
        s.raw_name,
        s.raw_domain,
        s.created_at,
        st.phase AS review_phase,
        st.input_hash AS review_input_hash,
        st.input_manifest AS review_input_manifest,
        jev.id AS jev_id,
        jev.parsed AS jev_parsed,
        jev.decision AS jev_decision,
        jev.updated_at AS jev_updated_at,
        result.input_hash AS result_input_hash,
        result.jev_evaluation_id AS result_jev_evaluation_id,
        result.muse_evaluation_id AS result_muse_evaluation_id,
        result.model_a_id AS result_jev_model,
        result.model_b_id AS result_muse_model,
        result.prompt_version AS result_prompt_version,
        result.final_decision,
        result.updated_at AS result_updated_at,
        muse.id AS muse_id,
        muse.model_id AS muse_model_id,
        muse.signal_id AS muse_signal_id,
        muse.input_hash AS muse_input_hash,
        muse.input_manifest AS muse_input_manifest,
        muse.parsed AS muse_parsed,
        muse.decision AS muse_decision,
        muse.error AS muse_error,
        muse.updated_at AS muse_updated_at,
        analyst.id AS analyst_case_id,
        analyst.input_hash AS analyst_input_hash,
        analyst.status AS analyst_status,
        analyst.memo AS analyst_memo,
        analyst.completed_at AS analyst_completed_at,
        COALESCE((
          st.signal_id IS NOT NULL
          AND st.source_revision = s.review_revision
          AND st.phase IN ('muse', 'settled')
          AND st.input_hash IS NOT NULL
          AND st.input_manifest->'sourceRevision' = to_jsonb(s.review_revision)
          AND st.input_manifest->>'version' = ${expectedVersion}
          AND st.input_manifest->'policy'->>'ladder' = ${expectedLadder}
          AND st.input_manifest->'policy'->>'analyst' = ${expectedAnalyst}
          AND st.input_manifest->'policy'->>'jevModel' = ${expectedJevModel}
          AND st.input_manifest->'policy'->>'museModel' = ${expectedMuseModel}
          AND st.input_manifest->'policy'->>'evaluatorPrompt' = ${expectedEvaluatorPrompt}
          AND jev.id = st.jev_evaluation_id
          AND jev.signal_id = s.id
          AND jev.input_hash = st.input_hash
          AND jev.input_manifest = st.input_manifest
          AND jev.model_id = ${expectedJevModel}
          AND jev.error IS NULL
          AND jsonb_typeof(jev.parsed) = 'object'
          AND jev.parsed->>'version' = 'jev-triage-v1'
          AND jev.decision IN ('reject', 'research', 'high_priority')
          AND jev.parsed->>'decision' = jev.decision
          AND (
            jev.parsed->'confidence' = 'null'::jsonb
            OR CASE
              WHEN jsonb_typeof(jev.parsed->'confidence') = 'number' THEN
                (jev.parsed->>'confidence')::numeric BETWEEN
                  -1.7976931348623157e308::numeric
                  AND 1.7976931348623157e308::numeric
              ELSE FALSE
            END
          )
          AND jev.parsed->>'productFit' IN (
            'supported_product',
            'plausible_supplier',
            'process_or_service',
            'unknown',
            'outside_scope'
          )
          AND jev.parsed->>'acquisitionReadiness' IN (
            'ready',
            'needs_research',
            'blocked'
          )
          AND jev.parsed->'researchPriority' IN (
            '1'::jsonb,
            '2'::jsonb,
            '3'::jsonb
          )
          AND jsonb_typeof(jev.parsed->'reasonCodes') = 'array'
          AND NOT jsonb_path_exists(
            jev.parsed->'reasonCodes',
            '$[*] ? (@.type() != "string")'
          )
          AND jsonb_typeof(jev.parsed->'explanation') = 'string'
          AND jsonb_typeof(jev.parsed->'observations') = 'array'
          AND jsonb_typeof(jev.parsed->'gaps') = 'array'
        ), FALSE) AS triage_current
      FROM source_signals s
      LEFT JOIN signal_review_state st ON st.signal_id = s.id
      LEFT JOIN faa_ensemble_evaluations jev ON jev.id = st.jev_evaluation_id
      LEFT JOIN faa_ensemble_results result ON result.signal_id = s.id
      LEFT JOIN faa_ensemble_evaluations muse
        ON muse.id = result.muse_evaluation_id
      LEFT JOIN LATERAL (
        SELECT candidate.*
        FROM signal_analyst_cases candidate
        WHERE candidate.signal_id = s.id
          AND candidate.source_revision = s.review_revision
          AND candidate.policy_version = ${expectedAnalyst}
          AND candidate.status <> 'superseded'
        ORDER BY candidate.updated_at DESC, candidate.id DESC
        LIMIT 1
      ) analyst ON TRUE
      WHERE ${sourceScope}
    ), facts AS MATERIALIZED (
      SELECT
        proof.signal_id,
        proof.raw_name,
        proof.raw_domain,
        proof.created_at,
        proof.jev_updated_at,
        proof.result_updated_at,
        proof.muse_updated_at,
        proof.triage_current,
        proof.jev_parsed,
        proof.review_input_manifest->'evidence' AS evidence,
        (
          proof.triage_current
          AND
          proof.review_input_manifest->'evidence'->'sourcedSupport'->>'product'
            = 'true'
          AND jsonb_path_exists(
            proof.review_input_manifest->'evidence',
            '$.namedProductProofs[*]'
          )
          AND proof.jev_parsed->>'productFit' = 'supported_product'
        ) AS supported_product,
        (
          proof.triage_current
          AND proof.jev_parsed->>'productFit' = 'plausible_supplier'
        ) AS plausible_supplier,
        (
          proof.triage_current
          AND
          proof.review_input_manifest->'evidence'->>'identityStatus' = 'verified'
          AND proof.review_input_manifest->'evidence'->'sourcedSupport'->>'identity'
            = 'true'
        ) AS verified_identity,
        (
          proof.triage_current
          AND
          proof.review_input_manifest->'evidence'->'headquarters'->>'status'
            = 'supported'
          AND proof.review_input_manifest->'evidence'->'sourcedSupport'->>'headquarters'
            = 'true'
          AND upper(btrim(
            proof.review_input_manifest->'evidence'->'headquarters'->>'country'
          )) IN ('US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA')
        ) AS us_headquarters,
        (
          proof.triage_current
          AND
          proof.review_input_manifest->'evidence'->>'ownershipStatus' = 'independent'
          AND proof.review_input_manifest->'evidence'->'sourcedSupport'->>'ownership'
            = 'true'
        ) AS independent_ownership,
        (
          proof.triage_current
          AND
          proof.review_input_manifest->'evidence'->>'revenueAssessment' = 'under_50m'
          AND proof.review_input_manifest->'evidence'->'sourcedSupport'->>'size'
            = 'true'
        ) AS under_50m_revenue,
        (
          proof.triage_current
          AND
          proof.review_input_manifest->'evidence'->>'ownershipStatus'
            IN ('acquired', 'pe_owned', 'public_parent', 'dead')
          AND proof.review_input_manifest->'evidence'->'sourcedSupport'->>'ownership'
            = 'true'
        ) AS ownership_blocker,
        (
          proof.triage_current
          AND
          proof.review_input_manifest->'evidence'->'headquarters'->>'status'
            = 'supported'
          AND proof.review_input_manifest->'evidence'->'sourcedSupport'->>'headquarters'
            = 'true'
          AND proof.review_input_manifest->'evidence'->'headquarters'->>'country'
            IS NOT NULL
          AND upper(btrim(
            proof.review_input_manifest->'evidence'->'headquarters'->>'country'
          )) NOT IN ('US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA')
        ) AS headquarters_blocker,
        (
          proof.triage_current
          AND
          proof.review_input_manifest->'evidence'->>'revenueAssessment' = 'over_50m'
          AND proof.review_input_manifest->'evidence'->'sourcedSupport'->>'size'
            = 'true'
        ) AS revenue_blocker,
        (
          proof.triage_current
          AND proof.review_phase = 'settled'
          AND proof.result_input_hash = proof.review_input_hash
          AND proof.result_jev_evaluation_id = proof.jev_id
          AND proof.result_muse_evaluation_id = proof.muse_id
          AND proof.result_jev_model = ${expectedJevModel}
          AND proof.result_muse_model = ${expectedMuseModel}
          AND proof.result_prompt_version = ${expectedEvaluatorPrompt}
          AND proof.final_decision = 'high_priority'
          AND proof.jev_decision = 'high_priority'
          AND proof.muse_id IS NOT NULL
          AND proof.muse_signal_id = proof.signal_id
          AND proof.muse_model_id = ${expectedMuseModel}
          AND proof.muse_input_hash = proof.review_input_hash
          AND proof.muse_input_manifest = proof.review_input_manifest
          AND proof.muse_error IS NULL
          AND proof.muse_parsed IS NOT NULL
          AND proof.muse_parsed->>'decision' = proof.muse_decision
          AND proof.muse_decision = 'high_priority'
          AND proof.analyst_case_id IS NOT NULL
          AND proof.analyst_input_hash = proof.review_input_hash
          AND proof.analyst_status = 'completed'
          AND jsonb_typeof(proof.analyst_memo) = 'object'
          AND proof.analyst_memo->>'version' = 'signal-analyst-memo-v1'
          AND proof.analyst_memo->>'inputHash' = proof.review_input_hash
          AND jsonb_typeof(proof.analyst_memo->'createdAt') = 'string'
          AND jsonb_typeof(proof.analyst_memo->'summary') = 'object'
          AND proof.analyst_memo->'summary'->>'label' = 'model_analysis'
          AND jsonb_typeof(proof.analyst_memo->'summary'->'text') = 'string'
          AND jsonb_typeof(proof.analyst_memo->'answers') = 'array'
          AND jsonb_typeof(proof.analyst_memo->'nextActions') = 'array'
          AND proof.analyst_completed_at IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM signal_analyst_steps final_step
            JOIN faa_review_model_usage final_usage
              ON final_usage.id = final_step.model_usage_receipt_id
            WHERE final_step.case_id = proof.analyst_case_id
              AND final_step.kind = 'final_verifier'
              AND (
                final_step.status = 'completed'
                OR (
                  final_step.status = 'late_result'
                  AND final_step.observed_status = 'completed'
                )
              )
              AND final_step.claim_input_hash = proof.review_input_hash
              AND final_step.request->>'inputHash' = proof.review_input_hash
              AND final_step.response->>'kind' = 'final'
              AND final_step.response->'verification' = proof.muse_parsed
              AND final_usage.source_signal_id = proof.signal_id
              AND final_usage.configured_model = ${expectedMuseModel}
              AND final_usage.phase = 'muse'
              AND final_usage.input_hash = proof.review_input_hash
              AND final_usage.prompt_version =
                final_step.request->>'promptVersion'
          )
        ) AS aligned_final_review
      FROM proof
    ), scored AS MATERIALIZED (
      SELECT
        facts.*,
        CASE
          WHEN NOT facts.triage_current THEN 'unscored'
          WHEN facts.ownership_blocker
            OR facts.headquarters_blocker
            OR facts.revenue_blocker THEN 'excluded'
          ELSE 'ranked'
        END AS ranking_status,
        CASE
          WHEN NOT facts.triage_current THEN NULL
          WHEN facts.ownership_blocker
            OR facts.headquarters_blocker
            OR facts.revenue_blocker THEN 0
          ELSE
            CASE
              WHEN facts.supported_product THEN 50
              WHEN facts.plausible_supplier THEN 15
              ELSE 0
            END
            + CASE WHEN facts.verified_identity THEN 10 ELSE 0 END
            + CASE WHEN facts.us_headquarters THEN 10 ELSE 0 END
            + CASE WHEN facts.independent_ownership THEN 10 ELSE 0 END
            + CASE WHEN facts.under_50m_revenue THEN 10 ELSE 0 END
            + CASE WHEN facts.aligned_final_review THEN 10 ELSE 0 END
        END AS ranking_score,
        CASE
          WHEN NOT facts.triage_current THEN 'unscored'
          WHEN facts.ownership_blocker
            OR facts.headquarters_blocker
            OR facts.revenue_blocker THEN 'blocked'
          WHEN facts.jev_parsed->>'acquisitionReadiness' = 'ready' THEN 'ready'
          ELSE 'needs_research'
        END AS readiness,
        CASE
          WHEN facts.triage_current THEN to_char(
            GREATEST(
              facts.jev_updated_at,
              facts.result_updated_at,
              facts.muse_updated_at
            ) AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
          ELSE NULL
        END AS ranking_updated_at
      FROM facts
    )
    SELECT
      scored.signal_id,
      scored.raw_name,
      scored.raw_domain,
      scored.created_at,
      to_char(
        scored.created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS created_at_text,
      scored.ranking_status,
      scored.ranking_score,
      CASE scored.ranking_status
        WHEN 'ranked' THEN 0
        WHEN 'unscored' THEN 1
        ELSE 2
      END AS ranking_bucket,
      COALESCE(scored.ranking_score, -1) AS ranking_sort_score,
      scored.readiness,
      jsonb_build_object(
        'policyVersion', ${INVESTOR_RANKING_POLICY_VERSION}::text,
        'score', scored.ranking_score,
        'status', scored.ranking_status,
        'breakdown', jsonb_build_array(
          jsonb_build_object(
            'key', 'product_fit',
            'label', 'Own named-product fit',
            'points', CASE
              WHEN scored.supported_product THEN 50
              WHEN scored.plausible_supplier THEN 15
              ELSE 0
            END,
            'maxPoints', 50,
            'basis', CASE
              WHEN scored.supported_product THEN 'source'
              WHEN scored.plausible_supplier THEN 'hypothesis'
              ELSE 'unresolved'
            END,
            'reason', CASE
              WHEN scored.supported_product
                THEN 'Current admitted source evidence proves named products.'
              WHEN scored.plausible_supplier
                THEN 'Current Jev review identifies a provisional plausible-supplier hypothesis.'
              ELSE 'No current named-product proof or plausible-supplier hypothesis.'
            END
          ),
          jsonb_build_object(
            'key', 'identity',
            'label', 'Verified target identity',
            'points', CASE WHEN scored.verified_identity THEN 10 ELSE 0 END,
            'maxPoints', 10,
            'basis', CASE WHEN scored.verified_identity THEN 'source' ELSE 'unresolved' END,
            'reason', CASE
              WHEN scored.verified_identity
                THEN 'Current admitted source evidence verifies target identity.'
              ELSE 'Target identity is not verified by current admitted source evidence.'
            END
          ),
          jsonb_build_object(
            'key', 'headquarters',
            'label', 'US headquarters',
            'points', CASE WHEN scored.us_headquarters THEN 10 ELSE 0 END,
            'maxPoints', 10,
            'basis', CASE WHEN scored.us_headquarters THEN 'source' ELSE 'unresolved' END,
            'reason', CASE
              WHEN scored.us_headquarters
                THEN 'Current admitted source evidence supports US headquarters.'
              ELSE 'US headquarters is not supported by current admitted source evidence.'
            END
          ),
          jsonb_build_object(
            'key', 'ownership',
            'label', 'Independent ownership',
            'points', CASE WHEN scored.independent_ownership THEN 10 ELSE 0 END,
            'maxPoints', 10,
            'basis', CASE WHEN scored.independent_ownership THEN 'source' ELSE 'unresolved' END,
            'reason', CASE
              WHEN scored.independent_ownership
                THEN 'Current admitted source evidence supports independent ownership.'
              ELSE 'Independent ownership is not supported by current admitted source evidence.'
            END
          ),
          jsonb_build_object(
            'key', 'revenue',
            'label', 'Annual revenue under $50m',
            'points', CASE WHEN scored.under_50m_revenue THEN 10 ELSE 0 END,
            'maxPoints', 10,
            'basis', CASE WHEN scored.under_50m_revenue THEN 'source' ELSE 'unresolved' END,
            'reason', CASE
              WHEN scored.under_50m_revenue
                THEN 'Current admitted annual-revenue evidence supports revenue under $50m.'
              ELSE 'Current admitted annual-revenue evidence does not establish revenue under $50m.'
            END
          ),
          jsonb_build_object(
            'key', 'final_review',
            'label', 'Aligned final Jev/Muse review',
            'points', CASE WHEN scored.aligned_final_review THEN 10 ELSE 0 END,
            'maxPoints', 10,
            'basis', CASE
              WHEN scored.aligned_final_review THEN 'verified_review'
              ELSE 'unresolved'
            END,
            'reason', CASE
              WHEN scored.aligned_final_review
                THEN 'Current linked Jev and completed Muse final both verify high priority.'
              ELSE 'No current linked, error-free, completed high-priority Muse final is available.'
            END
          )
        ),
        'blockers', (
          SELECT COALESCE(jsonb_agg(blocker ORDER BY blocker_order), '[]'::jsonb)
          FROM (
            SELECT
              1 AS blocker_order,
              'Current source evidence shows excluded ownership: '
                || (scored.evidence->>'ownershipStatus') || '.' AS blocker
            WHERE scored.ownership_blocker
            UNION ALL
            SELECT
              2,
              'Current source evidence shows headquarters outside the US: '
                || (scored.evidence->'headquarters'->>'country') || '.'
            WHERE scored.headquarters_blocker
            UNION ALL
            SELECT
              3,
              'Current source evidence shows annual revenue over $50m.'
            WHERE scored.revenue_blocker
          ) blockers
        ),
        'updatedAt', scored.ranking_updated_at
      ) AS ranking
    FROM scored
  `;
}
