/**
 * Blind-discovery benchmark CLI (bounded live run).
 *
 * Runs a fresh campaign through the production machinery with archetype-only
 * seeds (NO company names/domains), against the live local DB and the free
 * USAspending public API. No OpenRouter calls exist on this path; a hard
 * abort guard mirrors the enrichment runner's daily-cap discipline.
 *
 * Usage: npx tsx scripts/bench-blind-discovery.ts [--max-iterations 4]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// env bootstrap — force the live local DB (.env.local's DATABASE_URL is stale).
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
import { sql } from "drizzle-orm";

import { runBlindDiscoveryBenchmark } from "../packages/research/src/benchmarks/blind-discovery/index.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : undefined;
}

async function assertDailySpendUnderCap(): Promise<void> {
  const result = await getDatabase().execute<{ total: string | null }>(sql`
    SELECT coalesce(sum(cost_usd), 0)::text AS total
    FROM model_usage
    WHERE created_at >= date_trunc('day', now())
  `);
  const dailyUsd = Number(result.rows[0]?.total ?? "0");
  if (dailyUsd >= 0.8) {
    throw new Error(
      `Daily model spend $${dailyUsd.toFixed(2)} already at/over the $0.80 abort guard.`,
    );
  }
}

async function main(): Promise<void> {
  await assertDailySpendUnderCap();

  const maxIterations =
    argValue("--max-iterations") === undefined
      ? 4
      : Number(argValue("--max-iterations"));
  const outDir = argValue("--out") ?? "reports";

  console.log("== blind-discovery benchmark ==");
  const report = await runBlindDiscoveryBenchmark({ maxIterations });

  console.log("campaign:", report.campaignId, report.campaignName);
  console.log("seeds:", JSON.stringify(report.seeds));
  console.log("identity leaks:", report.identityLeaks.length);
  console.log("\niterations:");
  for (const it of report.iterations) {
    console.log(
      ` #${it.iteration} claimed=${it.claimed} completed=${it.completed} failed=${it.failed} children=${it.childrenInserted} stop=${it.stopReason}`,
    );
  }
  console.log("\nfrontier by type/status:", report.frontierByTypeAndStatus);
  console.log("ingest summary:", report.ingestSummary);
  console.log("\nverdict:", report.verdict);
  for (const r of report.rediscoveries) {
    console.log(` rediscovered [${r.signal}] ${r.lead} → ${r.target}`);
  }
  console.log(`\ncostUsd=${report.costUsd.toFixed(4)} wallTimeMs=${report.wallTimeMs}`);
  console.log("\nfindings:");
  for (const finding of report.findings) console.log(` - ${finding}`);

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const outPath = path.join(outDir, `blind-discovery-${stamp}.json`);
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
