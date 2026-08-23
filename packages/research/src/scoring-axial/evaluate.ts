import {
  evaluateProgram,
  leakageScan,
  vetoRuleKey,
  type ProgramEvaluation,
  type ScoringProgram,
} from "./dsl.js";
import type { FeatureVector } from "./features.js";

/**
 * Offline evaluation harness: pure, deterministic, LLM-free. Everything here
 * runs in milliseconds over the frozen v1 dataset and is fully reproducible
 * from an integer seed.
 */

export const DATASET_LABEL_VALUES = [
  "strong_positive",
  "positive_with_caveat",
  "borderline",
  "ideal_archetype_but_unactionable",
  "negative_business_model",
] as const;

export type DatasetLabel = (typeof DATASET_LABEL_VALUES)[number];

export interface ExpectedVeto {
  axis: "fit" | "actionability";
  /** Exact rule key, e.g. "businessModel.distributes_products:in". */
  rule: string;
}

export interface EvaluationEntry {
  id: string;
  label: DatasetLabel;
  features: FeatureVector;
  /** Vetoes this entry MUST trigger when the named axis program runs. */
  expectedVetos?: ExpectedVeto[];
}

export interface EvaluationDataset {
  name: string;
  entries: EvaluationEntry[];
  /** Held-out slice, never used for separation/LOOCV on candidates. */
  holdout?: EvaluationEntry[];
}

export interface VetoAuditResult {
  passed: boolean;
  checked: number;
  failures: Array<{
    id: string;
    expectedRule: string;
    actualRule: string | null;
  }>;
}

export function vetoAudit(
  programs: { fit: ScoringProgram; actionability: ScoringProgram },
  dataset: EvaluationDataset,
): VetoAuditResult {
  const all = [...dataset.entries, ...(dataset.holdout ?? [])];
  const failures: VetoAuditResult["failures"] = [];
  let checked = 0;
  for (const entry of all) {
    for (const expected of entry.expectedVetos ?? []) {
      checked += 1;
      const program =
        expected.axis === "fit" ? programs.fit : programs.actionability;
      const result = evaluateProgram(program, entry.features);
      const actual = result.veto?.rule ?? null;
      if (
        actual === null ||
        !(actual === expected.rule || actual.startsWith(expected.rule))
      ) {
        failures.push({
          id: entry.id,
          expectedRule: expected.rule,
          actualRule: actual,
        });
      }
    }
  }
  return { passed: failures.length === 0, checked, failures };
}

export interface SeparationResult {
  separation: number | null;
  strongMean: number | null;
  negativeMean: number | null;
  strongCount: number;
  negativeCount: number;
}

/**
 * Mean fit score of strong_positive labels minus mean of
 * negative_business_model labels — the primary quality metric. A null axis
 * score (hard-vetoed or otherwise un-scoreable) counts as 0: the company
 * cannot be pursued on this axis either way, so it sits at the bottom of the
 * range instead of being silently dropped.
 */
export function strongVsNegativeSeparation(
  program: ScoringProgram,
  dataset: EvaluationDataset,
): SeparationResult {
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const entry of dataset.entries) {
    if (entry.label === "strong_positive") positives.push(entry.id);
    if (entry.label === "negative_business_model") negatives.push(entry.id);
  }
  const scoreOf = new Map<string, ProgramEvaluation>();
  for (const entry of dataset.entries) {
    scoreOf.set(entry.id, evaluateProgram(program, entry.features));
  }
  const scoreOfId = (id: string): number => scoreOf.get(id)?.score ?? 0;
  const posScores = positives.map(scoreOfId);
  const negScores = negatives.map(scoreOfId);
  if (posScores.length === 0 || negScores.length === 0) {
    return {
      separation: null,
      strongMean: null,
      negativeMean: null,
      strongCount: posScores.length,
      negativeCount: negScores.length,
    };
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    separation: mean(posScores) - mean(negScores),
    strongMean: mean(posScores),
    negativeMean: mean(negScores),
    strongCount: posScores.length,
    negativeCount: negScores.length,
  };
}

function rankedIds(program: ScoringProgram, entries: EvaluationEntry[]): string[] {
  return entries
    .map((e) => ({ id: e.id, score: evaluateProgram(program, e.features).score }))
    .filter((r): r is { id: string; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((r) => r.id);
}

export interface LoocvStabilityResult {
  maxDisplacement: number;
  meanDisplacement: number;
  folds: number;
}

/**
 * Rank stability under leave-one-company-out. With no training step, "refit"
 * means re-ranking the remaining companies; a robust program barely moves
 * anyone when one company drops out.
 */
export function loocvStability(
  program: ScoringProgram,
  dataset: EvaluationDataset,
): LoocvStabilityResult {
  const entries = dataset.entries;
  const baselineRanks = new Map(
    rankedIds(program, entries).map((id, idx) => [id, idx]),
  );
  let maxDisplacement = 0;
  let total = 0;
  let folds = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const remaining = entries.filter((_, j) => j !== i);
    const foldRanks = rankedIds(program, remaining);
    folds += 1;
    for (const [id, baseRank] of baselineRanks) {
      if (id === entries[i]?.id) continue;
      const foldIdx = foldRanks.indexOf(id);
      if (foldIdx === -1) continue;
      const displacement = Math.abs(foldIdx - (baseRank as number));
      maxDisplacement = Math.max(maxDisplacement, displacement);
      total += displacement;
    }
  }
  const comparisons = Math.max(1, Math.max(1, folds - 1) * Math.max(0, entries.length - 1));
  return {
    maxDisplacement,
    meanDisplacement: total / comparisons,
    folds,
  };
}

/** Deterministic 32-bit PRNG (mulberry32). Same seed ⇒ identical stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  estimate: number;
  low: number;
  high: number;
  samplesUsed: number;
  seed: number;
}

/**
 * Seeded bootstrap 95% CI over the separation statistic. Resamples the
 * dataset with replacement; samples where either class is empty are skipped.
 * Fully reproducible: same seed + same data ⇒ identical interval.
 */
export function bootstrapCI95(
  program: ScoringProgram,
  dataset: EvaluationDataset,
  options: { seed?: number; samples?: number } = {},
): BootstrapCI {
  const seed = options.seed ?? 42;
  const samples = options.samples ?? 400;
  const rng = mulberry32(seed);
  const point = strongVsNegativeSeparation(program, dataset);
  const stats: number[] = [];
  const labeled = dataset.entries.filter(
    (e) => e.label === "strong_positive" || e.label === "negative_business_model",
  );
  for (let s = 0; s < samples; s += 1) {
    const draw: EvaluationEntry[] = [];
    for (let i = 0; i < labeled.length; i += 1) {
      draw.push(labeled[Math.floor(rng() * labeled.length)] as EvaluationEntry);
    }
    const resample: EvaluationDataset = { name: dataset.name, entries: draw };
    const sep = strongVsNegativeSeparation(program, resample).separation;
    if (sep !== null) stats.push(sep);
  }
  stats.sort((a, b) => a - b);
  const pick = (q: number) =>
    stats.length === 0 ? null : (stats[Math.floor(q * (stats.length - 1))] as number);
  return {
    estimate: point.separation ?? Number.NaN,
    low: pick(0.025) ?? Number.NaN,
    high: pick(0.975) ?? Number.NaN,
    samplesUsed: stats.length,
    seed,
  };
}

/**
 * Structural complexity: components + 2×interactions + vetoes + the program's
 * own complexityPenalty. Interactions double-counted: they couple features
 * and are the hardest thing for a human to reason about later.
 */
export function complexityScore(program: ScoringProgram): number {
  return (
    program.components.length +
    2 * program.interactions.length +
    program.hardVetoes.length +
    program.complexityPenalty
  );
}

/**
 * Reject any program referencing fields outside the FeatureVector allowlist —
 * pipeline state (priority/stage/contact recency) and identity strings are
 * outcomes or bookkeeping, never scoring inputs.
 */
export function scanProgramLeaks(program: ScoringProgram): {
  clean: boolean;
  leaked: string[];
} {
  return leakageScan(program);
}

export type PrimaryMetricKey =
  | "strongVsNegativeSeparation"
  | "separationMinusComplexityPenalty";

export interface ProgramEvaluationSummary {
  name: string;
  program: ScoringProgram;
  strongVsNegativeSeparation: number;
  separationDetail: SeparationResult;
  bootstrap: BootstrapCI;
  loocv: LoocvStabilityResult;
  complexity: number;
  vetoAudit: VetoAuditResult;
  holdoutSeparation: number | null;
  leakedFields: string[];
  rank?: number;
}

export interface EvaluationRun {
  datasetName: string;
  primaryMetric: PrimaryMetricKey;
  results: ProgramEvaluationSummary[];
}

const DEFAULT_BOOTSTRAP_SEED = 20260822;

/**
 * Evaluate a set of programs against one frozen dataset and rank them by the
 * configured primary metric (descending; ties broken by name for
 * determinism).
 */
export function runEvaluation(
  programs: Array<{ name: string; program: ScoringProgram }>,
  dataset: EvaluationDataset,
  options: {
    primaryMetric?: PrimaryMetricKey;
    bootstrapSeed?: number;
    bootstrapSamples?: number;
  } = {},
): EvaluationRun {
  const primaryMetric = options.primaryMetric ?? "strongVsNegativeSeparation";
  const summaries: ProgramEvaluationSummary[] = programs.map(({ name, program }) => {
    const sep = strongVsNegativeSeparation(program, dataset);
    // Only audit veto expectations that target THIS program's axis; the other
    // axis slot is a placeholder so vetoAudit can dispatch.
    const axisRelevant = (entries: EvaluationEntry[]): EvaluationEntry[] =>
      entries.map((e) => ({
        ...e,
        expectedVetos: (e.expectedVetos ?? []).filter(
          (v) => v.axis === program.axis,
        ),
      }));
    const auditDataset: EvaluationDataset = {
      name: dataset.name,
      entries: axisRelevant(dataset.entries),
    };
    if (dataset.holdout) {
      auditDataset.holdout = axisRelevant(dataset.holdout);
    }
    const audit = vetoAudit({ fit: program, actionability: program }, auditDataset);
    let holdoutSep: number | null = null;
    if (dataset.holdout && dataset.holdout.length > 0) {
      holdoutSep =
        strongVsNegativeSeparation(program, {
          name: `${dataset.name}-holdout`,
          entries: dataset.holdout,
        }).separation;
    }
    return {
      name,
      program,
      strongVsNegativeSeparation: sep.separation ?? Number.NaN,
      separationDetail: sep,
      bootstrap: bootstrapCI95(program, dataset, {
        seed: options.bootstrapSeed ?? DEFAULT_BOOTSTRAP_SEED,
        samples: options.bootstrapSamples ?? 400,
      }),
      loocv: loocvStability(program, dataset),
      complexity: complexityScore(program),
      vetoAudit: audit,
      holdoutSeparation: holdoutSep,
      leakedFields: leakageScan(program).leaked,
    };
  });

  summaries.sort((a, b) => {
    const metricOf = (s: ProgramEvaluationSummary) => {
      if (primaryMetric === "separationMinusComplexityPenalty") {
        return s.strongVsNegativeSeparation - s.program.complexityPenalty;
      }
      return s.strongVsNegativeSeparation;
    };
    const diff = metricOf(b) - metricOf(a);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
  summaries.forEach((s, idx) => {
    s.rank = idx + 1;
  });

  return { datasetName: dataset.name, primaryMetric, results: summaries };
}

export { vetoRuleKey };
