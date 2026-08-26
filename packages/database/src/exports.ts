import { eq, ilike, or, sql } from "drizzle-orm";

import { engineStatusToTier } from "@asi/contracts";
import { getDatabase } from "./client.js";
import { stringifyCsv } from "./csv.js";
import { searchContains } from "./search.js";
import {
  candidates,
  companies,
  contacts,
  dataSources,
  facilities,
  facilityQualifications,
  parts,
  platforms,
} from "./schema.js";

export type ExportEntity =
  | "companies"
  | "facilities"
  | "contacts"
  | "platforms"
  | "parts"
  | "qualifications"
  | "data_sources"
  | "candidates";

export type ExportFormat = "csv" | "jsonl";

const EXPORT_LIMIT = 10_000;
const CANDIDATES_EXPORT_LIMIT = 50_000;

function like(query: string | undefined) {
  return searchContains(query);
}

function toJsonl(rows: readonly Record<string, unknown>[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
}

function serialize(
  format: ExportFormat,
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
  csvHeaders?: readonly string[],
): { body: string; contentType: string; extension: string } {
  if (format === "jsonl") {
    return {
      body: toJsonl(rows),
      contentType: "application/x-ndjson; charset=utf-8",
      extension: "jsonl",
    };
  }
  const outHeaders = csvHeaders ?? headers;
  const outRows = csvHeaders
    ? rows.map((row) =>
        Object.fromEntries(headers.map((header, i) => [csvHeaders[i]!, row[header]])),
      )
    : rows;
  return {
    body: stringifyCsv(outHeaders, outRows),
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
  };
}

function mapRow(
  row: Record<string, unknown>,
  headers: readonly string[],
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const header of headers) {
    const value = row[header];
    mapped[header] = value instanceof Date ? value.toISOString() : value;
  }
  return mapped;
}

// SQL mirror of engineStatusToTier with tier_override precedence — same
// shape as query-candidates.ts so exports cannot drift from the ?tier= filter.
const effectiveTierSql = sql<string | null>`COALESCE(${candidates.tierOverride}::text, CASE ${candidates.status}::text ${sql.join(
  Object.entries(engineStatusToTier).map(([status, tier]) => sql`WHEN ${status} THEN ${tier}`),
  sql` `,
)} END)`;

function rationaleArraySql(key: string) {
  return sql<string | null>`(
    SELECT string_agg(v, '; ') FROM jsonb_array_elements_text(${candidates.rationale} -> ${key}) AS v
  )`;
}

export async function exportRecords(input: {
  entity: ExportEntity;
  format: ExportFormat;
  query?: string;
}): Promise<{
  body: string;
  contentType: string;
  fileName: string;
  rowCount: number;
}> {
  const db = getDatabase();
  const pattern = like(input.query);
  let headers: string[] = [];
  let rows: Record<string, unknown>[] = [];
  let csvHeaders: string[] | undefined;

  if (input.entity === "companies") {
    headers = [
      "id",
      "legalName",
      "displayName",
      "status",
      "headquartersCountryCode",
      "foundedYear",
      "createdAt",
    ];
    const where = pattern
      ? or(ilike(companies.legalName, pattern), ilike(companies.displayName, pattern))
      : undefined;
    rows = (await db
      .select({
        id: companies.id,
        legalName: companies.legalName,
        displayName: companies.displayName,
        status: companies.status,
        websiteUrl: companies.websiteUrl,
        headquartersCountryCode: companies.headquartersCountryCode,
        foundedYear: companies.foundedYear,
        createdAt: companies.createdAt,
      })
      .from(companies)
      .where(where)
      .limit(EXPORT_LIMIT)) as Record<string, unknown>[];
  } else if (input.entity === "facilities") {
    headers = [
      "id",
      "name",
      "companyId",
      "companyName",
      "city",
      "region",
      "countryCode",
      "status",
      "createdAt",
    ];
    const where = pattern
      ? or(ilike(facilities.name, pattern), ilike(companies.displayName, pattern))
      : undefined;
    rows = (await db
      .select({
        id: facilities.id,
        name: facilities.name,
        companyId: facilities.companyId,
        companyName: companies.displayName,
        city: facilities.city,
        region: facilities.region,
        countryCode: facilities.countryCode,
        status: facilities.status,
        createdAt: facilities.createdAt,
      })
      .from(facilities)
      .leftJoin(companies, eq(companies.id, facilities.companyId))
      .where(where)
      .limit(EXPORT_LIMIT)) as Record<string, unknown>[];
  } else if (input.entity === "contacts") {
    headers = [
      "id",
      "fullName",
      "title",
      "email",
      "companyId",
      "facilityId",
      "verificationStatus",
      "status",
    ];
    const where = pattern ? ilike(contacts.fullName, pattern) : undefined;
    rows = (await db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        title: contacts.title,
        email: contacts.email,
        companyId: contacts.companyId,
        facilityId: contacts.facilityId,
        verificationStatus: contacts.verificationStatus,
        status: contacts.status,
      })
      .from(contacts)
      .where(where)
      .limit(EXPORT_LIMIT)) as Record<string, unknown>[];
  } else if (input.entity === "platforms") {
    headers = ["id", "name", "platformType", "manufacturerCompanyId", "description", "createdAt"];
    const where = pattern ? ilike(platforms.name, pattern) : undefined;
    rows = (await db
      .select({
        id: platforms.id,
        name: platforms.name,
        platformType: platforms.platformType,
        manufacturerCompanyId: platforms.manufacturerCompanyId,
        description: platforms.description,
        createdAt: platforms.createdAt,
      })
      .from(platforms)
      .where(where)
      .limit(EXPORT_LIMIT)) as Record<string, unknown>[];
  } else if (input.entity === "parts") {
    headers = [
      "id",
      "partNumber",
      "name",
      "lifecycleStatus",
      "manufacturerCompanyId",
      "createdAt",
    ];
    const where = pattern
      ? or(ilike(parts.partNumber, pattern), ilike(parts.name, pattern))
      : undefined;
    rows = (await db
      .select({
        id: parts.id,
        partNumber: parts.partNumber,
        name: parts.name,
        lifecycleStatus: parts.lifecycleStatus,
        manufacturerCompanyId: parts.manufacturerCompanyId,
        createdAt: parts.createdAt,
      })
      .from(parts)
      .where(where)
      .limit(EXPORT_LIMIT)) as Record<string, unknown>[];
  } else if (input.entity === "qualifications") {
    headers = [
      "id",
      "facilityId",
      "partId",
      "platformId",
      "customerCompanyId",
      "scarcity",
      "validFrom",
      "validTo",
    ];
    rows = (await db
      .select({
        id: facilityQualifications.id,
        facilityId: facilityQualifications.facilityId,
        partId: facilityQualifications.partId,
        platformId: facilityQualifications.platformId,
        customerCompanyId: facilityQualifications.customerCompanyId,
        scarcity: facilityQualifications.scarcity,
        validFrom: facilityQualifications.validFrom,
        validTo: facilityQualifications.validTo,
      })
      .from(facilityQualifications)
      .limit(EXPORT_LIMIT)) as Record<string, unknown>[];
  } else if (input.entity === "candidates") {
    headers = [
      "id",
      "companyId",
      "companyName",
      "companyDomain",
      "status",
      "tierOverride",
      "effectiveTier",
      "noveltyStatus",
      "fit",
      "novelty",
      "confidence",
      "actionability",
      "whyInteresting",
      "risks",
      "unknowns",
      "websiteUrl",
      "hqCountry",
      "researchPriority",
      "partnerReviewPriority",
      "createdAt",
    ];
    csvHeaders = [
      "Candidate ID",
      "Company ID",
      "Company Name",
      "Company Domain",
      "Status",
      "Tier Override",
      "Effective Tier",
      "Novelty Status",
      "Fit Score",
      "Novelty Score",
      "Confidence Score",
      "Actionability Score",
      "Why Interesting",
      "Risks",
      "Unknowns",
      "Website URL",
      "HQ Country",
      "Research Priority",
      "Partner Review Priority",
      "Created At",
    ];
    const primaryDomain = sql<string | null>`(
      SELECT lower(d.domain) FROM company_domains d
      WHERE d.company_id = ${candidates.companyId}
      ORDER BY d.is_primary DESC LIMIT 1
    )`;
    const where = pattern
      ? or(
          ilike(companies.displayName, pattern),
          ilike(companies.legalName, pattern),
        )
      : undefined;
    const raw = await db
      .select({
        id: candidates.id,
        companyId: candidates.companyId,
        companyName: companies.displayName,
        companyDomain: primaryDomain,
        status: candidates.status,
        noveltyStatus: candidates.noveltyStatus,
        tierOverride: candidates.tierOverride,
        effectiveTier: effectiveTierSql,
        fit: sql<number | null>`(${candidates.currentScores} ->> 'fit')::double precision`,
        novelty: sql<number | null>`(${candidates.currentScores} ->> 'novelty')::double precision`,
        confidence: sql<number | null>`(${candidates.currentScores} ->> 'confidence')::double precision`,
        actionability: sql<number | null>`(${candidates.currentScores} ->> 'actionability')::double precision`,
        whyInteresting: rationaleArraySql("whyInteresting"),
        risks: rationaleArraySql("risks"),
        unknowns: rationaleArraySql("unknowns"),
        websiteUrl: companies.websiteUrl,
        hqCountry: companies.headquartersCountryCode,
        researchPriority: candidates.researchPriority,
        partnerReviewPriority: candidates.partnerReviewPriority,
        createdAt: candidates.createdAt,
      })
      .from(candidates)
      .innerJoin(companies, eq(companies.id, candidates.companyId))
      .where(where)
      .orderBy(sql`${candidates.createdAt} DESC`)
      .limit(CANDIDATES_EXPORT_LIMIT);
    rows = raw as Record<string, unknown>[];
  } else {
    headers = ["id", "name", "baseUrl", "access", "ingestion", "publisher", "createdAt"];
    const where = pattern ? ilike(dataSources.name, pattern) : undefined;
    rows = (await db
      .select({
        id: dataSources.id,
        name: dataSources.name,
        baseUrl: dataSources.baseUrl,
        access: dataSources.access,
        ingestion: dataSources.ingestion,
        createdAt: dataSources.createdAt,
      })
      .from(dataSources)
      .where(where)
      .limit(EXPORT_LIMIT)) as Record<string, unknown>[];
  }

  const mapped = rows.map((row) => mapRow(row, headers));
  const file = serialize(input.format, headers, mapped, csvHeaders);
  return {
    body: file.body,
    contentType: file.contentType,
    fileName: `${input.entity}-${new Date().toISOString().slice(0, 10)}.${file.extension}`,
    rowCount: mapped.length,
  };
}
