
/**
 * Priority held-out diagnostic.
 *
 * The 246-row M&A pipeline workbook carries a human-assigned `Priority`
 * (verbatim "1" | "2" | "3") inside each known-universe member's
 * raw_payload. That field is an OUTCOME of the manual pipeline — it must
 * NEVER be used as a scoring feature or label. This module exists only to
 * measure, after the fact, how well the champion scorer's fit scores agree
 * with that human ordering. It is a correlation report, nothing more.
 */

export interface PriorityDiagnosticEntry {
  readonly companyId: string;
  /** Verbatim workbook Priority ("1" | "2" | "3"), or null when unset. */
  readonly priorityRaw: string | null;
  readonly fitScore: number;
  /** Optional pipeline stage for the per-stage breakdown. */
  readonly stage?: string | null;
}

export interface RankCorrelation {
  /** Companies actually compared — never padded. Report honestly even if tiny. */
  readonly n: number;
  /**
   * Spearman rank correlation in [-1, 1]; null when the comparison is
   * degenerate (fewer than two distinct Priority ranks, or zero variance
   * in the fit scores).
   */
  readonly spearman: number | null;
}

export interface StageRankCorrelation extends RankCorrelation {
  readonly stage: string;
}

export interface PriorityDiagnosticResult extends RankCorrelation {
  readonly note: "diagnostic-only; Priority never used as feature or label";
  /** Present when any entry carries a stage label. */
  readonly stages?: StageRankCorrelation[];
}

/** Map verbatim Priority text to its ordinal value; unparsable → null. */
export function parsePriorityOrdinal(priorityRaw: string | null): number | null {
  if (priorityRaw === null) return null;
  const trimmed = priorityRaw.trim();
  const match = /^([123])$/.exec(trimmed) ?? /^([123])\b/.exec(trimmed);
  return match === null ? null : Number(match[1]);
}

/** Mean of ranks 1..n, ties sharing their average rank. */
function averageRanks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (
      j + 1 < order.length &&
      order[j + 1]!.value === order[i]!.value
    ) {
      j += 1;
    }
    // Ties occupy ranks i+1 .. j+1; every tied item gets the mean.
    const mean = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) {
      ranks[order[k]!.index] = mean;
    }
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation over two equal-length samples; null when degenerate. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n === 0) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation between two sample vectors; null if degenerate. */
export function spearmanRankCorrelation(
  xs: number[],
  ys: number[],
): number | null {
  if (xs.length !== ys.length || xs.length === 0) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

/**
 * Correlate the human Priority ordering against champion fit scores,
 * computed ONLY over companies that have both a parsable non-null Priority
 * and a finite fit score. Priority is read once here as the measured
 * outcome — it is never fed back into scoring.
 */
export function priorityDiagnostic(
  companies: readonly PriorityDiagnosticEntry[],
): PriorityDiagnosticResult {
  const comparable = companies.filter((entry) => {
    return (
      Number.isFinite(entry.fitScore) &&
      parsePriorityOrdinal(entry.priorityRaw) !== null
    );
  });
  const spearman = spearmanRankCorrelation(
    comparable.map((entry) => parsePriorityOrdinal(entry.priorityRaw)!),
    comparable.map((entry) => entry.fitScore),
  );

  const stageNames = [
    ...new Set(
      companies
        .map((entry) => entry.stage ?? null)
        .filter((stage): stage is string => stage !== null),
    ),
  ];
  const stages =
    stageNames.length > 0
      ? stageNames.map((stage) => {
          const slice = comparable.filter((entry) => entry.stage === stage);
          return {
            stage,
            n: slice.length,
            spearman: spearmanRankCorrelation(
              slice.map((entry) => parsePriorityOrdinal(entry.priorityRaw)!),
              slice.map((entry) => entry.fitScore),
            ),
          };
        })
      : undefined;

  return stages === undefined
    ? { n: comparable.length, spearman, note: NOTE }
    : { n: comparable.length, spearman, note: NOTE, stages };
}

const NOTE = "diagnostic-only; Priority never used as feature or label" as const;
