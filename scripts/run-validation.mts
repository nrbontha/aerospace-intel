/**
 * Backtest runner for the acquisition scoring mechanism.
 *
 * Loads the frozen fixtures (investor-verdicts TEST set + ma-priorities DEV
 * set + golden-set.ts entries) and runs CURRENT deterministic logic only:
 * `deriveRound2Verdict`, `mapDiscoveryInvestorAssessment`,
 * `mapEnsembleInvestorAssessment` (via scripts/populate-unified-targets.mts,
 * which re-exports packages/database/src/unified-targets/populate.ts) and
 * `proposeLabels` (packages/database/src/golden/proposal-rules.ts).
 *
 * Ground-truth hierarchy (never violate):
 *   TEST-ONLY = 29 investor verdicts (Booie add/hold/pass_*) — tune NOTHING
 *     against these, report only.
 *   DEV = M&A pipeline Priority 1-3 sample + golden-set labels.
 *   Model-derived verdicts (ensemble HP/rejects) are NEVER ground truth.
 *
 * No live model calls, no DB writes, no secrets logging. Per split this
 * reports accuracy, per-class precision/recall, and a confusion summary,
 * plus HP-equivalent recall on golden strong_positives. Exits non-zero when
 * test-set accuracy drops below --min-accuracy (default 0.5).
 *
 * Usage:
 *   npx tsx scripts/run-validation.mts [--min-accuracy 0.5] [--json out/report.json]
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { writeFile, mkdir } from "node:fs/promises";

import {
  deriveRound2Verdict,
  mapDiscoveryInvestorAssessment,
  mapEnsembleInvestorAssessment,
} from "./populate-unified-targets.mts";
import { proposeLabels } from "../packages/database/src/golden/proposal-rules.js";
import {
  ALL_GOLDEN_ENTRIES_V1,
  GOLDEN_DATASET_V1,
} from "../packages/research/src/scoring-axial/fixtures/golden-set.js";
import { DATASET_LABEL_VALUES } from "../packages/research/src/scoring-axial/evaluate.js";

// ---------------------------------------------------------------------------
// Metric math (pure; unit-tested in tests/validation.test.ts)
// ---------------------------------------------------------------------------

/** One scored row: frozen ground-truth label vs current-logic prediction. */
export interface ScoredOutcome {
  id: string;
  actual: string;
  predicted: string;
}

export interface ClassMetrics {
  /** Rows with this ground-truth label. */
  support: number;
  /** Rows predicted as this class. */
  predicted: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ConfusionMatrix {
  /** Sorted union of observed actual + predicted labels. */
  classes: string[];
  /** Non-zero cells only, sorted by (actual, predicted). */
  cells: Array<{ actual: string; predicted: string; count: number }>;
}

export interface SplitSummary {
  name: string;
  n: number;
  /** Null when n === 0 (no denominator). */
  accuracy: number | null;
  perClass: Record<string, ClassMetrics>;
  confusion: ConfusionMatrix;
}

/** Fraction of exact matches; NaN when there are no outcomes. */
export function computeAccuracy(outcomes: readonly ScoredOutcome[]): number {
  if (outcomes.length === 0) return NaN;
  let correct = 0;
  for (const o of outcomes) {
    if (o.actual === o.predicted) correct++;
  }
  return correct / outcomes.length;
}

function zeroDivision(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Per-class precision/recall over `classes` (zero-division yields 0). */
export function perClassMetrics(
  outcomes: readonly ScoredOutcome[],
  classes: readonly string[],
): Record<string, ClassMetrics> {
  const result: Record<string, ClassMetrics> = {};
  for (const cls of classes) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const o of outcomes) {
      if (o.predicted === cls && o.actual === cls) tp++;
      else if (o.predicted === cls) fp++;
      else if (o.actual === cls) fn++;
    }
    const precision = zeroDivision(tp, tp + fp);
    const recall = zeroDivision(tp, tp + fn);
    result[cls] = {
      support: tp + fn,
      predicted: tp + fp,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1: zeroDivision(2 * precision * recall, precision + recall),
    };
  }
  return result;
}

/** Confusion counts over the sorted union of observed labels. */
export function confusionMatrix(
  outcomes: readonly ScoredOutcome[],
): ConfusionMatrix {
  const classSet = new Set<string>();
  for (const o of outcomes) {
    classSet.add(o.actual);
    classSet.add(o.predicted);
  }
  const classes = [...classSet].sort();
  const counts = new Map<string, number>();
  for (const o of outcomes) {
    const key = `${o.actual}||SEP||${o.predicted}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cells = [...counts.entries()]
    .map(([key, count]) => {
      const [actual, predicted] = key.split("||SEP||");
      return { actual: actual!, predicted: predicted!, count };
    })
    .sort((a, b) =>
      a.actual === b.actual
        ? a.predicted.localeCompare(b.predicted)
        : a.actual.localeCompare(b.actual),
    );
  return { classes, cells };
}

/** Accuracy + per-class metrics + confusion for one named split. */
export function summarizeSplit(
  name: string,
  outcomes: readonly ScoredOutcome[],
  classes: readonly string[],
): SplitSummary {
  const accuracy = computeAccuracy(outcomes);
  return {
    name,
    n: outcomes.length,
    accuracy: Number.isNaN(accuracy) ? null : accuracy,
    perClass: perClassMetrics(outcomes, classes),
    confusion: confusionMatrix(outcomes),
  };
}

/** Threshold gate: passes when test accuracy meets the minimum. */
export function evaluateThreshold(
  testAccuracy: number | null,
  minAccuracy: number,
): { passed: boolean; reason: string } {
  if (testAccuracy === null) {
    return { passed: false, reason: "test split has no rows; cannot gate" };
  }
  if (testAccuracy < minAccuracy) {
    return {
      passed: false,
      reason: `test accuracy ${testAccuracy.toFixed(4)} < min ${minAccuracy}`,
    };
  }
  return {
    passed: true,
    reason: `test accuracy ${testAccuracy.toFixed(4)} >= min ${minAccuracy}`,
  };
}

// ---------------------------------------------------------------------------
// Frozen-fixture loading (dynamic: fixtures land via the EvalDatasets track)
// ---------------------------------------------------------------------------

/** Investor-verdict TEST rows (frozen shape in fixtures/investor-verdicts.ts). */
export interface InvestorVerdictRow {
  name: string;
  verdict: string;
  owner: string | null;
  year: number | null;
  expectedOwnershipStatus: string;
  expectedPipelineDecision: string;
  note?: string;
  split?: string;
}

/** M&A-priority DEV rows (frozen shape in fixtures/ma-priorities.ts). */
export interface MaPriorityRow {
  name: string;
  domain: string | null;
  priority: 1 | 2 | 3;
  category?: string | null;
  revenue?: number | null;
  employees?: number | null;
  /** Verbatim snapshot ownership text, null where unstated. */
  ownership?: string | null;
  expectedInvestorPriority: number;
  rationale?: string;
  split?: string;
}
const INVESTOR_VERDICT_SPECIFIERS = [
  "../packages/research/src/scoring-axial/fixtures/investor-verdicts.js",
] as const;
const MA_PRIORITY_SPECIFIERS = [
  "../packages/research/src/scoring-axial/fixtures/ma-priorities.js",
] as const;

async function tryImport(
  specifier: string,
): Promise<Record<string, unknown> | null> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "ERR_LOAD_URL") return null;
    throw error;
  }
}

export interface EvalFixtures {
  investorVerdicts: InvestorVerdictRow[];
  investorSplit: string;
  investorVersion: string;
  maPriorities: MaPriorityRow[];
  maSplit: string;
  maVersion: string;
}

/** Load the frozen eval fixtures; throws a clear error when absent. */
export async function loadEvalFixtures(): Promise<EvalFixtures> {
  let investorMod: Record<string, unknown> | null = null;
  for (const spec of INVESTOR_VERDICT_SPECIFIERS) {
    investorMod = await tryImport(spec);
    if (investorMod !== null) break;
  }
  let maMod: Record<string, unknown> | null = null;
  for (const spec of MA_PRIORITY_SPECIFIERS) {
    maMod = await tryImport(spec);
    if (maMod !== null) break;
  }
  if (investorMod === null || maMod === null) {
    const missing = [
      investorMod === null ? INVESTOR_VERDICT_SPECIFIERS[0] : null,
      maMod === null ? MA_PRIORITY_SPECIFIERS[0] : null,
    ].filter((s): s is string => s !== null);
    throw new Error(
      `frozen eval fixtures not found (${missing.join(", ")}); ` +
        `the EvalDatasets track has not landed them yet`,
    );
  }
  const investorVerdicts = investorMod["INVESTOR_VERDICTS_V1"] as
    InvestorVerdictRow[] | undefined;
  const maPriorities = maMod["MA_PRIORITIES_V1"] as MaPriorityRow[] | undefined;
  if (!Array.isArray(investorVerdicts) || !Array.isArray(maPriorities)) {
    throw new Error(
      "frozen eval fixtures malformed: expected INVESTOR_VERDICTS_V1 and MA_PRIORITIES_V1 arrays",
    );
  }
  return {
    investorVerdicts,
    investorSplit: String(investorMod["INVESTOR_VERDICT_SPLIT"] ?? "unknown"),
    investorVersion: String(investorMod["DATASET_VERSION"] ?? "unknown"),
    maPriorities,
    maSplit: String(maMod["MA_PRIORITY_SPLIT"] ?? "unknown"),
    maVersion: String(maMod["DATASET_VERSION"] ?? "unknown"),
  };
}

/** TEST-split prediction: frozen Booie verdict vs deriveRound2Verdict. */
export function predictInvestorVerdict(
  name: string,
  evidence?: string | null,
): string {
  return deriveRound2Verdict(name, evidence).pipelineDecision;
}
/** DEV-split prediction: pipeline row fields through the discovery mapper. */
export function predictInvestorPriority(row: MaPriorityRow): 1 | 2 | 3 {
  const evidence =
    [row.ownership ?? null, row.category ?? null]
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .join(" | ") || null;
  const assessment = mapDiscoveryInvestorAssessment(
    null,
    null,
    row.domain === null || row.domain === undefined || row.domain.trim() === ""
      ? null
      : `https://${row.domain.trim()}`,
    evidence,
  );
  return assessment.investorPriority;
}

/**
 * Bridge from golden-set feature ownership types to the Grata-style
 * ownership text proposeLabels classifies on. Documents CURRENT rule
 * behavior: only "Public Subsidiary" triggers
 * ideal_archetype_but_unactionable and only sponsor-backed text triggers
 * positive_with_caveat; null/unknown ownership falls through to
 * strong_positive by rule design.
 */
export function goldenOwnershipText(ownershipType: string): string | null {
  switch (ownershipType) {
    case "public_sub":
      return "Public Subsidiary";
    case "pe_owned":
      return "Private Equity Add-On";
    case "independent_founder":
      return "Private Independent";
    case "independent_family":
      return "Private Family Owned";
    case "strategic_sub":
      return "Strategic Subsidiary";
    default:
      return null;
  }
}

/** GOLDEN-split prediction: HP-equivalent = proposed strong_positive. */
export function predictGoldenType(ownershipType: string): string {
  return proposeLabels({ ownership: goldenOwnershipText(ownershipType) })
    .goldenExampleType;
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export const VERDICT_VOCAB = [
  "add",
  "hold",
  "pass_acquired",
  "pass_dead",
  "pass_sector",
] as const;

/** Pipeline Priority values double as the investor-rank ground truth (identity mapping, per fixture). */
export const DEV_PRIORITY_VOCAB = ["1", "2", "3"] as const;

export interface EnsembleProbe {
  decision: string;
  thesisSignals: string[];
  predicted: string;
}

/**
 * Behavior probes for mapEnsembleInvestorAssessment on canonical inputs.
 * Reported as current-behavior documentation, never scored (ensemble
 * outputs are model-derived and NEVER ground truth).
 */
export function ensembleProbes(): EnsembleProbe[] {
  const cases: Array<{ decision: string; thesisSignals: string[] }> = [
    {
      decision: "high_priority",
      thesisSignals: ["proprietary PMA product line", "product catalog"],
    },
    {
      decision: "research",
      thesisSignals: ["proprietary catalog products", "PMA STC patented line"],
    },
    {
      decision: "research",
      thesisSignals: ["capabilities only, build-to-print shop"],
    },
    { decision: "reject", thesisSignals: ["distributor, no manufacturing"] },
  ];
  return cases.map((c) => {
    const assessment = mapEnsembleInvestorAssessment(
      c.decision,
      c.thesisSignals,
    );
    return {
      ...c,
      predicted:
        assessment === null
          ? "excluded(null)"
          : `priority-${assessment.investorPriority}/${assessment.proprietaryBasis}`,
    };
  });
}

export interface ValidationReport {
  version: string;
  generatedAt: string;
  fixtures: {
    investorVerdicts: { version: string; split: string; count: number };
    maPriorities: { version: string; split: string; count: number };
    golden: { version: string; count: number };
  };
  splits: {
    test: SplitSummary;
    dev: SplitSummary;
    golden: SplitSummary;
  };
  /** Recall of predicted strong_positive among actual golden strong_positives. */
  goldenHpRecall: number | null;
  goldenStrongPositiveSupport: number;
  probes: EnsembleProbe[];
  threshold: {
    minAccuracy: number;
    testAccuracy: number | null;
    passed: boolean;
    reason: string;
  };
}

/** Score all three splits with current deterministic logic. */
export function runValidation(fixtures: EvalFixtures): ValidationReport {
  const testOutcomes: ScoredOutcome[] = fixtures.investorVerdicts.map(
    (row, index) => ({
      id: `test-${index}:${row.name}`,
      actual: row.verdict,
      predicted: predictInvestorVerdict(row.name),
    }),
  );
  const devOutcomes: ScoredOutcome[] = fixtures.maPriorities.map(
    (row, index) => ({
      id: `dev-${index}:${row.name}`,
      actual: String(row.expectedInvestorPriority),
      predicted: String(predictInvestorPriority(row)),
    }),
  );
  const goldenOutcomes: ScoredOutcome[] = ALL_GOLDEN_ENTRIES_V1.map(
    (entry) => ({
      id: `golden:${entry.id}`,
      actual: entry.label,
      predicted: predictGoldenType(entry.features.ownership.ownershipType),
    }),
  );

  const test = summarizeSplit("test (investor verdicts)", testOutcomes, [
    ...VERDICT_VOCAB,
  ]);
  const dev = summarizeSplit("dev (ma priorities)", devOutcomes, [
    ...DEV_PRIORITY_VOCAB,
  ]);
  const golden = summarizeSplit("golden (golden-set labels)", goldenOutcomes, [
    ...DATASET_LABEL_VALUES,
  ]);

  const strongPositives = goldenOutcomes.filter(
    (o) => o.actual === "strong_positive",
  );
  const goldenHpRecall =
    strongPositives.length === 0
      ? null
      : strongPositives.filter((o) => o.predicted === "strong_positive")
          .length / strongPositives.length;

  return {
    version: "validation-v1",
    generatedAt: new Date().toISOString(),
    fixtures: {
      investorVerdicts: {
        version: fixtures.investorVersion,
        split: fixtures.investorSplit,
        count: fixtures.investorVerdicts.length,
      },
      maPriorities: {
        version: fixtures.maVersion,
        split: fixtures.maSplit,
        count: fixtures.maPriorities.length,
      },
      golden: { version: GOLDEN_DATASET_V1.name, count: goldenOutcomes.length },
    },
    splits: { test, dev, golden },
    goldenHpRecall,
    goldenStrongPositiveSupport: strongPositives.length,
    probes: ensembleProbes(),
    threshold: {
      minAccuracy: 0.5,
      testAccuracy: test.accuracy,
      passed: true,
      reason: "pending CLI gate (see main)",
    },
  };
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

function printSplit(summary: SplitSummary): void {
  console.log(`\n## ${summary.name} (n=${summary.n})`);
  console.log(`accuracy: ${formatRate(summary.accuracy)}`);
  for (const [cls, m] of Object.entries(summary.perClass)) {
    console.log(
      `  ${cls}: P=${m.precision.toFixed(4)} R=${m.recall.toFixed(4)} ` +
        `F1=${m.f1.toFixed(4)} (support=${m.support}, predicted=${m.predicted})`,
    );
  }
  console.log("confusion (actual -> predicted: count):");
  for (const cell of summary.confusion.cells) {
    console.log(`  ${cell.actual} -> ${cell.predicted}: ${cell.count}`);
  }
}

export interface ValidationCliOptions {
  minAccuracy: number;
  jsonPath: string | null;
}

export function parseValidationArgs(argv: string[]): ValidationCliOptions {
  let minAccuracy = 0.5;
  let jsonPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--min-accuracy") {
      const raw = argv[i + 1];
      i++;
      const parsed = raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(
          `--min-accuracy expects a number in [0, 1], got ${raw ?? "(missing)"}`,
        );
      }
      minAccuracy = parsed;
    } else if (arg === "--json") {
      const raw = argv[i + 1];
      if (raw === undefined || raw === "") {
        throw new Error("--json expects an output path");
      }
      i++;
      jsonPath = raw;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npx tsx scripts/run-validation.mts [--min-accuracy 0.5] [--json out/report.json]\n" +
          "\n" +
          "Backtests current deterministic acquisition-scoring logic against frozen fixtures.\n" +
          "Exits non-zero when TEST-split accuracy falls below --min-accuracy.",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown flag ${arg} (see --help)`);
    }
  }
  return { minAccuracy, jsonPath };
}

async function main(argv: string[]): Promise<void> {
  const { minAccuracy, jsonPath } = parseValidationArgs(argv);
  const fixtures = await loadEvalFixtures();
  const report = runValidation(fixtures);
  const gate = evaluateThreshold(report.splits.test.accuracy, minAccuracy);
  report.threshold = {
    minAccuracy,
    testAccuracy: report.splits.test.accuracy,
    ...gate,
  };

  console.log(
    `[validation] fixtures: investor-verdicts ${report.fixtures.investorVerdicts.version} ` +
      `(n=${report.fixtures.investorVerdicts.count}), ma-priorities ${report.fixtures.maPriorities.version} ` +
      `(n=${report.fixtures.maPriorities.count}), golden ${report.fixtures.golden.version} ` +
      `(n=${report.fixtures.golden.count})`,
  );
  printSplit(report.splits.test);
  printSplit(report.splits.dev);
  printSplit(report.splits.golden);
  console.log(
    `\ngolden HP-equivalent recall on strong_positives: ${formatRate(report.goldenHpRecall)} ` +
      `(support=${report.goldenStrongPositiveSupport})`,
  );
  console.log("ensemble mapper probes (behavior only, never scored):");
  for (const probe of report.probes) {
    console.log(
      `  ${probe.decision} [${probe.thesisSignals.join(" | ")}] => ${probe.predicted}`,
    );
  }
  console.log(`\ngate: ${gate.reason} => ${gate.passed ? "PASS" : "FAIL"}`);

  if (jsonPath !== null) {
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[validation] report written to ${jsonPath}`);
  }
  if (!gate.passed) process.exit(1);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main(process.argv.slice(2));
}
