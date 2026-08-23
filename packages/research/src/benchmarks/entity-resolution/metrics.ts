/**
 * Pure metric math for the entity-resolution benchmark.
 *
 * No I/O. Operates on labeled cases plus matcher outcomes so the threshold
 * sweep, false-merge accounting, and alias-capture rate are unit-testable on
 * synthetic inputs.
 */
import type { ErCase, ErOutcome } from "./types.js";

export const THRESHOLDS: readonly number[] = [
  0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9,
];

/** Default operating point = the production probable-match base threshold. */
export const OPERATING_THRESHOLD = 0.72;

export interface ConfusionCounts {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
}

export interface ThresholdPoint extends ConfusionCounts {
  readonly threshold: number;
  /** Precision at this threshold; null when no predictions were made. */
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
}

/** Is a predicted match made at the given decision threshold? */
export function predictsMatchAt(
  outcome: Pick<ErOutcome, "matchStatus" | "confidence">,
  threshold: number,
): boolean {
  if (outcome.matchStatus === "exact") return true;
  if (outcome.matchStatus === "probable") {
    return outcome.confidence !== null && outcome.confidence >= threshold;
  }
  return false;
}

function counts(
  cases: readonly ErCase[],
  outcomes: ReadonlyMap<string, ErOutcome>,
  predict: (o: ErOutcome) => boolean,
): ConfusionCounts {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const c of cases) {
    const outcome = outcomes.get(c.caseId);
    if (outcome === undefined) continue;
    const expected = c.expectedCompanyId !== null;
    const predicted = predict(outcome);
    if (expected && predicted) tp += 1;
    else if (!expected && predicted) fp += 1;
    else if (expected && !predicted) fn += 1;
    else tn += 1;
  }
  return { tp, fp, fn, tn };
}

/**
 * Sweep precision/recall over the decision threshold applied to the
 * production confidence score (exact matches always count as positive).
 */
export function thresholdSweep(
  cases: readonly ErCase[],
  outcomes: ReadonlyMap<string, ErOutcome>,
  thresholds: readonly number[] = THRESHOLDS,
): ThresholdPoint[] {
  return thresholds.map((threshold) => {
    const c = counts(cases, outcomes, (o) => predictsMatchAt(o, threshold));
    const precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : null;
    const recall = c.tp + c.fn > 0 ? c.tp / (c.tp + c.fn) : null;
    const f1 =
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : null;
    return { threshold, ...c, precision, recall, f1 };
  });
}

export interface FalseMergeDetail {
  readonly caseId: string;
  readonly kind: string;
  readonly rawName: string;
  readonly matchedCompanyId: string | null;
  readonly expectedCompanyId: string | null;
  readonly reason: string;
}

export interface FalseMergeReport {
  /**
   * Predictions that attach an expected-positive case to the WRONG company,
   * or any prediction onto a negative case whose matched company differs
   * from another case's expected company — i.e. a real cross-entity link.
   */
  readonly wrongCompanyMerges: number;
  /** Family siblings predicted onto the same target (or any target). */
  readonly familySiblingMerges: number;
  readonly detail: FalseMergeDetail[];
}

/**
 * Count false merges: any predicted link between entities that ground truth
 * says are distinct.
 */
export function countFalseMerges(
  cases: readonly ErCase[],
  outcomes: ReadonlyMap<string, ErOutcome>,
  threshold: number = OPERATING_THRESHOLD,
): FalseMergeReport {
  const detail: FalseMergeReport["detail"] = [];
  let wrongCompanyMerges = 0;

  for (const c of cases) {
    const outcome = outcomes.get(c.caseId);
    if (outcome === undefined || !predictsMatchAt(outcome, threshold)) continue;
    const matched = outcome.matchedCompanyId;
    if (matched === null) continue;
    if (c.expectedCompanyId !== null && matched !== c.expectedCompanyId) {
      wrongCompanyMerges += 1;
      detail.push({
        caseId: c.caseId,
        kind: c.kind,
        rawName: c.rawName,
        matchedCompanyId: matched,
        expectedCompanyId: c.expectedCompanyId,
        reason: "positive attached to the wrong company",
      });
    } else if (
      c.expectedCompanyId === null &&
      (c.kind === "confusable_negative" || c.kind === "lead_replay")
    ) {
      // Negative case linked to SOME real company it must not join.
      // Family siblings are accounted separately below; member_replay
      // negatives matching their own source company would be legitimate and
      // are not tracked here because members carry no expected id by design.
      wrongCompanyMerges += 1;
      detail.push({
        caseId: c.caseId,
        kind: c.kind,
        rawName: c.rawName,
        matchedCompanyId: matched,
        expectedCompanyId: null,
        reason: "negative confusable linked to a real company",
      });
    }
  }

  // Family siblings: distinct sibling cases must never converge onto the
  // same matched company (nor onto any company).
  const familyCases = new Map<string, ErCase[]>();
  for (const c of cases) {
    if (c.family === null) continue;
    const bucket = familyCases.get(c.family) ?? [];
    bucket.push(c);
    familyCases.set(c.family, bucket);
  }

  let familySiblingMerges = 0;
  for (const [family, siblings] of familyCases) {
    const mergedToTarget = new Map<string, string[]>();
    for (const sibling of siblings) {
      const outcome = outcomes.get(sibling.caseId);
      if (outcome === undefined || !predictsMatchAt(outcome, threshold)) continue;
      const matched = outcome.matchedCompanyId;
      if (matched === null) continue;
      const holders = mergedToTarget.get(matched) ?? [];
      holders.push(sibling.caseId);
      mergedToTarget.set(matched, holders);
      familySiblingMerges += 1;
      detail.push({
        caseId: sibling.caseId,
        kind: sibling.kind,
        rawName: sibling.rawName,
        matchedCompanyId: matched,
        expectedCompanyId: null,
        reason: `family ${family} sibling linked to a company`,
      });
    }
    for (const [target, holders] of mergedToTarget) {
      if (holders.length > 1) {
        detail.push({
          caseId: holders.join("+"),
          kind: "family_sibling",
          rawName: family,
          matchedCompanyId: target,
          expectedCompanyId: null,
          reason: `${holders.length} siblings collapsed onto one company`,
        });
      }
    }
  }

  return { wrongCompanyMerges, familySiblingMerges, detail };
}

export interface AliasCaptureReport {
  readonly aliasCases: number;
  readonly captured: number;
  /** Fraction of alias-style cases resolved to the correct company. */
  readonly rate: number | null;
  readonly misses: readonly { caseId: string; rawName: string }[];
}

/** Alias capture rate over alias/former-name/display-name cases. */
export function aliasCapture(
  cases: readonly ErCase[],
  outcomes: ReadonlyMap<string, ErOutcome>,
  threshold: number = OPERATING_THRESHOLD,
): AliasCaptureReport {
  const aliasKinds = new Set(["alias_short_name", "former_name_style"]);
  const misses: { caseId: string; rawName: string }[] = [];
  let total = 0;
  let captured = 0;
  for (const c of cases) {
    if (!aliasKinds.has(c.kind)) continue;
    total += 1;
    const outcome = outcomes.get(c.caseId);
    const hit =
      outcome !== undefined &&
      predictsMatchAt(outcome, threshold) &&
      outcome.matchedCompanyId === c.expectedCompanyId;
    if (hit) captured += 1;
    else misses.push({ caseId: c.caseId, rawName: c.rawName });
  }
  return {
    aliasCases: total,
    captured,
    rate: total > 0 ? captured / total : null,
    misses,
  };
}
