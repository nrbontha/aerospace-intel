import { z } from "zod";

import type { NoveltyStatus } from "./axes.js";

/**
 * Research vs partner-review prioritization and queue routing.
 *
 * The four scoring axes (fit / novelty / confidence / actionability) are
 * NEVER collapsed into one number. These priority functions are separate,
 * purpose-built aggregations over named inputs, each with an explicit
 * configurable weight object — the defaults below are decisions, not
 * arithmetic accidents, and each deviation from a naive equal-weight or
 * spec-literal reading is justified inline.
 */

export const PRIORITY_WEIGHT_SUM_TOLERANCE = 0.01;

const unitInterval = z.number().finite().min(0).max(1);

/**
 * researchPriority answers: "is it worth SPENDING RESEARCH EFFORT here?"
 *
 * Default weights (positive weights sum to 1; cost is subtractive):
 *   informationGain   0.35 — the queue exists to buy knowledge cheaply.
 *   uncertainty       0.25 — uncertain fit is precisely what research resolves;
 *                            DEVIATION from naive spec arithmetic which would
 *                            weight expectedFit highest: a high-fit + high-
 *                            certainty company needs no more research.
 *   expectedFit       0.20 — upside matters, but only as a cap on what
 *                            research can unlock.
 *   expectedNovelty   0.10 — novel-and-fitting is the prize, but novelty alone
 *                            is cheap to re-check later.
 *   sourceDiversity   0.10 — independent sources de-risk every other input.
 *   cost (subtract)   0.15 — expensive research must clear a higher bar; kept
 *                            below 0.25 so cost never dominates information
 *                            gain for high-value targets.
 */
export const researchPriorityWeightsSchema = z
  .object({
    expectedFit: unitInterval,
    expectedNovelty: unitInterval,
    uncertainty: unitInterval,
    informationGain: unitInterval,
    sourceDiversity: unitInterval,
  })
  .strict()
  .refine(
    (w) =>
      Math.abs(
        w.expectedFit +
          w.expectedNovelty +
          w.uncertainty +
          w.informationGain +
          w.sourceDiversity -
          1,
      ) <= PRIORITY_WEIGHT_SUM_TOLERANCE,
    { message: "research priority weights must sum to 1 ± 0.01" },
  );

export const researchCostWeightSchema = z.number().finite().min(0).max(1);

export const researchPriorityInputSchema = z.object({
  expectedFit: unitInterval,
  expectedNovelty: unitInterval,
  uncertainty: unitInterval,
  informationGain: unitInterval,
  sourceDiversity: unitInterval,
  cost: unitInterval,
});

export type ResearchPriorityWeights = z.infer<typeof researchPriorityWeightsSchema>;

export const DEFAULT_RESEARCH_PRIORITY_WEIGHTS: ResearchPriorityWeights =
  researchPriorityWeightsSchema.parse({
    expectedFit: 0.2,
    expectedNovelty: 0.1,
    uncertainty: 0.25,
    informationGain: 0.35,
    sourceDiversity: 0.1,
  });
export const DEFAULT_RESEARCH_COST_WEIGHT = 0.15;

export interface ResearchPriorityInput {
  expectedFit: number;
  expectedNovelty: number;
  uncertainty: number;
  informationGain: number;
  sourceDiversity: number;
  cost: number;
}

/** Pure; output in [0,100]. All inputs are normalized to [0,1]. */
export function researchPriority(
  input: ResearchPriorityInput,
  weights: ResearchPriorityWeights = DEFAULT_RESEARCH_PRIORITY_WEIGHTS,
  costWeight: number = DEFAULT_RESEARCH_COST_WEIGHT,
): number {
  const parsed = researchPriorityInputSchema.parse(input);
  const w = researchPriorityWeightsSchema.parse(weights);
  const costW = researchCostWeightSchema.parse(costWeight);
  const raw =
    w.expectedFit * parsed.expectedFit +
    w.expectedNovelty * parsed.expectedNovelty +
    w.uncertainty * parsed.uncertainty +
    w.informationGain * parsed.informationGain +
    w.sourceDiversity * parsed.sourceDiversity -
    costW * parsed.cost;
  return Math.min(100, Math.max(0, Math.round(raw * 100)));
}

/**
 * partnerReviewPriority answers: "how strongly should this claim a human
 * partner-review slot?"
 *
 * Default weights (sum to 1):
 *   actionability      0.40 — a partner conversation needs something we can
 *                             actually act on; DEVIATION: naive spec arithmetic
 *                             would average all five axes equally, which lets
 *                             un-actionable companies buy their way into the
 *                             queue on fit alone.
 *   fit                0.30 — thesis alignment is the second gate.
 *   novelty            0.15 — known companies are already covered elsewhere.
 *   archetypeDiversity 0.10 — portfolio tiebreaker so the review pipeline is
 *                             not all one look-alike archetype.
 *   confidence         0.05 — DEVIATION: confidence contributes positively but
 *                             small, instead of acting as a multiplier gate;
 *                             low-confidence routing is routeCandidate's job
 *                             (it sends them to research, never partner).
 */
export const partnerReviewPriorityWeightsSchema = z
  .object({
    fit: unitInterval,
    novelty: unitInterval,
    actionability: unitInterval,
    confidence: unitInterval,
    archetypeDiversity: unitInterval,
  })
  .strict()
  .refine(
    (w) =>
      Math.abs(
        w.fit +
          w.novelty +
          w.actionability +
          w.confidence +
          w.archetypeDiversity -
          1,
      ) <= PRIORITY_WEIGHT_SUM_TOLERANCE,
    { message: "partner review priority weights must sum to 1 ± 0.01" },
  );

export type PartnerReviewPriorityWeights = z.infer<
  typeof partnerReviewPriorityWeightsSchema
>;

export const DEFAULT_PARTNER_REVIEW_PRIORITY_WEIGHTS: PartnerReviewPriorityWeights =
  partnerReviewPriorityWeightsSchema.parse({
    fit: 0.3,
    novelty: 0.15,
    actionability: 0.4,
    confidence: 0.05,
    archetypeDiversity: 0.1,
  });

export interface PartnerReviewPriorityInput {
  fit: number;
  novelty: number;
  actionability: number;
  confidence: number;
  archetypeDiversity: number;
}

/** Pure; all inputs [0,1]; output [0,100]. Null axes are clamped to 0 upstream. */
export function partnerReviewPriority(
  input: PartnerReviewPriorityInput,
  weights: PartnerReviewPriorityWeights = DEFAULT_PARTNER_REVIEW_PRIORITY_WEIGHTS,
): number {
  const w = partnerReviewPriorityWeightsSchema.parse(weights);
  const parsed = z
    .object({
      fit: unitInterval,
      novelty: unitInterval,
      actionability: unitInterval,
      confidence: unitInterval,
      archetypeDiversity: unitInterval,
    })
    .parse(input);
  const raw =
    w.actionability * parsed.actionability +
    w.fit * parsed.fit +
    w.novelty * parsed.novelty +
    w.confidence * parsed.confidence +
    w.archetypeDiversity * parsed.archetypeDiversity;
  return Math.min(100, Math.max(0, Math.round(raw * 100)));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export const routingThresholdsSchema = z.object({
  /** fit ≥ highFit counts as "high fit". */
  highFit: z.number().min(0).max(100).default(70),
  /** confidence < lowConfidence forces research even at high fit. */
  lowConfidence: z.number().min(0).max(100).default(50),
  /** actionability at or below this ceiling counts as unactionable. */
  unactionableMax: z.number().min(0).max(100).default(25),
});

export type RoutingThresholds = z.infer<typeof routingThresholdsSchema>;

export const DEFAULT_ROUTING_THRESHOLDS: RoutingThresholds =
  routingThresholdsSchema.parse({});

export interface RouteCandidateInput {
  /** Fit axis score, 0..100 or null when vetoed/un-scoreable. */
  fit: number | null;
  noveltyStatus: NoveltyStatus;
  /** Confidence score, 0..100 (never null). */
  confidence: number;
  /** Actionability score 0..100, or null when ownership is unknown etc. */
  actionability: number | null;
}

export interface RoutingDecision {
  queue: "research" | "partner" | "watchlist";
  reasons: string[];
}

/**
 * Queue routing rules, evaluated in order:
 *   1. Un-scoreable fit → research (we cannot route what we cannot score).
 *   2. High fit + unactionable (null or ≤ threshold) → watchlist. A severe-
 *      capped public/PE subsidiary lands here, never partner.
 *   3. High fit + low confidence → research. NEVER partner: enthusiasm without
 *      evidence goes back for more evidence.
 *   4. High fit + confirmed known company → watchlist (already known).
 *   5. High fit otherwise → partner.
 *   6. Everything else → research (below the fit bar, keep gathering).
 */
export function routeCandidate(
  input: RouteCandidateInput,
  thresholds: RoutingThresholds = DEFAULT_ROUTING_THRESHOLDS,
): RoutingDecision {
  if (input.fit === null) {
    return {
      queue: "research",
      reasons: ["fit_unscorable"],
    };
  }

  if (input.fit >= thresholds.highFit) {
    if (
      input.actionability === null ||
      input.actionability <= thresholds.unactionableMax
    ) {
      return {
        queue: "watchlist",
        reasons:
          input.actionability === null
            ? ["high_fit", "actionability_unscoreable"]
            : ["high_fit", `actionability_capped_at_${thresholds.unactionableMax}`],
      };
    }
    if (input.confidence < thresholds.lowConfidence) {
      return {
        queue: "research",
        reasons: ["high_fit", "low_confidence_requires_research"],
      };
    }
    if (input.noveltyStatus === "confirmed_known_company") {
      return {
        queue: "watchlist",
        reasons: ["high_fit", "already_known_company"],
      };
    }
    return { queue: "partner", reasons: ["high_fit_actionable_confident"] };
  }

  return {
    queue: "research",
    reasons: [`fit_below_${thresholds.highFit}_gather_more_evidence`],
  };
}
