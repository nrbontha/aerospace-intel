/**
 * Idempotent dataset import CLI.
 *
 *   npx tsx scripts/import-datasets.ts [--data-dir data] [--effective-date YYYY-MM-DD]
 *
 * Imports, in order:
 *   1. golden-set-v01                   — 'Golden Set Targets' sheet (18 members)
 *   2. grata-enrichment-v01             — 'Grata Data' sheet (18 members)
 *   3. preliminary-pipeline-v01         — 'M&A Pipeline' sheet (246 MEMBERS ONLY;
 *                                         Priority preserved verbatim in raw_payload;
 *                                         pipeline rows are NEVER leads)
 *   4. booie-original29-2026-09-09      — all 29 pre-pipeline review names
 *                                         (membership only; no guessed domains)
 *   5. ma-priorities-sample36-2026-09-09— dated 36-name SAMPLE, not the full 303
 *                                         (membership only; no priority labels)
 *   + Database Sources sheet            → data_sources (5 nominated sources)
 *   + golden examples                   → 18 proposed-label rows
 *
 * Snapshots are keyed and idempotent: same key + same content sha256 skips,
 * same key + different sha errors. Real workbooks live gitignored under
 * data/ (copied from ~/Downloads when absent) and are never committed.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  closeDatabase,
  createKnownUniverseSnapshot,
  getDatabase,
  importDataSources,
  importGoldenExamples,
  joinGoldenWithGrata,
  parseGoldenSetWorkbook,
  parseGrataData,
  parsePipeline,
  sha256Hex,
  type MatchBreakdown,
} from "@asi/database";
import { INVESTOR_VERDICTS_V1 } from "../packages/research/src/scoring-axial/fixtures/investor-verdicts.js";
import { MA_PRIORITIES_V1 } from "../packages/research/src/scoring-axial/fixtures/ma-priorities.js";

const DOWNLOAD_FALLBACKS: Record<string, string> = {
  "golden-set-v01.xlsx": "ADCO-golden-set.xlsx",
  "preliminary-pipeline.xlsx": "ADCO-pipeline.xlsx",
};

function parseArgs(argv: string[]): {
  dataDir: string;
  effectiveDate?: string;
} {
  let dataDir = "data";
  let effectiveDate: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      dataDir = argv[i + 1] ?? dataDir;
      i += 1;
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    } else if (arg === "--effective-date") {
      effectiveDate = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--effective-date=")) {
      effectiveDate = arg.slice("--effective-date=".length);
    }
  }
  return { dataDir, effectiveDate };
}

function resolveWorkbook(dataDir: string, fileName: string): Uint8Array {
  const filePath = path.join(dataDir, fileName);
  if (!existsSync(filePath)) {
    const fallback = DOWNLOAD_FALLBACKS[fileName];
    const fallbackPath =
      fallback === undefined
        ? null
        : path.join(process.env.HOME ?? "", "Downloads", fallback);
    if (fallbackPath !== null && existsSync(fallbackPath)) {
      mkdirSync(dataDir, { recursive: true });
      copyFileSync(fallbackPath, filePath);
      console.log(`copied ${fallbackPath} -> ${filePath}`);
    } else {
      throw new Error(
        `Missing workbook ${filePath} (and no ~/Downloads fallback available)`,
      );
    }
  }
  return new Uint8Array(readFileSync(filePath));
}

function fileDate(filePath: string): string {
  return statSync(filePath).mtime.toISOString().slice(0, 10);
}

interface SummaryRow {
  key: string;
  status: string;
  members: number;
  breakdown: MatchBreakdown;
}

interface FrozenMembership {
  rawName: string;
  rawDomain: string | null;
  sourceRow: number;
}

function frozenMembershipBytes(
  members: readonly FrozenMembership[],
): Uint8Array {
  const nameDomainPairs = members.map((member) => [
    member.rawName,
    member.rawDomain,
  ]);
  return new TextEncoder().encode(JSON.stringify(nameDomainPairs));
}

function printSnapshotTable(rows: SummaryRow[]): void {
  const headers = ["key", "status", "members", "exact", "probable", "none"];
  const table = rows.map((row) => [
    row.key,
    row.status,
    String(row.members),
    String(row.breakdown.exact),
    String(row.breakdown.probable),
    String(row.breakdown.none),
  ]);
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...table.map((cells) => cells[col].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(line(headers));
  for (const cells of table) console.log(line(cells));
}

async function main(): Promise<void> {
  const { dataDir, effectiveDate } = parseArgs(process.argv);
  const db = getDatabase();

  const goldenBytes = resolveWorkbook(dataDir, "golden-set-v01.xlsx");
  const pipelineBytes = resolveWorkbook(dataDir, "preliminary-pipeline.xlsx");

  const goldenSet = parseGoldenSetWorkbook(goldenBytes);
  const grataRows = parseGrataData(goldenBytes);
  const pipeline = parsePipeline(pipelineBytes);

  const booieOriginal29: FrozenMembership[] = INVESTOR_VERDICTS_V1.map(
    (entry, index) => ({
      rawName: entry.name,
      rawDomain: null,
      sourceRow: index + 1,
    }),
  );
  const maPrioritiesSample36: FrozenMembership[] = MA_PRIORITIES_V1.map(
    (entry, index) => ({
      rawName: entry.name,
      rawDomain: entry.domain,
      sourceRow: index + 1,
    }),
  );
  const summaries: SummaryRow[] = [];

  const snapshotJobs = [
    {
      key: "golden-set-v01",
      name: "Golden Set v01 (ADCO workbook)",
      sourceType: "golden_set_workbook" as const,
      bytes: goldenBytes,
      importFileName: "golden-set-v01.xlsx",
      date:
        effectiveDate ?? fileDate(path.join(dataDir, "golden-set-v01.xlsx")),
      notes:
        "Qualifying parameters: " +
        `${goldenSet.criteria.qualifying.length}; disqualifying: ${goldenSet.criteria.disqualifying.length}.`,
      members: goldenSet.companies.map((company) => ({
        rawName: company.name,
        rawDomain: company.domain,
        sourceRow: company.workbookRow,
        rawPayload: company.grataPayload,
      })),
    },
    {
      key: "grata-enrichment-v01",
      name: "Grata Enrichment v01",
      sourceType: "grata_enrichment" as const,
      bytes: goldenBytes,
      importFileName: "golden-set-v01.xlsx",
      date:
        effectiveDate ?? fileDate(path.join(dataDir, "golden-set-v01.xlsx")),
      notes: "Grata enrichment columns for the golden set.",
      members: grataRows.map((row) => ({
        rawName: row.name,
        rawDomain: row.domain,
        sourceRow: row.workbookRow,
        rawPayload: row.grataPayload,
      })),
    },
    {
      key: "preliminary-pipeline-v01",
      name: "Preliminary Pipeline v01 (ADCO workbook)",
      sourceType: "preliminary_pipeline" as const,
      bytes: pipelineBytes,
      importFileName: "preliminary-pipeline.xlsx",
      date:
        effectiveDate ??
        fileDate(path.join(dataDir, "preliminary-pipeline.xlsx")),
      notes:
        "Known-universe members only. Pipeline rows are never leads; " +
        "Priority is preserved verbatim inside raw_payload.",
      members: pipeline.rows.map((row) => {
        const cells: Array<string | number | boolean | null> = [
          row.category,
          row.domain,
          row.stage,
          row.status,
          row.rawPriority,
          row.description,
          row.revenue,
          row.ebitda,
          row.ebitdaMargin,
          row.employees,
          row.situationUpdate,
          row.situationUpdateDate,
          row.nextAction,
          row.contactMade,
          row.ndaSignedDate,
          row.ioiLoi,
          row.source,
          row.processType,
          row.hq,
          row.ownership,
          row.contactName,
          row.contactTitle,
          row.contactEmail,
        ];
        // Headers are preserved verbatim; the sheet has a SECOND 'Name'
        // header (contact first name) — later occurrences get an
        // occurrence suffix so nothing silently overwrites anything.
        // 'Name' at headers[0] already holds the company name, so the
        // contact 'Name' column becomes 'Name (2)' instead of overwriting.
        const seen = new Map<string, number>([["Name", 1]]);
        const payload: Record<string, string | number | boolean | null> = {
          Name: row.companyName,
        };
        pipeline.headers.slice(1).forEach((header, index) => {
          const count = (seen.get(header) ?? 0) + 1;
          seen.set(header, count);
          payload[count === 1 ? header : `${header} (${count})`] =
            cells[index] ?? null;
        });
        return {
          rawName: row.companyName,
          rawDomain: typeof row.domain === "string" ? row.domain : null,
          sourceRow: row.workbookRow,
          rawPayload: payload,
        };
      }),
    },
    {
      key: "booie-original29-2026-09-09",
      name: "Booie Original 29 (2026-09-09 membership)",
      sourceType: "external_export" as const,
      bytes: frozenMembershipBytes(booieOriginal29),
      importFileName: "investor-verdicts.ts",
      date: "2026-09-09",
      notes:
        "Complete membership-only reconstruction, from the frozen " +
        "investor-verdicts-v1 fixture, of all 29 names appearing in the " +
        "2026-09-09 Nikhil New Targets investor review before the new JEv " +
        "pipeline. Presence is provenance only; verdict, ownership, and decision " +
        "labels are intentionally excluded. The fixture has no verified domains, " +
        "so none were guessed. source_row is the one-based fixture array order, " +
        "not an unavailable source workbook row.",
      members: booieOriginal29,
    },
    {
      key: "ma-priorities-sample36-2026-09-09",
      name: "M&A Priorities Sample 36 (2026-09-09 membership)",
      sourceType: "external_export" as const,
      bytes: frozenMembershipBytes(maPrioritiesSample36),
      importFileName: "ma-priorities.ts",
      date: "2026-09-09",
      notes:
        "Membership-only 36-row stratified sample (12 each from Priority 1/2/3) " +
        "from the frozen ma-priorities-v1 fixture, sourced from the separately " +
        "described 303-row 2026-09-09 M&A Pipeline CSV. This snapshot is not the " +
        "complete 303-row source. Presence is provenance only; priority, " +
        "ownership, financial, category, and expected-priority labels are " +
        "intentionally excluded. source_row is the one-based fixture array order, " +
        "not an unavailable source CSV row.",
      members: maPrioritiesSample36,
    },
  ];
  for (const job of snapshotJobs) {
    const result = await createKnownUniverseSnapshot(db, {
      key: job.key,
      name: job.name,
      sourceType: job.sourceType,
      importFileName: job.importFileName,
      effectiveDate: job.date,
      notes: job.notes,
      contentSha256: sha256Hex(job.bytes),
      members: job.members,
    });
    summaries.push({
      key: job.key,
      status: result.status,
      members: result.memberCount,
      breakdown: result.matchBreakdown,
    });
  }

  printSnapshotTable(summaries);

  const sources = await importDataSources(db, goldenSet.sources);
  console.log(
    `\ndata_sources: total=${sources.total} created=${sources.created} updated=${sources.updated}` +
      (sources.unmatched.length > 0
        ? ` UNMATCHED=${sources.unmatched.join(", ")}`
        : ""),
  );

  const goldenExamplesSummary = await importGoldenExamples(
    db,
    joinGoldenWithGrata(goldenSet.companies, grataRows),
  );
  const split = Object.entries(goldenExamplesSummary.breakdown)
    .map(([type, count]) => `${type}=${count}`)
    .join(" ");
  console.log(
    `golden_examples: total=${goldenExamplesSummary.total} ` +
      `inserted=${goldenExamplesSummary.inserted} updated=${goldenExamplesSummary.updated} ` +
      `skipped_reviewed=${goldenExamplesSummary.skippedReviewed}\nproposal split: ${split}`,
  );

  await closeDatabase();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
