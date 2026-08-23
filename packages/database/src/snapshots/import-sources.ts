import { eq, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { dataSources } from "../schema.js";
import type { DatabaseSourceRow } from "../import-parsers/types.js";

/**
 * Database Sources sheet importer.
 *
 * Rows are keyed by exact name (the natural unique index is
 * lower(name) + coalesce(publisher,'')). Access states are recorded HONESTLY:
 * the workbook distinguishes granular states (`public_account_required`,
 * `paid_subscription`, `api_key_required`, `public_no_auth`, `restricted`)
 * and model-processing policies that the current `source_access` /
 * `source_ingestion` enums cannot express, so each row maps to the nearest
 * enum value and carries the precise state verbatim in `notes`.
 */
type SourcePolicy = {
  /** Free-text source_type, matching the workbook's "Database Sources" framing. */
  sourceType: string;
  access: "public" | "authorized" | "restricted_metadata_only";
  ingestion: "manual" | "upload" | "web_fetch" | "api" | "import";
  /** Precise access-state vocabulary from the source-and-evidence policy. */
  accessState: string;
  modelProcessing: string;
};

const POLICIES_BY_LOWER_NAME: Record<string, SourcePolicy> = {
  "online aerospace supplier information system (oasis)": {
    sourceType: "web_database",
    access: "authorized",
    ingestion: "web_fetch",
    accessState: "public_account_required",
    modelProcessing: "manual_research_only",
  },
  "performance review institute": {
    sourceType: "web_database",
    access: "restricted_metadata_only",
    ingestion: "manual",
    accessState: "paid_subscription",
    modelProcessing: "disabled (metadata_only; manual_research_only)",
  },
  "system for award management (sam)": {
    sourceType: "web_database",
    access: "authorized",
    ingestion: "api",
    accessState: "api_key_required",
    modelProcessing: "manual_research_only",
  },
  usaspending: {
    sourceType: "web_database",
    access: "public",
    ingestion: "web_fetch",
    accessState: "public_no_auth",
    modelProcessing: "allowed",
  },
  "boeing illustrated parts catalog (ipc)": {
    sourceType: "restricted_portal",
    access: "restricted_metadata_only",
    ingestion: "manual",
    accessState: "restricted",
    modelProcessing: "disabled (restricted; manual_research_only)",
  },
};

export function policyForSource(name: string): SourcePolicy | null {
  return POLICIES_BY_LOWER_NAME[name.trim().toLowerCase()] ?? null;
}

export interface DataSourceImportSummary {
  total: number;
  created: number;
  updated: number;
  unmatched: string[];
}

function buildNotes(details: string | null, policy: SourcePolicy): string {
  const parts = [
    details === null ? undefined : details.replace(/\s+$/, ""),
    `Access state: ${policy.accessState}. Model processing: ${policy.modelProcessing}.`,
  ];
  return parts.filter((part) => part !== undefined).join("\n");
}

/** Upsert the five nominated database sources by exact name. */
export async function importDataSources(
  db: Database,
  rows: DatabaseSourceRow[],
): Promise<DataSourceImportSummary> {
  const summary: DataSourceImportSummary = {
    total: rows.length,
    created: 0,
    updated: 0,
    unmatched: [],
  };

  for (const row of rows) {
    const policy = policyForSource(row.name);
    if (policy === null) {
      summary.unmatched.push(row.name);
      continue;
    }
    const values = {
      name: row.name,
      sourceType: policy.sourceType,
      // The Domain column of this sheet holds a full URL.
      baseUrl: row.domain,
      access: policy.access,
      ingestion: policy.ingestion,
      notes: buildNotes(row.details, policy),
    };
    const existing = await db
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(
        sql`lower(${dataSources.name}) = lower(${row.name})
          AND coalesce(${dataSources.publisher}, '') = ''`,
      )
      .limit(1);

    if (existing[0] !== undefined) {
      await db
        .update(dataSources)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(dataSources.id, existing[0].id));
      summary.updated += 1;
    } else {
      await db.insert(dataSources).values(values);
      summary.created += 1;
    }
  }
  return summary;
}
