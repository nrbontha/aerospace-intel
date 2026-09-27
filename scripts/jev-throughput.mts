/**
 * Jev throughput probe: measures screening + verification pace against prod.
 *
 * Samples faa_ensemble_evaluations counts by prompt_version prefix
 * (jev-ladder-* vs everything else) and faa_ensemble_results counts at T0,
 * sleeps 300s, samples again, then prints:
 * - screened-per-minute for ladder and sweep streams (plus combined)
 * - verify backlog depth (distinct signals with a research evaluation
 *   but no faa_ensemble_results row)
 * - projected backlog drain time at the observed verify completion rate
 *
 * Usage: DATABASE_URL=<prod-railway-url> npx tsx scripts/jev-throughput.mts
 * Takes no arguments. Read-only: SELECT COUNT(*) queries only, never writes.
 * Never logs DATABASE_URL or any secret.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { closeDatabase, getDatabase } from "@asi/database";

const SAMPLE_INTERVAL_MS = 300_000;

interface Snapshot {
  at: string;
  ladderEvals: number;
  otherEvals: number;
  results: number;
  verifyBacklog: number;
}

async function sample(): Promise<Snapshot> {
  const { sql } = await import("drizzle-orm");
  const result = await getDatabase().execute<{
    ladderEvals: string;
    otherEvals: string;
    results: string;
    verifyBacklog: string;
  }>(sql`
    SELECT
      (SELECT count(*)::text FROM faa_ensemble_evaluations
        WHERE prompt_version LIKE 'jev-ladder-%') AS "ladderEvals",
      (SELECT count(*)::text FROM faa_ensemble_evaluations
        WHERE prompt_version NOT LIKE 'jev-ladder-%') AS "otherEvals",
      (SELECT count(*)::text FROM faa_ensemble_results) AS "results",
      (SELECT count(DISTINCT signal_id)::text FROM faa_ensemble_evaluations e
        WHERE e.decision = 'research'
          AND NOT EXISTS (
            SELECT 1 FROM faa_ensemble_results r WHERE r.signal_id = e.signal_id
          )) AS "verifyBacklog"
  `);
  const row = result.rows[0];
  if (row === undefined) throw new Error("throughput probe returned no rows");
  return {
    at: new Date().toISOString(),
    ladderEvals: Number(row.ladderEvals),
    otherEvals: Number(row.otherEvals),
    results: Number(row.results),
    verifyBacklog: Number(row.verifyBacklog),
  };
}

function formatDrain(backlog: number, resultsPerMin: number): string {
  if (!(resultsPerMin > 0))
    return "unknown (no verify completions observed in window)";
  const minutes = backlog / resultsPerMin;
  if (minutes < 90) return `~${Math.round(minutes)}m`;
  return `~${Math.round(minutes)}m (~${(minutes / 60).toFixed(1)}h)`;
}

async function main(): Promise<void> {
  if (
    process.env.DATABASE_URL === undefined ||
    process.env.DATABASE_URL === ""
  ) {
    throw new Error("DATABASE_URL is required (prod Railway Postgres URL)");
  }
  try {
    const t0 = await sample();
    console.log(`T0 ${t0.at} ${JSON.stringify(t0)}`);
    console.log(
      `sleeping ${(SAMPLE_INTERVAL_MS / 1000).toFixed(0)}s between samples…`,
    );
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS));
    const startedAt = Date.parse(t0.at);
    const t1 = await sample();
    const elapsedMin = (Date.now() - startedAt) / 60_000;
    const ladderPerMin = (t1.ladderEvals - t0.ladderEvals) / elapsedMin;
    // Non-ladder eval rows are sweep-dominated: JEv sweep writes
    // faa_qualification_v1 rows at high concurrency while Muse verify (2
    // concurrent) adds only a handful per window.
    const sweepPerMin = (t1.otherEvals - t0.otherEvals) / elapsedMin;
    const resultsPerMin = (t1.results - t0.results) / elapsedMin;
    const report = {
      windowMin: Number(elapsedMin.toFixed(2)),
      t0,
      t1,
      ladderScreenedPerMin: Number(ladderPerMin.toFixed(2)),
      sweepScreenedPerMin: Number(sweepPerMin.toFixed(2)),
      combinedScreenedPerMin: Number((ladderPerMin + sweepPerMin).toFixed(2)),
      verifyCompletionsPerMin: Number(resultsPerMin.toFixed(2)),
      verifyBacklog: t1.verifyBacklog,
      projectedDrain: formatDrain(t1.verifyBacklog, resultsPerMin),
    };
    console.log(JSON.stringify(report, null, 2));
    console.log(
      `ladder=${report.ladderScreenedPerMin}/min ` +
        `sweep=${report.sweepScreenedPerMin}/min ` +
        `combined=${report.combinedScreenedPerMin}/min ` +
        `verify=${report.verifyCompletionsPerMin}/min ` +
        `backlog=${report.verifyBacklog} drain=${report.projectedDrain}`,
    );
  } finally {
    await closeDatabase().catch(() => undefined);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await main();
}
