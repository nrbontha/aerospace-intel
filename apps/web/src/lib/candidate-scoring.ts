import { createHash } from "node:crypto";

import {
  DEFAULT_ACTIONABILITY_PROGRAM,
  DEFAULT_FIT_PROGRAM,
  FEATURE_SCHEMA_VERSION,
  computeConfidence,
  computeNovelty,
  evaluateProgram,
  extractFeatureVector,
  getChampionProgramOrFallback,
  partnerReviewPriority,
  researchPriority,
  routeCandidate,
  type FeatureVector,
  type ProgramEvaluation,
  type ResolvedChampionProgram,
} from "@asi/research/scoring-axial";

import {
  activeSnapshotMatchVerdicts,
  appendScoreRows,
  buildFeatureRecordInput,
  ensureFeatureSnapshot,
  getCandidateById,
  latestAxisScores,
  latestFeatureSnapshotForCompany,
  loadCanonicalCompanyState,
  toCandidateDto,
  upsertCandidate,
  type CandidateUpsertValues,
} from "@asi/database";

import type { Database } from "@asi/database";

import {
  resolveEffectiveTier,
  type CandidateDto,
  type CandidateStatusValue,
  type EffectiveTier,
  type TierOverride,
} from "@asi/contracts";

/**
 * Orchestration glue between the canonical catalog and the axial scoring
 * engine. Loads a company's canonical state, builds the frozen-v1 feature
 * vector, runs the champion programs plus the novelty/confidence axes, and
 * persists everything with provenance via the @asi/database storage layer.
 */


function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`);
  return `{${entries.join(",")}}`;
}

/** Content address of a feature vector — stable across key order. */
export function sha256OfFeatures(features: FeatureVector): string {
  return createHash("sha256").update(stableStringify(features)).digest("hex");
}

/**
 * Queue → candidate status mapping:
 *   research → queued_research · partner → partner_review · watchlist → watchlist
 */
export function routingQueueToStatus(
  queue: "research" | "partner" | "watchlist",
): "queued_research" | "partner_review" | "watchlist" {
  switch (queue) {
    case "partner":
      return "partner_review";
    case "watchlist":
      return "watchlist";
    default:
      return "queued_research";
  }
}

/**
 * Effective tier under the Targets-tab precedence (REDESIGN_PLAN §2.1):
 * a human tier_override always wins; otherwise the tier is derived from the
 * engine routing status. The engine mapping itself lives in @asi/contracts
 * (engineStatusToTier) so the SQL ?tier= filter and DTO shaping stay in
 * lockstep with this function.
 */
export function resolveTier(
  candidate: {
    readonly status: CandidateStatusValue;
    readonly tierOverride: TierOverride | null;
  },
  routedStatus?: CandidateStatusValue,
): EffectiveTier {
  return resolveEffectiveTier(routedStatus ?? candidate.status, candidate.tierOverride);
}

// ---------------------------------------------------------------------------
// Rationale derivation
// ---------------------------------------------------------------------------

interface RationaleInput {
  fv: FeatureVector;
  fitEvaluation: ProgramEvaluation;
  actionabilityEvaluation: ProgramEvaluation;
  evidenceCounts: {
    conflictCount: number;
    freshestObservationDaysOld: number | null;
  };
}

function deriveRationale(input: RationaleInput): CandidateUpsertValues["rationale"] {
  const whyInteresting: string[] = [];
  const risks: string[] = [];
  const unknowns: string[] = [];

  if (
    input.fv.ownership.ownershipType === "independent_founder" ||
    input.fv.ownership.ownershipType === "independent_family"
  ) {
    whyInteresting.push("Independent ownership");
  }
  if (input.fv.qualifications.as9100 === "present") {
    whyInteresting.push("AS9100 certification on file");
  }
  if (input.fv.qualifications.nadcap === "present") {
    whyInteresting.push("Nadcap accreditation on file");
  }
  if (input.fv.platforms.length > 0) {
    whyInteresting.push(`Linked to ${input.fv.platforms.length} platform(s)`);
  }
  if (input.fv.businessModel.proprietaryProductEvidence === "patented") {
    whyInteresting.push("Patented proprietary products");
  }

  if (input.fitEvaluation.veto !== undefined) {
    risks.push(`Fit veto: ${input.fitEvaluation.veto.reason}`);
  }
  if (
    input.actionabilityEvaluation.veto !== undefined &&
    input.actionabilityEvaluation.veto.rule !== "required_feature_missing"
  ) {
    risks.push(`Actionability cap: ${input.actionabilityEvaluation.veto.reason}`);
  }
  if (input.evidenceCounts.conflictCount > 0) {
    risks.push(`${input.evidenceCounts.conflictCount} conflicting observation(s)`);
  }
  if (
    input.evidenceCounts.freshestObservationDaysOld !== null &&
    input.evidenceCounts.freshestObservationDaysOld > 730
  ) {
    risks.push("Freshest observation is over two years old");
  }

  if (input.fv.size.revenueBand === "unknown") unknowns.push("Revenue band unverified");
  if (input.fv.size.employeesBand === "unknown") unknowns.push("Employee count unverified");
  if (input.fv.ownership.ownershipType === "unknown") unknowns.push("Ownership unresolved");
  if (input.fv.businessModel.distributesProducts === "unknown") {
    unknowns.push("Distribution vs manufacturing mix unclear");
  }
  if (input.fv.aftermarket === "unknown") unknowns.push("Aftermarket presence unknown");
  const unknownQuals = Object.entries(input.fv.qualifications)
    .filter(([, status]) => status === "unknown")
    .map(([name]) => name);
  if (unknownQuals.length > 0) {
    unknowns.push(`Qualifications unverified: ${unknownQuals.join(", ")}`);
  }

  return {
    whyInteresting: whyInteresting.slice(0, 6),
    risks: risks.slice(0, 6),
    unknowns: unknowns.slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Priority + scoring pipeline
// ---------------------------------------------------------------------------

/** Fraction of scoring-relevant facts that are explicitly unknown. */
export function unknownFraction(fv: FeatureVector): number {
  const slots: Array<boolean | string | null> = [
    fv.size.revenueBand,
    fv.size.employeesBand,
    fv.ownership.ownershipType,
    fv.businessModel.distributesProducts,
    fv.businessModel.pureService,
    fv.businessModel.buildToPrintShare,
    fv.aftermarket,
    ...Object.values(fv.qualifications),
    fv.evidence.freshestObservationDaysOld === null ? "unknown" : true,
  ];
  const unknownCount = slots.filter((slot) => slot === "unknown").length;
  return unknownCount / slots.length;
}

/**
 * Axis values are persisted as numeric(5,2); rounding at computation time
 * keeps the denormalized jsonb, the score rows, and the idempotency
 * comparison on identical values.
 */
function roundToScorePrecision(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

/** All four axes plus priorities and routing for one company's canonical state. */
export interface ComputedAxes {
  featureVector: FeatureVector;
  fitEvaluation: ProgramEvaluation;
  actionabilityEvaluation: ProgramEvaluation;
  noveltyStatus: ReturnType<typeof computeNovelty>["status"];
  noveltyScore: number | null;
  confidenceScore: number;
  rationale: CandidateUpsertValues["rationale"];
  currentScores: {
    fit: number | null;
    novelty: number | null;
    confidence: number;
    actionability: number | null;
  };
  researchPriority: number | null;
  partnerReviewPriority: number | null;
  routedStatus: CandidateUpsertValues["routedStatus"];
  contentSha256: string;
  /** scoring_programs.id backing each axis; null = shipped default fallback. */
  fitScoringProgramId: string | null;
  actionabilityScoringProgramId: string | null;
}

/**
 * Pure computation over canonical state — no writes; deterministic for
 * identical inputs.
 */
export function computeCandidateAxes(
  state: Awaited<ReturnType<typeof loadCanonicalCompanyState>>,
  verdictStatuses: Array<"exact" | "probable" | "possible" | "none">,
  /**
   * Champion programs resolved from scoring_programs. Defaults to the
   * shipped defaults — production callers MUST resolve via
   * getChampionProgramOrFallback so Lab promotions take effect.
   */
  champions?: {
    readonly fit: ResolvedChampionProgram;
    readonly actionability: ResolvedChampionProgram;
  },
): ComputedAxes {
  const featureVector = extractFeatureVector(buildFeatureRecordInput(state));
  const contentSha256 = sha256OfFeatures(featureVector);

  const fitEvaluation = evaluateProgram(
    champions?.fit.program ?? DEFAULT_FIT_PROGRAM,
    featureVector,
  );
  const actionabilityEvaluation = evaluateProgram(
    champions?.actionability.program ?? DEFAULT_ACTIONABILITY_PROGRAM,
    featureVector,
  );

  const novelty = computeNovelty(featureVector, { matchStatusesBySnapshot: verdictStatuses });
  const confidence = computeConfidence({
    sourceCount: state.evidenceCounts.sourceCount,
    primarySourceCount: state.evidenceCounts.primarySourceCount,
    conflictCount: state.evidenceCounts.conflictCount,
    freshestObservationDaysOld: state.evidenceCounts.freshestObservationDaysOld,
    identityResolved: featureVector.evidence.identityResolved,
  });

  // Research priority: information gain is the share of unknown features;
  // cost grows with observation staleness (fully stale when recency unknown).
  const expectedFit = (fitEvaluation.score ?? 0) / 100;
  const uncertainty = 1 - confidence / 100;
  const cost =
    state.evidenceCounts.freshestObservationDaysOld === null
      ? 1
      : Math.min(1, state.evidenceCounts.freshestObservationDaysOld / 730);
  const rp = researchPriority({
    expectedFit,
    expectedNovelty: (novelty.score ?? 0) / 100,
    uncertainty,
    informationGain: unknownFraction(featureVector),
    sourceDiversity: Math.min(1, state.evidenceCounts.sourceCount / 3),
    cost,
  });

  const prp = partnerReviewPriority({
    fit: (fitEvaluation.score ?? 0) / 100,
    novelty: (novelty.score ?? 0) / 100,
    actionability: (actionabilityEvaluation.score ?? 0) / 100,
    confidence: confidence / 100,
    archetypeDiversity: Math.min(1, featureVector.platforms.length / 4),
  });

  const decision = routeCandidate({
    fit: fitEvaluation.score,
    noveltyStatus: novelty.status,
    confidence,
    actionability: actionabilityEvaluation.score,
  });

  return {
    featureVector,
    fitEvaluation,
    actionabilityEvaluation,
    noveltyStatus: novelty.status,
    noveltyScore: novelty.score,
    confidenceScore: confidence,
    rationale: deriveRationale({
      fv: featureVector,
      fitEvaluation,
      actionabilityEvaluation,
      evidenceCounts: state.evidenceCounts,
    }),
    currentScores: {
      fit: roundToScorePrecision(fitEvaluation.score),
      novelty: roundToScorePrecision(novelty.score),
      confidence,
      actionability: roundToScorePrecision(actionabilityEvaluation.score),
    },
    researchPriority: rp,
    partnerReviewPriority: prp,
    routedStatus: routingQueueToStatus(decision.queue),
    contentSha256,
    fitScoringProgramId: champions?.fit.scoringProgramId ?? null,
    actionabilityScoringProgramId: champions?.actionability.scoringProgramId ?? null,
  };
}

export interface PromoteResult {
  candidate: CandidateDto;
  /** False when an identical re-promotion skipped appending duplicate rows. */
  appendedScoreRows: boolean;
}

async function promoteByCompanyId(
  db: Database,
  companyId: string,
  options: { forceAppend?: boolean } = {},
): Promise<PromoteResult> {
  const state = await loadCanonicalCompanyState(db, companyId);
  const verdicts = await activeSnapshotMatchVerdicts(db, {
    companyId,
    domain: state.domains[0]?.domain ?? null,
    displayName: state.company.displayName,
  });
  // Resolve the LIVE champions (Lab promotions) with shipped-default fallback.
  const [fitChampion, actionabilityChampion] = await Promise.all([
    getChampionProgramOrFallback(db, "fit"),
    getChampionProgramOrFallback(db, "actionability"),
  ]);
  const axes = computeCandidateAxes(
    state,
    verdicts.map((verdict) => verdict.status),
    { fit: fitChampion, actionability: actionabilityChampion },
  );
  const snapshotIds = verdicts.map((verdict) => verdict.snapshotId);

  const result = await db.transaction(async (tx) => {
    await ensureFeatureSnapshot(tx, {
      companyId,
      schemaVersion: FEATURE_SCHEMA_VERSION,
      contentSha256: axes.contentSha256,
      features: axes.featureVector as unknown as Record<string, unknown>,
    });
    const candidateRow = await upsertCandidate(tx, {
      companyId,
      routedStatus: axes.routedStatus,
      noveltyStatus: axes.noveltyStatus,
      noveltySnapshotIds: snapshotIds,
      rationale: axes.rationale,
      currentScores: axes.currentScores,
      researchPriority: axes.researchPriority,
      partnerReviewPriority: axes.partnerReviewPriority,
    });

    // Idempotency: skip appending score rows when nothing observable changed
    // (same feature bytes AND identical per-axis values). Explicit rescore
    // always appends so history reflects the re-run.
    let appended = true;
    if (options.forceAppend !== true) {
      const [latestScores, latestSnapshot] = await Promise.all([
        latestAxisScores(tx, candidateRow.id),
        latestFeatureSnapshotForCompany(tx, companyId),
      ]);
      const sameFeatures = latestSnapshot?.contentSha256 === axes.contentSha256;
      const sameValues = (
        [
          ["fit", axes.fitScoringProgramId],
          ["novelty", null],
          ["confidence", null],
          ["actionability", axes.actionabilityScoringProgramId],
        ] as const
      ).every(
        ([axis, programId]) =>
          (latestScores[axis]?.value ?? undefined) ===
            (axes.currentScores[axis] ?? undefined) &&
          (latestScores[axis]?.scoringProgramId ?? null) === programId,
      );
      appended = !(sameFeatures && sameValues);
    }
    if (appended) {
      await appendScoreRows(tx, candidateRow.id, [
        {
          axis: "fit",
          value: axes.currentScores.fit,
          // Null when the shipped-default fallback was used (no champion row).
          scoringProgramId: fitChampion.scoringProgramId,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          details: {
            contributions: axes.fitEvaluation.contributions,
            missingHandled: axes.fitEvaluation.missingHandled,
            ...(axes.fitEvaluation.veto === undefined ? {} : { veto: axes.fitEvaluation.veto }),
          },
        },
        {
          axis: "actionability",
          value: axes.currentScores.actionability,
          scoringProgramId: actionabilityChampion.scoringProgramId,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          details: {
            contributions: axes.actionabilityEvaluation.contributions,
            missingHandled: axes.actionabilityEvaluation.missingHandled,
            ...(axes.actionabilityEvaluation.veto === undefined
              ? {}
              : { veto: axes.actionabilityEvaluation.veto }),
          },
        },
        {
          axis: "novelty",
          value: axes.noveltyScore,
          scoringProgramId: null,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          details: {
            status: axes.noveltyStatus,
            matchVerdicts: verdicts,
          },
        },
        {
          axis: "confidence",
          value: axes.confidenceScore,
          scoringProgramId: null,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          details: { inputs: state.evidenceCounts },
        },
      ]);
    }
    return { candidateRow, appended };
  });

  return { candidate: toCandidateDto(result.candidateRow), appendedScoreRows: result.appended };
}

/** Promote a resolved company to a scored, routed candidate (idempotent). */
export async function promoteCompany(db: Database, companyId: string): Promise<PromoteResult> {
  return promoteByCompanyId(db, companyId);
}

/** Re-run the promotion path appending new score rows (history preserved). */
export async function rescoreCandidate(
  db: Database,
  candidateId: string,
): Promise<PromoteResult> {
  const candidate = await getCandidateById(db, candidateId);
  if (candidate === null) throw new Error(`candidate ${candidateId} not found`);
  return promoteByCompanyId(db, candidate.companyId, { forceAppend: true });
}
