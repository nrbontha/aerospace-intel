/**
 * High-recall filter over queued source signals. By default it drains every
 * queued source key; pass `--source-key faa_pma_database` to limit to FAA PMA
 * holders. Each signal is evaluated independently by two models; the
 * deterministic ensemble rule accepts agreements, defaults research +
 * high_priority pairs to research, and adjudicates every other disagreement
 * (including malformed model output). API failures are recorded as errors
 * with retry — NEVER as decisions.
 *
 * The runner persists `faa_ensemble_evaluations` + `faa_ensemble_results`
 * rows only. It deliberately does NOT write candidates, leads, or
 * `source_signals.status` — promotion wiring is a later decision.
 *
 * Usage:
 *   npx tsx scripts/run-faa-ensemble.mts [--limit N] [--status S]
 *     [--source-key K[,K...]] [--dry-run] [--sample N] [--concurrency N]
 *     [--include-known] [--benchmark-names a,b,c] [--failed-only]
 *
 * `--source-key` accepts a comma-separated list; omit it, use an empty value,
 * or pass `all` to select every queued source key.
 *
 * Thin CLI wrapper: all ensemble logic lives in
 * `packages/research/src/faa-ensemble/runner.js` and is re-exported below so
 * existing importers (including tests) keep working untouched.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import {
  closeDatabase,
  getDatabase,
} from "../packages/database/src/index.js";

export * from "../packages/research/src/faa-ensemble/runner.js";
import {
  DEFAULT_FAA_STATUS,
  loadKnownNames,
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
  if (!options.includeKnown && !options.dryRun) {
    // Surface the known-name filter size without disturbing the hot path.
    const db = getDatabase();
    try {
      const known = await loadKnownNames(db);
      console.log(
        `known-name filter: ${known.size} names (golden_examples + companies)`,
      );
    } finally {
      await closeDatabase();
    }
  }
  const summary = await runFaaEnsemble(options);
  console.log(`signals=${summary.signals}`);
  await closeDatabase();
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await main();
}
