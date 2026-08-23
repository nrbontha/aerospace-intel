import type { ScoringProgram } from "./dsl.js";
import { z } from "zod";

import { leakageScan } from "./dsl.js";
import type { EvaluationRun } from "./evaluate.js";

/**
 * Champion/challenger promotion gate.
 *
 * A challenger is promoted ONLY if it clears every bar:
 *   1. Primary-metric gain beyond epsilon (not noise).
 *   2. Clean veto audit — no expected veto regressed or vanished.
 *   3. No holdout degradation beyond tolerance.
 *   4. Component count ≤ champion + 2, UNLESS the metric gain exceeds
 *      GAIN_FOR_EXTRA_COMPLEXITY (0.05) — complexity must pay rent.
 *   5. Zero leaked fields (pipeline/identity references).
 * Any failed check produces a reason string; the decision is the conjunction.
 */

export const promotionOptionsSchema = z.object({
  /** Minimum primary-metric improvement to count as real. */
  epsilon: z.number().min(0).default(0.02),
  /** Maximum tolerated drop in holdout separation. */
  holdoutTolerance: z.number().min(0).default(0.03),
  /** Extra components allowed over the champion without a big gain. */
  maxComplexityWithoutGain: z.number().int().min(0).default(2),
});

export type PromotionOptions = z.input<typeof promotionOptionsSchema>;

export const GAIN_FOR_EXTRA_COMPLEXITY = 0.05;

export interface PromotionDecision {
  decision: "promote" | "reject";
  reasons: string[];
}

function resultByName(run: EvaluationRun, name: string) {
  return run.results.find((r) => r.name === name);
}

/**
 * champion/challenger are looked up in `results` by their program `name`.
 * Deterministic and total: unknown names reject with an explanatory reason
 * rather than throwing, so a bad run report can never crash a gatekeeper.
 */
export function decidePromotion(
  champion: ScoringProgram,
  challenger: ScoringProgram,
  results: EvaluationRun,
  options: PromotionOptions = {},
): PromotionDecision {
  const opts = promotionOptionsSchema.parse(options);

  // Leakage is a structural defect: reject before anything else runs.
  const leakScan = leakageScan(challenger);
  if (!leakScan.clean) {
    return {
      decision: "reject",
      reasons: [`leaked_fields:${leakScan.leaked.join(",")}`],
    };
  }

  const reasons: string[] = [];

  const champResult = resultByName(results, champion.name ?? "");
  const challResult = resultByName(results, challenger.name ?? "");
  if (!champResult || !challResult) {
    return {
      decision: "reject",
      reasons: [
        `results missing ${!champResult ? `champion "${champion.name ?? ""}"` : ""}${!champResult && !challResult ? " and " : ""}${!challResult ? `challenger "${challenger.name ?? ""}"` : ""}`,
      ],
    };
  }

  const metricGain =
    challResult.strongVsNegativeSeparation -
    champResult.strongVsNegativeSeparation;

  if (!(metricGain > opts.epsilon)) {
    reasons.push(
      `metric_gain_${metricGain.toFixed(4)}_not_beyond_epsilon_${opts.epsilon}`,
    );
  } else {
    reasons.push(`metric_gain_${metricGain.toFixed(4)}_beyond_epsilon`);
  }

  if (challResult.vetoAudit.passed) {
    reasons.push("veto_audit_clean");
  } else {
    reasons.push(
      `veto_audit_failed:${challResult.vetoAudit.failures
        .map((f) => `${f.id}:${f.expectedRule}`)
        .join(";")}`,
    );
  }

  if (
    champResult.holdoutSeparation !== null &&
    challResult.holdoutSeparation !== null &&
    champResult.holdoutSeparation - challResult.holdoutSeparation >
      opts.holdoutTolerance
  ) {
    reasons.push(
      `holdout_degraded_by_${(champResult.holdoutSeparation - challResult.holdoutSeparation).toFixed(4)}_beyond_tolerance_${opts.holdoutTolerance}`,
    );
  } else {
    reasons.push("no_holdout_degradation");
  }

  const componentDelta =
    challenger.components.length - champion.components.length;
  if (
    componentDelta > opts.maxComplexityWithoutGain &&
    metricGain <= GAIN_FOR_EXTRA_COMPLEXITY
  ) {
    reasons.push(
      `component_delta_${componentDelta}_exceeds_${opts.maxComplexityWithoutGain}_without_gain_above_${GAIN_FOR_EXTRA_COMPLEXITY}`,
    );
  } else {
    reasons.push(`complexity_ok(component_delta_${componentDelta})`);
  }

  const approved =
    metricGain > opts.epsilon &&
    challResult.vetoAudit.passed &&
    !(componentDelta > opts.maxComplexityWithoutGain && metricGain <= GAIN_FOR_EXTRA_COMPLEXITY) &&
    !(
      champResult.holdoutSeparation !== null &&
      challResult.holdoutSeparation !== null &&
      champResult.holdoutSeparation - challResult.holdoutSeparation >
        opts.holdoutTolerance
    );

  return { decision: approved ? "promote" : "reject", reasons };
}

