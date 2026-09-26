/**
 * Import the 409-row ADCO M&A Pipeline CSV (2026-09-09) as a dated
 * known-universe snapshot.
 *
 *   npx tsx scripts/import-ma-pipeline.mts [--csv <path>] [--dry-run] [--limit N]
 *
 * Reads the CSV with a small local parser (the export layout differs from
 * the xlsx 'M&A Pipeline' sheet: no Stage/Status columns, contacts as
 * Name/Title/Email), reuses `toNumber`/`toText` from the import-parsers
 * where they fit, and writes:
 *   1. one `preliminary_pipeline` snapshot (closest fit in the
 *      snapshotSourceType vocabulary — the same sourceType the xlsx M&A
 *      Pipeline sheet used), members carry the verbatim row payload
 *      (Name/Category/Domain/Priority/Description/Revenue/EBITDA/
 *      Employees/contacts/...);
 *   2. revenue / employee / ownership facts for exactly-matched companies
 *      (financial_observations + employee_observations +
 *      ownership_observations behind one evidence row per company);
 *   3. probable matches stay candidates only: the member row records
 *      matched_company_id + match_confidence and NOTHING is auto-merged.
 *      (`identity_match_candidates` is lead-scoped, and pipeline rows are
 *      NEVER leads, so no rows are written there.)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { and, eq } from "drizzle-orm";

import {
  closeDatabase,
  dataSources,
  employeeObservations,
  evidence,
  financialObservations,
  getDatabase,
  knownUniverseMembers,
  ownershipObservations,
  sha256Hex,
  sourceDocuments,
  createKnownUniverseSnapshot,
} from "@asi/database";
import {
  toNumber,
  toText,
} from "../packages/database/src/import-parsers/internal.js";

// ---------------------------------------------------------------------------
// env bootstrap (mirror scripts/populate-unified-targets.mts)
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

const DEFAULT_CSV =
  "/Users/nrb/Downloads/ADCO MA Pipeline 2026.09.09.xlsx - M&A Pipeline.csv";

// ---------------------------------------------------------------------------
// tiny CSV parser (RFC-4180 shaped: quotes, doubled quotes, CRLF, embedded
// newlines). Returns rows with the 1-based physical line each row starts on.
// ---------------------------------------------------------------------------
interface CsvRow {
  cells: string[];
  line: number;
}

function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowStartLine = 1;
  let line = 1;
  let fieldTouched = false;

  const pushField = (): void => {
    cells.push(field);
    field = "";
    fieldTouched = false;
  };
  const pushRow = (): void => {
    // Drop trailing all-empty rows (e.g. final newline).
    if (cells.length > 0 || fieldTouched || field !== "") {
      pushField();
      if (cells.some((c) => c !== "")) rows.push({ cells, line: rowStartLine });
    }
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
        fieldTouched = true;
      } else {
        field += ch;
        fieldTouched = true;
        if (ch === "\n") line++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      fieldTouched = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\r") {
      // skip; LF handles the break
    } else if (ch === "\n") {
      pushRow();
      line++;
      rowStartLine = line;
    } else {
      field += ch;
      fieldTouched = true;
    }
  }
  pushRow();
  return rows;
}

// ---------------------------------------------------------------------------
// row mapping (positional; the export has a leading empty column and a
// SECOND 'Name' header at index 18 holding the contact name)
// ---------------------------------------------------------------------------
const COL = {
  name: 1,
  category: 2,
  domain: 3,
  priority: 4,
  description: 5,
  revenue: 6,
  ebitda: 7,
  employees: 8,
  situationUpdate: 9,
  situationUpdateDate: 10,
  nextAction: 11,
  contactMade: 12,
  ndaSignedDate: 13,
  ioiLoi: 14,
  source: 15,
  hq: 16,
  ownership: 17,
  contactName: 18,
  contactTitle: 19,
  contactEmail: 20,
} as const;

interface PipelineCsvRow {
  line: number;
  name: string;
  domain: string | null;
  payload: Record<string, unknown>;
  revenue: number | null;
  employees: number | null;
  ownership: string | null;
}

/** "$1,000,000" / "15,535,000" / "$98M"-shaped cells → plain number or null. */
function parseMoney(value: string | null): number | null {
  if (value === null) return null;
  const cleaned = value.replace(/[$,\s]/g, "");
  if (cleaned === "") return null;
  const scaled = /^([0-9]+(?:\.[0-9]+)?)([mMkK])$/.exec(cleaned);
  if (scaled !== null) {
    const base = Number(scaled[1]);
    if (!Number.isFinite(base)) return null;
    const mult = scaled[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000;
    return base * mult;
  }
  return toNumber(cleaned);
}

function parsePipelineCsv(
  text: string,
  limit: number | null,
): PipelineCsvRow[] {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex(
    (r) => (r.cells[COL.name] ?? "").trim() === "Name",
  );
  if (headerIdx === -1) throw new Error("Pipeline CSV header row not found");
  const headers = rows[headerIdx]!.cells;

  const out: PipelineCsvRow[] = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const name = toText(
      row.cells[COL.name]?.trim() === "" ? null : row.cells[COL.name],
    );
    if (name === null || name === "") continue;
    // Verbatim payload keyed by header; the contact 'Name' column becomes
    // 'Name (2)' so it never overwrites the company name.
    const seen = new Map<string, number>();
    const payload: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      const label = header === "" ? `Column ${index + 1}` : header;
      const count = (seen.get(label) ?? 0) + 1;
      seen.set(label, count);
      const key = count === 1 ? label : `${label} (${count})`;
      const cell = row.cells[index] ?? "";
      payload[key] = cell === "" ? null : cell;
    });
    out.push({
      line: row.line,
      name: name.trim(),
      domain:
        toText(
          row.cells[COL.domain]?.trim() === "" ? null : row.cells[COL.domain],
        )?.trim() || null,
      payload,
      revenue: parseMoney(
        toText(
          row.cells[COL.revenue]?.trim() === "" ? null : row.cells[COL.revenue],
        ),
      ),
      employees: toNumber(
        (row.cells[COL.employees] ?? "").trim() === ""
          ? null
          : row.cells[COL.employees],
      ),
      ownership:
        toText(
          row.cells[COL.ownership]?.trim() === ""
            ? null
            : row.cells[COL.ownership],
        )?.trim() || null,
    });
    if (limit !== null && out.length >= limit) break;
  }
  return out;
}

function ownershipTypeFor(raw: string): string {
  const lower = raw.toLowerCase();
  if (/\bpublic\b/.test(lower)) return "public";
  if (/\bsubsidiar|\bdivision\b|\bunit of\b|portfolio company\b/.test(lower))
    return "subsidiary";
  if (/\bgovernment\b|state-owned\b/.test(lower)) return "government";
  if (/\bjoint venture\b|\bjv\b/.test(lower)) return "joint_venture";
  if (/\bprivate\b/.test(lower)) return "private";
  return "unknown";
}

function parseArgs(argv: string[]): {
  csv: string;
  dryRun: boolean;
  limit: number | null;
} {
  let csv = DEFAULT_CSV;
  let dryRun = false;
  let limit: number | null = null;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--csv") csv = argv[++i] ?? csv;
    else if (arg.startsWith("--csv=")) csv = arg.slice("--csv=".length);
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--limit") limit = Number(argv[++i]);
    else if (arg.startsWith("--limit="))
      limit = Number(arg.slice("--limit=".length));
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0))
    throw new Error("--limit must be a positive integer");
  return { csv, dryRun, limit };
}

async function main(): Promise<void> {
  const { csv, dryRun, limit } = parseArgs(process.argv);
  if (!existsSync(csv)) throw new Error(`CSV not found: ${csv}`);
  const bytes = readFileSync(csv);
  const parsed = parsePipelineCsv(bytes.toString("utf8"), limit);

  const withRevenue = parsed.filter((r) => r.revenue !== null).length;
  const withEmployees = parsed.filter((r) => r.employees !== null).length;
  const withOwnership = parsed.filter((r) => r.ownership !== null).length;
  console.log(
    `[ma-pipeline] parsed=${parsed.length} with_revenue=${withRevenue} ` +
      `with_employees=${withEmployees} with_ownership=${withOwnership}` +
      (limit !== null ? ` (limit=${limit})` : ""),
  );
  for (const row of parsed.slice(0, 3)) {
    console.log(
      `  row line=${row.line} name=${JSON.stringify(row.name)} ` +
        `domain=${row.domain ?? "-"} revenue=${row.revenue ?? "-"} ` +
        `employees=${row.employees ?? "-"} ownership=${row.ownership ?? "-"}`,
    );
  }
  if (dryRun) {
    console.log("[ma-pipeline] dry-run: no writes performed");
    return;
  }

  const dateMatch = path.basename(csv).match(/(\d{4})\.(\d{2})\.(\d{2})/);
  const effectiveDate = dateMatch
    ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
    : new Date().toISOString().slice(0, 10);
  const dateKey = effectiveDate.replaceAll("-", "");
  const key = `ma-pipeline-${dateKey}`;

  const db = getDatabase();
  try {
    const result = await createKnownUniverseSnapshot(db, {
      key,
      name: `M&A Pipeline ${effectiveDate} (ADCO curated CSV)`,
      sourceType: "preliminary_pipeline",
      importFileName: path.basename(csv),
      effectiveDate,
      notes:
        "409-row ADCO curated M&A target list (CSV export). Known-universe " +
        "members only; pipeline rows are never leads. Priority preserved " +
        "verbatim inside raw_payload.",
      contentSha256: sha256Hex(bytes),
      members: parsed.map((row) => ({
        rawName: row.name,
        rawDomain: row.domain,
        sourceRow: row.line,
        rawPayload: row.payload,
      })),
    });
    const b = result.matchBreakdown;
    console.log(
      `[ma-pipeline] snapshot key=${key} status=${result.status} ` +
        `members=${result.memberCount} exact=${b.exact} probable=${b.probable} none=${b.none}`,
    );

    // --- facts for exactly-matched companies only -------------------------
    let revenueFacts = 0;
    let employeeFacts = 0;
    let ownershipFacts = 0;
    if (result.status === "created" && b.exact > 0) {
      // Evidence chain: one data_sources row + one source_document for the
      // CSV file; one evidence row per matched company covering its facts.
      const existingSource = await db
        .select({ id: dataSources.id })
        .from(dataSources)
        .where(eq(dataSources.name, "ADCO M&A Pipeline"))
        .limit(1);
      let dataSourceId = existingSource[0]?.id ?? null;
      if (dataSourceId === null) {
        const [created] = await db
          .insert(dataSources)
          .values({
            name: "ADCO M&A Pipeline",
            sourceType: "investor_pipeline_export",
            publisher: "ADCO",
            ingestion: "manual",
            notes:
              "Curated M&A target list shared by the investor (CSV export).",
          })
          .returning({ id: dataSources.id });
        dataSourceId = created!.id;
      }
      const fileSha = sha256Hex(bytes);
      const existingDoc = await db
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.contentSha256, fileSha))
        .limit(1);
      let documentId = existingDoc[0]?.id ?? null;
      if (documentId === null) {
        const [doc] = await db
          .insert(sourceDocuments)
          .values({
            dataSourceId,
            storageKey: csv,
            title: path.basename(csv),
            documentType: "csv",
            contentSha256: fileSha,
            metadata: { snapshotKey: key, effectiveDate },
          })
          .returning({ id: sourceDocuments.id });
        documentId = doc!.id;
      }

      const members = await db
        .select()
        .from(knownUniverseMembers)
        .where(
          and(
            eq(knownUniverseMembers.snapshotId, result.snapshot.id),
            eq(knownUniverseMembers.matchStatus, "exact"),
          ),
        );
      const byLine = new Map(parsed.map((r) => [r.line, r]));
      for (const member of members) {
        if (member.companyId === null || member.sourceRow === null) continue;
        const row = byLine.get(member.sourceRow);
        if (row === undefined) continue;
        const hasFact =
          row.revenue !== null ||
          row.employees !== null ||
          row.ownership !== null;
        if (!hasFact) continue;
        const quoteParts: string[] = [];
        if (row.revenue !== null) quoteParts.push(`Revenue ${row.revenue}`);
        if (row.employees !== null)
          quoteParts.push(`Employees ${row.employees}`);
        if (row.ownership !== null)
          quoteParts.push(`Ownership ${row.ownership}`);
        const quote = `${row.name} — M&A Pipeline ${effectiveDate}, CSV row ${row.line}: ${quoteParts.join("; ")}`;
        const [evidenceRow] = await db
          .insert(evidence)
          .values({
            sourceDocumentId: documentId,
            extractionStatus: "completed",
            quote,
            locator: `M&A Pipeline CSV row ${row.line}`,
            extractionMethod: "ma_pipeline_csv_import",
            contentSha256: sha256Hex(Buffer.from(quote, "utf8")),
            metadata: { snapshotKey: key, csvRow: row.line },
          })
          .returning({ id: evidence.id });
        const evidenceId = evidenceRow!.id;
        if (row.revenue !== null) {
          const dup = await db
            .select({ id: financialObservations.id })
            .from(financialObservations)
            .where(
              and(
                eq(financialObservations.companyId, member.companyId),
                eq(financialObservations.metric, "revenue"),
                eq(financialObservations.amountLower, String(row.revenue)),
              ),
            )
            .limit(1);
          if (dup.length === 0) {
            await db.insert(financialObservations).values({
              companyId: member.companyId,
              metric: "revenue",
              amountLower: String(row.revenue),
              amountUpper: String(row.revenue),
              currency: "USD",
              confidence: "0.600",
              evidenceId,
            });
            revenueFacts++;
          }
        }
        if (row.employees !== null) {
          const dup = await db
            .select({ id: employeeObservations.id })
            .from(employeeObservations)
            .where(
              and(
                eq(employeeObservations.companyId, member.companyId),
                eq(employeeObservations.employeeCountLower, row.employees),
              ),
            )
            .limit(1);
          if (dup.length === 0) {
            await db.insert(employeeObservations).values({
              companyId: member.companyId,
              employeeCountLower: row.employees,
              employeeCountUpper: row.employees,
              confidence: "0.600",
              evidenceId,
            });
            employeeFacts++;
          }
        }
        if (row.ownership !== null) {
          const dup = await db
            .select({ id: ownershipObservations.id })
            .from(ownershipObservations)
            .where(
              and(
                eq(ownershipObservations.companyId, member.companyId),
                eq(ownershipObservations.ownerName, row.ownership),
              ),
            )
            .limit(1);
          if (dup.length === 0) {
            await db.insert(ownershipObservations).values({
              companyId: member.companyId,
              type: ownershipTypeFor(row.ownership),
              ownerName: row.ownership,
              confidence: "0.700",
              evidenceId,
            });
            ownershipFacts++;
          }
        }
      }
    }
    console.log(
      `[ma-pipeline] facts revenue=${revenueFacts} employees=${employeeFacts} ` +
        `ownership=${ownershipFacts} (exact matches only; probable=${b.probable} ` +
        `recorded as member candidates, never auto-merged)`,
    );
    console.log(
      `[ma-pipeline] tables: known_universe_snapshots + known_universe_members` +
        (revenueFacts + employeeFacts + ownershipFacts > 0
          ? ` + data_sources/source_documents/evidence + financial_observations/employee_observations/ownership_observations`
          : ``),
    );
  } finally {
    await closeDatabase();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    try {
      await closeDatabase();
    } catch {
      // ignore secondary close errors
    }
    process.exitCode = 1;
  });
}
