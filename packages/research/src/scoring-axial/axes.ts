import type { FeatureVector } from "./features.js";

/**
 * Novelty + confidence axes.
 *
 * Unlike fit/actionability these are NOT weight programs: novelty is a
 * discrete status derived from known-universe matching, and confidence is a
 * calibrated evidence-quality reading. Both are pure functions.
 */

export const NOVELTY_STATUS_VALUES = [
  "not_matched_to_current_known_universe",
  "possible_known_universe_match",
  "confirmed_known_company",
  "unable_to_assess",
] as const;

export type NoveltyStatus = (typeof NOVELTY_STATUS_VALUES)[number];

/** Match statuses mirror packages/contracts snapshotMemberMatchStatusValues. */
export const MATCH_STATUS_VALUES = [
  "exact",
  "probable",
  "possible",
  "none",
  "unresolved",
] as const;

export type MemberMatchStatus = (typeof MATCH_STATUS_VALUES)[number];

export interface NoveltyInput {
  /** One match status per active known-universe snapshot comparison. */
  matchStatusesBySnapshot: MemberMatchStatus[];
}

export interface NoveltyAssessment {
  status: NoveltyStatus;
  /**
   * 0 (certainly already known) .. 100 (certainly novel); null when we
   * cannot assess (no snapshots compared, or every comparison unresolved).
   */
  score: number | null;
}

// Possible-but-unconfirmed matches keep most of the benefit of the doubt:
// they are not proven new, so they must not score like fresh discoveries.
const NOVELTY_SCORE_CONFIRMED = 0;
const NOVELTY_SCORE_POSSIBLE = 25;
const NOVELTY_SCORE_NOT_MATCHED = 100;

/**
 * fv is part of the signature for API stability (future heuristics may weigh
 * identity resolution quality); current semantics depend only on the
 * per-snapshot match statuses.
 */
export function computeNovelty(
  _fv: FeatureVector,
  input: NoveltyInput,
): NoveltyAssessment {
  const statuses = input.matchStatusesBySnapshot;
  if (statuses.length === 0) {
    return { status: "unable_to_assess", score: null };
  }
  if (statuses.includes("exact")) {
    return { status: "confirmed_known_company", score: NOVELTY_SCORE_CONFIRMED };
  }
  if (statuses.includes("probable") || statuses.includes("possible")) {
    return { status: "possible_known_universe_match", score: NOVELTY_SCORE_POSSIBLE };
  }
  if (statuses.every((s) => s === "unresolved")) {
    return { status: "unable_to_assess", score: null };
  }
  return { status: "not_matched_to_current_known_universe", score: NOVELTY_SCORE_NOT_MATCHED };
}

/**
 * Documented confidence bands for computeConfidence output.
 * <25 very_low · 25–49 low · 50–69 moderate · 70–84 high · ≥85 very_high.
 * routeCandidate treats <50 (low and below) as "needs research".
 */
export function confidenceBand(score: number): string {
  if (score < 25) return "very_low";
  if (score < 50) return "low";
  if (score < 70) return "moderate";
  if (score < 85) return "high";
  return "very_high";
}

export interface ConfidenceEvidence {
  sourceCount: number;
  primarySourceCount: number;
  conflictCount: number;
  freshestObservationDaysOld: number | null;
  identityResolved: boolean;
}

const CONF_SOURCE_BASE_MAX = 50;
const CONF_SOURCE_POINTS = 10; // per source, saturating at 5 sources
const CONF_PRIMARY_MAX = 30;
const CONF_PRIMARY_POINTS = 10; // per primary source, saturating at 3
const CONFLICT_PENALTY_MAX = 20;
const CONFLICT_PENALTY_PER = 7;
const FRESH_GRACE_DAYS = 90;
const FRESH_PENALTY_MAX = 15;
const UNRESOLVED_IDENTITY_PENALTY = 20;
const UNKNOWN_RECENCY_PENALTY = 10;

/**
 * Evidence-quality read in [0,100]:
 *   base      = min(50, 10 × sources)
 *   + primary = min(30, 10 × primarySources)
 *   − conflicts  = min(20, 7 × conflicts)
 *   − staleness  = 0 within 90 days, tapering linearly to −15 by ~2 years;
 *                  −10 when recency itself is unknown (null)
 *   − identity   = −20 when the company identity is unresolved
 * Deterministic; no clamping surprises outside [0,100].
 */
export function computeConfidence(evidence: ConfidenceEvidence): number {
  let score =
    Math.min(CONF_SOURCE_BASE_MAX, evidence.sourceCount * CONF_SOURCE_POINTS) +
    Math.min(CONF_PRIMARY_MAX, evidence.primarySourceCount * CONF_PRIMARY_POINTS);

  score -= Math.min(
    CONFLICT_PENALTY_MAX,
    evidence.conflictCount * CONFLICT_PENALTY_PER,
  );

  if (evidence.freshestObservationDaysOld === null) {
    score -= UNKNOWN_RECENCY_PENALTY;
  } else {
    const staleDays = Math.max(0, evidence.freshestObservationDaysOld - FRESH_GRACE_DAYS);
    score -= Math.min(FRESH_PENALTY_MAX, (staleDays / 730) * FRESH_PENALTY_MAX);
  }

  if (!evidence.identityResolved) {
    score -= UNRESOLVED_IDENTITY_PENALTY;
  }

  return Math.min(100, Math.max(0, Math.round(score)));
}
