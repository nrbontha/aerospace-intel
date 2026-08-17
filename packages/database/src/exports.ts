import { eq, ilike, or } from "drizzle-orm";

import { getDatabase } from "./client.js";
import { stringifyCsv } from "./csv.js";
import { searchContains } from "./search.js";
import {
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
  | "data_sources";
export type ExportFormat = "csv" | "jsonl";

const EXPORT_LIMIT = 10_000;

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
): { body: string; contentType: string; extension: string } {
  if (format === "jsonl") {
    return {
      body: toJsonl(rows),
      contentType: "application/x-ndjson; charset=utf-8",
      extension: "jsonl",
    };
  }
  return {
    body: stringifyCsv(headers, rows),
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

  if (input.entity === "companies") {
    headers = [
      "id",
      "legalName",
      "displayName",
      "status",
      "websiteUrl",
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
        publisher: dataSources.publisher,
        createdAt: dataSources.createdAt,
      })
      .from(dataSources)
      .where(where)
      .limit(EXPORT_LIMIT)) as Record<string, unknown>[];
  }

  const mapped = rows.map((row) => mapRow(row, headers));
  const file = serialize(input.format, headers, mapped);
  return {
    body: file.body,
    contentType: file.contentType,
    fileName: `${input.entity}-${new Date().toISOString().slice(0, 10)}.${file.extension}`,
    rowCount: mapped.length,
  };
}
