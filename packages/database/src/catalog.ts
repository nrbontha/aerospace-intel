import { and, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDatabase } from "./client.js";
import { searchContains } from "./search.js";
import { normalizePagination, type PageInput, type PageResult } from "./repositories.js";
import {
  capabilities,
  certifications,
  companies,
  companyCapabilities,
  facilityCapabilities,
  facilityQualifications,
  facilities,
  imports,
  importRows,
  parts,
  platformFamilies,
  platforms,
  platformVariants,
  subsystems,
  contracts,
} from "./schema.js";

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const nullableText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

export interface FacilityListRecord {
  readonly id: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly name: string;
  readonly facilityType: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly countryCode: string;
  readonly status: string;
  readonly capabilityCount: number;
  readonly qualificationCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FacilityDetailRecord extends FacilityListRecord {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly capabilities: readonly {
    readonly id: string;
    readonly capabilityId: string;
    readonly name: string;
    readonly code: string;
    readonly status: string;
    readonly confidence: string | null;
    readonly validFrom: string | null;
    readonly validTo: string | null;
  }[];
  readonly qualifications: readonly {
    readonly id: string;
    readonly partId: string;
    readonly partNumber: string;
    readonly platformId: string | null;
    readonly platformName: string | null;
    readonly customerCompanyId: string | null;
    readonly customerName: string | null;
    readonly scarcity: string;
    readonly validFrom: string | null;
    readonly validTo: string | null;
    readonly confidence: string | null;
  }[];
}

export interface PlatformListRecord {
  readonly id: string;
  readonly name: string;
  readonly platformType: string | null;
  readonly description: string | null;
  readonly familyId: string | null;
  readonly familyName: string | null;
  readonly manufacturerCompanyId: string | null;
  readonly manufacturerName: string | null;
  readonly variantCount: number;
  readonly qualificationCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PlatformDetailRecord extends PlatformListRecord {
  readonly variants: readonly {
    readonly id: string;
    readonly name: string;
    readonly designation: string | null;
    readonly enteredServiceOn: string | null;
    readonly retiredOn: string | null;
  }[];
}

export interface PartListRecord {
  readonly id: string;
  readonly partNumber: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly lifecycleStatus: string;
  readonly manufacturerCompanyId: string | null;
  readonly manufacturerName: string | null;
  readonly qualificationCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PartDetailRecord extends PartListRecord {
  readonly qualifications: readonly {
    readonly id: string;
    readonly facilityId: string;
    readonly facilityName: string;
    readonly platformId: string | null;
    readonly platformName: string | null;
    readonly customerCompanyId: string | null;
    readonly customerName: string | null;
    readonly scarcity: string;
    readonly validFrom: string | null;
    readonly validTo: string | null;
  }[];
}

export interface QualificationListRecord {
  readonly id: string;
  readonly facilityId: string;
  readonly facilityName: string;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly partId: string;
  readonly partNumber: string;
  readonly partName: string | null;
  readonly platformId: string | null;
  readonly platformName: string | null;
  readonly platformVariantId: string | null;
  readonly platformVariantName: string | null;
  readonly subsystemId: string | null;
  readonly subsystemName: string | null;
  readonly customerCompanyId: string | null;
  readonly customerName: string | null;
  readonly qualificationReference: string | null;
  readonly scarcity: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly confidence: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ImportListRecord {
  readonly id: string;
  readonly fileName: string;
  readonly status: string;
  readonly storageKey: string;
  readonly contentSha256: string;
  readonly dataSourceId: string | null;
  readonly requestedByUserId: string | null;
  readonly rowCount: number | null;
  readonly importedCount: number;
  readonly rejectedCount: number;
  readonly error: unknown;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function facilitySelect() {
  return {
    id: facilities.id,
    companyId: facilities.companyId,
    companyName: companies.displayName,
    name: facilities.name,
    facilityType: facilities.facilityType,
    city: facilities.city,
    region: facilities.region,
    countryCode: facilities.countryCode,
    status: facilities.status,
    capabilityCount: sql<number>`(select count(*) from ${facilityCapabilities} where facility_id = ${facilities.id})`,
    qualificationCount: sql<number>`(select count(*) from ${facilityQualifications} where facility_id = ${facilities.id})`,
    createdAt: facilities.createdAt,
    updatedAt: facilities.updatedAt,
  };
}

function mapFacility(row: Record<string, unknown>): FacilityListRecord {
  return {
    id: String(row.id),
    companyId: typeof row.companyId === "string" ? row.companyId : null,
    companyName: nullableText(row.companyName),
    name: String(row.name),
    facilityType: nullableText(row.facilityType),
    city: nullableText(row.city),
    region: nullableText(row.region),
    countryCode: String(row.countryCode),
    status: String(row.status),
    capabilityCount: n(row.capabilityCount),
    qualificationCount: n(row.qualificationCount),
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export async function listFacilityRecords(
  input: PageInput & {
    query?: string;
    status?: string;
    companyId?: string;
    country?: string;
  },
): Promise<PageResult<FacilityListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters: SQL[] = [];
  const pattern = searchContains(input.query);
  if (pattern) {
    filters.push(
      or(
        ilike(facilities.name, pattern),
        ilike(facilities.city, pattern),
      )!,
    );
  }
  if (input.status) {
    filters.push(
      eq(facilities.status, input.status as typeof facilities.$inferSelect.status),
    );
  }
  if (input.companyId) filters.push(eq(facilities.companyId, input.companyId));
  if (input.country) filters.push(eq(facilities.countryCode, input.country));
  const where = filters.length ? and(...filters) : undefined;
  const db = getDatabase();
  const [rows, countRows] = await Promise.all([
    db
      .select(facilitySelect())
      .from(facilities)
      .leftJoin(companies, eq(companies.id, facilities.companyId))
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ value: sql<number>`count(*)` })
      .from(facilities)
      .where(where),
  ]);
  return {
    records: rows.map((row) => mapFacility(row as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(countRows[0]?.value),
  };
}

export async function getFacilityRecord(
  id: string,
): Promise<FacilityDetailRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select({
      ...facilitySelect(),
      addressLine1: facilities.addressLine1,
      addressLine2: facilities.addressLine2,
      postalCode: facilities.postalCode,
      latitude: facilities.latitude,
      longitude: facilities.longitude,
    })
    .from(facilities)
    .leftJoin(companies, eq(companies.id, facilities.companyId))
    .where(eq(facilities.id, id))
    .limit(1);
  if (!row) return null;

  const [capabilityRows, qualificationRows] = await Promise.all([
    db
      .select({
        id: facilityCapabilities.id,
        capabilityId: capabilities.id,
        name: capabilities.name,
        code: capabilities.code,
        status: facilityCapabilities.status,
        confidence: facilityCapabilities.confidence,
        validFrom: facilityCapabilities.validFrom,
        validTo: facilityCapabilities.validTo,
      })
      .from(facilityCapabilities)
      .innerJoin(
        capabilities,
        eq(capabilities.id, facilityCapabilities.capabilityId),
      )
      .where(eq(facilityCapabilities.facilityId, id)),
    db
      .select({
        id: facilityQualifications.id,
        partId: parts.id,
        partNumber: parts.partNumber,
        platformId: platforms.id,
        platformName: platforms.name,
        customerCompanyId: companies.id,
        customerName: companies.displayName,
        scarcity: facilityQualifications.scarcity,
        validFrom: facilityQualifications.validFrom,
        validTo: facilityQualifications.validTo,
        confidence: facilityQualifications.confidence,
      })
      .from(facilityQualifications)
      .innerJoin(parts, eq(parts.id, facilityQualifications.partId))
      .leftJoin(platforms, eq(platforms.id, facilityQualifications.platformId))
      .leftJoin(
        companies,
        eq(companies.id, facilityQualifications.customerCompanyId),
      )
      .where(eq(facilityQualifications.facilityId, id)),
  ]);

  return {
    ...mapFacility(row as unknown as Record<string, unknown>),
    addressLine1: nullableText(row.addressLine1),
    addressLine2: nullableText(row.addressLine2),
    postalCode: nullableText(row.postalCode),
    latitude: row.latitude === null ? null : String(row.latitude),
    longitude: row.longitude === null ? null : String(row.longitude),
    capabilities: capabilityRows.map((item) => ({
      id: item.id,
      capabilityId: item.capabilityId,
      name: item.name,
      code: item.code,
      status: item.status,
      confidence: item.confidence === null ? null : String(item.confidence),
      validFrom: item.validFrom,
      validTo: item.validTo,
    })),
    qualifications: qualificationRows.map((item) => ({
      id: item.id,
      partId: item.partId,
      partNumber: item.partNumber,
      platformId: item.platformId,
      platformName: item.platformName,
      customerCompanyId: item.customerCompanyId,
      customerName: item.customerName,
      scarcity: item.scarcity,
      validFrom: item.validFrom,
      validTo: item.validTo,
      confidence: item.confidence === null ? null : String(item.confidence),
    })),
  };
}

function platformSelect() {
  return {
    id: platforms.id,
    name: platforms.name,
    platformType: platforms.platformType,
    description: platforms.description,
    familyId: platforms.familyId,
    familyName: platformFamilies.name,
    manufacturerCompanyId: platforms.manufacturerCompanyId,
    manufacturerName: companies.displayName,
    variantCount: sql<number>`(select count(*) from ${platformVariants} where platform_id = ${platforms.id})`,
    qualificationCount: sql<number>`(select count(*) from ${facilityQualifications} where platform_id = ${platforms.id})`,
    createdAt: platforms.createdAt,
    updatedAt: platforms.updatedAt,
  };
}

function mapPlatform(row: Record<string, unknown>): PlatformListRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    platformType: nullableText(row.platformType),
    description: nullableText(row.description),
    familyId: typeof row.familyId === "string" ? row.familyId : null,
    familyName: nullableText(row.familyName),
    manufacturerCompanyId:
      typeof row.manufacturerCompanyId === "string"
        ? row.manufacturerCompanyId
        : null,
    manufacturerName: nullableText(row.manufacturerName),
    variantCount: n(row.variantCount),
    qualificationCount: n(row.qualificationCount),
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export async function listPlatformRecords(
  input: PageInput & { query?: string; manufacturerCompanyId?: string },
): Promise<PageResult<PlatformListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters: SQL[] = [];
  const pattern = searchContains(input.query);
  if (pattern) {
    filters.push(
      or(
        ilike(platforms.name, pattern),
        ilike(platforms.description, pattern),
      )!,
    );
  }
  if (input.manufacturerCompanyId) {
    filters.push(eq(platforms.manufacturerCompanyId, input.manufacturerCompanyId));
  }
  const where = filters.length ? and(...filters) : undefined;
  const db = getDatabase();
  const [rows, countRows] = await Promise.all([
    db
      .select(platformSelect())
      .from(platforms)
      .leftJoin(platformFamilies, eq(platformFamilies.id, platforms.familyId))
      .leftJoin(companies, eq(companies.id, platforms.manufacturerCompanyId))
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db.select({ value: sql<number>`count(*)` }).from(platforms).where(where),
  ]);
  return {
    records: rows.map((row) => mapPlatform(row as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(countRows[0]?.value),
  };
}

export async function getPlatformRecord(
  id: string,
): Promise<PlatformDetailRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select(platformSelect())
    .from(platforms)
    .leftJoin(platformFamilies, eq(platformFamilies.id, platforms.familyId))
    .leftJoin(companies, eq(companies.id, platforms.manufacturerCompanyId))
    .where(eq(platforms.id, id))
    .limit(1);
  if (!row) return null;
  const variants = await db
    .select({
      id: platformVariants.id,
      name: platformVariants.name,
      designation: platformVariants.designation,
      enteredServiceOn: platformVariants.enteredServiceOn,
      retiredOn: platformVariants.retiredOn,
    })
    .from(platformVariants)
    .where(eq(platformVariants.platformId, id));
  return {
    ...mapPlatform(row as unknown as Record<string, unknown>),
    variants,
  };
}

function partSelect() {
  return {
    id: parts.id,
    partNumber: parts.partNumber,
    name: parts.name,
    description: parts.description,
    lifecycleStatus: parts.lifecycleStatus,
    manufacturerCompanyId: parts.manufacturerCompanyId,
    manufacturerName: companies.displayName,
    qualificationCount: sql<number>`(select count(*) from ${facilityQualifications} where part_id = ${parts.id})`,
    createdAt: parts.createdAt,
    updatedAt: parts.updatedAt,
  };
}

function mapPart(row: Record<string, unknown>): PartListRecord {
  return {
    id: String(row.id),
    partNumber: String(row.partNumber),
    name: nullableText(row.name),
    description: nullableText(row.description),
    lifecycleStatus: String(row.lifecycleStatus),
    manufacturerCompanyId:
      typeof row.manufacturerCompanyId === "string"
        ? row.manufacturerCompanyId
        : null,
    manufacturerName: nullableText(row.manufacturerName),
    qualificationCount: n(row.qualificationCount),
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export async function listPartRecords(
  input: PageInput & {
    query?: string;
    manufacturerCompanyId?: string;
    status?: string;
  },
): Promise<PageResult<PartListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters: SQL[] = [];
  const pattern = searchContains(input.query);
  if (pattern) {
    filters.push(
      or(
        ilike(parts.partNumber, pattern),
        ilike(parts.name, pattern),
      )!,
    );
  }
  if (input.manufacturerCompanyId) {
    filters.push(eq(parts.manufacturerCompanyId, input.manufacturerCompanyId));
  }
  if (input.status) {
    filters.push(
      eq(
        parts.lifecycleStatus,
        input.status as typeof parts.$inferSelect.lifecycleStatus,
      ),
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const db = getDatabase();
  const [rows, countRows] = await Promise.all([
    db
      .select(partSelect())
      .from(parts)
      .leftJoin(companies, eq(companies.id, parts.manufacturerCompanyId))
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db.select({ value: sql<number>`count(*)` }).from(parts).where(where),
  ]);
  return {
    records: rows.map((row) => mapPart(row as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(countRows[0]?.value),
  };
}

export async function getPartRecord(id: string): Promise<PartDetailRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select(partSelect())
    .from(parts)
    .leftJoin(companies, eq(companies.id, parts.manufacturerCompanyId))
    .where(eq(parts.id, id))
    .limit(1);
  if (!row) return null;
  const qualificationRows = await db
    .select({
      id: facilityQualifications.id,
      facilityId: facilities.id,
      facilityName: facilities.name,
      platformId: platforms.id,
      platformName: platforms.name,
      customerCompanyId: companies.id,
      customerName: companies.displayName,
      scarcity: facilityQualifications.scarcity,
      validFrom: facilityQualifications.validFrom,
      validTo: facilityQualifications.validTo,
    })
    .from(facilityQualifications)
    .innerJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
    .leftJoin(platforms, eq(platforms.id, facilityQualifications.platformId))
    .leftJoin(companies, eq(companies.id, facilityQualifications.customerCompanyId))
    .where(eq(facilityQualifications.partId, id));
  return {
    ...mapPart(row as unknown as Record<string, unknown>),
    qualifications: qualificationRows.map((item) => ({
      id: item.id,
      facilityId: item.facilityId,
      facilityName: item.facilityName,
      platformId: item.platformId,
      platformName: item.platformName,
      customerCompanyId: item.customerCompanyId,
      customerName: item.customerName,
      scarcity: item.scarcity,
      validFrom: item.validFrom,
      validTo: item.validTo,
    })),
  };
}

function qualificationSelect() {
  return {
    id: facilityQualifications.id,
    facilityId: facilities.id,
    facilityName: facilities.name,
    companyId: facilities.companyId,
    companyName: sql<string | null>`(select display_name from ${companies} where id = ${facilities.companyId})`,
    partId: parts.id,
    partNumber: parts.partNumber,
    partName: parts.name,
    platformId: platforms.id,
    platformName: platforms.name,
    platformVariantId: platformVariants.id,
    platformVariantName: platformVariants.name,
    subsystemId: subsystems.id,
    subsystemName: subsystems.name,
    customerCompanyId: facilityQualifications.customerCompanyId,
    customerName: sql<string | null>`(select display_name from ${companies} where id = ${facilityQualifications.customerCompanyId})`,
    qualificationReference: facilityQualifications.qualificationReference,
    scarcity: facilityQualifications.scarcity,
    validFrom: facilityQualifications.validFrom,
    validTo: facilityQualifications.validTo,
    confidence: facilityQualifications.confidence,
    createdAt: facilityQualifications.createdAt,
    updatedAt: facilityQualifications.updatedAt,
  };
}

function mapQualification(row: Record<string, unknown>): QualificationListRecord {
  return {
    id: String(row.id),
    facilityId: String(row.facilityId),
    facilityName: String(row.facilityName),
    companyId: typeof row.companyId === "string" ? row.companyId : null,
    companyName: nullableText(row.companyName),
    partId: String(row.partId),
    partNumber: String(row.partNumber),
    partName: nullableText(row.partName),
    platformId: typeof row.platformId === "string" ? row.platformId : null,
    platformName: nullableText(row.platformName),
    platformVariantId:
      typeof row.platformVariantId === "string" ? row.platformVariantId : null,
    platformVariantName: nullableText(row.platformVariantName),
    subsystemId: typeof row.subsystemId === "string" ? row.subsystemId : null,
    subsystemName: nullableText(row.subsystemName),
    customerCompanyId:
      typeof row.customerCompanyId === "string" ? row.customerCompanyId : null,
    customerName: nullableText(row.customerName),
    qualificationReference: nullableText(row.qualificationReference),
    scarcity: String(row.scarcity),
    validFrom: typeof row.validFrom === "string" ? row.validFrom : null,
    validTo: typeof row.validTo === "string" ? row.validTo : null,
    confidence: row.confidence === null || row.confidence === undefined
      ? null
      : String(row.confidence),
    createdAt: row.createdAt as Date,
    updatedAt: row.updatedAt as Date,
  };
}

export async function listQualificationRecords(
  input: PageInput & {
    query?: string;
    facilityId?: string;
    partId?: string;
    platformId?: string;
    customerCompanyId?: string;
    scarcity?: string;
  },
): Promise<PageResult<QualificationListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters: SQL[] = [];
  const pattern = searchContains(input.query);
  if (pattern) {
    filters.push(
      or(
        ilike(facilities.name, pattern),
        ilike(parts.partNumber, pattern),
        ilike(platforms.name, pattern),
      )!,
    );
  }
  if (input.facilityId) {
    filters.push(eq(facilityQualifications.facilityId, input.facilityId));
  }
  if (input.partId) filters.push(eq(facilityQualifications.partId, input.partId));
  if (input.platformId) {
    filters.push(eq(facilityQualifications.platformId, input.platformId));
  }
  if (input.customerCompanyId) {
    filters.push(
      eq(facilityQualifications.customerCompanyId, input.customerCompanyId),
    );
  }
  if (input.scarcity) {
    filters.push(
      eq(
        facilityQualifications.scarcity,
        input.scarcity as typeof facilityQualifications.$inferSelect.scarcity,
      ),
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const db = getDatabase();
  const [rows, countRows] = await Promise.all([
    db
      .select(qualificationSelect())
      .from(facilityQualifications)
      .innerJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
      .innerJoin(parts, eq(parts.id, facilityQualifications.partId))
      .leftJoin(platforms, eq(platforms.id, facilityQualifications.platformId))
      .leftJoin(
        platformVariants,
        eq(platformVariants.id, facilityQualifications.platformVariantId),
      )
      .leftJoin(subsystems, eq(subsystems.id, facilityQualifications.subsystemId))
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db
      .select({ value: sql<number>`count(*)` })
      .from(facilityQualifications)
      .innerJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
      .innerJoin(parts, eq(parts.id, facilityQualifications.partId))
      .leftJoin(platforms, eq(platforms.id, facilityQualifications.platformId))
      .where(where),
  ]);
  return {
    records: rows.map((row) =>
      mapQualification(row as unknown as Record<string, unknown>),
    ),
    page,
    pageSize,
    total: n(countRows[0]?.value),
  };
}

export async function getQualificationRecord(
  id: string,
): Promise<QualificationListRecord | null> {
  const [row] = await getDatabase()
    .select(qualificationSelect())
    .from(facilityQualifications)
    .innerJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
    .innerJoin(parts, eq(parts.id, facilityQualifications.partId))
    .leftJoin(platforms, eq(platforms.id, facilityQualifications.platformId))
    .leftJoin(
      platformVariants,
      eq(platformVariants.id, facilityQualifications.platformVariantId),
    )
    .leftJoin(subsystems, eq(subsystems.id, facilityQualifications.subsystemId))
    .where(eq(facilityQualifications.id, id))
    .limit(1);
  return row
    ? mapQualification(row as unknown as Record<string, unknown>)
    : null;
}

export async function listImportRecords(
  input: PageInput & { query?: string; status?: string },
): Promise<PageResult<ImportListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters: SQL[] = [];
  const pattern = searchContains(input.query);
  if (pattern) filters.push(ilike(imports.fileName, pattern));
  if (input.status) {
    filters.push(eq(imports.status, input.status as typeof imports.$inferSelect.status));
  }
  const where = filters.length ? and(...filters) : undefined;
  const db = getDatabase();
  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(imports)
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db.select({ value: sql<number>`count(*)` }).from(imports).where(where),
  ]);
  return {
    records: rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      status: row.status,
      storageKey: row.storageKey,
      contentSha256: row.contentSha256,
      dataSourceId: row.dataSourceId,
      requestedByUserId: row.requestedByUserId,
      rowCount: row.rowCount,
      importedCount: row.importedCount,
      rejectedCount: row.rejectedCount,
      error: row.error,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    page,
    pageSize,
    total: n(countRows[0]?.value),
  };
}

export async function getImportRecord(id: string): Promise<
  | (ImportListRecord & {
      readonly rows: readonly {
        readonly id: string;
        readonly rowNumber: number;
        readonly status: string;
        readonly targetEntityType: string | null;
        readonly targetEntityId: string | null;
        readonly errors: unknown;
      }[];
    })
  | null
> {
  const db = getDatabase();
  const [row] = await db.select().from(imports).where(eq(imports.id, id)).limit(1);
  if (!row) return null;
  const rows = await db
    .select({
      id: importRows.id,
      rowNumber: importRows.rowNumber,
      status: importRows.status,
      targetEntityType: importRows.targetEntityType,
      targetEntityId: importRows.targetEntityId,
      errors: importRows.errors,
    })
    .from(importRows)
    .where(eq(importRows.importId, id));
  return {
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    storageKey: row.storageKey,
    contentSha256: row.contentSha256,
    dataSourceId: row.dataSourceId,
    requestedByUserId: row.requestedByUserId,
    rowCount: row.rowCount,
    importedCount: row.importedCount,
    rejectedCount: row.rejectedCount,
    error: row.error,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rows,
  };
}


export interface CapabilityListRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly parentId: string | null;
  readonly companyCount: number;
  readonly facilityCount: number;
}

export interface CertificationListRecord {
  readonly id: string;
  readonly standard: string;
  readonly certificateNumber: string | null;
  readonly issuingBody: string | null;
  readonly status: string;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly companyId: string | null;
  readonly companyName: string | null;
  readonly facilityId: string | null;
  readonly facilityName: string | null;
}

export async function listCapabilityRecords(
  input: PageInput & { query?: string },
): Promise<PageResult<CapabilityListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const pattern = searchContains(input.query);
  const where = pattern
    ? or(
        ilike(capabilities.name, pattern),
        ilike(capabilities.code, pattern),
      )
    : undefined;
  const db = getDatabase();
  const [rows, total] = await Promise.all([
    db
      .select({
        id: capabilities.id,
        code: capabilities.code,
        name: capabilities.name,
        description: capabilities.description,
        parentId: capabilities.parentId,
        companyCount: sql<number>`(select count(*) from ${companyCapabilities} where capability_id = ${capabilities.id})`,
        facilityCount: sql<number>`(select count(*) from ${facilityCapabilities} where capability_id = ${capabilities.id})`,
      })
      .from(capabilities)
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db.select({ v: sql<number>`count(*)` }).from(capabilities).where(where),
  ]);
  return {
    records: rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: nullableText(row.description),
      parentId: row.parentId,
      companyCount: n(row.companyCount),
      facilityCount: n(row.facilityCount),
    })),
    page,
    pageSize,
    total: n(total[0]?.v),
  };
}

export async function getCapabilityRecord(id: string): Promise<
  | (CapabilityListRecord & {
      readonly companies: readonly { id: string; name: string; status: string }[];
      readonly facilities: readonly { id: string; name: string; status: string }[];
    })
  | null
> {
  const db = getDatabase();
  const [row] = await db
    .select({
      id: capabilities.id,
      code: capabilities.code,
      name: capabilities.name,
      description: capabilities.description,
      parentId: capabilities.parentId,
      companyCount: sql<number>`(select count(*) from ${companyCapabilities} where capability_id = ${capabilities.id})`,
      facilityCount: sql<number>`(select count(*) from ${facilityCapabilities} where capability_id = ${capabilities.id})`,
    })
    .from(capabilities)
    .where(eq(capabilities.id, id))
    .limit(1);
  if (!row) return null;
  const [companyRows, facilityRows] = await Promise.all([
    db
      .select({
        id: companies.id,
        name: companies.displayName,
        status: companyCapabilities.status,
      })
      .from(companyCapabilities)
      .innerJoin(companies, eq(companies.id, companyCapabilities.companyId))
      .where(eq(companyCapabilities.capabilityId, id)),
    db
      .select({
        id: facilities.id,
        name: facilities.name,
        status: facilityCapabilities.status,
      })
      .from(facilityCapabilities)
      .innerJoin(facilities, eq(facilities.id, facilityCapabilities.facilityId))
      .where(eq(facilityCapabilities.capabilityId, id)),
  ]);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: nullableText(row.description),
    parentId: row.parentId,
    companyCount: n(row.companyCount),
    facilityCount: n(row.facilityCount),
    companies: companyRows,
    facilities: facilityRows,
  };
}

function certificationSelect() {
  return {
    id: certifications.id,
    standard: certifications.standard,
    certificateNumber: certifications.certificateNumber,
    issuingBody: certifications.issuingBody,
    status: certifications.status,
    issuedOn: certifications.issuedOn,
    expiresOn: certifications.expiresOn,
    companyId: certifications.companyId,
    companyName: companies.displayName,
    facilityId: certifications.facilityId,
    facilityName: facilities.name,
  };
}

function mapCertification(row: Record<string, unknown>): CertificationListRecord {
  return {
    id: String(row.id),
    standard: String(row.standard),
    certificateNumber: nullableText(row.certificateNumber),
    issuingBody: nullableText(row.issuingBody),
    status: String(row.status),
    issuedOn: row.issuedOn instanceof Date ? row.issuedOn.toISOString().slice(0, 10) : nullableText(row.issuedOn),
    expiresOn: row.expiresOn instanceof Date ? row.expiresOn.toISOString().slice(0, 10) : nullableText(row.expiresOn),
    companyId: typeof row.companyId === "string" ? row.companyId : null,
    companyName: nullableText(row.companyName),
    facilityId: typeof row.facilityId === "string" ? row.facilityId : null,
    facilityName: nullableText(row.facilityName),
  };
}

export async function listCertificationRecords(
  input: PageInput & { query?: string; companyId?: string; facilityId?: string; status?: string },
): Promise<PageResult<CertificationListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters: SQL[] = [];
  const pattern = searchContains(input.query);
  if (pattern) {
    filters.push(
      or(
        ilike(certifications.standard, pattern),
        ilike(certifications.certificateNumber, pattern),
        ilike(certifications.issuingBody, pattern),
      )!,
    );
  }
  if (input.companyId) filters.push(eq(certifications.companyId, input.companyId));
  if (input.facilityId) filters.push(eq(certifications.facilityId, input.facilityId));
  if (input.status) filters.push(eq(certifications.status, input.status as typeof certifications.$inferSelect.status));
  const where = filters.length ? and(...filters) : undefined;
  const db = getDatabase();
  const [rows, total] = await Promise.all([
    db
      .select(certificationSelect())
      .from(certifications)
      .leftJoin(companies, eq(companies.id, certifications.companyId))
      .leftJoin(facilities, eq(facilities.id, certifications.facilityId))
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db.select({ v: sql<number>`count(*)` }).from(certifications).where(where),
  ]);
  return {
    records: rows.map((row) => mapCertification(row as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(total[0]?.v),
  };
}

export async function getCertificationRecord(
  id: string,
): Promise<CertificationListRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select(certificationSelect())
    .from(certifications)
    .leftJoin(companies, eq(companies.id, certifications.companyId))
    .leftJoin(facilities, eq(facilities.id, certifications.facilityId))
    .where(eq(certifications.id, id))
    .limit(1);
  return row ? mapCertification(row as unknown as Record<string, unknown>) : null;
}


const parentSubsystems = alias(subsystems, "parent_subsystems");
const qualifiedSubsystemId = sql.raw('"subsystems"."id"');
const qualifiedCompanyId = sql.raw('"companies"."id"');

export interface SubsystemListRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly parentName: string | null;
  readonly code: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly qualificationCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SubsystemDetailRecord extends SubsystemListRecord {
  readonly qualifications: readonly {
    readonly id: string;
    readonly facilityId: string;
    readonly facilityName: string | null;
    readonly partId: string;
    readonly partNumber: string | null;
    readonly platformId: string | null;
    readonly customerCompanyId: string | null;
    readonly customerName: string | null;
    readonly scarcity: string;
    readonly validFrom: string | null;
    readonly validTo: string | null;
  }[];
}

export interface CustomerListRecord {
  readonly id: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly status: string;
  readonly headquartersCountryCode: string | null;
  readonly websiteUrl: string | null;
  readonly qualificationCount: number;
  readonly contractCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomerDetailRecord extends CustomerListRecord {
  readonly description: string | null;
  readonly qualifications: readonly {
    readonly id: string;
    readonly facilityId: string;
    readonly facilityName: string | null;
    readonly partId: string;
    readonly partNumber: string | null;
    readonly platformId: string | null;
    readonly subsystemId: string | null;
    readonly subsystemName: string | null;
    readonly scarcity: string;
    readonly validFrom: string | null;
    readonly validTo: string | null;
  }[];
  readonly awardedContracts: readonly {
    readonly id: string;
    readonly contractNumber: string;
    readonly title: string | null;
    readonly supplierCompanyId: string | null;
    readonly supplierName: string | null;
    readonly status: string;
    readonly startDate: string | null;
    readonly endDate: string | null;
  }[];
}

function dateOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return nullableText(value);
}

function subsystemSelect() {
  return {
    id: subsystems.id,
    parentId: subsystems.parentId,
    parentName: parentSubsystems.name,
    code: subsystems.code,
    name: subsystems.name,
    description: subsystems.description,
    qualificationCount: sql<number>`(select count(*) from ${facilityQualifications} where ${facilityQualifications.subsystemId} = ${qualifiedSubsystemId})`,
    createdAt: subsystems.createdAt,
    updatedAt: subsystems.updatedAt,
  };
}

function mapSubsystem(row: Record<string, unknown>): SubsystemListRecord {
  return {
    id: String(row.id),
    parentId: typeof row.parentId === "string" ? row.parentId : null,
    parentName: nullableText(row.parentName),
    code: nullableText(row.code),
    name: String(row.name ?? ""),
    description: nullableText(row.description),
    qualificationCount: n(row.qualificationCount),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updatedAt)),
  };
}

export async function listSubsystemRecords(
  input: PageInput & { query?: string },
): Promise<PageResult<SubsystemListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters: SQL[] = [];
  const pattern = searchContains(input.query);
  if (pattern) {
    filters.push(
      or(
        ilike(subsystems.name, pattern),
        ilike(subsystems.code, pattern),
        ilike(subsystems.description, pattern),
      )!,
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const db = getDatabase();
  const [rows, total] = await Promise.all([
    db
      .select(subsystemSelect())
      .from(subsystems)
      .leftJoin(parentSubsystems, eq(parentSubsystems.id, subsystems.parentId))
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db.select({ v: sql<number>`count(*)` }).from(subsystems).where(where),
  ]);
  return {
    records: rows.map((row) => mapSubsystem(row as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(total[0]?.v),
  };
}

export async function getSubsystemRecord(
  id: string,
): Promise<SubsystemDetailRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select(subsystemSelect())
    .from(subsystems)
    .leftJoin(parentSubsystems, eq(parentSubsystems.id, subsystems.parentId))
    .where(eq(subsystems.id, id))
    .limit(1);
  if (!row) return null;
  const qualificationRows = await db
    .select({
      id: facilityQualifications.id,
      facilityId: facilityQualifications.facilityId,
      facilityName: facilities.name,
      partId: facilityQualifications.partId,
      partNumber: parts.partNumber,
      platformId: facilityQualifications.platformId,
      customerCompanyId: facilityQualifications.customerCompanyId,
      customerName: companies.displayName,
      scarcity: facilityQualifications.scarcity,
      validFrom: facilityQualifications.validFrom,
      validTo: facilityQualifications.validTo,
    })
    .from(facilityQualifications)
    .leftJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
    .leftJoin(parts, eq(parts.id, facilityQualifications.partId))
    .leftJoin(companies, eq(companies.id, facilityQualifications.customerCompanyId))
    .where(eq(facilityQualifications.subsystemId, id));
  return {
    ...mapSubsystem(row as unknown as Record<string, unknown>),
    qualifications: qualificationRows.map((qualification) => ({
      id: qualification.id,
      facilityId: qualification.facilityId,
      facilityName: nullableText(qualification.facilityName),
      partId: qualification.partId,
      partNumber: nullableText(qualification.partNumber),
      platformId: qualification.platformId,
      customerCompanyId: qualification.customerCompanyId,
      customerName: nullableText(qualification.customerName),
      scarcity: qualification.scarcity,
      validFrom: dateOrNull(qualification.validFrom),
      validTo: dateOrNull(qualification.validTo),
    })),
  };
}

function customerSelect() {
  return {
    id: companies.id,
    legalName: companies.legalName,
    displayName: companies.displayName,
    status: companies.status,
    headquartersCountryCode: companies.headquartersCountryCode,
    websiteUrl: companies.websiteUrl,
    description: companies.description,
    qualificationCount: sql<number>`(select count(*) from ${facilityQualifications} where ${facilityQualifications.customerCompanyId} = ${qualifiedCompanyId})`,
    contractCount: sql<number>`(select count(*) from ${contracts} where ${contracts.customerCompanyId} = ${qualifiedCompanyId})`,
    createdAt: companies.createdAt,
    updatedAt: companies.updatedAt,
  };
}

function mapCustomer(row: Record<string, unknown>): CustomerListRecord {
  return {
    id: String(row.id),
    legalName: String(row.legalName ?? ""),
    displayName: String(row.displayName ?? ""),
    status: String(row.status ?? "unknown"),
    headquartersCountryCode: nullableText(row.headquartersCountryCode),
    websiteUrl: nullableText(row.websiteUrl),
    qualificationCount: n(row.qualificationCount),
    contractCount: n(row.contractCount),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(String(row.updatedAt)),
  };
}

const customerRoleFilter = sql`(
  exists (select 1 from ${facilityQualifications} where ${facilityQualifications.customerCompanyId} = ${qualifiedCompanyId})
  or exists (select 1 from ${contracts} where ${contracts.customerCompanyId} = ${qualifiedCompanyId})
)`;

export async function listCustomerRecords(
  input: PageInput & { query?: string; country?: string },
): Promise<PageResult<CustomerListRecord>> {
  const { page, pageSize, offset } = normalizePagination(input);
  const filters: SQL[] = [customerRoleFilter];
  const pattern = searchContains(input.query);
  if (pattern) {
    filters.push(
      or(
        ilike(companies.legalName, pattern),
        ilike(companies.displayName, pattern),
        ilike(companies.description, pattern),
      )!,
    );
  }
  if (input.country) {
    filters.push(eq(companies.headquartersCountryCode, input.country));
  }
  const where = and(...filters);
  const db = getDatabase();
  const [rows, total] = await Promise.all([
    db
      .select(customerSelect())
      .from(companies)
      .where(where)
      .limit(pageSize)
      .offset(offset),
    db.select({ v: sql<number>`count(*)` }).from(companies).where(where),
  ]);
  return {
    records: rows.map((row) => mapCustomer(row as unknown as Record<string, unknown>)),
    page,
    pageSize,
    total: n(total[0]?.v),
  };
}

export async function getCustomerRecord(
  id: string,
): Promise<CustomerDetailRecord | null> {
  const db = getDatabase();
  const [row] = await db
    .select(customerSelect())
    .from(companies)
    .where(and(eq(companies.id, id), customerRoleFilter))
    .limit(1);
  if (!row) return null;
  const [qualificationRows, contractRows] = await Promise.all([
    db
      .select({
        id: facilityQualifications.id,
        facilityId: facilityQualifications.facilityId,
        facilityName: facilities.name,
        partId: facilityQualifications.partId,
        partNumber: parts.partNumber,
        platformId: facilityQualifications.platformId,
        subsystemId: facilityQualifications.subsystemId,
        subsystemName: subsystems.name,
        scarcity: facilityQualifications.scarcity,
        validFrom: facilityQualifications.validFrom,
        validTo: facilityQualifications.validTo,
      })
      .from(facilityQualifications)
      .leftJoin(facilities, eq(facilities.id, facilityQualifications.facilityId))
      .leftJoin(parts, eq(parts.id, facilityQualifications.partId))
      .leftJoin(subsystems, eq(subsystems.id, facilityQualifications.subsystemId))
      .where(eq(facilityQualifications.customerCompanyId, id)),
    db
      .select({
        id: contracts.id,
        contractNumber: contracts.contractNumber,
        title: contracts.title,
        supplierCompanyId: contracts.supplierCompanyId,
        supplierName: companies.displayName,
        status: contracts.status,
        startDate: contracts.startDate,
        endDate: contracts.endDate,
      })
      .from(contracts)
      .leftJoin(companies, eq(companies.id, contracts.supplierCompanyId))
      .where(eq(contracts.customerCompanyId, id)),
  ]);
  const mapped = mapCustomer(row as unknown as Record<string, unknown>);
  return {
    ...mapped,
    description: nullableText((row as unknown as Record<string, unknown>).description),
    qualifications: qualificationRows.map((qualification) => ({
      id: qualification.id,
      facilityId: qualification.facilityId,
      facilityName: nullableText(qualification.facilityName),
      partId: qualification.partId,
      partNumber: nullableText(qualification.partNumber),
      platformId: qualification.platformId,
      subsystemId: qualification.subsystemId,
      subsystemName: nullableText(qualification.subsystemName),
      scarcity: qualification.scarcity,
      validFrom: dateOrNull(qualification.validFrom),
      validTo: dateOrNull(qualification.validTo),
    })),
    awardedContracts: contractRows.map((contract) => ({
      id: contract.id,
      contractNumber: contract.contractNumber,
      title: nullableText(contract.title),
      supplierCompanyId: contract.supplierCompanyId,
      supplierName: nullableText(contract.supplierName),
      status: contract.status,
      startDate: dateOrNull(contract.startDate),
      endDate: dateOrNull(contract.endDate),
    })),
  };
}
