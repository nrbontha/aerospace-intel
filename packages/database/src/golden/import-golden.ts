import { sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  goldenExamples,
  type GoldenExample,
} from "../schema.js";
import { normalizeDomain, normalizeName } from "../snapshots/normalize.js";
import type { GoldenCompanyRow } from "../import-parsers/types.js";
import {
  proposeLabels,
  type ProposedLabelSet,
} from "./proposal-rules.js";

/**
 * Golden-example import (18 rows in the real workbook).
 *
 * Targets-sheet rows are joined to the Grata sheet by normalized domain
 * (fallback: normalized name) and the merged payload is stored. Labels are
 * RULES ONLY — see proposal-rules.ts. Re-import is upsert-safe: existing
 * rows with review_status='reviewed' are NEVER overwritten; proposed or
 * unclassified rows are refreshed.
 */
export interface GoldenExampleImportRow {
  name: string;
  domain: string | null;
  descriptionRaw: string | null;
  grataPayload: Record<string, unknown>;
  workbookRow: number;
  proposedLabels: ProposedLabelSet;
}

export interface GoldenImportSummary {
  total: number;
  inserted: number;
  updated: number;
  skippedReviewed: number;
  breakdown: Partial<Record<ProposedLabelSet["goldenExampleType"], number>>;
}

/** Join targets rows with Grata rows by domain (fallback normalized name). */
export function joinGoldenWithGrata(
  targetRows: GoldenCompanyRow[],
  grataRows: GoldenCompanyRow[],
): GoldenExampleImportRow[] {
  const grataByDomain = new Map<string, GoldenCompanyRow>();
  const grataByName = new Map<string, GoldenCompanyRow>();
  for (const row of grataRows) {
    const rawDomain = row.domain;
    const domain = rawDomain === null ? null : normalizeDomain(rawDomain);
    if (domain !== null) grataByDomain.set(domain, row);
    grataByName.set(normalizeName(row.name), row);
  }

  return targetRows.map((target) => {
    const domain = target.domain === null ? null : normalizeDomain(target.domain);
    const grata =
      (domain !== null ? grataByDomain.get(domain) : undefined) ??
      grataByName.get(normalizeName(target.name));
    // Grata columns win on collision: they carry the standardized
    // classification vocabulary the rules depend on.
    const payload = {
      ...target.grataPayload,
      ...(grata === undefined ? {} : grata.grataPayload),
    };
    const ownership =
      payloadValue(payload, ["ownership"]) ?? grata?.ownership ?? null;
    const ownerName = payloadValue(payload, ["owner"]);
    return {
      name: target.name,
      domain: target.domain,
      descriptionRaw: target.description,
      grataPayload: payload,
      workbookRow: target.workbookRow,
      proposedLabels: proposeLabels({
        ownership:
          typeof ownership === "string" && ownership.trim() !== ""
            ? ownership.trim()
            : null,
        ownerName: typeof ownerName === "string" ? ownerName.trim() : null,
      }),
    };
  });
}

function payloadValue(
  payload: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const [key, value] of Object.entries(payload)) {
    if (
      keys.includes(key.trim().toLowerCase()) &&
      value !== null &&
      value !== ""
    ) {
      return value;
    }
  }
  return undefined;
}

type ExistingGoldenRow = {
  id: string;
  reviewStatus: string;
}

async function findExisting(
  db: Database,
  name: string,
  domain: string | null,
): Promise<ExistingGoldenRow | undefined> {
  const result = await db.execute<ExistingGoldenRow & { id: string }>(sql`
    SELECT id, review_status AS "reviewStatus"
    FROM golden_examples
    WHERE lower(name) = lower(${name})
      AND coalesce(lower(domain), '') = coalesce(lower(${domain}), '')
    LIMIT 1
  `);
  return result.rows[0];
}

async function resolveCompanyId(
  db: Database,
  domain: string | null,
): Promise<string | null> {
  const normalized = domain === null ? null : normalizeDomain(domain);
  if (normalized === null) return null;
  const result = await db.execute<{ id: string }>(sql`
    SELECT c.id
    FROM company_domains d
    JOIN companies c ON c.id = d.company_id
    WHERE lower(d.domain) = ${normalized}
    LIMIT 1
  `);
  return result.rows[0]?.id ?? null;
}

function rowValues(row: GoldenExampleImportRow) {
  return {
    archetypeFit: row.proposedLabels.archetypeFit,
    currentActionability: row.proposedLabels.currentActionability,
    businessModelFit: row.proposedLabels.businessModelFit,
    ownershipFit: row.proposedLabels.ownershipFit,
    goldenExampleType: row.proposedLabels.goldenExampleType,
    buildToPrintRisk: row.proposedLabels.buildToPrintRisk,
  };
}

/**
 * Import joined golden examples. Upsert-safe: `reviewed` rows are never
 * overwritten; everything else is inserted or refreshed as `proposed`.
 */
export async function importGoldenExamples(
  db: Database,
  rows: GoldenExampleImportRow[],
): Promise<GoldenImportSummary> {
  const summary: GoldenImportSummary = {
    total: rows.length,
    inserted: 0,
    updated: 0,
    skippedReviewed: 0,
    breakdown: {},
  };

  for (const row of rows) {
    const labels = row.proposedLabels;
    const existing = await findExisting(db, row.name, row.domain);

    if (existing !== undefined && existing.reviewStatus === "reviewed") {
      summary.skippedReviewed += 1;
      continue;
    }

    const companyId = await resolveCompanyId(db, row.domain);

    if (existing !== undefined) {
      await db.execute(sql`
        UPDATE golden_examples SET
          description_raw = ${row.descriptionRaw},
          grata_payload = ${JSON.stringify(row.grataPayload)}::jsonb,
          workbook_row = ${row.workbookRow},
          proposed_labels = ${JSON.stringify(labels)}::jsonb,
          archetype_fit = ${rowValues(row).archetypeFit},
          current_actionability = ${rowValues(row).currentActionability},
          business_model_fit = ${rowValues(row).businessModelFit},
          ownership_fit = ${rowValues(row).ownershipFit},
          golden_example_type = ${rowValues(row).goldenExampleType},
          build_to_print_risk = 'unknown',
          review_status = 'proposed',
          reviewed_by = NULL,
          reviewed_at = NULL,
          review_notes = NULL,
          company_id = ${companyId}
        WHERE id = ${existing.id}
      `);
      summary.updated += 1;
    } else {
      await db.insert(goldenExamples).values({
        companyId,
        name: row.name,
        domain: row.domain,
        descriptionRaw: row.descriptionRaw,
        grataPayload: row.grataPayload,
        workbookRow: row.workbookRow,
        proposedLabels: labels,
        ...rowValues(row),
        reviewStatus: "proposed",
      });
      summary.inserted += 1;
    }
    summary.breakdown[labels.goldenExampleType] =
      (summary.breakdown[labels.goldenExampleType] ?? 0) + 1;
  }
  return summary;
}

/**
 * Apply a human review decision: persists reviewed labels onto the typed
 * columns plus the mandatory rationale, and writes an audit event. Used by
 * PATCH /api/v1/golden-examples/[id]/review.
 */
export async function reviewGoldenExample(
  db: Database,
  options: {
    exampleId: string;
    reviewerId: string;
    rationale: string;
    reviewNotes?: string | undefined;
    labels: Partial<
      Pick<
        ProposedLabelSet,
        | "archetypeFit"
        | "currentActionability"
        | "businessModelFit"
        | "ownershipFit"
        | "goldenExampleType"
        | "buildToPrintRisk"
      >
    >;
    requestId?: string | undefined;
  },
): Promise<GoldenExample | null> {
  const beforeRows = await db
    .select()
    .from(goldenExamples)
    .where(sql`${goldenExamples.id} = ${options.exampleId}`)
    .limit(1);
  const before = beforeRows[0];
  if (before === undefined) return null;

  const mergedLabels: ProposedLabelSet = {
    archetypeFit:
      options.labels.archetypeFit ?? before.archetypeFit ?? "unknown",
    currentActionability:
      options.labels.currentActionability ??
      before.currentActionability ??
      "unknown",
    businessModelFit:
      options.labels.businessModelFit ?? before.businessModelFit ?? "unknown",
    ownershipFit: options.labels.ownershipFit ?? before.ownershipFit ?? "unknown",
    goldenExampleType:
      options.labels.goldenExampleType ??
      before.goldenExampleType ??
      "unclassified",
    buildToPrintRisk:
      options.labels.buildToPrintRisk ?? before.buildToPrintRisk ?? "unknown",
    rationale: options.rationale,
  };

  const updated = await db
    .update(goldenExamples)
    .set({
      archetypeFit: mergedLabels.archetypeFit,
      currentActionability: mergedLabels.currentActionability,
      businessModelFit: mergedLabels.businessModelFit,
      ownershipFit: mergedLabels.ownershipFit,
      goldenExampleType: mergedLabels.goldenExampleType,
      buildToPrintRisk: mergedLabels.buildToPrintRisk,
      proposedLabels: mergedLabels,
      reviewStatus: "reviewed",
      reviewedBy: options.reviewerId,
      reviewedAt: new Date(),
      reviewNotes: options.reviewNotes ?? options.rationale,
    })
    .where(sql`${goldenExamples.id} = ${options.exampleId}`)
    .returning();


  await db.execute(sql`
    INSERT INTO audit_events (actor_user_id, action, entity_type, entity_id, request_id, before, after, metadata)
    VALUES (
      ${options.reviewerId},
      'golden_example.reviewed',
      'golden_example',
      ${options.exampleId},
      ${options.requestId ?? null},
      ${JSON.stringify({
        reviewStatus: before.reviewStatus,
        proposedLabels: before.proposedLabels,
      })}::jsonb,
      ${JSON.stringify({
        reviewStatus: "reviewed",
        proposedLabels: mergedLabels,
        reviewNotes: options.reviewNotes ?? options.rationale,
      })}::jsonb,
      '{}'::jsonb
    )
  `);

  return updated[0] ?? null;
}
