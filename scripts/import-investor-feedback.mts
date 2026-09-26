/**
 * Import Booie's round-2 investor verdicts on the 29-row "Nikhil New Targets"
 * CSV into the feedback journal + ownership observations.
 *
 * For each row (row 1 is blank, row 2 is the header) this writes:
 *  - one channel='investment' feedback record via createFeedbackRecord
 *    (verdict + verbatim Booie commentary, reviewer Booie, date 2026-09-09),
 *  - one ownership_observations row for acquired targets (owner name +
 *    event year + acquisition note from the shared-contract owner map),
 *    backed by a single investor-feedback data source / source document /
 *    per-company evidence chain.
 *
 * Company resolution is normalized domain first, then normalized name
 * (same helpers as golden seeding). Unmatched names get a minimal company
 * shell so no verdict is ever dropped; the feedback payload records
 * matched/unmatched plus the raw name.
 *
 * Verdict mapping (shared contract):
 *   Add=Yes                              -> add / shortlist
 *   Add=Maybe                            -> hold / hold
 *   Relevant=Yes + acquired comment      -> pass_acquired / historical_ideal_unactionable
 *   Relevant=Yes + public comment        -> hold / hold (+ public note)
 *   dead comment (Keddeg, gone 2008)     -> pass_dead / reject
 *   Relevant=No (wrong sector/too large) -> pass_sector / reject
 *
 * Idempotent: re-runs skip feedback whose payload.importKey already exists
 * and ownership facts with the same (company, owner) pair.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/import-investor-feedback.mts \
 *     [--csv "/Users/nrb/Downloads/ADCO MA Pipeline 2026.09.09.xlsx - Nikhil New Targets 2026.09.09.csv"] \
 *     [--dry-run] [--limit N]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";

import {
  closeDatabase,
  companies,
  companyDomains,
  companySourceLinks,
  createFeedbackRecord,
  dataSources,
  evidence,
  getDatabase,
  normalizeDomain,
  normalizeLegalName,
  ownershipObservations,
  parseCsv,
  sourceDocuments,
  users,
} from "@asi/database";

const DEFAULT_CSV =
  "/Users/nrb/Downloads/ADCO MA Pipeline 2026.09.09.xlsx - Nikhil New Targets 2026.09.09.csv";
const REVIEWER = "Booie";
const REVIEW_DATE = "2026-09-09";
const SOURCE_NAME = "ADCO investor feedback 2026-09-09 (Nikhil new targets)";
const SOURCE_TYPE = "investor_feedback";
const DOCUMENT_URL =
  "investor-feedback://adco-ma-pipeline-2026-09-09/nikhil-new-targets";
const EXTRACTION_METHOD = "investor-feedback-import.v1";
const OBSERVED_AT = new Date("2026-09-09T00:00:00Z");

type PipelineDecision =
  | "add"
  | "hold"
  | "pass_acquired"
  | "pass_scale"
  | "pass_dead"
  | "pass_sector"
  | "unreviewed";

type InvestmentAction =
  | "strong_fit"
  | "possible_fit"
  | "shortlist"
  | "hold"
  | "needs_more_research"
  | "reject"
  | "historical_ideal_unactionable";

interface OwnerFact {
  owner: string;
  year: number | null;
  note: string | null;
}

/**
 * Shared-contract acquired-owner map, keyed by display name (normalized at
 * lookup time). Owner strings follow Booie's commentary verbatim.
 */
const OWNER_MAP_ENTRIES: Array<{ name: string; fact: OwnerFact }> = [
  {
    name: "Ametek Ameron LLC d/b/a Mass Systems",
    fact: { owner: "Ametek", year: 2009, note: "acquisition" },
  },
  {
    name: "B/E Aerospace Inc, DBA, SMR Technologies Inc",
    fact: { owner: "Loar Group", year: 2019, note: "acquisition" },
  },
  {
    name: "CPI Eimac Division",
    fact: {
      owner: "CPI (TJC portfolio company)",
      year: null,
      note: "add-on acquisition",
    },
  },
  {
    name: "Dart Aerospace",
    fact: { owner: "TransDigm", year: null, note: "acquisition" },
  },
  {
    name: "Jet Parts Engineering, Inc. (JPE)",
    fact: { owner: "TransDigm", year: null, note: "acquisition" },
  },
  {
    name: "Kirkhill Aircraft Parts Company",
    fact: {
      owner: "TransDigm (via Esterline)",
      year: null,
      note: "acquisition",
    },
  },
  {
    name: "PRECISION AIRMOTIVE LLC",
    fact: {
      owner: "McFarlane Aviation (via Vance Street Capital)",
      year: null,
      note: "add-on acquisition",
    },
  },
  {
    name: "Raisbeck Engineering Inc",
    fact: { owner: "Acorn Capital", year: 2016, note: "acquisition" },
  },
  {
    name: "Robertson Fuel Systems LLC",
    fact: { owner: "HEICO", year: 2016, note: "acquisition for $255m" },
  },
  {
    name: "Shadin Avionics",
    fact: { owner: "Two PE firms", year: 2020, note: "acquisition" },
  },
  {
    name: "Sirius Technologies, Inc., DBA Flight Display System",
    fact: { owner: "Vance Street Partners", year: 2021, note: "acquisition" },
  },
  {
    name: "Turbine Kinetics Inc, Subsidiary of HEICO Corp",
    fact: {
      owner: "HEICO",
      year: null,
      note: "acquisition; subsidiary of HEICO",
    },
  },
  {
    name: "Vibro-Meter Corp",
    fact: {
      owner: "Parker Hannifin (via Meggitt)",
      year: null,
      note: "acquisition",
    },
  },
  {
    name: "Wellman Products Group",
    fact: { owner: "Carlisle Companies", year: null, note: "acquisition" },
  },
  {
    name: "Meggitt Thermal Systems Inc",
    fact: { owner: "Parker Hannifin", year: 2022, note: "acquisition" },
  },
  {
    name: "VisionSafe Corporation",
    fact: { owner: "The Stephens Group", year: 2024, note: "acquisition" },
  },
];

const DEAD_COMMENT =
  /no longer exists|defunct|ceased operations|shut down|dissolved|out of business/i;
const PUBLIC_COMMENT = /public company|publicly traded|nasdaq|nyse/i;
const ACQUIRED_COMMENT = /acquired/i;

function flagValue(value: string): string {
  return value.trim().toLowerCase();
}

function decide(row: {
  name: string;
  relevant: string;
  add: string;
  commentary: string;
}): {
  decision: PipelineDecision;
  action: InvestmentAction;
} {
  const relevant = flagValue(row.relevant);
  const add = flagValue(row.add);
  if (add === "yes") return { decision: "add", action: "shortlist" };
  if (DEAD_COMMENT.test(row.commentary))
    return { decision: "pass_dead", action: "reject" };
  if (relevant === "no") return { decision: "pass_sector", action: "reject" };
  if (add === "maybe") return { decision: "hold", action: "hold" };
  if (ACQUIRED_COMMENT.test(row.commentary)) {
    return {
      decision: "pass_acquired",
      action: "historical_ideal_unactionable",
    };
  }
  // Relevant-but-unactionable without an acquisition (e.g. Butler National,
  // public ~$98M rev): retain the profile as a hold.
  return { decision: "hold", action: "hold" };
}

function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== "")
    return;
  for (const candidate of [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), ".env"),
  ]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^DATABASE_URL=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) {
        process.env.DATABASE_URL = match[1].trim();
        return;
      }
    }
  }
  throw new Error("DATABASE_URL is required (env or .env.local)");
}

function flagAfter(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const raw = process.argv[idx + 1];
  if (raw === undefined || raw.startsWith("--")) return undefined;
  return raw;
}

function flagEquals(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

/**
 * The export names its first column empty and leaves a blank first row;
 * parseCsv skips blank rows but rejects the empty header, so name that
 * column before parsing. The header line never contains quoted newlines.
 */
function prepareCsvText(text: string): string {
  const marker = text.indexOf("Company Name");
  if (marker === -1)
    throw new Error("CSV header row with 'Company Name' not found");
  const lineStart = text.lastIndexOf("\n", marker) + 1;
  if (text[lineStart] !== ",") {
    throw new Error(
      "expected the header row to start with an empty first column",
    );
  }
  return `${text.slice(0, lineStart)}row_id${text.slice(lineStart)}`;
}

async function main(): Promise<void> {
  const csvPath = flagAfter("--csv") ?? flagEquals("--csv") ?? DEFAULT_CSV;
  const dryRun = process.argv.includes("--dry-run");
  const limitRaw = flagAfter("--limit") ?? flagEquals("--limit");
  let limit = Number.POSITIVE_INFINITY;
  if (limitRaw !== undefined) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      console.error("--limit must be a positive integer");
      process.exit(2);
    }
    limit = parsed;
  }
  if (!existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(2);
  }

  const rawText = readFileSync(csvPath, "utf8");
  const { rows } = parseCsv(prepareCsvText(rawText));
  const dataRows = rows
    .map((record, index) => ({
      workbookRow: index + 3,
      name: record.company_name ?? "",
      domain: record.domain ?? "",
      relevant: record.relevant ?? "",
      add: record.add_to_pipeline ?? "",
      commentary: record.commentary_booie ?? "",
    }))
    .filter((row) => row.name.trim() !== "")
    .slice(0, limit);
  if (dataRows.length === 0)
    throw new Error("no named company rows found in the CSV");

  const ownerByName = new Map(
    OWNER_MAP_ENTRIES.map((entry) => [
      normalizeLegalName(entry.name),
      entry.fact,
    ]),
  );

  loadDatabaseUrl();
  const db = getDatabase();
  const [actor] = await db.select({ id: users.id }).from(users).limit(1);
  if (actor === undefined)
    throw new Error(
      "No users — seed at least one user before importing feedback",
    );

  const fileSha256 = createHash("sha256").update(rawText, "utf8").digest("hex");

  let dataSourceId: string | null = null;
  let documentId: string | null = null;
  if (!dryRun) {
    const [existingSource] = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(sql`lower(${dataSources.name}) = lower(${SOURCE_NAME})`)
      .limit(1);
    dataSourceId = existingSource?.id ?? null;
    if (dataSourceId === null) {
      const [created] = await db
        .insert(dataSources)
        .values({
          name: SOURCE_NAME,
          sourceType: SOURCE_TYPE,
          access: "public",
          ingestion: "manual",
          publisher: REVIEWER,
          notes: `Round-2 investor verdicts on the Nikhil new-targets sheet, reviewed ${REVIEW_DATE}.`,
        })
        .onConflictDoNothing()
        .returning({ id: dataSources.id });
      dataSourceId =
        created?.id ??
        (
          await db
            .select({ id: dataSources.id })
            .from(dataSources)
            .where(sql`lower(${dataSources.name}) = lower(${SOURCE_NAME})`)
            .limit(1)
        )[0]?.id ??
        null;
    }
    if (dataSourceId === null)
      throw new Error("could not ensure investor-feedback data source");

    const [existingDoc] = await db
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.contentSha256, fileSha256))
      .limit(1);
    documentId = existingDoc?.id ?? null;
    if (documentId === null) {
      const [created] = await db
        .insert(sourceDocuments)
        .values({
          dataSourceId,
          canonicalUrl: DOCUMENT_URL,
          title: "Nikhil New Targets 2026.09.09 (Booie review)",
          documentType: "spreadsheet",
          contentSha256: fileSha256,
          mimeType: "text/csv",
          metadata: {
            reviewer: REVIEWER,
            reviewDate: REVIEW_DATE,
            sourceFile: path.basename(csvPath),
          },
        })
        .onConflictDoNothing()
        .returning({ id: sourceDocuments.id });
      documentId =
        created?.id ??
        (
          await db
            .select({ id: sourceDocuments.id })
            .from(sourceDocuments)
            .where(eq(sourceDocuments.contentSha256, fileSha256))
            .limit(1)
        )[0]?.id ??
        null;
    }
    if (documentId === null)
      throw new Error("could not ensure investor-feedback source document");
  }

  const counts = {
    rows: dataRows.length,
    verdictsRecorded: 0,
    verdictsSkippedExisting: 0,
    ownershipFacts: 0,
    ownershipSkippedExisting: 0,
    matched: 0,
    unmatched: 0,
    companiesCreated: 0,
  };

  for (const row of dataRows) {
    const { decision, action } = decide(row);
    const normalizedDomain = normalizeDomain(row.domain);
    let companyId: string | null = null;
    if (normalizedDomain !== null) {
      const byDomain = await db.execute<{ id: string }>(sql`
        SELECT c.id
        FROM company_domains d
        JOIN companies c ON c.id = d.company_id
        WHERE lower(d.domain) = ${normalizedDomain}
        LIMIT 1
      `);
      companyId = byDomain.rows[0]?.id ?? null;
    }
    if (companyId === null) {
      const normalizedName = normalizeLegalName(row.name);
      const byName = await db.execute<{ id: string }>(sql`
        SELECT id FROM companies
        WHERE lower(legal_name) = ${normalizedName} OR lower(display_name) = ${normalizedName}
        LIMIT 1
      `);
      companyId = byName.rows[0]?.id ?? null;
    }
    const matched = companyId !== null;

    if (dryRun) {
      if (matched) counts.matched += 1;
      else counts.unmatched += 1;
      console.log(
        `  ${(matched ? "match" : "create").padEnd(6)} ${row.name.padEnd(48)} ` +
          `relevant=${flagValue(row.relevant) || "-"} add=${flagValue(row.add) || "-"} -> ${decision}/${action}`,
      );
      continue;
    }
    if (companyId === null) {
      const [inserted] = await db
        .insert(companies)
        .values({
          displayName: row.name.trim(),
          legalName: normalizeLegalName(row.name),
          websiteUrl:
            normalizedDomain === null ? null : `https://${normalizedDomain}`,
        })
        .returning({ id: companies.id });
      if (inserted === undefined)
        throw new Error(`company insert returned no row for ${row.name}`);
      companyId = inserted.id;
      counts.companiesCreated += 1;
      if (normalizedDomain !== null) {
        await db
          .insert(companyDomains)
          .values({ companyId, domain: normalizedDomain, isPrimary: true })
          .onConflictDoNothing();
      }
    }
    if (matched) counts.matched += 1;
    else counts.unmatched += 1;

    const importKey = `investor-2026-09-09|${normalizeLegalName(row.name)}`;
    const [existingFeedback] = await db.execute<{ id: string }>(sql`
      SELECT id FROM feedback
      WHERE company_id = ${companyId} AND payload->>'importKey' = ${importKey}
      LIMIT 1
    `);
    const ownerFact =
      decision === "pass_acquired"
        ? (ownerByName.get(normalizeLegalName(row.name)) ?? null)
        : null;
    const isPublicHold =
      decision === "hold" && PUBLIC_COMMENT.test(row.commentary);

    if (existingFeedback === undefined) {
      await createFeedbackRecord(db, {
        channel: "investment",
        action,
        companyId,
        reason: `${REVIEWER} ${REVIEW_DATE}: Relevant=${row.relevant.trim() || "?"} Add=${row.add.trim() || "?"} -> ${decision}`,
        payload: {
          importKey,
          source: "nikhil-new-targets-2026-09-09",
          reviewer: REVIEWER,
          reviewDate: REVIEW_DATE,
          verdict: decision,
          relevant: row.relevant.trim(),
          addToPipeline: row.add.trim(),
          rawName: row.name.trim(),
          domain: normalizedDomain,
          matched,
          ...(ownerFact === null
            ? {}
            : {
                owner: ownerFact.owner,
                eventYear: ownerFact.year,
                acquisition: ownerFact.note,
              }),
          ...(isPublicHold
            ? {
                publicCompany: true,
                subsidiaries: ["Avcon Industries", "BNC Tempe"],
              }
            : {}),
          ...(decision === "pass_dead" ? { ceasedOperations: "2008" } : {}),
        },
        notes: row.commentary.trim() === "" ? null : row.commentary.trim(),
        actor: actor.id,
      });
      counts.verdictsRecorded += 1;
    } else {
      counts.verdictsSkippedExisting += 1;
    }

    if (ownerFact !== null && dataSourceId !== null && documentId !== null) {
      const [existingFact] = await db
        .select({ id: ownershipObservations.id })
        .from(ownershipObservations)
        .where(
          and(
            eq(ownershipObservations.companyId, companyId),
            eq(ownershipObservations.ownerName, ownerFact.owner),
          ),
        )
        .limit(1);
      if (existingFact !== undefined) {
        counts.ownershipSkippedExisting += 1;
      } else {
        const [evidenceRow] = await db
          .insert(evidence)
          .values({
            sourceDocumentId: documentId,
            extractionStatus: "completed",
            quote: row.commentary.trim(),
            extractionMethod: EXTRACTION_METHOD,
            metadata: {
              reviewer: REVIEWER,
              reviewDate: REVIEW_DATE,
              verdict: decision,
              companyName: row.name.trim(),
            },
          })
          .returning({ id: evidence.id });
        if (evidenceRow === undefined)
          throw new Error(`evidence insert returned no row for ${row.name}`);
        await db
          .insert(companySourceLinks)
          .values({ dataSourceId, companyId, relationship: "mentions" })
          .onConflictDoNothing();
        await db.insert(ownershipObservations).values({
          companyId,
          type: "subsidiary",
          ownerName: ownerFact.owner,
          validFrom: ownerFact.year === null ? null : `${ownerFact.year}-01-01`,
          confidence: "0.9",
          evidenceId: evidenceRow.id,
          observedAt: OBSERVED_AT,
        });
        counts.ownershipFacts += 1;
      }
    }

    console.log(
      `  ${(matched ? "match" : "create").padEnd(6)} ${row.name.padEnd(48)} ` +
        `-> ${decision}/${action}` +
        (ownerFact === null
          ? ""
          : ` owner=${ownerFact.owner}${ownerFact.year === null ? "" : ` (${ownerFact.year})`}`),
    );
  }

  console.log(
    `\nsummary${dryRun ? " (dry run)" : ""}: rows=${counts.rows} ` +
      `verdicts_recorded=${counts.verdictsRecorded} verdicts_skipped_existing=${counts.verdictsSkippedExisting} ` +
      `ownership_facts=${counts.ownershipFacts} ownership_skipped_existing=${counts.ownershipSkippedExisting} ` +
      `matched=${counts.matched} unmatched=${counts.unmatched} companies_created=${counts.companiesCreated}`,
  );
  if (dryRun) {
    console.log("tables written: none (dry run)");
  } else {
    console.log(
      "tables written: feedback (+ audit_events via createFeedbackRecord), " +
        "data_sources, source_documents, evidence, company_source_links, ownership_observations" +
        (counts.companiesCreated > 0 ? ", companies, company_domains" : ""),
    );
  }

  await closeDatabase();
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
