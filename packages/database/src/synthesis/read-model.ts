import { and, desc, eq, or } from "drizzle-orm";

import { getDatabase } from "../client.js";
import {
  candidates,
  canonicalFacts,
  companies,
  companyDomains,
  companyIdentifiers,
  dataSources,
  evidence,
  facilities,
  facilityQualifications,
  observations,
  partAlternateIds,
  parts,
  researchProposals,
  researchQuestions,
  sourceDocumentLinks,
  sourceDocuments,
} from "../schema.js";

export type SynthesisFactStatus = "canonical" | "pending" | "conflict" | "unknown";

export interface SynthesisFact {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly status: SynthesisFactStatus;
  readonly authority?: string | null;
  readonly officialUrl?: string | null;
  readonly excerpt?: string | null;
  readonly locator?: string | null;
  readonly freshness?: string | null;
}

export interface CompanySynthesisTrail {
  readonly company: { readonly id: string; readonly name: string; readonly domain?: string | null };
  readonly identifiers: readonly SynthesisFact[];
  readonly facilities: readonly {
    readonly id: string;
    readonly name: string;
    readonly address?: string | null;
    readonly status: SynthesisFactStatus;
    readonly authority?: string | null;
    readonly officialUrl?: string | null;
    readonly excerpt?: string | null;
    readonly locator?: string | null;
    readonly freshness?: string | null;
  }[];
  readonly sourceRecords: readonly {
    readonly id: string;
    readonly sourceKey: string;
    readonly locator: string;
    readonly authority: string;
    readonly status: string;
    readonly facts: readonly SynthesisFact[];
    readonly evidenceUrls: readonly string[];
    readonly expectedObservationIds: readonly string[];
    readonly freshness?: string | null;
  }[];
  readonly qualifications: readonly {
    readonly id: string;
    readonly holderNumber: string;
    readonly status: string;
    readonly part: {
      readonly number: string;
      readonly name: string;
      readonly replacementFor?: string | null;
    };
    readonly make: string;
    readonly models: readonly string[];
    readonly approvalBasis?: string | null;
    readonly supplement?: string | null;
    readonly facility?: {
      readonly id?: string | null;
      readonly name: string;
      readonly address?: string | null;
    } | null;
    readonly materializationStatus: "draft" | "active";
    readonly authority?: string | null;
    readonly officialUrl?: string | null;
    readonly locator?: string | null;
    readonly freshness?: string | null;
  }[];
  readonly conflicts: readonly {
    readonly id: string;
    readonly field: string;
    readonly summary: string;
    readonly facts: readonly SynthesisFact[];
  }[];
  readonly gaps: readonly {
    readonly id: string;
    readonly question: string;
    readonly reason: string;
    readonly priority?: "low" | "medium" | "high" | null;
  }[];
  readonly confidence: {
    readonly sourceCount: number;
    readonly primarySourceCount: number;
    readonly conflictCount: number;
    readonly score?: number | null;
  };
}

interface SourceObservationRow {
  readonly documentId: string;
  readonly documentUrl: string | null;
  readonly documentTitle: string | null;
  readonly documentType: string | null;
  readonly documentMetadata: Record<string, unknown>;
  readonly publishedOn: string | null;
  readonly retrievedAt: Date;
  readonly sourceName: string;
  readonly publisher: string | null;
  readonly observationId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly fieldKey: string;
  readonly value: unknown;
  readonly normalizedText: string | null;
  readonly observedAt: Date;
  readonly reviewStatus: "pending" | "accepted" | "rejected" | "superseded";
  readonly conflictStatus: "none" | "potential" | "confirmed" | "resolved";
  readonly quote: string | null;
  readonly evidenceLocator: string | null;
  readonly proposalStatus: "pending" | "accepted" | "rejected" | "superseded" | null;
  readonly canonicalFactId: string | null;
}

/**
 * Read the complete synthesis projection with a fixed set of batched queries.
 * The query count does not grow with documents, observations, or graph nodes.
 */
export async function getCompanySynthesisTrail(
  companyId: string,
): Promise<CompanySynthesisTrail | null> {
  const db = getDatabase();
  const [companyRows, identifierRows, facilityRows, sourceRows, qualificationRows, gapRows] =
    await Promise.all([
      db
        .select({
          id: companies.id,
          name: companies.displayName,
          domain: companyDomains.domain,
          currentScores: candidates.currentScores,
        })
        .from(companies)
        .leftJoin(companyDomains, eq(companyDomains.companyId, companies.id))
        .leftJoin(candidates, eq(candidates.companyId, companies.id))
        .where(eq(companies.id, companyId))
        .orderBy(desc(companyDomains.isPrimary), companyDomains.createdAt),
      db
        .select({ id: companyIdentifiers.id, type: companyIdentifiers.type, value: companyIdentifiers.value })
        .from(companyIdentifiers)
        .where(eq(companyIdentifiers.companyId, companyId)),
      db
        .select()
        .from(facilities)
        .where(eq(facilities.companyId, companyId)),
      loadSourceObservationRows(companyId),
      db
        .select({
          id: facilityQualifications.id,
          status: facilityQualifications.status,
          facilityId: facilities.id,
          facilityName: facilities.name,
          facilityAddressLine1: facilities.addressLine1,
          facilityAddressLine2: facilities.addressLine2,
          facilityCity: facilities.city,
          facilityRegion: facilities.region,
          facilityPostalCode: facilities.postalCode,
          facilityCountryCode: facilities.countryCode,
          partId: parts.id,
          partNumber: parts.partNumber,
          partName: parts.name,
          partStatus: parts.lifecycleStatus,
          replacementFor: partAlternateIds.identifierValue,
          documentId: sourceDocuments.id,
          documentUrl: sourceDocuments.canonicalUrl,
          documentTitle: sourceDocuments.title,
          retrievedAt: sourceDocuments.retrievedAt,
          authority: dataSources.publisher,
          sourceName: dataSources.name,
        })
        .from(facilityQualifications)
        .innerJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
        .innerJoin(parts, eq(parts.id, facilityQualifications.partId))
        .leftJoin(
          partAlternateIds,
          and(
            eq(partAlternateIds.partId, parts.id),
            eq(partAlternateIds.identifierType, "oem_replacement_part_number"),
          ),
        )
        .leftJoin(
          sourceDocumentLinks,
          eq(sourceDocumentLinks.facilityQualificationId, facilityQualifications.id),
        )
        .leftJoin(sourceDocuments, eq(sourceDocuments.id, sourceDocumentLinks.sourceDocumentId))
        .leftJoin(dataSources, eq(dataSources.id, sourceDocuments.dataSourceId))
        .where(eq(facilities.companyId, companyId)),
      db
        .select({
          id: researchQuestions.id,
          question: researchQuestions.question,
          status: researchQuestions.status,
          priority: researchQuestions.priority,
        })
        .from(researchQuestions)
        .leftJoin(candidates, eq(candidates.id, researchQuestions.candidateId))
        .where(
          and(
            or(eq(researchQuestions.companyId, companyId), eq(candidates.companyId, companyId)),
            or(eq(researchQuestions.status, "open"), eq(researchQuestions.status, "stale")),
          ),
        ),
    ]);

  const company = companyRows[0];
  if (company === undefined) return null;

  const factsByDocument = new Map<string, SourceObservationRow[]>();
  for (const row of sourceRows) {
    const rows = factsByDocument.get(row.documentId) ?? [];
    rows.push(row);
    factsByDocument.set(row.documentId, rows);
  }

  const sourceRecords = [...factsByDocument.entries()].map(([documentId, rows]) => {
    const first = rows[0]!;
    const pendingIds = unique(
      rows.filter(({ proposalStatus }) => proposalStatus === "pending").map(({ observationId }) => observationId),
    );
    const statuses = new Set(rows.map(({ proposalStatus }) => proposalStatus).filter(Boolean));
    const status = pendingIds.length > 0
      ? "pending"
      : statuses.has("accepted")
        ? "accepted"
        : statuses.has("rejected")
          ? "rejected"
          : rows.some(({ canonicalFactId }) => canonicalFactId !== null)
            ? "active"
            : "observed";
    return {
      id: documentId,
      sourceKey: metadataString(first.documentMetadata, "sourceKey") ?? first.documentType ?? first.sourceName,
      locator:
        metadataString(first.documentMetadata, "sourceLocator") ??
        first.documentTitle ??
        first.documentUrl ??
        "No locator recorded",
      authority: first.publisher ?? first.sourceName,
      status,
      facts: uniqueById(rows.map(toFact)),
      evidenceUrls: unique(rows.map(({ documentUrl }) => documentUrl).filter(isString)),
      expectedObservationIds: pendingIds.sort(),
      freshness: freshness(first.publishedOn, first.retrievedAt),
    };
  });

  const observationBySubjectField = new Map<string, SourceObservationRow[]>();
  for (const row of sourceRows) {
    const key = `${row.subjectType}:${row.subjectId}:${row.fieldKey}`;
    const rows = observationBySubjectField.get(key) ?? [];
    rows.push(row);
    observationBySubjectField.set(key, rows);
  }

  const identifiers = identifierRows.map((identifier) => {
    const rows = observationBySubjectField.get(`company:${companyId}:identifier.${identifier.type}`) ?? [];
    const matchingRows = rows.filter(({ normalizedText, value }) =>
      (normalizedText ?? displayValue(value)).localeCompare(identifier.value, undefined, { sensitivity: "accent" }) === 0,
    );
    const evidenceRow = bestFactRow(matchingRows.length > 0 ? matchingRows : rows);
    return evidenceRow === undefined
      ? {
          id: identifier.id,
          label: label(identifier.type),
          value: identifier.value,
          status: "unknown" as const,
        }
      : { ...toFact(evidenceRow), id: identifier.id, label: label(identifier.type), value: identifier.value };
  });

  const facilityProjection = facilityRows.map((facility) => {
    const row = bestFactRow(
      observationBySubjectField.get(`facility:${facility.id}:registered_address`) ?? [],
    );
    return {
      id: facility.id,
      name: facility.name,
      address: address([
        facility.addressLine1,
        facility.addressLine2,
        facility.city,
        facility.region,
        facility.postalCode,
        facility.countryCode,
      ]),
      status: row === undefined ? (facility.status === "active" ? "canonical" as const : "unknown" as const) : factStatus(row),
      authority: row?.publisher ?? row?.sourceName ?? null,
      officialUrl: row?.documentUrl ?? null,
      excerpt: row?.quote ?? null,
      locator: row?.evidenceLocator ?? null,
      freshness: row === undefined ? null : freshness(row.publishedOn, row.retrievedAt),
    };
  });

  const qualifications = uniqueByKey(qualificationRows, ({ id }) => id).map((qualification) => {
    const rows = qualification.documentId === null ? [] : factsByDocument.get(qualification.documentId) ?? [];
    const qualificationFacts = new Map(
      rows
        .filter(({ subjectType, subjectId }) => subjectType === "qualification" && subjectId === qualification.id)
        .map((row) => [row.fieldKey, row.value]),
    );
    const holder = rows.find(({ subjectType, fieldKey }) =>
      subjectType === "company" && fieldKey === "identifier.faa_pma_holder",
    );
    const supplementNumber = displayOptional(qualificationFacts.get("faa.supplement_number"));
    const supplementDate = displayOptional(qualificationFacts.get("faa.supplement_date"));
    return {
      id: qualification.id,
      holderNumber: holder === undefined ? "Not recorded" : displayValue(holder.value),
      status:
        displayOptional(qualificationFacts.get("faa.sub_status")) ??
        displayOptional(qualificationFacts.get("faa.status")) ??
        "Unknown",
      part: {
        number: qualification.partNumber,
        name: qualification.partName ?? "Name not recorded",
        replacementFor: qualification.replacementFor,
      },
      make: displayOptional(qualificationFacts.get("faa.make")) ?? "Unknown",
      models: stringArray(qualificationFacts.get("faa.models")),
      approvalBasis: displayOptional(qualificationFacts.get("faa.approval_basis")),
      supplement: [supplementNumber, supplementDate].filter(isString).join(" · ") || null,
      facility: {
        id: qualification.facilityId,
        name: qualification.facilityName,
        address: address([
          qualification.facilityAddressLine1,
          qualification.facilityAddressLine2,
          qualification.facilityCity,
          qualification.facilityRegion,
          qualification.facilityPostalCode,
          qualification.facilityCountryCode,
        ]),
      },
      materializationStatus:
        qualification.status === "active" && qualification.partStatus === "active" ? "active" as const : "draft" as const,
      authority: qualification.authority ?? qualification.sourceName,
      officialUrl: qualification.documentUrl,
      locator: qualification.documentTitle,
      freshness: qualification.retrievedAt === null ? null : freshness(null, qualification.retrievedAt),
    };
  });

  const conflictGroups = new Map<string, SourceObservationRow[]>();
  for (const row of sourceRows.filter(({ conflictStatus }) => conflictStatus !== "none")) {
    const key = `${row.subjectType}:${row.subjectId}:${row.fieldKey}`;
    const rows = conflictGroups.get(key) ?? [];
    rows.push(row);
    conflictGroups.set(key, rows);
  }
  const conflicts = [...conflictGroups.entries()].map(([id, rows]) => ({
    id,
    field: label(rows[0]!.fieldKey),
    summary: `Conflicting source observations are recorded for ${label(rows[0]!.fieldKey)}.`,
    facts: uniqueById(rows.map(toFact).map((fact) => ({ ...fact, status: "conflict" as const }))),
  }));

  const gaps = [
    ...gapRows.map((gap) => ({
      id: gap.id,
      question: gap.question,
      reason: `Research question is ${gap.status.replaceAll("_", " ")}.`,
      priority: priority(gap.priority),
    })),
    ...sourceRows
      .filter(({ fieldKey }) => fieldKey === "faa.platform_resolution_gap")
      .map((row) => {
        const value = recordValue(row.value);
        const recordId = typeof value.recordId === "string" ? value.recordId : row.observationId;
        const reason = typeof value.reason === "string" ? value.reason : "FAA make/model could not be resolved exactly.";
        return {
          id: `faa-platform:${row.observationId}`,
          question: `Resolve the exact platform for FAA PMA record ${recordId}`,
          reason,
          priority: "high" as const,
        };
      }),
  ];

  const scoreValue = company.currentScores?.["confidence"];
  return {
    company: { id: company.id, name: company.name, domain: company.domain },
    identifiers,
    facilities: facilityProjection,
    sourceRecords,
    qualifications,
    conflicts,
    gaps: uniqueByKey(gaps, ({ id }) => id),
    confidence: {
      sourceCount: sourceRecords.length,
      primarySourceCount: sourceRecords.filter(({ sourceKey, authority }) =>
        /(?:sam|faa|general services administration|federal aviation administration)/iu.test(`${sourceKey} ${authority}`),
      ).length,
      conflictCount: conflicts.length,
      score: typeof scoreValue === "number" ? scoreValue : null,
    },
  };
}

function loadSourceObservationRows(companyId: string): Promise<SourceObservationRow[]> {
  const db = getDatabase();
  return db
    .select({
      documentId: sourceDocuments.id,
      documentUrl: sourceDocuments.canonicalUrl,
      documentTitle: sourceDocuments.title,
      documentType: sourceDocuments.documentType,
      documentMetadata: sourceDocuments.metadata,
      publishedOn: sourceDocuments.publishedOn,
      retrievedAt: sourceDocuments.retrievedAt,
      sourceName: dataSources.name,
      publisher: dataSources.publisher,
      observationId: observations.id,
      subjectType: observations.subjectType,
      subjectId: observations.subjectId,
      fieldKey: observations.fieldKey,
      value: observations.value,
      normalizedText: observations.normalizedText,
      observedAt: observations.observedAt,
      reviewStatus: observations.reviewStatus,
      conflictStatus: observations.conflictStatus,
      quote: evidence.quote,
      evidenceLocator: evidence.locator,
      proposalStatus: researchProposals.status,
      canonicalFactId: canonicalFacts.id,
    })
    .from(sourceDocumentLinks)
    .innerJoin(sourceDocuments, eq(sourceDocuments.id, sourceDocumentLinks.sourceDocumentId))
    .innerJoin(dataSources, eq(dataSources.id, sourceDocuments.dataSourceId))
    .innerJoin(evidence, eq(evidence.sourceDocumentId, sourceDocuments.id))
    .innerJoin(observations, eq(observations.evidenceId, evidence.id))
    .leftJoin(researchProposals, eq(researchProposals.observationId, observations.id))
    .leftJoin(canonicalFacts, eq(canonicalFacts.currentObservationId, observations.id))
    .where(eq(sourceDocumentLinks.companyId, companyId));
}
function bestFactRow(
  rows: readonly SourceObservationRow[],
): SourceObservationRow | undefined {
  return (
    rows.find(({ conflictStatus }) => conflictStatus !== "none") ??
    rows.find(
      ({ canonicalFactId, proposalStatus, reviewStatus }) =>
        canonicalFactId !== null ||
        proposalStatus === "accepted" ||
        reviewStatus === "accepted",
    ) ??
    rows.find(({ proposalStatus }) => proposalStatus === "pending") ??
    rows.find(({ proposalStatus }) => proposalStatus === null) ??
    rows[0]
  );
}


function toFact(row: SourceObservationRow): SynthesisFact {
  return {
    id: row.observationId,
    label: label(row.fieldKey),
    value: displayValue(row.value),
    status: factStatus(row),
    authority: row.publisher ?? row.sourceName,
    officialUrl: row.documentUrl,
    excerpt: row.quote,
    locator: row.evidenceLocator,
    freshness: freshness(row.publishedOn, row.retrievedAt),
  };
}

function factStatus(row: SourceObservationRow): SynthesisFactStatus {
  if (row.conflictStatus !== "none") return "conflict";
  if (
    row.canonicalFactId !== null ||
    row.proposalStatus === "accepted" ||
    row.reviewStatus === "accepted"
  ) {
    return "canonical";
  }
  if (
    row.proposalStatus === "rejected" ||
    row.proposalStatus === "superseded" ||
    row.reviewStatus === "rejected" ||
    row.reviewStatus === "superseded"
  ) {
    return "unknown";
  }
  if (row.proposalStatus === "pending" || row.reviewStatus === "pending") {
    return "pending";
  }
  return "unknown";
}

function freshness(publishedOn: string | null, retrievedAt: Date): string {
  return publishedOn === null
    ? `Retrieved ${retrievedAt.toISOString().slice(0, 10)}`
    : `Published ${publishedOn} · retrieved ${retrievedAt.toISOString().slice(0, 10)}`;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function displayOptional(value: unknown): string | null {
  return value === null || value === undefined ? null : displayValue(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function address(parts: readonly (string | null)[]): string | null {
  const present = parts.filter(isString).map((part) => part.trim()).filter(Boolean);
  return present.length === 0 ? null : present.join(", ");
}

const IDENTIFIER_ACRONYMS: Readonly<Record<string, string>> = {
  cage: "CAGE",
  faa: "FAA",
  pma: "PMA",
  sam: "SAM",
  uei: "UEI",
};

function label(value: string): string {
  const normalized = value.startsWith("identifier.")
    ? value.slice("identifier.".length)
    : value.replace(/^(?:sam|faa)\./u, "");
  return normalized
    .split("_")
    .map(
      (word) =>
        IDENTIFIER_ACRONYMS[word] ??
        `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`,
    )
    .join(" ");
}

function priority(value: string | null): "low" | "medium" | "high" | null {
  if (value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric >= 67 ? "high" : numeric >= 34 ? "medium" : "low";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[]): T[] {
  return uniqueByKey(values, ({ id }) => id);
}

function uniqueByKey<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function isString(value: string | null | unknown): value is string {
  return typeof value === "string" && value !== "";
}
