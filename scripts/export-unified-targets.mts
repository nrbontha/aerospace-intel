/**
 * Export the `unified_targets` acquisition-target table (migration 0008) to
 * CSV or JSON for the updated golden-set / target feed.
 *
 * Thin CLI wrapper over
 * `packages/database/src/unified-targets/export.ts`. All row mapping and
 * rendering logic lives there; this file only parses argv, opens the pool,
 * and writes the output file.
 *
 * Usage:
 *   npx tsx scripts/export-unified-targets.mts [--format csv|json]
 *     [--tier reference|high_interest|evaluate|needs_research]
 *     [--out exports/unified-targets-YYYYMMDD.csv]
 *
 * Defaults: --format csv, no tier filter, --out
 * `exports/unified-targets-<YYYYMMDD>.csv` (or `.json` for --format json).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { getPool } from "../packages/database/src/client.js";
import {
  exportUnifiedTargets,
  parseExportArgs,
} from "../packages/database/src/unified-targets/export.js";

export * from "../packages/database/src/unified-targets/export.js";

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
  const options = parseExportArgs(argv);
  const pool = getPool();
  try {
    const body = await exportUnifiedTargets(pool, options.format, options.tier);
    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(options.out, body, "utf8");
    const rowCount =
      options.format === "json"
        ? (JSON.parse(body) as unknown[]).length
        : Math.max(0, body.trimEnd().split("\n").length - 1);
    console.log(
      `[unified-targets] wrote ${rowCount} rows (${options.format}${options.tier ? `, tier=${options.tier}` : ""}) to ${options.out}`,
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
