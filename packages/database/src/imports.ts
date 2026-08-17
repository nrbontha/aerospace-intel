import { createHash } from "node:crypto";

import {
  companyStatusValues,
  importEntityValues,
  recordStatusValues,
} from "@asi/contracts";
import { and, eq, sql } from "drizzle-orm";

import { getDatabase } from "./client.js";
import { CSV_MAX_BYTES, CSV_MAX_ROWS, parseCsv } from "./csv.js";
import { writeStoredDocument } from "./provenance.js";
import { auditEvents, companies, facilities, imports, importRows } from "./schema.js";

const COMPANY_STATUSES = new Set<string>(companyStatusValues);
const RECORD_STATUSES = new Set<string>(recordStatusValues);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const URL_PATTERN = /^https?:\/\/[^\s]+$/iu;

export const IMPORTABLE_ENTITIES = ["companies", "facilities"] as const;
export type ImportableEntity = (typeof IMPORTABLE_ENTITIES)[number];

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function cell(
  row: Record<string, string>,
  aliases: readonly string[],
): string {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function countryCode(value: string): string | null {
  if (value === "") return null;
  const code = value.toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "invalid";
}

export interface ValidatedImportRow {
  readonly rowNumber: number;
  readonly status: "validated" | "rejected";
  readonly rawData: Record<string, string>;
  readonly normalizedData: Record<string, unknown> | null;
  readonly errors: string[];
}

export function validateCompanyRow(
  row: Record<string, string>,
  rowNumber: number,
): ValidatedImportRow {
  const errors: string[] = [];
  const legalName = cell(row, ["legal_name", "legalname", "company", "name"]);
  if (legalName === "") errors.push("legal_name is required");
  if (legalName.length > 300) errors.push("legal_name is too long");
  const displayName = cell(row, ["display_name", "common_name"]) || legalName;
  const description = cell(row, ["description", "notes"]);
  const websiteUrl = cell(row, ["website_url", "website", "url"]);
  if (websiteUrl !== "" && !URL_PATTERN.test(websiteUrl)) {
    errors.push("website_url must be an http(s) URL");
  }
  const country = countryCode(
    cell(row, ["headquarters_country_code", "country_code", "country"]),
  );
  if (country === "invalid") errors.push("headquarters_country_code must be ISO 3166-1 alpha-2");
  const statusRaw = cell(row, ["status"]).toLowerCase() || "active";
  if (!COMPANY_STATUSES.has(statusRaw)) errors.push("status is not a known company status");
  const foundedRaw = cell(row, ["founded_year", "founded"]);
  let foundedYear: number | null = null;
  if (foundedRaw !== "") {
    foundedYear = Number(foundedRaw);
    if (!Number.isInteger(foundedYear) || foundedYear < 1700 || foundedYear > 2200) {
      errors.push("founded_year must be between 1700 and 2200");
      foundedYear = null;
    }
  }
  const normalizedData =
    errors.length === 0
      ? {
          legalName,
          displayName,
          ...(description === "" ? {} : { description }),
          ...(websiteUrl === "" ? {} : { websiteUrl }),
          ...(country === null ? {} : { headquartersCountryCode: country }),
          status: statusRaw,
          ...(foundedYear === null ? {} : { foundedYear }),
        }
      : null;
  return {
    rowNumber,
    status: errors.length === 0 ? "validated" : "rejected",
    rawData: row,
    normalizedData,
    errors,
  };
}

export function validateFacilityRow(
  row: Record<string, string>,
  rowNumber: number,
): ValidatedImportRow {
  const errors: string[] = [];
  const name = cell(row, ["name", "facility", "facility_name"]);
  if (name === "") errors.push("name is required");
  if (name.length > 300) errors.push("name is too long");
  const country = countryCode(cell(row, ["country_code", "country"]));
  if (country === null) errors.push("country_code is required");
  if (country === "invalid") errors.push("country_code must be ISO 3166-1 alpha-2");
  const companyId = cell(row, ["company_id"]);
  const companyLegalName = cell(row, [
    "company_legal_name",
    "company",
    "legal_name",
  ]);
  if (companyId !== "" && !UUID_PATTERN.test(companyId)) {
    errors.push("company_id must be a UUID");
  }
  if (companyId === "" && companyLegalName === "") {
    errors.push("company_id or company_legal_name is required");
  }
  const statusRaw = cell(row, ["status"]).toLowerCase() || "active";
  if (!RECORD_STATUSES.has(statusRaw)) errors.push("status is not a known record status");
  const normalizedData =
    errors.length === 0
      ? {
          name,
          countryCode: country,
          ...(companyId === "" ? {} : { companyId }),
          ...(companyLegalName === "" ? {} : { companyLegalName }),
          ...(cell(row, ["facility_type", "type"]) === ""
            ? {}
            : { facilityType: cell(row, ["facility_type", "type"]) }),
          ...(cell(row, ["city"]) === "" ? {} : { city: cell(row, ["city"]) }),
          ...(cell(row, ["region", "state"]) === ""
            ? {}
            : { region: cell(row, ["region", "state"]) }),
          ...(cell(row, ["address_line_1", "address"]) === ""
            ? {}
            : { addressLine1: cell(row, ["address_line_1", "address"]) }),
          ...(cell(row, ["postal_code", "zip"]) === ""
            ? {}
            : { postalCode: cell(row, ["postal_code", "zip"]) }),
          status: statusRaw,
        }
      : null;
  return {
    rowNumber,
    status: errors.length === 0 ? "validated" : "rejected",
    rawData: row,
    normalizedData,
    errors,
  };
}

export function validateImportRows(
  entity: ImportableEntity,
  rows: readonly Record<string, string>[],
): ValidatedImportRow[] {
  if (rows.length === 0) {
    throw new ImportValidationError("The CSV file does not contain any data rows");
  }
  if (rows.length > CSV_MAX_ROWS) {
    throw new ImportValidationError(`CSV imports are limited to ${CSV_MAX_ROWS} rows`);
  }
  return rows.map((row, index) =>
    entity === "companies"
      ? validateCompanyRow(row, index + 2)
      : validateFacilityRow(row, index + 2),
  );
}

export interface ProcessImportInput {
  readonly actorUserId: string;
  readonly content: Uint8Array;
  readonly dryRun: boolean;
  readonly entity: ImportableEntity;
  readonly fileName: string;
  readonly requestId?: string;
}

export async function processImportBatch(input: ProcessImportInput) {
  if (input.content.byteLength === 0) {
    throw new ImportValidationError("The uploaded file is empty");
  }
  if (input.content.byteLength > CSV_MAX_BYTES) {
    throw new ImportValidationError("CSV imports are limited to 5 MB");
  }
  if (!(importEntityValues as readonly string[]).includes(input.entity)) {
    throw new ImportValidationError("Unsupported import entity");
  }
  if (!IMPORTABLE_ENTITIES.includes(input.entity)) {
    throw new ImportValidationError(
      "Only company and facility CSV imports are implemented",
    );
  }

  const contentSha256 = digest(input.content);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(input.content);
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (error) {
    throw new ImportValidationError(
      error instanceof Error ? error.message : "CSV could not be parsed",
    );
  }
  const validated = validateImportRows(input.entity, parsed.rows);
  const rejectedCount = validated.filter((row) => row.status === "rejected").length;
  const acceptedCount = validated.length - rejectedCount;
  const storageKey = `imports/${contentSha256}.csv`;
  await writeStoredDocument(storageKey, input.content, contentSha256);

  const db = getDatabase();
  const existing = await db
    .select()
    .from(imports)
    .where(eq(imports.contentSha256, contentSha256))
    .limit(1);
  const current = existing[0];

  if (current?.status === "completed") {
    return current;
  }
  if (current?.status === "ready" && input.dryRun) {
    return current;
  }
  if (
    current &&
    (current.status === "queued" ||
      current.status === "validating" ||
      current.status === "processing")
  ) {
    throw new ImportValidationError("An import for this file is already in progress");
  }

  return db.transaction(async (tx) => {
    const now = new Date();
    let importId = current?.id;
    if (importId === undefined) {
      const [created] = await tx
        .insert(imports)
        .values({
          requestedByUserId: input.actorUserId,
          status: input.dryRun ? "ready" : "processing",
          fileName: input.fileName,
          storageKey,
          contentSha256,
          mapping: { entity: input.entity, format: "csv" },
          rowCount: validated.length,
          importedCount: 0,
          rejectedCount,
          startedAt: now,
        })
        .returning();
      if (!created) throw new Error("Unable to persist import batch");
      importId = created.id;
    } else {
      await tx
        .update(imports)
        .set({
          status: input.dryRun ? "ready" : "processing",
          fileName: input.fileName,
          storageKey,
          mapping: { entity: input.entity, format: "csv" },
          rowCount: validated.length,
          importedCount: 0,
          rejectedCount,
          error: null,
          startedAt: now,
          completedAt: null,
          requestedByUserId: input.actorUserId,
        })
        .where(eq(imports.id, importId));
      await tx.delete(importRows).where(eq(importRows.importId, importId));
    }

    const persistedRows: (typeof importRows.$inferInsert)[] = [];
    let importedCount = 0;

    for (const row of validated) {
      if (input.dryRun || row.status === "rejected" || row.normalizedData === null) {
        persistedRows.push({
          importId,
          rowNumber: row.rowNumber,
          status: row.status === "rejected" ? "rejected" : "validated",
          rawData: row.rawData,
          normalizedData: row.normalizedData,
          errors: row.errors.length === 0 ? null : row.errors,
        });
        continue;
      }

      if (input.entity === "companies") {
        const data = row.normalizedData as {
          legalName: string;
          displayName: string;
          description?: string;
          websiteUrl?: string;
          headquartersCountryCode?: string;
          status: (typeof companyStatusValues)[number];
          foundedYear?: number;
        };
        const [match] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(sql`lower(${companies.legalName}) = lower(${data.legalName})`)
          .limit(1);
        const companyId =
          match?.id ??
          (
            await tx
              .insert(companies)
              .values({
                legalName: data.legalName,
                displayName: data.displayName,
                status: data.status,
                ...(data.description === undefined ? {} : { description: data.description }),
                ...(data.websiteUrl === undefined ? {} : { websiteUrl: data.websiteUrl }),
                ...(data.headquartersCountryCode === undefined
                  ? {}
                  : { headquartersCountryCode: data.headquartersCountryCode }),
                ...(data.foundedYear === undefined ? {} : { foundedYear: data.foundedYear }),
              })
              .returning({ id: companies.id })
          )[0]?.id;
        if (!companyId) throw new Error("Unable to persist imported company");
        importedCount += 1;
        persistedRows.push({
          importId,
          rowNumber: row.rowNumber,
          status: "imported",
          rawData: row.rawData,
          normalizedData: row.normalizedData,
          targetEntityType: "company",
          targetEntityId: companyId,
          errors: null,
        });
        continue;
      }

      const data = row.normalizedData as {
        name: string;
        countryCode: string;
        companyId?: string;
        companyLegalName?: string;
        facilityType?: string;
        city?: string;
        region?: string;
        addressLine1?: string;
        postalCode?: string;
        status: (typeof recordStatusValues)[number];
      };
      let companyId = data.companyId ?? null;
      if (companyId === null && data.companyLegalName !== undefined) {
        const [match] = await tx
          .select({ id: companies.id })
          .from(companies)
          .where(sql`lower(${companies.legalName}) = lower(${data.companyLegalName})`)
          .limit(1);
        companyId = match?.id ?? null;
      }
      if (companyId === null) {
        persistedRows.push({
          importId,
          rowNumber: row.rowNumber,
          status: "rejected",
          rawData: row.rawData,
          normalizedData: row.normalizedData,
          errors: ["Owning company was not found"],
        });
        continue;
      }
      const [existingFacility] = await tx
        .select({ id: facilities.id })
        .from(facilities)
        .where(
          and(
            eq(facilities.companyId, companyId),
            sql`lower(${facilities.name}) = lower(${data.name})`,
          ),
        )
        .limit(1);
      const facilityId =
        existingFacility?.id ??
        (
          await tx
            .insert(facilities)
            .values({
              companyId,
              name: data.name,
              countryCode: data.countryCode,
              status: data.status,
              ...(data.facilityType === undefined ? {} : { facilityType: data.facilityType }),
              ...(data.city === undefined ? {} : { city: data.city }),
              ...(data.region === undefined ? {} : { region: data.region }),
              ...(data.addressLine1 === undefined ? {} : { addressLine1: data.addressLine1 }),
              ...(data.postalCode === undefined ? {} : { postalCode: data.postalCode }),
            })
            .returning({ id: facilities.id })
        )[0]?.id;
      if (!facilityId) throw new Error("Unable to persist imported facility");
      importedCount += 1;
      persistedRows.push({
        importId,
        rowNumber: row.rowNumber,
        status: "imported",
        rawData: row.rawData,
        normalizedData: row.normalizedData,
        targetEntityType: "facility",
        targetEntityId: facilityId,
        errors: null,
      });
    }

    if (persistedRows.length > 0) {
      await tx.insert(importRows).values(persistedRows);
    }

    const finalRejected = persistedRows.filter((row) => row.status === "rejected").length;
    const [updated] = await tx
      .update(imports)
      .set({
        status: input.dryRun ? "ready" : "completed",
        importedCount: input.dryRun ? 0 : importedCount,
        rejectedCount: finalRejected,
        completedAt: new Date(),
      })
      .where(eq(imports.id, importId))
      .returning();
    if (!updated) throw new Error("Unable to finalize import batch");

    await tx.insert(auditEvents).values({
      actorUserId: input.actorUserId,
      action: input.dryRun ? "import.dry_run" : "import.commit",
      entityType: "import",
      entityId: updated.id,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      after: {
        entity: input.entity,
        dryRun: input.dryRun,
        rowCount: validated.length,
        acceptedCount,
        importedCount: input.dryRun ? 0 : importedCount,
        rejectedCount: finalRejected,
        contentSha256,
      },
    });

    return updated;
  });
}
