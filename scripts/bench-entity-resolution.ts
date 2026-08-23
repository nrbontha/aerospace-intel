/**
 * Entity-resolution benchmark CLI.
 *
 * Deterministic (no network, no LLM): loads ground truth from the live local
 * DB, runs both production identity matchers over labeled perturbation
 * cases, prints a console report, writes reports/entity-resolution-<ts>.json,
 * and journals an experiment_runs row.
 *
 * Usage: npx tsx scripts/bench-entity-resolution.ts [--seed N] [--out dir]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// env bootstrap (mirrors scripts/bench-enrichment.ts convention) — but the
// stale .env.local DATABASE_URL must never win: force the live local DB.
// ---------------------------------------------------------------------------
const LIVE_DATABASE_URL =
  process.env["ASI_BENCH_DATABASE_URL"] ??
  "postgresql://asi:local-development-only@localhost:55440/aerospace_supplier_intelligence";
process.env["DATABASE_URL"] = LIVE_DATABASE_URL;
for (const line of existsSync(".env.local")
  ? readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
  const key = match?.[1];
  const value = match?.[2];
  if (
    key !== undefined &&
    value !== undefined &&
    key !== "DATABASE_URL" &&
    process.env[key] === undefined
  ) {
    process.env[key] = value;
  }
}

import { closeDatabase, getDatabase } from "@asi/database";

import { runEntityResolutionBenchmark } from "../packages/research/src/benchmarks/entity-resolution/index.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : undefined;
}

function printThresholdTable(
  sweep: readonly {
    threshold: number;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  }[],
): void {
  console.log("\nthreshold sweep (production confidence score):");
  console.log(
    "thr    tp     fp     fn     tn     prec    rec     f1",
  );
  for (const p of sweep) {
    const fmt = (v: number | null) => (v === null ? "  —" : v.toFixed(3));
    console.log(
      `${p.threshold.toFixed(2)}  ${String(p.tp).padStart(4)}  ${String(p.fp).padStart(5)}  ${String(p.fn).padStart(5)}  ${String(p.tn).padStart(5)}  ${fmt(p.precision)}  ${fmt(p.recall)}  ${fmt(p.f1)}`,
    );
  }
}

async function main(): Promise<void> {
  const seed = argValue("--seed") === undefined ? undefined : Number(argValue("--seed"));
  const outDir = argValue("--out") ?? "reports";

  const db = getDatabase();
  const report = await runEntityResolutionBenchmark(seed === undefined ? {} : { seed });

  console.log("== entity-resolution benchmark ==");
  console.log("ground truth:", report.groundTruth);
  console.log("cases:", report.caseCount, report.casesByKind);

  const sm = report.snapshotMatcher;
  console.log("\nsnapshot matcher (matchMember path)");
  console.log(
    `exact   precision=${sm.exactPrecision?.toFixed(3) ?? "—"} recall=${sm.exactRecall?.toFixed(3) ?? "—"}`,
  );
  console.log(
    `probable@${sm.operatingThreshold} tp=${sm.probableAtThreshold.tp} fp=${sm.probableAtThreshold.fp} fn=${sm.probableAtThreshold.fn} tn=${sm.probableAtThreshold.tn} precision=${sm.probableAtThreshold.precision?.toFixed(3) ?? "—"} recall=${sm.probableAtThreshold.recall?.toFixed(3) ?? "—"} f1=${sm.probableAtThreshold.f1?.toFixed(3) ?? "—"}`,
  );
  printThresholdTable(sm.sweep);
  console.log(`false merges: wrongCompany=${sm.falseMerges.wrongCompanyMerges} familySibling=${sm.falseMerges.familySiblingMerges}`);
  for (const d of sm.falseMerges.detail) {
    console.log(`  - [${d.caseId}] ${d.kind}: "${d.rawName}" → ${d.matchedCompanyId} (${d.reason})`);
  }
  const ac = sm.aliasCapture;
  console.log(
    `alias capture: ${ac.captured}/${ac.aliasCases}${ac.rate === null ? "" : ` (${(ac.rate * 100).toFixed(1)}%)`}`,
  );

  const lm = report.leadsMatcher;
  console.log("\nleads ingestion matcher");
  console.log("summary:", lm.summary);
  console.log(`domain exact hits: ${lm.domainExactHits}/${lm.domainExactTotal}`);
  console.log(`probable review correct: ${lm.probableCorrect}, wrong: ${lm.probableWrong.length}`);
  console.log(`negative leaks: ${lm.negativeLeaks.length}`, lm.negativeLeaks);
  console.log(`duplicate replays skipped: ${lm.duplicateSkipped}`);

  console.log("\nparent/subsidiary:", report.parentSubsidiary);
  console.log("\nfindings:");
  for (const finding of report.findings) console.log(` - ${finding}`);

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const outPath = path.join(outDir, `entity-resolution-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("\nreport written:", outPath);

  await closeDatabase();
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
