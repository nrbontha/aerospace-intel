/**
 * Export the `unified_targets` acquisition-target table (migration 0008) to
 * CSV or JSON for the updated golden-set / target feed.
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
// Contract: human-readable CSV headers + tier set (mirror migration 0008)
// ---------------------------------------------------------------------------

export const UNIFIED_CSV_HEADERS = [
  "Company Name",
  "Domain",
  "Website",
  "City",
  "State",
  "Country",
  "Tier",
  "Origins",
  "Golden v1",
  "Pipeline Status",
  "Fit",
  "Novelty",
  "Confidence",
  "Actionability",
  "Ensemble Decision",
  "Ensemble Confidence",
  "Why Interesting",
  "Risks",
  "Unknowns",
  "Evidence URLs",
] as const;

export const UNIFIED_TIERS = [
  "reference",
  "high_interest",
  "evaluate",
  "needs_research",
] as const;

export type UnifiedExportFormat = "csv" | "json";

export interface ExportUnifiedTargetsOptions {
  readonly format: UnifiedExportFormat;
  readonly tier: string | null;
  readonly out: string;
}

/** YYYYMMDD stamp for the default --out filename. */
export function dateStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export function defaultExportPath(format: UnifiedExportFormat): string {
  const ext = format === "json" ? "json" : "csv";
  return path.join("exports", `unified-targets-${dateStamp()}.${ext}`);
}

export function parseExportArgs(argv: readonly string[]): ExportUnifiedTargetsOptions {
  let format: UnifiedExportFormat = "csv";
  let tier: string | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format" && i + 1 < argv.length) {
      const value = argv[++i]!.trim().toLowerCase();
      if (value !== "csv" && value !== "json") {
        throw new Error(`--format must be csv|json (got "${argv[i]}")`);
      }
      format = value;
    } else if (arg === "--tier" && i + 1 < argv.length) {
      const value = argv[++i]!.trim().toLowerCase();
      if (!(UNIFIED_TIERS as readonly string[]).includes(value)) {
        throw new Error(
          `--tier must be one of ${(UNIFIED_TIERS as readonly string[]).join("|")} (got "${argv[i]}")`,
        );
      }
      tier = value;
    } else if (arg === "--out" && i + 1 < argv.length) {
      out = argv[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: export-unified-targets.mts [--format csv|json] [--tier TIER] [--out PATH]",
      );
      process.exit(0);
    }
  }
  return { format, tier, out: out ?? defaultExportPath(format) };
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const EXPORT_COLUMNS = [
  "company_name",
  "domain",
  "website_url",
  "city",
  "state_code",
  "country_code",
  "tier",
  "origins",
  "golden_v1_member",
  "pipeline_status",
  "fit",
  "novelty",
  "confidence",
  "actionability",
  "ensemble_decision",
  "ensemble_confidence",
  "why_interesting",
  "risks",
  "unknowns",
  "evidence_urls",
] as const;

function joinList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = (value as unknown[])
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  return items.length === 0 ? null : items.join("; ");
}

function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** Map one `unified_targets` row to the human-readable CSV record. */
export function toCsvRecord(row: Record<string, unknown>): Record<string, string> {
  const cells: Record<string, string | null> = {
    "Company Name": cellText(row["company_name"]),
    Domain: cellText(row["domain"]),
    Website: cellText(row["website_url"]),
    City: cellText(row["city"]),
    State: cellText(row["state_code"]),
    Country: cellText(row["country_code"]),
    Tier: cellText(row["tier"]),
    Origins: joinList(row["origins"]),
    "Golden v1": row["golden_v1_member"] === true ? "yes" : "no",
    "Pipeline Status": cellText(row["pipeline_status"]),
    Fit: cellText(row["fit"]),
    Novelty: cellText(row["novelty"]),
    Confidence: cellText(row["confidence"]),
    Actionability: cellText(row["actionability"]),
    "Ensemble Decision": cellText(row["ensemble_decision"]),
    "Ensemble Confidence": cellText(row["ensemble_confidence"]),
    "Why Interesting": cellText(row["why_interesting"]),
    Risks: cellText(row["risks"]),
    Unknowns: cellText(row["unknowns"]),
    "Evidence URLs": joinList(row["evidence_urls"]),
  };
  return Object.fromEntries(
    UNIFIED_CSV_HEADERS.map((h) => [h, cells[h] ?? ""]),
  ) as Record<string, string>;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function stringifyUnifiedCsv(
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [UNIFIED_CSV_HEADERS.map(csvEscape).join(",")];
  for (const row of rows) {
    const record = toCsvRecord(row);
    lines.push(UNIFIED_CSV_HEADERS.map((h) => csvEscape(record[h]!)).join(","));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const options = parseExportArgs(argv);
  const pool = getPool();
  try {
    const where =
      options.tier === null ? "" : "WHERE tier = $1";
    const params = options.tier === null ? [] : [options.tier];
    const { rows } = await pool.query(
      `SELECT ${EXPORT_COLUMNS.join(", ")} FROM unified_targets ${where} ORDER BY company_name`,
      params,
    );
    let body: string;
    if (options.format === "json") {
      body = `${JSON.stringify(rows, null, 2)}\n`;
    } else {
      body = stringifyUnifiedCsv(rows as Record<string, unknown>[]);
    }
    await mkdir(path.dirname(options.out), { recursive: true });
    await writeFile(options.out, body, "utf8");
    console.log(
      `[unified-targets] wrote ${rows.length} rows (${options.format}${options.tier ? `, tier=${options.tier}` : ""}) to ${options.out}`,
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
