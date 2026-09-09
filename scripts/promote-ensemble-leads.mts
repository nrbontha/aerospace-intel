/**
 * Promote high-priority FAA ensemble results into leads.
 *
 * Thin CLI wrapper over
 * `packages/database/src/unified-targets/promote.ts`. All selection,
 * skip-check, and lead-creation logic lives there; this file only parses
 * argv, opens the pool, and reports counts.
 *
 * Usage:
 *   npx tsx scripts/promote-ensemble-leads.mts [--limit 25] [--dry-run]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { getPool } from "../packages/database/src/client.js";
import { promoteEnsembleLeads } from "../packages/database/src/unified-targets/promote.js";

// ---------------------------------------------------------------------------
// env bootstrap (mirror scripts/run-faa-ensemble.mts: source .env.local)
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

export function parsePromoteArgs(argv: readonly string[]): {
  limit: number;
  dryRun: boolean;
} {
  let limit = 25;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--limit" && i + 1 < argv.length) {
      const parsed = Number(argv[++i]!);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--limit must be a non-negative number (got "${argv[i]}")`);
      }
      limit = Math.floor(parsed);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: promote-ensemble-leads.mts [--limit N] [--dry-run]");
      process.exit(0);
    }
  }
  return { limit, dryRun };
}

async function main(argv: string[]): Promise<void> {
  const { limit, dryRun } = parsePromoteArgs(argv);
  const pool = getPool();
  try {
    const result = await promoteEnsembleLeads(pool, { limit, dryRun });
    console.log(
      `[ensemble-promote]${dryRun ? " (dry-run)" : ""} promoted ${result.promoted}, skipped ${result.skipped} (limit=${limit})`,
    );
  } finally {
    await pool.end();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main(process.argv.slice(2));
}
