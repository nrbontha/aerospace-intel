/**
 * Current-input FAA signal review CLI.
 *
 * Persisting runs claim evidence-ready review state, execute the complete JEv
 * ladder, then verify due Muse claims against the same frozen canonical input.
 * Provider failures remain retryable and no unlinked historical evaluation can
 * suppress or replace a current result. `--limit` is a per-stage batch cap;
 * zero uses the bounded production default.
 *
 * Usage:
 *   npx tsx scripts/run-faa-ensemble.mts [--limit N] [--dry-run]
 *     [--concurrency N] [--delay-ms N]
 *
 * Thin CLI wrapper: production logic lives in
 * `packages/research/src/faa-ensemble/runner.js`.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { closeDatabase } from "../packages/database/src/index.js";

export * from "../packages/research/src/faa-ensemble/runner.js";
import {
  DEFAULT_FAA_STATUS,
  resolveEnsembleConfig,
  runFaaEnsemble,
  type FaaEnsembleCliOptions,
} from "../packages/research/src/faa-ensemble/runner.js";

// ---------------------------------------------------------------------------
// env bootstrap (mirror scripts/bench-enrichment.ts: source .env.local)
// ---------------------------------------------------------------------------
for (const line of existsSync(".env.local")
  ? readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/u);
  const key = match?.[1];
  const value = match?.[2];
  if (
    key !== undefined &&
    value !== undefined &&
    process.env[key] === undefined
  ) {
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const exact = argv.indexOf(flag);
  if (exact >= 0) return argv[exact + 1];
  const prefixed = argv.find((arg) => arg.startsWith(`${flag}=`));
  return prefixed === undefined ? undefined : prefixed.slice(flag.length + 1);
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}
function hasOption(argv: readonly string[], flag: string): boolean {
  return argv.some(
    (argument) => argument === flag || argument.startsWith(`${flag}=`),
  );
}

function parseNonNegativeInt(
  raw: string | undefined,
  flag: string,
): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer (got ${raw})`);
  }
  return parsed;
}

export function parseEnsembleArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): FaaEnsembleCliOptions {
  const limit = parseNonNegativeInt(flagValue(argv, "--limit"), "--limit") ?? 0;
  const status = flagValue(argv, "--status") ?? DEFAULT_FAA_STATUS;
  const sourceKeys = parseSourceKeys(flagValue(argv, "--source-key"));
  const dryRun = hasFlag(argv, "--dry-run");
  if (!dryRun) {
    const unsupported = [
      "--status",
      "--source-key",
      "--sample",
      "--include-known",
      "--benchmark-names",
      "--failed-only",
    ].filter((flag) => hasOption(argv, flag));
    if (unsupported.length > 0) {
      throw new Error(
        `${unsupported.join(", ")} ${
          unsupported.length === 1 ? "is" : "are"
        } supported only with --dry-run; live work is selected atomically from review claims`,
      );
    }
  }
  const sample = parseNonNegativeInt(flagValue(argv, "--sample"), "--sample");
  const concurrencyOverride = parseNonNegativeInt(
    flagValue(argv, "--concurrency"),
    "--concurrency",
  );
  const concurrency =
    concurrencyOverride === null || concurrencyOverride === 0
      ? resolveEnsembleConfig(env).concurrency
      : concurrencyOverride;
  const includeKnown = hasFlag(argv, "--include-known");
  const benchmarkRaw = flagValue(argv, "--benchmark-names") ?? "";
  const benchmarkNames = benchmarkRaw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const failedOnly = hasFlag(argv, "--failed-only");
  const delayMs = parseNonNegativeInt(
    flagValue(argv, "--delay-ms"),
    "--delay-ms",
  );
  const rawAnalystMode = (
    flagValue(argv, "--analyst-mode") ??
    env["FAA_ANALYST_MODE"] ??
    "disabled"
  ).trim();
  if (
    rawAnalystMode !== "disabled" &&
    rawAnalystMode !== "free_only" &&
    rawAnalystMode !== "bounded_paid"
  ) {
    throw new Error(
      "--analyst-mode must be disabled, free_only, or bounded_paid",
    );
  }
  const exaBudgetScopeId = (
    flagValue(argv, "--exa-budget-scope-id") ??
    env["EXA_BUDGET_SCOPE_ID"] ??
    ""
  ).trim();
  return {
    limit,
    status,
    sourceKeys,
    dryRun,
    sample,
    concurrency,
    delayMs,
    includeKnown,
    benchmarkNames,
    failedOnly,
    analystMode: rawAnalystMode,
    ...(exaBudgetScopeId === "" ? {} : { exaBudgetScopeId }),
  };
}

function parseSourceKeys(raw: string | undefined): readonly string[] {
  const sourceKeys = (raw ?? "")
    .split(",")
    .map((sourceKey) => sourceKey.trim())
    .filter((sourceKey) => sourceKey.length > 0);
  return sourceKeys.some((sourceKey) => sourceKey.toLowerCase() === "all")
    ? []
    : sourceKeys;
}

async function main(): Promise<void> {
  const options = parseEnsembleArgs(process.argv.slice(2));
  const summary = await runFaaEnsemble(options);
  console.log(
    summary.dryRunCandidates === null
      ? JSON.stringify({ jev: summary.jev, muse: summary.muse })
      : `dry_run_candidates=${summary.dryRunCandidates}`,
  );
  await closeDatabase();
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await main();
}
