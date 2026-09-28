/**
 * Offline reporting for JEv production-path benchmark results.
 *
 * This module never predicts a label. `jev-ladder-bakeoff.mts` supplies
 * decisions from the production ladder, while this module only validates and
 * summarizes those outcomes. The 29 Booie-reviewed companies are explicitly
 * report-only prior-review cases, not an untouched holdout. The 36 priority
 * rows are a sample, not a substitute for the unavailable 303-row source.
 *
 * Usage:
 *   npx tsx scripts/run-validation.mts --input out/jev-results.json
 *   npx tsx scripts/run-validation.mts --input out/jev-results.json --json out/summary.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const BENCHMARK_DECISIONS = [
  "high_priority",
  "research",
  "reject",
] as const;
export type BenchmarkDecision = (typeof BENCHMARK_DECISIONS)[number];
export type BenchmarkObservedDecision = BenchmarkDecision | "error";

export const BENCHMARK_COHORTS = [
  "sourced_real",
  "synthetic_control",
  "investor_review_report_only",
] as const;
export type BenchmarkCohort = (typeof BENCHMARK_COHORTS)[number];

export interface BenchmarkOutcome {
  id: string;
  cohort: BenchmarkCohort;
  expected: BenchmarkDecision;
  actual: BenchmarkObservedDecision;
  costUsd: number;
  callCount: number;
}

export interface BenchmarkConfusionCell {
  expected: BenchmarkDecision;
  actual: BenchmarkObservedDecision;
  count: number;
}

export interface BenchmarkTotals {
  caseCount: number;
  exactMatches: number;
  exactMatchRate: number | null;
  falsePromotions: number;
  falseRejects: number;
  missedHighPriority: number;
  expectedResearchPromotions: number;
  abstentions: number;
  errors: number;
  decisiveCases: number;
  coverage: number | null;
  totalCostUsd: number;
  averageCostUsd: number | null;
  totalCallCount: number;
  confusion: BenchmarkConfusionCell[];
}

export interface BenchmarkSummary extends BenchmarkTotals {
  version: "jev-validation-v2";
  byCohort: Record<BenchmarkCohort, BenchmarkTotals>;
}

export interface BenchmarkResultDocument {
  version: string;
  outcomes: BenchmarkOutcome[];
}

export interface ReferenceSet {
  id: string;
  rows: number;
  availability: "available" | "missing";
  role: "membership" | "calibration" | "sample" | "report_only";
  decisionInput: false;
  note: string;
}

/**
 * Honest inventory of the local reference sources. These sets are provenance
 * only and must never become ownership, product, or promotion inputs.
 */
export const VALIDATION_REFERENCE_SETS: readonly ReferenceSet[] = [
  {
    id: "golden-set-v01",
    rows: 18,
    availability: "available",
    role: "calibration",
    decisionInput: false,
    note: "Original ADCO golden workbook; curated reference set, not a holdout.",
  },
  {
    id: "preliminary-pipeline-v01",
    rows: 246,
    availability: "available",
    role: "membership",
    decisionInput: false,
    note: "Original ADCO pipeline workbook membership only.",
  },
  {
    id: "ma-priorities-2026-09-09",
    rows: 303,
    availability: "missing",
    role: "membership",
    decisionInput: false,
    note: "The source CSV is absent and cannot be reconstructed from its sample.",
  },
  {
    id: "ma-priorities-v1-sample",
    rows: 36,
    availability: "available",
    role: "sample",
    decisionInput: false,
    note: "Stratified development sample only; not the 303-row membership source.",
  },
  {
    id: "investor-verdicts-v1",
    rows: 29,
    availability: "available",
    role: "report_only",
    decisionInput: false,
    note: "Prior investor-review labels; tuned historical set, never an untouched holdout.",
  },
] as const;

function emptyTotals(): Omit<BenchmarkTotals, "confusion"> {
  return {
    caseCount: 0,
    exactMatches: 0,
    exactMatchRate: null,
    falsePromotions: 0,
    falseRejects: 0,
    missedHighPriority: 0,
    expectedResearchPromotions: 0,
    abstentions: 0,
    errors: 0,
    decisiveCases: 0,
    coverage: null,
    totalCostUsd: 0,
    averageCostUsd: null,
    totalCallCount: 0,
  };
}

function summarizeTotals(
  outcomes: readonly BenchmarkOutcome[],
): BenchmarkTotals {
  const totals = emptyTotals();
  const confusion = new Map<string, BenchmarkConfusionCell>();

  for (const outcome of outcomes) {
    totals.caseCount += 1;
    totals.totalCostUsd += outcome.costUsd;
    totals.totalCallCount += outcome.callCount;

    if (outcome.actual === outcome.expected) totals.exactMatches += 1;
    if (
      outcome.actual === "high_priority" &&
      outcome.expected !== "high_priority"
    ) {
      totals.falsePromotions += 1;
    }
    if (outcome.actual === "reject" && outcome.expected !== "reject") {
      totals.falseRejects += 1;
    }
    if (
      outcome.expected === "high_priority" &&
      outcome.actual !== "high_priority"
    ) {
      totals.missedHighPriority += 1;
    }
    if (outcome.expected === "research" && outcome.actual === "high_priority") {
      totals.expectedResearchPromotions += 1;
    }
    if (outcome.actual === "research") totals.abstentions += 1;
    else if (outcome.actual === "error") totals.errors += 1;
    else totals.decisiveCases += 1;

    const key = `${outcome.expected}\u0000${outcome.actual}`;
    const cell = confusion.get(key);
    if (cell === undefined) {
      confusion.set(key, {
        expected: outcome.expected,
        actual: outcome.actual,
        count: 1,
      });
    } else {
      cell.count += 1;
    }
  }

  totals.exactMatchRate =
    totals.caseCount === 0 ? null : totals.exactMatches / totals.caseCount;
  totals.coverage =
    totals.caseCount === 0 ? null : totals.decisiveCases / totals.caseCount;
  totals.averageCostUsd =
    totals.caseCount === 0 ? null : totals.totalCostUsd / totals.caseCount;

  return {
    ...totals,
    confusion: [...confusion.values()].sort((left, right) => {
      const byExpected = left.expected.localeCompare(right.expected);
      return byExpected === 0
        ? left.actual.localeCompare(right.actual)
        : byExpected;
    }),
  };
}

/**
 * Summarize classification outcomes without forgiving `research -> HP`.
 * Research is the production ladder's abstention and is excluded from coverage.
 */
export function summarizeBenchmark(
  outcomes: readonly BenchmarkOutcome[],
): BenchmarkSummary {
  const ids = new Set<string>();
  for (const outcome of outcomes) {
    if (ids.has(outcome.id)) {
      throw new Error(`duplicate benchmark outcome id: ${outcome.id}`);
    }
    ids.add(outcome.id);
    if (
      !Number.isFinite(outcome.costUsd) ||
      outcome.costUsd < 0 ||
      !Number.isInteger(outcome.callCount) ||
      outcome.callCount < 0
    ) {
      throw new Error(
        `invalid cost/call count for benchmark outcome ${outcome.id}`,
      );
    }
  }

  const byCohort = Object.fromEntries(
    BENCHMARK_COHORTS.map((cohort) => [
      cohort,
      summarizeTotals(outcomes.filter((outcome) => outcome.cohort === cohort)),
    ]),
  ) as Record<BenchmarkCohort, BenchmarkTotals>;

  return {
    version: "jev-validation-v2",
    ...summarizeTotals(outcomes),
    byCohort,
  };
}

const benchmarkOutcomeSchema = z.object({
  id: z.string().min(1),
  cohort: z.enum(BENCHMARK_COHORTS),
  expected: z.enum(BENCHMARK_DECISIONS),
  actual: z.union([z.enum(BENCHMARK_DECISIONS), z.literal("error")]),
  costUsd: z.number().finite().nonnegative(),
  callCount: z.number().int().nonnegative(),
});

const benchmarkResultDocumentSchema = z.object({
  version: z.string().default("unknown"),
  outcomes: z.array(benchmarkOutcomeSchema),
});

/** Validate the portable JSON emitted by the bakeoff before reporting it. */
export function parseBenchmarkResultDocument(
  value: unknown,
): BenchmarkResultDocument {
  const document = benchmarkResultDocumentSchema.parse(value);
  summarizeBenchmark(document.outcomes);
  return document;
}

export interface ValidationCliOptions {
  inputPath: string | null;
  jsonPath: string | null;
  help: boolean;
}

export function parseValidationArgs(
  argv: readonly string[],
): ValidationCliOptions {
  let inputPath: string | null = null;
  let jsonPath: string | null = null;
  let help = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--input" || arg === "--json") {
      const value = argv[index + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error(`${arg} expects a path`);
      }
      index += 1;
      if (arg === "--input") inputPath = value;
      else jsonPath = value;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`unknown flag ${String(arg)} (see --help)`);
    }
  }
  return { inputPath, jsonPath, help };
}

function printSummary(summary: BenchmarkSummary): void {
  console.log(
    `cases=${summary.caseCount} exact=${summary.exactMatches} ` +
      `false_promotions=${summary.falsePromotions} ` +
      `false_rejects=${summary.falseRejects} ` +
      `research_to_hp=${summary.expectedResearchPromotions}`,
  );
  console.log(
    `abstentions=${summary.abstentions} errors=${summary.errors} ` +
      `coverage=${summary.coverage === null ? "n/a" : summary.coverage.toFixed(4)} ` +
      `calls=${summary.totalCallCount} cost_usd=${summary.totalCostUsd.toFixed(6)}`,
  );
  for (const cohort of BENCHMARK_COHORTS) {
    const result = summary.byCohort[cohort];
    console.log(
      `${cohort}: cases=${result.caseCount} false_promotions=${result.falsePromotions} ` +
        `false_rejects=${result.falseRejects} abstentions=${result.abstentions} ` +
        `coverage=${result.coverage === null ? "n/a" : result.coverage.toFixed(4)} ` +
        `cost_usd=${result.totalCostUsd.toFixed(6)}`,
    );
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseValidationArgs(argv);
  if (options.help) {
    console.log(
      "Usage: npx tsx scripts/run-validation.mts --input <bakeoff-results.json> [--json <summary.json>]\n" +
        "Without --input, prints the reference-set inventory and performs no scoring.",
    );
    return;
  }

  if (options.inputPath === null) {
    console.log(
      JSON.stringify({ referenceSets: VALIDATION_REFERENCE_SETS }, null, 2),
    );
    return;
  }

  const raw = JSON.parse(await readFile(options.inputPath, "utf8")) as unknown;
  const document = parseBenchmarkResultDocument(raw);
  const summary = summarizeBenchmark(document.outcomes);
  printSummary(summary);

  if (options.jsonPath !== null) {
    await mkdir(path.dirname(options.jsonPath), { recursive: true });
    await writeFile(
      options.jsonPath,
      `${JSON.stringify(
        {
          sourceVersion: document.version,
          summary,
          referenceSets: VALIDATION_REFERENCE_SETS,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) await main(process.argv.slice(2));
