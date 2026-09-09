/**
 * Populate the `unified_targets` acquisition-target table (migration 0008).
 *
 * Thin CLI wrapper over
 * `packages/database/src/unified-targets/populate.ts`. All loaders, merge,
 * upsert, and guard logic live there; this file only parses argv, opens the
 * pool, and reports counts.
 *
 * Usage:
 *   npx tsx scripts/populate-unified-targets.mts [--curated path/to.csv]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { getPool } from "../packages/database/src/client.js";
import {
  ORIGIN_CURATED,
  ORIGIN_DISCOVERY,
  ORIGIN_FAA_ENSEMBLE,
  ORIGIN_GOLDEN_V1,
  parsePopulateArgs,
  populateUnifiedTargets,
} from "../packages/database/src/unified-targets/populate.js";

export * from "../packages/database/src/unified-targets/populate.js";

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

async function main(argv: string[]): Promise<void> {
  const { curatedPath } = parsePopulateArgs(argv);
  const pool = getPool();
  try {
    const counts = await populateUnifiedTargets(pool, {
      curatedCsvPath: curatedPath,
    });
    let inserted = 0;
    let merged = 0;
    for (const origin of [
      ORIGIN_GOLDEN_V1,
      ORIGIN_CURATED,
      ORIGIN_DISCOVERY,
      ORIGIN_FAA_ENSEMBLE,
    ] as const) {
      const source = counts[origin];
      inserted += source.inserted;
      merged += source.merged;
      console.log(
        `[unified-targets] ${origin}: ${source.inserted} inserted, ${source.merged} merged`,
      );
    }
    console.log(
      `[unified-targets] total: ${inserted} inserted, ${merged} merged`,
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
